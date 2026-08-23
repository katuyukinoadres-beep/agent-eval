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

import type { Leaning } from './composite.js'

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

/**
 * `static-defects` is gone: v2 §3.5 removes D from this axis entirely and moves
 * it to the safety check, which is not scored (C-20). Declaring an omission for
 * a term the axis no longer has overstates what is missing, and it was one of
 * the two deductions that made the whole axis unscorable.
 */
export type MetabolismOmission = 'dead-weight-descriptions' | 'listing-truncated'

/** What is not computed, and which way each moves the score. */
export const METABOLISM_OMISSION_LEANINGS: Readonly<Record<MetabolismOmission, Leaning>> = {
  // Wd, a deduction. Needs each skill's description length out of the listing
  // text; the listing gives names and a total, and splitting the total per name
  // means parsing prose. A parser fitted to today's formatting is a number that
  // changes when the formatting does. Leaving a deduction out reads **high**.
  'dead-weight-descriptions': 'high',
  // The skill listing hit the character cap, so the asset set is a lower bound.
  // A short denominator makes U larger, which makes the multiplier larger.
  'listing-truncated': 'high',
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
  /**
   * The largest context any one call in a task bundle operated at.
   *
   * Per bundle, as v1 §8 and v2 §3.5 both say (`median(1タスク束あたり…)`), and
   * a context *size*, which is the unit the trapezoid's 40k and 120k thresholds
   * are in. v1's own two lines disagree -- the first says per task bundle, the
   * second writes `median(usage.input_tokens + cache_read_input_tokens)`, which
   * is per assistant message -- so the thresholds are what disambiguate them.
   *
   * Measured here, all four readings:
   *
   *   per assistant message, with cache   123,276   trapezoid 20.00
   *   per bundle, summed, with cache    5,594,668   trapezoid 20.00
   *   per bundle, peak, with cache        476,013   trapezoid 20.00
   *   per bundle, summed, without cache        30   trapezoid 100.00
   *
   * Summing per bundle counts the same cached context once per call inside the
   * bundle, and no environment will ever have a bundle summing under 120,000 --
   * that reading returns 20 for everyone forever, which is a metric that
   * measures nothing. The peak is the one figure that is both per bundle and in
   * the units the thresholds are in.
   */
  readonly peakInputPerBundle: readonly number[]
  /** The same summed rather than peaked. Reported, not scored. */
  readonly effectiveInputPerBundle: readonly number[]
  /**
   * The same per bundle without cache reads.
   *
   * v2 §3.5(b) requires both and forbids scoring on one alone: cache reads are
   * 94.7% of all tokens measured, so the with-cache figure mostly measures how
   * long a session ran -- the exact thing v1 §15 rejected as a metric.
   */
  readonly inputPerBundleWithoutCache: readonly number[]
  readonly skillsListed: readonly string[]
  readonly skillFirings: Readonly<Record<string, number>>
  readonly hookFirings: Readonly<Record<string, number>>
  readonly mcpFirings: Readonly<Record<string, number>>
  /** MCP servers enabled by configuration, fired or not. */
  readonly mcpServersDefined: number
  /**
   * Hooks registered in the merged settings, fired or not.
   *
   * The denominator used to be the fired hooks alone -- its own numerator's
   * support set -- so an unfired hook cost nothing and sixty-one hooks with no
   * firings were indistinguishable from none at all. That reverses the guard
   * this axis exists to be.
   */
  readonly hooksDefined: number
  readonly listingTruncated: boolean
}

/**
 * Whether this axis may be scored at all.
 *
 * Axis 5 is a deduction form: the trapezoid takes points off 100, and Wd and D
 * take more. Dropping a deduction can only raise the result, and redistributing
 * its coefficient makes another deduction bite harder than it should. v2 §12.5
 * allows neither, and rules that a deduction-style axis with any dropped term
 * is `not_applicable` and leaves the total.
 *
 * This was implemented as `available` first. The score it produced -- 45.0 --
 * was the same name for a different quantity, and it went into a composite.
 */
export const SCORABLE_WITHOUT_OMISSIONS = true

export interface Metabolism {
  /** Median effective input tokens per call, or null when nothing carried usage. */
  readonly fc: number | null
  readonly trapezoidScore: number | null
  /** Assets registered: listed skills, registered hooks, configured MCP servers. */
  readonly assets: number
  /** The second context-tax figure. Reported beside `fc`, never scored alone. */
  readonly fcWithoutCache: number | null
  /** The summed reading, reported so the choice between them stays visible. */
  readonly fcSummed: number | null
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
  /**
   * False whenever a deduction was dropped, which is always today.
   *
   * The score is still computed and still recorded -- a later window needs the
   * raw figures -- but it must not be scored or composed.
   */
  readonly scorable: boolean
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
  const fc = median(inputs.peakInputPerBundle)
  const fcSummed = median(inputs.effectiveInputPerBundle)
  const fcWithoutCache = median(inputs.inputPerBundleWithoutCache)
  const trapezoidScore = fc === null ? null : trapezoid(fc)

  const firings = new Map<string, number>()
  for (const name of inputs.skillsListed) firings.set(`skill:${name}`, inputs.skillFirings[name] ?? 0)
  for (const [name, n] of Object.entries(inputs.hookFirings)) firings.set(`hook:${name}`, n)
  for (const [name, n] of Object.entries(inputs.mcpFirings)) firings.set(`mcp:${name}`, n)
  // Registered assets that never fired are assets too -- they are the ones the
  // axis is most interested in. Hooks were padded nowhere, so the hook part of
  // the denominator was the set of hooks that fired.
  const unfiredServers = Math.max(0, inputs.mcpServersDefined - Object.keys(inputs.mcpFirings).length)
  for (let i = 0; i < unfiredServers; i += 1) firings.set(`mcp:unfired-${i}`, 0)
  const unfiredHooks = Math.max(0, inputs.hooksDefined - Object.keys(inputs.hookFirings).length)
  for (let i = 0; i < unfiredHooks; i += 1) firings.set(`hook:unfired-${i}`, 0)

  const assets = firings.size
  const weightSum = [...firings.values()].reduce((sum, n) => sum + firingWeight(n), 0)
  const u = assets === 0 ? null : weightSum / assets
  const firedAssets = [...firings.values()].filter((n) => n > 0).length

  const score =
    trapezoidScore === null
      ? null
      : Math.max(0, Math.min(100, u === null ? trapezoidScore : trapezoidScore * (0.5 + 0.5 * u)))

  const omitted: MetabolismOmission[] = ['dead-weight-descriptions']
  // A truncated listing understates the asset set, so U runs high with nothing
  // to show it. Recorded as an omission rather than left as a flag nobody read.
  if (inputs.listingTruncated) omitted.push('listing-truncated')

  return {
    fc,
    fcWithoutCache,
    fcSummed,
    trapezoidScore,
    assets,
    u,
    firedAssets,
    score,
    saturated: fc !== null && fc > TRAPEZOID_CEILING_TOKENS,
    omitted,
    // Wd is a deduction and it is not computed. Dropping a deduction can only
    // raise the result, and v2 §12.5(b) refuses a deduction-form axis with any
    // dropped term rather than renormalising it.
    scorable: false,
  }
}
