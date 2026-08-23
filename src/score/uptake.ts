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
import type { Mention } from '../collect/reference.js'

/** v1's weights over the three terms. They sum to 1. */
export const WEIGHT_REUSE = 0.55
export const WEIGHT_NOT_ABANDONED = 0.3
export const WEIGHT_NOT_OVERWRITTEN = 0.15

/** Below this many bundles in the window, the axis has nothing to judge. */
export const MIN_BUNDLES = 10

export type UptakeOmission = 'axis4-abandonment' | 'axis4-next-window-survival'

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
 * that reads **high**.
 *
 * `axis4-next-window-survival` is one of the four ways (a) can be satisfied and
 * needs a previous window, so a first window cannot have it. Omitting a way to
 * satisfy a numerator makes the score read **low**.
 */
export const UPTAKE_OMISSION_LEANINGS: Readonly<Record<UptakeOmission, 'high' | 'low'>> = {
  'axis4-abandonment': 'high',
  'axis4-next-window-survival': 'low',
}

export interface UptakeInputs {
  readonly artifacts: readonly Artifact[]
  /** Total weight of the artifact set, for the denominator of (a). */
  readonly totalWeight: number
  readonly bundles: number
  /** The latest mention of a path, with the bundle it happened in. */
  readonly lastMentionIn: (path: string) => Mention | null
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
  } as const

  if (artifacts.length === 0) return { ...empty, unavailable: 'no-artifacts' }
  if (bundles < MIN_BUNDLES) return { ...empty, unavailable: 'too-few-bundles' }

  let reusedWeight = 0
  let reused = 0
  let overwritten = 0

  for (const a of artifacts) {
    const mention = inputs.lastMentionIn(a.path)
    // A different bundle, and after the write. Same-bundle read-back is
    // verification, not uptake.
    const elsewhere =
      mention !== null && mention.bundle !== null && a.bundle !== null && mention.bundle !== a.bundle
    if (elsewhere) {
      reusedWeight += a.weight
      reused += 1
    }
    if (inputs.manuallyOverwritten(normalise(a.path))) overwritten += 1
  }

  const reuse = inputs.totalWeight > 0 ? reusedWeight / inputs.totalWeight : 0
  const overwrittenShare = overwritten / artifacts.length

  // Renormalised over the terms that were computed, per the rule for
  // convex-combination axes: the coefficients of the survivors are scaled until
  // they sum to 1 again. Nothing is credited and nothing is docked.
  const surviving = WEIGHT_REUSE + WEIGHT_NOT_OVERWRITTEN
  const score =
    100 * ((WEIGHT_REUSE / surviving) * reuse + (WEIGHT_NOT_OVERWRITTEN / surviving) * (1 - overwrittenShare))

  return {
    reuse,
    overwritten: overwrittenShare,
    score: Math.max(0, Math.min(100, score)),
    artifacts: artifacts.length,
    reusedArtifacts: reused,
    overwrittenArtifacts: overwritten,
    bundles,
    omitted,
    unavailable: null,
  }
}
