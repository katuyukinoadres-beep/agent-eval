/**
 * Axis 2 — wasted motion per task bundle, and the first axis that produces a
 * score.
 *
 * The formula is v1's:
 *
 *   W     = numerator / bundles
 *   score = 100 * (1 - 0.65 * min(1, W / W_ref) - 0.35 * r_in)
 *
 * `W_ref` is 3.0 and v1 calls it provisional — three wasted moves per task for
 * full deduction. It says plainly that until a population exists the absolute
 * value must not be compared against anyone else's, so the score ships with
 * that stated rather than as a bare number.
 */

import type { WastedCounts } from '../collect/wasted.js'
import type { Leaning } from './composite.js'
import {
  WEIGHT_FAILURE,
  WEIGHT_INVESTIGATION_REPEAT,
  WEIGHT_LARGE_OUTPUT,
  WEIGHT_TIMEOUT,
  WEIGHT_WRITE_REPEAT,
} from '../collect/wasted.js'

/** Wasted moves per bundle at which the deduction saturates. Provisional, per v1. */
export const W_REF = 3.0

export const WEIGHT_W = 0.65
export const WEIGHT_R_IN = 0.35

/** Bundles below this and the axis reports no rate, per v1's axis-2 note. */
export const MIN_FILTERED_CALLS = 50

/**
 * Terms v1 defines that are not computed here.
 *
 * Stated because leaving them out moves the score, and in the direction that
 * flatters: each is a positive numerator term, so omitting them makes W smaller
 * and the score higher. The artifact axis errs low; this one errs high, and a
 * reader deserves to know which way each leans.
 */
export const OMITTED_TERMS = [
  // "Succeeded but contributed nothing" — a call whose result never appears in
  // any later input, edit or reply. Matching arbitrary result text against the
  // rest of the log is a different problem from matching paths, and a proxy
  // invented for it would be a number nobody could defend.
  'unused-success',
  // Calls axis 3 already counted as verification are meant to be removed from
  // the repeat terms. Axis 3 is not built, so nothing is removed, and the
  // repeat counts here are an upper bound.
  'verification-exclusion',
  // Tracebacks from the user's own scripts decay to 0.3 rather than 1.0.
  'user-script-decay',
  // v1 winsorises per-bundle call counts at the population p90. The statistics
  // are computed and reported below, but nothing is capped: the numerator is
  // not tracked per bundle, so there is nothing to pull down. This one leans
  // the other way from the three above — an unbounded heavy bundle raises W,
  // which lowers the score. 35 of 357 bundles here sit above a p90 of 26.
  'winsorisation',
] as const

/**
 * Which way each omitted term moves the score it was left out of.
 *
 * Three are positive numerator terms: leaving them out makes W smaller and the
 * score higher. Winsorisation is the reverse -- nothing caps a heavy bundle, so
 * W runs high and the score low. Both directions in one axis is why a total
 * containing it can only be called `mixed`.
 */
export type OmittedTermName = (typeof OMITTED_TERMS)[number]

/**
 * Keyed by the union rather than by `string`, so adding a term to
 * `OMITTED_TERMS` without stating its direction fails to compile. A term with
 * no direction is exactly what V-24 exists to refuse, and catching it here is
 * cheaper than catching it in a payload.
 */
export const OMITTED_TERM_LEANINGS: Readonly<Record<OmittedTermName, Leaning>> = {
  // v1 §5 lists this under the additions: `+ 0.5 * a call that succeeded and
  // contributed nothing`. Leaving an addition out makes W smaller and the score
  // higher.
  'unused-success': 'high',
  // v1 §5 lists both of these under `# 除外` -- they *subtract* from the
  // numerator. Leaving a subtraction out leaves W too large and the score too
  // low, the same direction as winsorisation. They were marked `high`, which
  // contradicted this file's own note that the repeat counts are an upper
  // bound, two paragraphs above.
  'verification-exclusion': 'low',
  'user-script-decay': 'low',
  winsorisation: 'low',
}

export interface Winsorised {
  /**
   * Bundles that made at least one tool call.
   *
   * Not the same as the denominator: 357 here against 427 bundles, because a
   * bundle where someone asked a question and got an answer made no calls. The
   * denominator is bundles, per v1, so those 70 stay in it and correctly pull W
   * down — they were work with no wasted motion in them.
   */
  readonly bundles: number
  /** The population p90 of per-bundle call counts. */
  readonly cap: number
  /** Bundles above it. Reported; nothing is actually capped. */
  readonly capped: number
}

/**
 * The p90 of per-bundle call counts, and how many bundles exceed it.
 *
 * v1 winsorises rather than trims: a bundle where 400 calls happened is real
 * work and dropping it would shrink the denominator, which raises W. Pulling it
 * to the p90 keeps the bundle and bounds its influence.
 */
export function winsorise(callsPerBundle: Readonly<Record<string, number>>): Winsorised {
  const counts = Object.values(callsPerBundle).sort((a, b) => a - b)
  if (counts.length === 0) return { bundles: 0, cap: 0, capped: 0 }
  // Nearest-rank: ceil(0.9n) - 1. `floor(0.9n)` returns the maximum for n = 10
  // and every n where 0.9n lands on an integer, which makes `capped` zero by
  // construction — a cap nothing can exceed. It read plausibly on 357 bundles
  // and only showed on a ten-element case.
  const at = Math.min(counts.length - 1, Math.max(0, Math.ceil(counts.length * 0.9) - 1))
  const cap = counts[at] ?? 0
  return { bundles: counts.length, cap, capped: counts.filter((c) => c > cap).length }
}

export interface WastedMotion {
  /** The weighted numerator. */
  readonly numerator: number
  readonly bundles: number
  /** Wasted moves per bundle. */
  readonly w: number
  readonly rIn: number
  /** 0..100, or null when the axis has no rate to score. */
  readonly score: number | null
  readonly terms: Readonly<Record<string, number>>
  readonly winsorised: Winsorised
  readonly omitted: readonly string[]
}

export function wastedMotion(counts: WastedCounts, rIn: number, bundleCount: number): WastedMotion {
  const terms = {
    failures: counts.failures * WEIGHT_FAILURE,
    writeRepeats: counts.writeRepeats * WEIGHT_WRITE_REPEAT,
    investigationRepeats: counts.investigationRepeats * WEIGHT_INVESTIGATION_REPEAT,
    timedOut: counts.timedOut * WEIGHT_TIMEOUT,
    largeOutput: counts.largeOutput * WEIGHT_LARGE_OUTPUT,
  }
  const numerator = Object.values(terms).reduce((a, b) => a + b, 0)
  const winsorised = winsorise(counts.callsPerBundle)
  const bundles = bundleCount

  if (bundles <= 0) {
    return { numerator, bundles, w: 0, rIn, score: null, terms, winsorised, omitted: [...OMITTED_TERMS] }
  }

  const w = numerator / bundles
  const score = 100 * (1 - WEIGHT_W * Math.min(1, w / W_REF) - WEIGHT_R_IN * rIn)

  return {
    numerator,
    bundles,
    w,
    rIn,
    // Clamped at zero. The formula can go negative when both terms saturate,
    // and a negative score on a 0..100 scale reads as a bug rather than as a
    // very bad result.
    score: Math.max(0, score),
    terms,
    winsorised,
    omitted: [...OMITTED_TERMS],
  }
}
