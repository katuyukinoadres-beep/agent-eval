/**
 * Comparing this window with the last one.
 *
 * This is the thing the product is for, and it is also the easiest place to
 * report a change that did not happen. A delta between two numbers is only a
 * measurement of the environment when everything else about how they were made
 * is the same: the same axes, the same formulas, the same counting basis. When
 * any of those differ, the delta measures the difference in method, and saying
 * so is the whole job.
 *
 * The strictest rule here is the one about naming a change. A delta may only be
 * called an improvement or a degradation when its interval excludes zero *and*
 * its size clears a floor. The floor is not caution for its own sake: on the
 * data v2 was fitted to, one indicator moved +0.834pt with an interval of
 * [+0.091, +1.636] over one pair of windows and -0.083pt over another pair of
 * the same data cut differently. Significance alone would have printed
 * "improved" for a sign that flips with the window boundary.
 */

import type { AxisKey } from '../payload/types.js'

/** Below this many comparable axes, no delta at all. */
export const MIN_COMPARABLE_AXES = 4

/** Points below which a difference is not called a change, however significant. */
export const MDE_FLOOR = 1.0

export type ComparisonBasis = 'identical' | 'intersection'

export type ComparisonRefusal =
  | 'no-previous-window'
  | 'count-basis-changed'
  | 'too-few-comparable-axes'

/**
 * Why a delta cannot be called an improvement or a degradation.
 *
 * Separate from the refusals above: the delta exists and is shown, but nothing
 * may be claimed about its direction.
 */
export type SignificanceGap = 'no-interval' | 'interval-crosses-zero' | 'below-floor'

export interface AxisSnapshotView {
  readonly state: 'measured' | 'not-applicable' | 'not-implemented'
  readonly scoreE4: number | null
  readonly formulaFingerprint: string | null
  /** True when the axis had no interval, which forbids naming the direction. */
  readonly belowMinDenominator: boolean
}

export interface WindowView {
  readonly axes: Readonly<Record<string, AxisSnapshotView>>
  readonly countBasisDigest: string
  readonly keyFingerprint: string
  /** False when this window's composite may not supply a `compositeThen`. */
  readonly compositeComparable: boolean
  readonly compositeE4: number | null
}

export interface AxisDelta {
  readonly axis: AxisKey
  readonly then: number
  readonly now: number
  readonly delta: number
  /** Null until a bootstrap runs. Its absence is itself a significance gap. */
  readonly interval: readonly [number, number] | null
  readonly significant: boolean
  readonly gap: SignificanceGap | null
}

export interface Comparison {
  readonly basis: ComparisonBasis
  readonly axes: readonly AxisKey[]
  readonly perAxis: readonly AxisDelta[]
  readonly compositeNow: number | null
  /** Null whenever either window may not supply one. */
  readonly compositeThen: number | null
  readonly delta: number | null
  /**
   * Axes dropped from the comparison because their formula changed.
   *
   * Named, because a definition change and an environment change look
   * identical in a score and only this tells them apart.
   */
  readonly excludedByFingerprint: readonly AxisKey[]
  /** True when the key changed, so no signature set may be intersected. */
  readonly signatureSetsUsable: boolean
  readonly refused: ComparisonRefusal | null
}

const REFUSED = (refused: ComparisonRefusal): Comparison => ({
  basis: 'identical',
  axes: [],
  perAxis: [],
  compositeNow: null,
  compositeThen: null,
  delta: null,
  excludedByFingerprint: [],
  signatureSetsUsable: false,
  refused,
})

/**
 * Whether a delta may be called a change.
 *
 * Both conditions, never one. An interval that excludes zero says the
 * difference is unlikely to be noise; the floor says it is large enough to act
 * on. The data v2 was fitted to has a case that passes the first and fails the
 * second, and whose sign reverses when the window boundary moves.
 */
export function significanceOf(
  delta: number,
  interval: readonly [number, number] | null,
): { readonly significant: boolean; readonly gap: SignificanceGap | null } {
  if (interval === null) return { significant: false, gap: 'no-interval' }
  const [lo, hi] = interval
  if (lo <= 0 && hi >= 0) return { significant: false, gap: 'interval-crosses-zero' }
  if (Math.abs(delta) < MDE_FLOOR) return { significant: false, gap: 'below-floor' }
  return { significant: true, gap: null }
}

export function compare(now: WindowView, then: WindowView | null): Comparison {
  if (then === null) return REFUSED('no-previous-window')

  // A different counting basis means the two windows counted different things.
  // No axis survives that, so the refusal is whole rather than per axis.
  if (now.countBasisDigest !== then.countBasisDigest) return REFUSED('count-basis-changed')

  const measuredNow = Object.keys(now.axes).filter((k) => now.axes[k]?.state === 'measured')
  const measuredThen = Object.keys(then.axes).filter((k) => then.axes[k]?.state === 'measured')

  const excludedByFingerprint: AxisKey[] = []
  const comparable: AxisKey[] = []
  for (const k of measuredNow) {
    if (!measuredThen.includes(k)) continue
    const a = now.axes[k]
    const b = then.axes[k]
    if (a === undefined || b === undefined) continue
    if (a.formulaFingerprint !== b.formulaFingerprint) {
      excludedByFingerprint.push(k as AxisKey)
      continue
    }
    comparable.push(k as AxisKey)
  }

  if (comparable.length < MIN_COMPARABLE_AXES) {
    return { ...REFUSED('too-few-comparable-axes'), excludedByFingerprint }
  }

  const perAxis: AxisDelta[] = comparable
    .map((k): AxisDelta => {
      const a = now.axes[k]
      const b = then.axes[k]
      const nowScore = (a?.scoreE4 ?? 0) / 10_000
      const thenScore = (b?.scoreE4 ?? 0) / 10_000
      const delta = Math.round((nowScore - thenScore) * 100) / 100
      // No bootstrap yet, so no interval. That is a significance gap in its own
      // right rather than a licence to call the direction.
      const interval = null
      const { significant, gap } = significanceOf(delta, interval)
      return { axis: k, then: thenScore, now: nowScore, delta, interval, significant, gap }
    })
    .sort((x, y) => (x.axis < y.axis ? -1 : 1))

  // A composite over one axis set and a composite over another are different
  // quantities, so both windows must supply one *and* have measured the same
  // axes. The flag alone is not enough: it says a figure exists, not that the
  // two figures are the same quantity.
  const sameAxisSet =
    measuredNow.length === measuredThen.length && measuredNow.every((k) => measuredThen.includes(k))
  const compositeThen =
    sameAxisSet && now.compositeComparable && then.compositeComparable && then.compositeE4 !== null
      ? then.compositeE4 / 10_000
      : null
  const compositeNow = now.compositeE4 === null ? null : now.compositeE4 / 10_000

  return {
    // Decided by the sets, not by their sizes. Two windows measuring four axes
    // each, one of them a different four, are not the same basis -- and
    // `identical` is the word a reader takes to mean nothing moved but the
    // environment.
    basis: sameAxisSet && excludedByFingerprint.length === 0 ? 'identical' : 'intersection',
    axes: comparable.sort((a, b) => (a < b ? -1 : 1)),
    perAxis,
    compositeNow,
    compositeThen,
    delta:
      compositeThen === null || compositeNow === null
        ? null
        : Math.round((compositeNow - compositeThen) * 100) / 100,
    excludedByFingerprint: excludedByFingerprint.sort((a, b) => (a < b ? -1 : 1)),
    // The key decides whether MAC sets mean the same thing. When it changed,
    // an intersection would be empty, and an empty intersection reads as "no
    // failure recurred" -- the flattering direction.
    signatureSetsUsable: now.keyFingerprint === then.keyFingerprint,
    refused: null,
  }
}
