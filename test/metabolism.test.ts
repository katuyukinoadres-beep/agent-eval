import { describe, expect, it } from 'vitest'
import {
  DEAD_WEIGHT_THRESHOLD,
  METABOLISM_OMISSION_LEANINGS,
  TRAPEZOID_CEILING_TOKENS,
  TRAPEZOID_FLOOR_TOKENS,
  TRAPEZOID_MIN_SCORE,
  firingWeight,
  median,
  metabolism,
  trapezoid,
  type MetabolismInputs,
} from '@/score/metabolism.js'

/**
 * Axis 5, and the two attacks its shape is built around.
 *
 * Measuring the tax in characters lets someone write "read docs/context.md
 * first" and move the body there, at which point the tax vanishes and the cost
 * does not. Counting assets from disk lets someone move a skill to a
 * neighbouring directory, at which point its unfired status leaves the
 * denominator with it. Both are closed by measuring what was actually paid and
 * what was actually loaded.
 */

const base: MetabolismInputs = {
  effectiveInputPerCall: [30_000],
  skillsListed: [],
  skillFirings: {},
  hookFirings: {},
  mcpFirings: {},
  mcpServersDefined: 0,
  listingTruncated: false,
}

const at = (over: Partial<MetabolismInputs>): MetabolismInputs => ({ ...base, ...over })

describe('the trapezoid', () => {
  it('costs nothing below the floor', () => {
    expect(trapezoid(0)).toBe(100)
    expect(trapezoid(TRAPEZOID_FLOOR_TOKENS)).toBe(100)
  })

  it('does not deduct for being light', () => {
    // v1 removed the thin-side penalty on purpose: a study of 401 repositories
    // found no evidence that rules improve model performance, and a deduction
    // worth 60 points cannot rest on an intuition.
    expect(trapezoid(1_000)).toBe(100)
    expect(trapezoid(1_000)).toBe(trapezoid(TRAPEZOID_FLOOR_TOKENS))
  })

  it('falls eight points per twenty thousand above the floor', () => {
    expect(trapezoid(60_000)).toBeCloseTo(92)
    expect(trapezoid(80_000)).toBeCloseTo(84)
  })

  it('stops falling past the ceiling', () => {
    expect(trapezoid(TRAPEZOID_CEILING_TOKENS + 1)).toBe(TRAPEZOID_MIN_SCORE)
    expect(trapezoid(10_000_000)).toBe(TRAPEZOID_MIN_SCORE)
  })

  it('is measured on this machine at 114,635, inside the ceiling by 4.5%', () => {
    // Worth pinning because of how close it is. A slightly different mix of
    // main and subagent calls puts it past 120,000 and on the floor, where the
    // axis stops responding to anything the environment does.
    expect(trapezoid(114_635)).toBeGreaterThan(TRAPEZOID_MIN_SCORE)
    expect(trapezoid(415_437)).toBe(TRAPEZOID_MIN_SCORE)
  })
})

describe('firing weights', () => {
  it('follows v1 steps rather than interpolating', () => {
    expect(firingWeight(0)).toBe(0)
    expect(firingWeight(1)).toBe(0.3)
    expect(firingWeight(2)).toBe(0.7)
    expect(firingWeight(4)).toBe(0.7)
    expect(firingWeight(5)).toBe(1)
    expect(firingWeight(500)).toBe(1)
  })

  it('gives a heavily used asset no more than a moderately used one past five', () => {
    // Nothing is credited for volume. Firing a skill 500 times is not worth
    // more than firing it 5 times.
    expect(firingWeight(5)).toBe(firingWeight(500))
  })
})

describe('utilisation', () => {
  it('counts a listed skill that never fired', () => {
    const r = metabolism(at({ skillsListed: ['a', 'b'], skillFirings: { a: 9 } }))
    expect(r.assets).toBe(2)
    expect(r.firedAssets).toBe(1)
    expect(r.u).toBeCloseTo(0.5)
  })

  it('counts a configured MCP server that never fired', () => {
    // The assets this axis is most interested in are the ones nothing uses.
    const r = metabolism(at({ mcpServersDefined: 4, mcpFirings: { x: 10 } }))
    expect(r.assets).toBe(4)
    expect(r.u).toBeCloseTo(1 / 4)
  })

  it('has no utilisation to report when nothing is owned', () => {
    // Not zero. Nothing owned cannot be used, so the multiplier is not applied
    // rather than set to its worst value.
    const r = metabolism(base)
    expect(r.u).toBeNull()
    expect(r.score).toBe(r.trapezoidScore)
  })

  it('computes it for one or two assets rather than filling the gap', () => {
    // v1 required three. That left the multiplier at 1.0 below the floor, so
    // two unfired assets scored 1.00 where three scored 0.50 -- deleting an
    // asset doubled the axis. Filling a gap with the best possible value is
    // the shape this product refuses, and it was in the spec.
    const two = metabolism(at({ skillsListed: ['a', 'b'] }))
    const three = metabolism(at({ skillsListed: ['a', 'b', 'c'] }))
    expect(two.u).toBe(0)
    expect(three.u).toBe(0)
    expect(two.score).toBeCloseTo(three.score as number)
  })
})

describe('the score', () => {
  it('halves a clean trapezoid when nothing fires', () => {
    const r = metabolism(at({ skillsListed: ['a', 'b', 'c'] }))
    expect(r.score).toBeCloseTo(50)
  })

  it('leaves a clean trapezoid alone when everything fires', () => {
    const r = metabolism(at({ skillsListed: ['a'], skillFirings: { a: 9 } }))
    expect(r.score).toBeCloseTo(100)
  })

  it('has no score when nothing carried usage', () => {
    // Not zero: a window with no measured tokens has no tax to judge.
    expect(metabolism(at({ effectiveInputPerCall: [] })).score).toBeNull()
  })

  it('stays inside 0 and 100', () => {
    const r = metabolism(at({ effectiveInputPerCall: [10_000_000], skillsListed: ['a'] }))
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
})

describe('saturation', () => {
  it('is reported, because an axis on its floor cannot move', () => {
    // A score that cannot respond to anything the environment does is useless
    // as a time series, which is what this product is for.
    expect(metabolism(at({ effectiveInputPerCall: [500_000] })).saturated).toBe(true)
    expect(metabolism(at({ effectiveInputPerCall: [114_635] })).saturated).toBe(false)
  })
})

describe('what it does not compute', () => {
  it('names both omissions and their direction', () => {
    const r = metabolism(base)
    expect([...r.omitted]).toEqual(['static-defects', 'dead-weight-descriptions'])
    // Both are deductions, so leaving them out makes this axis read high.
    for (const o of r.omitted) expect(METABOLISM_OMISSION_LEANINGS[o]).toBe('high')
  })

  it('keeps the dead-weight threshold visible even though it is unused', () => {
    expect(DEAD_WEIGHT_THRESHOLD).toBe(0.3)
  })
})

describe('the median', () => {
  it('takes the middle of an odd count and the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('has none for an empty set', () => {
    expect(median([])).toBeNull()
  })
})
