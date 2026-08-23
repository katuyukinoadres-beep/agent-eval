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
  peakInputPerBundle: [30_000], effectiveInputPerBundle: [30_000],
  inputPerBundleWithoutCache: [],
  skillsListed: [],
  skillFirings: {},
  hookFirings: {},
  mcpFirings: {},
  mcpServersDefined: 0,
  hooksDefined: 0,
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
    expect(metabolism(at({ peakInputPerBundle: [] })).score).toBeNull()
  })

  it('stays inside 0 and 100', () => {
    const r = metabolism(at({ peakInputPerBundle: [10_000_000], skillsListed: ['a'] }))
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
})

describe('saturation', () => {
  it('is reported, because an axis on its floor cannot move', () => {
    // A score that cannot respond to anything the environment does is useless
    // as a time series, which is what this product is for.
    expect(metabolism(at({ peakInputPerBundle: [500_000] })).saturated).toBe(true)
    expect(metabolism(at({ peakInputPerBundle: [114_635] })).saturated).toBe(false)
  })
})

describe('what it does not compute', () => {
  it('names the one omission left, and its direction', () => {
    // `static-defects` is not an omission any more: v2 §3.5 removes D from this
    // axis entirely and moves it to the safety check, which is not scored.
    // Declaring an omission for a term the axis no longer has overstates what
    // is missing, and it was one of the two deductions that made the axis
    // unscorable.
    const r = metabolism(base)
    expect([...r.omitted]).toEqual(['dead-weight-descriptions'])
    expect(METABOLISM_OMISSION_LEANINGS['dead-weight-descriptions']).toBe('high')
  })

  it('records a truncated listing as an omission rather than as a flag nobody reads', () => {
    // The flag was collected, threaded through two interfaces, and never read.
    // A truncated listing understates the asset set, so U runs high with
    // nothing to show it -- truncated and short were indistinguishable.
    expect(metabolism({ ...base, listingTruncated: true }).omitted).toContain('listing-truncated')
    expect(metabolism({ ...base, listingTruncated: false }).omitted).not.toContain('listing-truncated')
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

describe('a deduction-style axis with a dropped deduction', () => {
  it('says it must not be scored', () => {
    // v2 §12.5(b): dropping a deduction can only raise the result, and
    // redistributing its coefficient makes another deduction bite harder than
    // it should. Neither is allowed, so the axis leaves the total.
    //
    // This was shipped as `available` first, and the 45.0 it produced was the
    // same name for a different quantity -- and it went into a composite.
    expect(metabolism(base).scorable).toBe(false)
  })

  it('still computes the number, because a later window needs it', () => {
    // Not scored is not the same as not measured. A snapshot that omitted this
    // would lose it for good.
    expect(metabolism(base).score).not.toBeNull()
  })
})

describe('which context-tax reading is scored', () => {
  /**
   * v1's two lines disagree. The first says `median(per task bundle)`; the
   * second writes `median(usage.input_tokens + cache_read_input_tokens)`, which
   * is per assistant message. The trapezoid's 40k and 120k thresholds are
   * context *sizes*, and that is what disambiguates them.
   *
   * All four readings, measured on this machine:
   *
   *   per assistant message, with cache   123,276   trapezoid 20.00
   *   per bundle, summed, with cache    5,594,668   trapezoid 20.00
   *   per bundle, peak, with cache        476,013   trapezoid 20.00
   *   per bundle, summed, without cache        30   trapezoid 100.00
   */
  it('grades the peak, not the sum', () => {
    // Summing counts the same cached context once per call inside the bundle.
    const r = metabolism(at({ peakInputPerBundle: [50_000], effectiveInputPerBundle: [5_000_000] }))
    expect(r.fc).toBe(50_000)
    expect(r.fcSummed).toBe(5_000_000)
    expect(r.trapezoidScore).toBeCloseTo(trapezoid(50_000))
  })

  it('reports the summed and cache-free readings beside it', () => {
    // Never scored alone: cache reads are 94.7% of all tokens measured, so the
    // with-cache figure mostly measures how long a session ran.
    const r = metabolism(
      at({
        peakInputPerBundle: [50_000],
        effectiveInputPerBundle: [5_000_000],
        inputPerBundleWithoutCache: [30],
      }),
    )
    expect(r.fcSummed).toBe(5_000_000)
    expect(r.fcWithoutCache).toBe(30)
  })

  it('would return the floor for every possible environment under the summed reading', () => {
    // The decisive argument against it. No environment has a bundle summing
    // under the 120,000 ceiling, so that reading returns 20 for everyone
    // forever -- a metric that measures nothing.
    expect(trapezoid(5_594_668)).toBe(20)
    expect(trapezoid(120_001)).toBe(20)
    // The peak can still discriminate.
    expect(trapezoid(50_000)).toBeGreaterThan(20)
  })
})

describe('the asset denominator', () => {
  /**
   * v2 §3.5: `assetsDefined = skills listed + hooks registered + MCP servers
   * enabled`. Registrations, not firings.
   *
   * Hooks were the one class whose denominator was its own numerator's support
   * set: it iterated `hookFirings`, so an unfired hook cost nothing and sixty
   * hooks with no firings were indistinguishable from no hooks at all. That
   * reverses the guard this axis exists to be.
   */
  it('counts a registered hook that never fired', () => {
    const fired = metabolism(at({ skillsListed: [], hookFirings: { a: 5 }, hooksDefined: 1 }))
    const withDead = metabolism(at({ skillsListed: [], hookFirings: { a: 5 }, hooksDefined: 4 }))
    expect(fired.assets).toBe(1)
    expect(withDead.assets).toBe(4)
    expect(fired.u).toBe(1)
    expect(withDead.u).toBeCloseTo(0.25)
  })

  it('does not double-count a hook that did fire', () => {
    // The padding is `defined - fired`, so a fully exercised set adds nothing.
    const r = metabolism(at({ skillsListed: [], hookFirings: { a: 5, b: 5 }, hooksDefined: 2 }))
    expect(r.assets).toBe(2)
    expect(r.firedAssets).toBe(2)
  })

  it('pads MCP servers the same way, which it always did', () => {
    const r = metabolism(at({ skillsListed: [], mcpFirings: { x: 3 }, mcpServersDefined: 5 }))
    expect(r.assets).toBe(5)
  })
})
