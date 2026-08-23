/**
 * One number out of six, and what to say when the six are not there.
 *
 * The weight table existed from the start; the formula that consumes it did
 * not, which left the whole of S12 unable to compose anything. This is v2 §12,
 * settled 2026-08-20.
 *
 * Three principles govern it, and the second and third are the ones that are
 * easy to get wrong:
 *
 *   P-A  A missing axis is neither zero nor its best possible value. Scoring it
 *        zero punishes an environment for what it cannot measure; filling it
 *        with the best value makes the unmeasurable environment win, which is
 *        the shape this product was built to refuse.
 *   P-B  "Nothing happened" and "cannot be measured" are different. Folding
 *        them together deletes the best possible environment — the one with no
 *        rework at all — from the total.
 *   P-C  A comparison only holds over the same set of axes. The difference
 *        between a total from four axes and one from six measures the change in
 *        the axis set, not the change in the environment.
 */

import type { AxisKey } from '../payload/types.js'

/**
 * Nominal weights, v2 §2.1.
 *
 * v1's 15/14/14/14/10/13 renormalised over the 80 points left after axes 7 and
 * 8 were dropped from the first release. They sum to 100.
 */
export const AXIS_WEIGHTS = {
  firstPassLanding: 18.75,
  wastedMotion: 17.5,
  selfVerification: 17.5,
  artifactUptake: 17.5,
  environmentMetabolism: 12.5,
  recurrencePrevention: 16.25,
} as const

export type ScoredAxisKey = keyof typeof AXIS_WEIGHTS

export const SCORED_AXIS_KEYS = Object.keys(AXIS_WEIGHTS) as readonly ScoredAxisKey[]

/** Outcome is axes 1-4 (nominal 71.25); design is axes 5-6 (nominal 28.75). */
export const OUTCOME_AXES: readonly ScoredAxisKey[] = [
  'firstPassLanding',
  'wastedMotion',
  'selfVerification',
  'artifactUptake',
]
export const DESIGN_AXES: readonly ScoredAxisKey[] = ['environmentMetabolism', 'recurrencePrevention']

/** Outcome needs 3 of its 4; design needs both of its 2. */
export const MIN_OUTCOME_AXES = 3

/**
 * More than this many missing axes and no total is produced.
 *
 * v1 allowed 3 of 8 — 37.5%. Holding that ratio over 6 axes gives 2.25, so 2.
 * At three missing, a window can arise where 39.47% of the total rides on one
 * axis; at two, the worst case leaves 63.75 nominal weight and no axis exceeds
 * a 30% share.
 */
export const MAX_MISSING_AXES = 2

/** The nominal weight that must survive for a total to mean anything. */
export const MIN_NOMINAL_WEIGHT_SUM = 63.75

export const TIERS = [
  { min: 85, tier: 'S' },
  { min: 70, tier: 'A' },
  { min: 55, tier: 'B' },
  { min: 40, tier: 'C' },
  { min: -Infinity, tier: 'D' },
] as const

export type Tier = (typeof TIERS)[number]['tier']

/**
 * Why no total was produced.
 *
 * The first three are the exact strings `GateReason` already uses. v2's first
 * draft coined `parse_rate` / `roots_incomplete` / `active_days` for the same
 * three conditions; that is the shape AB-88 was about — two documents naming
 * one thing differently and a receiver silently failing to match — so the spec
 * moved to the implementation's words. `too-many-missing-axes` is the only new
 * one.
 */
export const SUPPRESSED_REASONS = [
  'parse-failure-rate',
  'subagents-not-walked',
  'too-few-active-days',
  'too-many-missing-axes',
] as const

export type SuppressedReason = (typeof SUPPRESSED_REASONS)[number]

/** Which way a missing term moves the score it was left out of. */
export type Leaning = 'high' | 'low'

/**
 * Why a term is missing.
 *
 * `not-implemented` is a property of this build and is the same in every window
 * it produces. `below-minimum` is a property of this window's data and changes
 * as the data does. Reporting both as one would make a version difference look
 * like a change in the environment.
 */
export type OmissionCause = 'not-implemented' | 'below-minimum'

export interface OmittedTerm {
  readonly term: string
  readonly cause: OmissionCause
  readonly leans: Leaning
}

export type CompositeLeaning = Leaning | 'mixed'

export interface AxisInput {
  readonly key: AxisKey
  readonly available: boolean
  readonly score: number | null
  readonly omittedTerms: readonly OmittedTerm[]
}

export interface Composite {
  readonly score: number | null
  readonly tier: Tier | null
  readonly axesUsed: readonly ScoredAxisKey[]
  readonly nominalWeightSum: number
  readonly effectiveWeights: Readonly<Record<string, number>>
  readonly excluded: readonly ScoredAxisKey[]
  readonly suppressedReason: SuppressedReason | null
  readonly leans: CompositeLeaning | null
  readonly outcomeScore: number | null
  readonly designScore: number | null
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function tierOf(score: number): Tier {
  for (const t of TIERS) {
    if (score >= t.min) return t.tier
  }
  return 'D'
}

/**
 * The aggregate direction of everything left out of the scored axes.
 *
 * Both directions present means `mixed`, not whichever weighs more. v2 §12.4b
 * settles this with the case at hand: axis 2 drops three positive numerator
 * terms and one winsorisation, so a total containing it "is mixed, and is
 * neither high nor low — saying that it cannot be told is the correct state,
 * rather than pretending to a precision that is not there".
 */
export function aggregateLeaning(axes: readonly AxisInput[]): CompositeLeaning | null {
  let high = false
  let low = false
  for (const axis of axes) {
    for (const term of axis.omittedTerms) {
      if (term.leans === 'high') high = true
      else low = true
    }
  }
  if (high && low) return 'mixed'
  if (high) return 'high'
  if (low) return 'low'
  return null
}

/** A weighted mean over a subset, renormalised to 100. Null when the subset is empty. */
function weightedMean(axes: readonly AxisInput[], within: readonly ScoredAxisKey[]): number | null {
  const members = axes.filter(
    (a): a is AxisInput & { score: number } =>
      a.available && a.score !== null && (within as readonly string[]).includes(a.key),
  )
  if (members.length === 0) return null
  const total = members.reduce((sum, a) => sum + AXIS_WEIGHTS[a.key as ScoredAxisKey], 0)
  if (total <= 0) return null
  const value = members.reduce(
    (sum, a) => sum + AXIS_WEIGHTS[a.key as ScoredAxisKey] * a.score,
    0,
  )
  return round2(value / total)
}

export interface CompositeInputs {
  readonly axes: readonly AxisInput[]
  /**
   * A gate condition that already withheld the total, if one fired.
   *
   * Passed in rather than recomputed: the gate is the authority on its own
   * three conditions, and a second implementation of them here would be a
   * second thing to keep in step.
   */
  readonly gateReason: SuppressedReason | null
}

export function composite(inputs: CompositeInputs): Composite {
  const scored = inputs.axes.filter(
    (a) => a.available && a.score !== null && (SCORED_AXIS_KEYS as readonly string[]).includes(a.key),
  )
  const axesUsed = scored.map((a) => a.key as ScoredAxisKey)
  const excluded = SCORED_AXIS_KEYS.filter((k) => !axesUsed.includes(k))

  const nominalWeightSum = round2(axesUsed.reduce((sum, k) => sum + AXIS_WEIGHTS[k], 0))
  const leans = aggregateLeaning(scored)

  const suppressed: SuppressedReason | null =
    inputs.gateReason ?? (excluded.length > MAX_MISSING_AXES ? 'too-many-missing-axes' : null)

  if (suppressed !== null || axesUsed.length === 0) {
    return {
      score: null,
      tier: null,
      axesUsed,
      nominalWeightSum,
      // Empty rather than a set that does not sum to 100. V-18 requires the
      // sum, and an unscored submission has no weights to report.
      effectiveWeights: {},
      excluded,
      suppressedReason: suppressed ?? 'too-many-missing-axes',
      leans,
      outcomeScore: null,
      designScore: null,
    }
  }

  const effectiveWeights: Record<string, number> = {}
  for (const k of axesUsed) effectiveWeights[k] = round2((100 * AXIS_WEIGHTS[k]) / nominalWeightSum)

  const raw = scored.reduce(
    (sum, a) => sum + AXIS_WEIGHTS[a.key as ScoredAxisKey] * (a.score ?? 0),
    0,
  )
  const score = round2(raw / nominalWeightSum)

  // Outcome needs three of its four; design needs both of its two. A single
  // design axis is not "the design score" -- it is one axis wearing that name,
  // which is the same objection that keeps a deduction-style axis with a
  // missing term out of the total.
  const outcomeCount = axesUsed.filter((k) => OUTCOME_AXES.includes(k)).length
  const designCount = axesUsed.filter((k) => DESIGN_AXES.includes(k)).length

  return {
    score,
    tier: tierOf(score),
    axesUsed,
    nominalWeightSum,
    effectiveWeights,
    excluded,
    suppressedReason: null,
    leans,
    outcomeScore: outcomeCount >= MIN_OUTCOME_AXES ? weightedMean(scored, OUTCOME_AXES) : null,
    designScore: designCount === DESIGN_AXES.length ? weightedMean(scored, DESIGN_AXES) : null,
  }
}
