/**
 * Axis 3 — whether the agent checks its own work before handing it back, and
 * whether it can recover from a failure without calling a person.
 *
 * It carries the heaviest weight of the agent-side axes because it is one of
 * the few behaviours with an effect size behind it: explicit self-verification
 * moves success rates by 13 to 87 percent, and self-correction by 1.5 to 4
 * times.
 *
 * Two of v1's decisions here were reversals, and both matter more than the
 * formula.
 *
 * There is no command dictionary. Fitted to one machine, most Bash calls were
 * python invocations, so whatever piece of work came after an edit — sending
 * mail, saving to a vault — counted as verification of it at full weight. And
 * on a machine in another language or another line of work, the dictionary
 * matches nothing and the term is permanently zero. A dictionary fails in both
 * directions.
 *
 * There is no cap for having no executions. Minutes, articles and draft emails
 * have no one-command check, and a cap would hold anyone doing secretarial or
 * writing work at a C forever however carefully they worked.
 */

/** v1's weights. They sum to 1. */
export const WEIGHT_VERIFIED = 0.6
export const WEIGHT_SELF_REPAIR = 0.3
export const WEIGHT_RESOLVED = 0.1

/** Below this many edit intervals the axis has nothing to divide by. */
export const MIN_INTERVALS = 25

/**
 * v1 deducts five points when TodoWrite was never used. v2 §9.2 suspends the
 * deduction pending a decision and keeps the flag as a breakdown line, so the
 * penalty is zero here and the flag is still measured and reported.
 *
 * Left as a named constant rather than deleted: the suspension is a decision
 * that can be reversed, and a reversal should be one number rather than a
 * re-derivation.
 */
export const TODO_PENALTY = 0
/** What v1 deducted, kept so the suspended rule stays legible. */
export const TODO_PENALTY_V1 = 5

/** Where the effectiveness multiplier saturates. */
export const G_TARGET = 0.2
export const V_EFF_FLOOR = 0.7

export type VerificationOmission =
  | 'axis3-command-history'
  | 'axis3-effectiveness'
  | 'axis3-consecutive-read-rounding'
  | 'axis3-no-failures'
  | 'axis3-todo-penalty-suspended'

/**
 * What is not computed, and which way each moves the score.
 *
 * `axis3-command-history` is condition (ii): an execution counts as
 * verification only if that command has exited non-zero at least once in a
 * past window, so a decoration that always passes does not count. It needs a
 * previous window's command set, which a first window does not have. v2 makes
 * this explicitly a first-window omission. Dropping a condition that
 * verification must satisfy makes verification easier to earn, so V reads
 * **high**.
 *
 * `axis3-effectiveness` is G, the share of verifications that actually caught
 * something. The multiplier it feeds runs from 0.7 to 1.0, and G is not
 * measured. This used to leave the multiplier at 1.0 — the top of the range —
 * which asserts that every verification caught something, on no evidence, while
 * the omission list next to it said the score read high. Taking the **floor**
 * asserts the opposite and is the end this codebase is built to err towards, so
 * the score now reads **low** by up to 30% of the V term.
 *
 * `axis3-consecutive-read-rounding` collapses three or more consecutive reads
 * whose results are not used into one. Not implemented, so a run of reads
 * counts as one verification anyway under the one-per-interval rule — which
 * makes this one a no-op today rather than a bias, but it is listed because it
 * stops being a no-op the moment the rule changes.
 */
export const VERIFICATION_OMISSION_LEANINGS: Readonly<Record<VerificationOmission, 'high' | 'low'>> = {
  'axis3-command-history': 'high',
  // Flipped when the multiplier moved from its ceiling to its floor.
  'axis3-effectiveness': 'low',
  'axis3-consecutive-read-rounding': 'high',
  // Both repair terms drop and V renormalises to the whole, so the score is
  // 100*V_eff. V is usually the smallest of the three, so this reads low.
  'axis3-no-failures': 'low',
  // v1 deducted five points; v2 suspends it. Not deducting reads high.
  'axis3-todo-penalty-suspended': 'high',
}

export interface VerificationInputs {
  readonly intervals: number
  readonly verifiedIntervals: number
  readonly selfRepaired: number
  readonly humanRescued: number
  readonly unresolved: number
  /** Cleared, but outside the repair rate's numerator. Denominator only. */
  readonly repairedNotCounted: number
  readonly todoWriteUsed: boolean
  readonly firstWindow: boolean
}

export interface Verification {
  /** Share of edit intervals a verification touched. */
  readonly v: number | null
  /** Share of failures the agent cleared itself. */
  readonly selfRepairRate: number | null
  /** Share of failures nothing cleared. The only third that is deducted for. */
  readonly unresolvedRate: number | null
  readonly score: number | null
  readonly intervals: number
  readonly failures: number
  readonly omitted: readonly VerificationOmission[]
  readonly unavailable: 'too-few-intervals' | null
}

export function verification(inputs: VerificationInputs): Verification {
  const omitted: VerificationOmission[] = ['axis3-effectiveness', 'axis3-consecutive-read-rounding']
  if (inputs.firstWindow) omitted.unshift('axis3-command-history')
  if (!inputs.todoWriteUsed) omitted.push('axis3-todo-penalty-suspended')

  const failures =
    inputs.selfRepaired + inputs.humanRescued + inputs.unresolved + inputs.repairedNotCounted
  // Both repair terms fall out below when there is nothing to repair, which
  // leaves 100*V_eff -- a different formula from the one the axis declares. It
  // is recorded as an omission rather than applied quietly.
  if (failures === 0) omitted.push('axis3-no-failures')

  if (inputs.intervals < MIN_INTERVALS) {
    return {
      v: null,
      selfRepairRate: null,
      unresolvedRate: null,
      score: null,
      intervals: inputs.intervals,
      failures,
      omitted,
      unavailable: 'too-few-intervals',
    }
  }

  const v = inputs.verifiedIntervals / inputs.intervals
  // G is not computed. The multiplier runs from V_EFF_FLOOR to 1, and this
  // takes the floor: leaving it at 1 asserts that every verification caught
  // something, which is filling a gap with its best value.
  const vEff = v * V_EFF_FLOOR

  // A window with no failures has nothing to repair, and a repair rate of 0
  // would read as never recovering. Both terms fall out of the score in that
  // case rather than being scored at their worst.
  const selfRepairRate = failures === 0 ? null : inputs.selfRepaired / failures
  const unresolvedRate = failures === 0 ? null : inputs.unresolved / failures

  const parts: Array<{ weight: number; value: number }> = [{ weight: WEIGHT_VERIFIED, value: vEff }]
  if (selfRepairRate !== null) parts.push({ weight: WEIGHT_SELF_REPAIR, value: selfRepairRate })
  if (unresolvedRate !== null) parts.push({ weight: WEIGHT_RESOLVED, value: 1 - unresolvedRate })

  // Renormalised over the terms that exist, per the rule for convex-combination
  // axes: the survivors are scaled until they sum to 1.
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
  const raw = parts.reduce((sum, p) => sum + (p.weight / totalWeight) * p.value, 0)

  const penalty = inputs.todoWriteUsed ? 0 : TODO_PENALTY
  return {
    v,
    selfRepairRate,
    unresolvedRate,
    score: Math.max(0, Math.min(100, 100 * raw - penalty)),
    intervals: inputs.intervals,
    failures,
    omitted,
    unavailable: null,
  }
}
