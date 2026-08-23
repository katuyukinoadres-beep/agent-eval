/**
 * Axis 4 — whether what was made got used.
 *
 * It exists because the other axes all watch procedure, and someone producing
 * rubbish by a tidy procedure scores full marks on every one of them. A request
 * that ended in silence with nothing built was simply missing from the old
 * design, so failing cost nothing.
 *
 * The re-reference rule is what stops the obvious attack. A file only counts as
 * used when something in a *different* task bundle refers to it: reading back
 * one's own output inside the same request is verification, axis 3 counts it
 * there, and letting it count here would make re-reading the cheapest way to
 * raise the score.
 */

import type { Artifact } from './artifact.js'
import type { Leaning } from './composite.js'
import type { Mention } from '../collect/reference.js'

/** v1's weights over the three terms. They sum to 1. */
export const WEIGHT_REUSE = 0.55
export const WEIGHT_NOT_ABANDONED = 0.3
export const WEIGHT_NOT_OVERWRITTEN = 0.15

/** Below this many bundles in the window, the axis has nothing to judge. */
export const MIN_BUNDLES = 10

export type UptakeOmission =
  | 'axis4-abandonment'
  | 'axis4-next-window-survival'
  | 'axis4-manual-overwrite'

/**
 * What is not computed, and which way each moves the score.
 *
 * `axis4-abandonment` is the (b) term. v1 defines an abandoned bundle as one
 * where no write succeeded **and** the closing human turn was not an
 * acknowledgement **and** the next bundle was not a continuation of the same
 * topic. The first is mechanical; the other two are semantic judgements no
 * regular expression settles. Implementing only the first would call every
 * question-and-answer bundle abandoned -- 70 of 427 on this machine made no
 * tool call at all -- which is not a conservative approximation but a wrong
 * one. So the term is dropped and the remaining two are renormalised, per the
 * rule for convex-combination axes.
 *
 * Dropping `(1 - A)` removes a term that is at most 1, so the renormalised
 * score is whatever the other two say. On an environment that abandons a lot,
 * and the direction that follows is not one this build can know. The axis is a
 * convex combination renormalised over its survivors, so dropping the (b) term
 * raises the score exactly when the abandonment rate is below the renormalised
 * score -- a comparison against a value that is not computed. `high` was
 * asserting the answer to the question the omission exists to record.
 *
 * `axis4-next-window-survival` is one of the four ways (a) can be satisfied and
 * needs a previous window, so a first window cannot have it. Omitting a way to
 * satisfy a numerator makes the score read **low**.
 */
export const UPTAKE_OMISSION_LEANINGS: Readonly<Record<UptakeOmission, Leaning>> = {
  'axis4-abandonment': 'unknown',
  'axis4-next-window-survival': 'low',
  // Overridden per window by `leaningOf`, which compares the refused value
  // against the score that survived without it. This entry is the fallback for
  // a reader that does not look at `overwriteLeaning`.
  'axis4-manual-overwrite': 'unknown',
}

/** Below this numerator a term is dropped and the rest renormalised. v2 §6.2. */
export const MIN_TERM_NUMERATOR = 5

/**
 * Which way dropping a term of known value moved the score.
 *
 * For a convex combination renormalised over its survivors, dropping term k
 * raises the score exactly when x_k sits below the renormalised result. When
 * x_k was computed and then refused for want of a denominator, that comparison
 * is available and the direction is a fact rather than a guess.
 */
export function leaningOf(droppedValue: number, survivingScore: number): Leaning {
  const surviving = survivingScore / 100
  if (Math.abs(droppedValue - surviving) < 1e-9) return 'none'
  return droppedValue < surviving ? 'high' : 'low'
}

export interface UptakeInputs {
  readonly artifacts: readonly Artifact[]
  /** Total weight of the artifact set, for the denominator of (a). */
  readonly totalWeight: number
  readonly bundles: number
  /**
   * Whether a request other than the writing one referred to the path after it
   * was written.
   *
   * Not "the latest mention was elsewhere": a write records its own path as a
   * mention in its own bundle, so a file written, re-used, then edited again
   * had its last mention overwritten by that final write and scored as never
   * re-used. A file someone kept maintaining scored as an abandoned one.
   */
  readonly mentionedElsewhereAfter: (path: string, bundle: number | null, after: string) => boolean
  /** Paths a person edited by hand, already normalised for comparison. */
  readonly manuallyOverwritten: (path: string) => boolean
  /** Whether this is the first window, so next-window survival cannot count. */
  readonly firstWindow: boolean
}

export interface Uptake {
  /** Weighted share of artifacts something later referred to, from another bundle. */
  readonly reuse: number | null
  /** Share of artifacts a person edited by hand. */
  readonly overwritten: number | null
  readonly score: number | null
  readonly artifacts: number
  readonly reusedArtifacts: number
  readonly overwrittenArtifacts: number
  readonly bundles: number
  readonly omitted: readonly UptakeOmission[]
  /**
   * Which way dropping the (c) term moved this window's score, or null when it
   * was not dropped.
   *
   * Decided per window rather than declared in the leanings table: the value
   * was computed and then refused for want of a denominator, so the comparison
   * against the surviving score is available and the direction is a fact.
   */
  readonly overwriteLeaning: Leaning | null
  /** Why there is no score, when there is none. */
  readonly unavailable: 'no-artifacts' | 'too-few-bundles' | null
}

const normalise = (p: string): string => p.split('\\').join('/').toLowerCase()

export function uptake(inputs: UptakeInputs): Uptake {
  const { artifacts, bundles } = inputs
  const omitted: UptakeOmission[] = ['axis4-abandonment']
  if (inputs.firstWindow) omitted.push('axis4-next-window-survival')

  const empty = {
    reuse: null,
    overwritten: null,
    score: null,
    artifacts: artifacts.length,
    reusedArtifacts: 0,
    overwrittenArtifacts: 0,
    bundles,
    omitted,
    overwriteLeaning: null,
  } as const

  if (artifacts.length === 0) return { ...empty, unavailable: 'no-artifacts' }
  if (bundles < MIN_BUNDLES) return { ...empty, unavailable: 'too-few-bundles' }

  let reusedWeight = 0
  let reused = 0
  let overwritten = 0

  for (const a of artifacts) {
    // A different bundle, and after the write. Same-bundle read-back is
    // verification, not uptake.
    const elsewhere = inputs.mentionedElsewhereAfter(a.path, a.bundle, a.lastWrite)
    if (elsewhere) {
      reusedWeight += a.weight
      reused += 1
    }
    if (inputs.manuallyOverwritten(normalise(a.path))) overwritten += 1
  }

  const reuse = inputs.totalWeight > 0 ? reusedWeight / inputs.totalWeight : 0
  const overwrittenShare = overwritten / artifacts.length

  // (c) needs its own numerator to clear the minimum. Four hand-overwritten
  // artifacts is not a rate, and carrying it anyway put `1 - 0.018` into the
  // combination on the strength of four observations -- worth 10.65 points on
  // this axis and 2.71 on the composite.
  const keepOverwrite = overwritten >= MIN_TERM_NUMERATOR
  if (!keepOverwrite) omitted.push('axis4-manual-overwrite')

  // Renormalised over the terms that survive, per the rule for
  // convex-combination axes: the coefficients of the survivors are scaled until
  // they sum to 1 again. Nothing is credited and nothing is docked.
  const surviving = WEIGHT_REUSE + (keepOverwrite ? WEIGHT_NOT_OVERWRITTEN : 0)
  const score = keepOverwrite
    ? 100 * ((WEIGHT_REUSE / surviving) * reuse + (WEIGHT_NOT_OVERWRITTEN / surviving) * (1 - overwrittenShare))
    : 100 * reuse

  // Known, not guessed: the value was computed before it was refused.
  const overwriteLeaning = keepOverwrite ? null : leaningOf(1 - overwrittenShare, score)

  return {
    reuse,
    overwritten: overwrittenShare,
    score: Math.max(0, Math.min(100, score)),
    artifacts: artifacts.length,
    reusedArtifacts: reused,
    overwrittenArtifacts: overwritten,
    bundles,
    omitted,
    overwriteLeaning,
    unavailable: null,
  }
}
