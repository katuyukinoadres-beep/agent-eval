/**
 * Axis 6 — whether the same failure and the same correction are still turning
 * up.
 *
 * The numerator here was replaced once already, and the reason is a good
 * warning about what a plausible formula can hide. The original counted
 * "did a correction get written into a persistent file" — and measured against
 * real data, 1 of 142 negative redirects was followed by a write to a
 * persistent layer inside the same session. 0.7% against a formula calibrated
 * at 0.45: every user would have scored zero on the term, forever, and the
 * number would have looked like a finding about them.
 *
 * So the numerator asks whether the same thing came back instead, which has
 * enough occurrences to divide by and is also what the product actually claims
 * to deliver.
 *
 * On a first window there is no previous set to intersect, so the within-window
 * repeat rate stands in, and the report has to say that the baseline was
 * registered rather than that a score was earned.
 */

/** v1's weights over the two terms. */
export const WEIGHT_RECURRENCE = 0.7
export const WEIGHT_EXPLANATION = 0.3

/** Where the explanation-repetition term saturates. */
export const L3_TARGET = 0.25

export type RecurrenceOmission = 'axis6-explanation-repetition' | 'axis6-external-hook-log'

/**
 * What is not computed, and which way each moves the score.
 *
 * `axis6-explanation-repetition` is L3: how often a person had to say the same
 * thing again. It needs MinHash clustering of human utterances over 3-grams at
 * 0.75, plus a co-occurrence Jaccard at 0.6 for the cases where someone says
 * "that file" instead of naming it. Both are mechanical and neither is built.
 * The term enters as `1 - min(1, L3/0.25)`, so dropping it removes a
 * possible deduction: the score reads **high**.
 *
 * `axis6-external-hook-log` is layer B, which needs a hook log this environment
 * does not keep. v1 puts it as an optional layer on top, so its absence is not
 * a deduction and leaves the score where layer A puts it.
 */
export const RECURRENCE_OMISSION_LEANINGS: Readonly<Record<RecurrenceOmission, 'high' | 'low'>> = {
  'axis6-explanation-repetition': 'high',
  'axis6-external-hook-log': 'high',
}

export interface RecurrenceInputs {
  /** Within-window repeat rate, from axis 2. Stands in for r_cross on a first window. */
  readonly rIn: number
  /** Failures the rate was computed over. Zero means nothing to divide by. */
  readonly errors: number
  /** Whether a previous window's signature set was available. */
  readonly firstWindow: boolean
  /** Whether this environment keeps an external hook log. */
  readonly hasExternalHookLog: boolean
}

export interface Recurrence {
  /** The rate used: r_in on a first window, r_cross afterwards. */
  readonly rate: number | null
  /** Which one it was, so two windows are never compared across the switch. */
  readonly rateKind: 'within-window' | 'cross-window'
  readonly score: number | null
  readonly errors: number
  /**
   * True on a first window, where the report must say a baseline was registered
   * rather than that a score was earned. The two are not the same claim.
   */
  readonly baselineOnly: boolean
  readonly omitted: readonly RecurrenceOmission[]
  readonly unavailable: 'no-failures' | null
}

export function recurrence(inputs: RecurrenceInputs): Recurrence {
  const omitted: RecurrenceOmission[] = ['axis6-explanation-repetition']
  if (!inputs.hasExternalHookLog) omitted.push('axis6-external-hook-log')

  const rateKind = inputs.firstWindow ? 'within-window' : 'cross-window'

  if (inputs.errors === 0) {
    // No failures is not a perfect recurrence score. There is nothing to
    // recur, and reporting 100 would put the best possible mark on the window
    // with the least evidence.
    return {
      rate: null,
      rateKind,
      score: null,
      errors: 0,
      baselineOnly: inputs.firstWindow,
      omitted,
      unavailable: 'no-failures',
    }
  }

  // Renormalised over the surviving term, per the rule for convex-combination
  // axes. With only the recurrence term left, its coefficient becomes 1.
  const score = 100 * (1 - inputs.rIn)

  return {
    rate: inputs.rIn,
    rateKind,
    score: Math.max(0, Math.min(100, score)),
    errors: inputs.errors,
    baselineOnly: inputs.firstWindow,
    omitted,
    unavailable: null,
  }
}
