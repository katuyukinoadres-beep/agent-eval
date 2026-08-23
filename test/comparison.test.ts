import { describe, expect, it } from 'vitest'
import {
  MDE_FLOOR,
  MIN_COMPARABLE_AXES,
  compare,
  significanceOf,
  type AxisSnapshotView,
  type WindowView,
} from '@/score/comparison.js'

/**
 * A delta between two numbers only measures the environment when everything
 * else about how they were made is the same. When it is not, the delta measures
 * the difference in method, and saying so is the job.
 *
 * The strictest rule is about naming a change. On the data the floor was fitted
 * to, one indicator moved +0.834pt with an interval of [+0.091, +1.636] over one
 * pair of windows and -0.083pt over the same data cut differently. Significance
 * alone would have printed "improved" for a sign that flips with the window
 * boundary.
 */

const axis = (over: Partial<AxisSnapshotView> = {}): AxisSnapshotView => ({
  state: 'measured',
  scoreE4: 500_000,
  formulaFingerprint: 'sha256:aaa',
  belowMinDenominator: true,
  ...over,
})

const window = (over: Partial<WindowView> = {}): WindowView => ({
  axes: {
    wastedMotion: axis(),
    selfVerification: axis(),
    artifactUptake: axis(),
    recurrencePrevention: axis(),
  },
  countBasisDigest: 'sha256:basis',
  keyFingerprint: 'sha256:key',
  compositeComparable: false,
  compositeE4: null,
  ...over,
})

describe('when a delta may not be taken at all', () => {
  it('refuses without a previous window, by name', () => {
    // Not an absent field. "There was no previous window" and "the two could
    // not be compared" are different facts.
    const c = compare(window(), null)
    expect(c.refused).toBe('no-previous-window')
    expect(c.perAxis).toEqual([])
  })

  it('refuses when the counting basis changed', () => {
    // The two windows counted different things. No axis survives that, so the
    // refusal is whole rather than per axis.
    const c = compare(window(), window({ countBasisDigest: 'sha256:other' }))
    expect(c.refused).toBe('count-basis-changed')
  })

  it('refuses below four comparable axes', () => {
    const three = window({
      axes: { wastedMotion: axis(), selfVerification: axis(), artifactUptake: axis() },
    })
    expect(compare(three, three).refused).toBe('too-few-comparable-axes')
    expect(MIN_COMPARABLE_AXES).toBe(4)
  })
})

describe('when a formula changed', () => {
  it('drops that axis and keeps the rest', () => {
    const then = window({
      axes: {
        wastedMotion: axis({ formulaFingerprint: 'sha256:old' }),
        selfVerification: axis(),
        artifactUptake: axis(),
        recurrencePrevention: axis(),
        environmentMetabolism: axis(),
      },
    })
    const now = window({
      axes: {
        wastedMotion: axis(),
        selfVerification: axis(),
        artifactUptake: axis(),
        recurrencePrevention: axis(),
        environmentMetabolism: axis(),
      },
    })
    const c = compare(now, then)
    expect(c.excludedByFingerprint).toEqual(['wastedMotion'])
    expect(c.axes).not.toContain('wastedMotion')
    expect(c.refused).toBeNull()
  })

  it('names the dropped axis rather than leaving it out quietly', () => {
    // A definition change and an environment change look identical in a score,
    // and this is the only thing that tells them apart.
    const then = window({
      axes: {
        wastedMotion: axis({ formulaFingerprint: 'sha256:old' }),
        selfVerification: axis(),
        artifactUptake: axis(),
        recurrencePrevention: axis(),
        environmentMetabolism: axis(),
      },
    })
    expect(compare(window({ axes: then.axes }), then).excludedByFingerprint).toEqual([])
  })
})

describe('the deltas', () => {
  it('subtracts then from now', () => {
    const then = window()
    const now = window({
      axes: { ...then.axes, wastedMotion: axis({ scoreE4: 600_000 }) },
    })
    const c = compare(now, then)
    const w = c.perAxis.find((a) => a.axis === 'wastedMotion')
    expect(w?.then).toBeCloseTo(50)
    expect(w?.now).toBeCloseTo(60)
    expect(w?.delta).toBeCloseTo(10)
  })

  it('reports identical when both windows measured the same set', () => {
    expect(compare(window(), window()).basis).toBe('identical')
  })

  it('reports intersection when they did not', () => {
    const then = window({ axes: { ...window().axes, environmentMetabolism: axis() } })
    expect(compare(window(), then).basis).toBe('intersection')
  })
})

describe('naming a change', () => {
  it('needs an interval, and there is none yet', () => {
    // Every delta this build produces is shown and none is named. The absence
    // of an interval is a reason in its own right, not a licence.
    const then = window()
    const now = window({ axes: { ...then.axes, wastedMotion: axis({ scoreE4: 900_000 }) } })
    const w = compare(now, then).perAxis.find((a) => a.axis === 'wastedMotion')
    expect(w?.significant).toBe(false)
    expect(w?.gap).toBe('no-interval')
  })

  it('refuses an interval that crosses zero', () => {
    expect(significanceOf(5, [-1, 9])).toEqual({ significant: false, gap: 'interval-crosses-zero' })
  })

  it('refuses a difference under the floor even when the interval is clean', () => {
    // The case that decided the rule: significant and too small to act on, with
    // a sign that reverses when the window boundary moves.
    expect(significanceOf(0.834, [0.091, 1.636])).toEqual({ significant: false, gap: 'below-floor' })
    expect(MDE_FLOOR).toBe(1)
  })

  it('names a change only when both hold', () => {
    expect(significanceOf(2.5, [1.1, 3.9])).toEqual({ significant: true, gap: null })
  })

  it('treats an interval touching zero as crossing it', () => {
    expect(significanceOf(5, [0, 9]).significant).toBe(false)
  })
})

describe('the composite delta', () => {
  it('is withheld when either window may not supply one', () => {
    // A composite over one axis set and a composite over another are different
    // quantities. Making the refusal a stored flag is what keeps it mechanical.
    const then = window({ compositeComparable: false, compositeE4: 480_000 })
    const now = window({ compositeComparable: true, compositeE4: 500_000 })
    const c = compare(now, then)
    expect(c.compositeThen).toBeNull()
    expect(c.delta).toBeNull()
  })

  it('is taken when both may', () => {
    const then = window({ compositeComparable: true, compositeE4: 480_000 })
    const now = window({ compositeComparable: true, compositeE4: 500_000 })
    const c = compare(now, then)
    expect(c.compositeThen).toBeCloseTo(48)
    expect(c.delta).toBeCloseTo(2)
  })
})

describe('signature sets across a key change', () => {
  it('are marked unusable rather than intersected to nothing', () => {
    // An empty intersection reads as "no failure recurred", which is a perfect
    // score arrived at by accident.
    const c = compare(window(), window({ keyFingerprint: 'sha256:other' }))
    expect(c.signatureSetsUsable).toBe(false)
  })

  it('are usable when the key held', () => {
    expect(compare(window(), window()).signatureSetsUsable).toBe(true)
  })
})
