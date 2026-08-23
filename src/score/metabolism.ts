/**
 * Axis 5 — whether the fixed context tax paid on every turn buys assets that
 * are actually used.
 *
 * Two of v1's choices here are worth keeping in front of the code, because both
 * came from an attack that worked on the version before.
 *
 * The tax is measured in tokens actually paid, not in characters of
 * instructions. Measured statically, writing "read docs/context.md first" in
 * CLAUDE.md and moving the body there makes the tax vanish while the cost stays.
 * Tokens do not care which route the context took.
 *
 * The asset set comes from what was listed, not from what is on disk. On a disk
 * count, moving a skill to a neighbouring directory removes it from the
 * denominator along with its unfired status, so hiding an asset and tidying one
 * away score the same. A skill that is not listed was not loaded, so it is
 * rightly out of both.
 */

/** Below this, the tax costs nothing. */
export const TRAPEZOID_FLOOR_TOKENS = 40_000
/** Above this, the deduction stops growing. */
export const TRAPEZOID_CEILING_TOKENS = 120_000
/** Points lost per step above the floor. */
export const TRAPEZOID_STEP_TOKENS = 20_000
export const TRAPEZOID_STEP_PENALTY = 8
export const TRAPEZOID_MIN_SCORE = 20

/** Firing counts and what each is worth. v1's steps, not interpolated. */
export const FIRING_WEIGHTS = [
  { atLeast: 5, weight: 1.0 },
  { atLeast: 2, weight: 0.7 },
  { atLeast: 1, weight: 0.3 },
  { atLeast: 0, weight: 0.0 },
] as const

/** Above this share of listing text sitting unfired, ten points go. */
export const DEAD_WEIGHT_THRESHOLD = 0.3
export const DEAD_WEIGHT_PENALTY = 10

export type MetabolismOmission = 'static-defects' | 'dead-weight-descriptions'

/**
 * What is not computed, and which way each moves the score.
 *
 * Both are deductions, so leaving them out makes this axis read **high**.
 */
export const METABOLISM_OMISSION_LEANINGS: Readonly<Record<MetabolismOmission, 'high' | 'low'>> = {
  // Needs SKILL.md line counts, description lengths and reference nesting from
  // disk. v1 bounds it at 15 points.
  'static-defects': 'high',
  // Needs each skill's description length out of the listing text. The listing
  // gives names and a total; splitting the total per name means parsing prose,
  // and a parser fitted to today's formatting is a number that changes when the
  // formatting does.
  'dead-weight-descriptions': 'high',
}

export const firingWeight = (count: number): number => {
  for (const step of FIRING_WEIGHTS) {
    if (count >= step.atLeast) return step.weight
  }
  return 0
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

/**
 * The trapezoid. No deduction below the floor, and none for being light.
 *
 * v1 removed the thin-side penalty deliberately: the claim that sparse
 * instructions cost quality is not established, and a study of 401 repositories
 * found no evidence that rules improve model performance. A deduction worth 60
 * points cannot rest on an intuition.
 */
export function trapezoid(fc: number): number {
  if (fc <= TRAPEZOID_FLOOR_TOKENS) return 100
  if (fc > TRAPEZOID_CEILING_TOKENS) return TRAPEZOID_MIN_SCORE
  const steps = (fc - TRAPEZOID_FLOOR_TOKENS) / TRAPEZOID_STEP_TOKENS
  return Math.max(TRAPEZOID_MIN_SCORE, 100 - TRAPEZOID_STEP_PENALTY * steps)
}

export interface MetabolismInputs {
  readonly effectiveInputPerCall: readonly number[]
  readonly skillsListed: readonly string[]
  readonly skillFirings: Readonly<Record<string, number>>
  readonly hookFirings: Readonly<Record<string, number>>
  readonly mcpFirings: Readonly<Record<string, number>>
  /** MCP servers enabled by configuration, fired or not. */
  readonly mcpServersDefined: number
  readonly listingTruncated: boolean
}

export interface Metabolism {
  /** Median effective input tokens per call, or null when nothing carried usage. */
  readonly fc: number | null
  readonly trapezoidScore: number | null
  /** Assets that were loaded: listed skills, fired hooks, configured MCP servers. */
  readonly assets: number
  /** Utilisation, or null when there are no assets to divide by. */
  readonly u: number | null
  readonly firedAssets: number
  readonly score: number | null
  /**
   * True when the tax sits past the ceiling.
   *
   * Worth carrying separately: an axis pinned to its floor cannot move, and a
   * score that cannot move is useless as a time series -- which is what this
   * product is for. Measured here at 415k per call against a 120k ceiling, so
   * the trapezoid reads 20 whatever the environment does next.
   */
  readonly saturated: boolean
  readonly omitted: readonly MetabolismOmission[]
}

/**
 * Utilisation over the whole asset set.
 *
 * v1 required three assets before computing this. v2 §12.8 removed that floor,
 * because the multiplier was left at 1.0 below it: two unfired assets scored
 * 1.00 where three unfired assets scored 0.50, so deleting one asset doubled the
 * axis. Filling a gap with the best possible value is the shape this product
 * exists to refuse, and it was in the spec.
 *
 * Zero assets is different, and still special: nothing owned cannot be used, so
 * the multiplier is not applied at all rather than set to its worst value.
 */
export function metabolism(inputs: MetabolismInputs): Metabolism {
  const fc = median(inputs.effectiveInputPerCall)
  const trapezoidScore = fc === null ? null : trapezoid(fc)

  const firings = new Map<string, number>()
  for (const name of inputs.skillsListed) firings.set(`skill:${name}`, inputs.skillFirings[name] ?? 0)
  for (const [name, n] of Object.entries(inputs.hookFirings)) firings.set(`hook:${name}`, n)
  for (const [name, n] of Object.entries(inputs.mcpFirings)) firings.set(`mcp:${name}`, n)
  // Configured servers that never fired are assets too -- they are the ones the
  // axis is most interested in.
  const unfiredServers = Math.max(0, inputs.mcpServersDefined - Object.keys(inputs.mcpFirings).length)
  for (let i = 0; i < unfiredServers; i += 1) firings.set(`mcp:unfired-${i}`, 0)

  const assets = firings.size
  const weightSum = [...firings.values()].reduce((sum, n) => sum + firingWeight(n), 0)
  const u = assets === 0 ? null : weightSum / assets
  const firedAssets = [...firings.values()].filter((n) => n > 0).length

  const score =
    trapezoidScore === null
      ? null
      : Math.max(0, Math.min(100, u === null ? trapezoidScore : trapezoidScore * (0.5 + 0.5 * u)))

  return {
    fc,
    trapezoidScore,
    assets,
    u,
    firedAssets,
    score,
    saturated: fc !== null && fc > TRAPEZOID_CEILING_TOKENS,
    omitted: ['static-defects', 'dead-weight-descriptions'],
  }
}
