import { describe, expect, it } from 'vitest'
import {
  AXIS_WEIGHTS,
  MAX_MISSING_AXES,
  MIN_NOMINAL_WEIGHT_SUM,
  SCORED_AXIS_KEYS,
  aggregateLeaning,
  composite,
  tierOf,
  type AxisInput,
  type OmittedTerm,
} from '@/score/composite.js'
import { OMITTED_TERMS, OMITTED_TERM_LEANINGS } from '@/score/wastedMotion.js'

/**
 * Composing six numbers into one, and the three principles that decide what
 * happens when six are not there.
 *
 * The one that is easiest to get backwards is P-A: a missing axis must be
 * neither zero nor its best value. Zero punishes an environment for what it
 * cannot measure; the best value makes the environment that measures nothing
 * win, which is the shape this product was built to refuse.
 */

const axis = (key: string, over: Partial<AxisInput> = {}): AxisInput => ({
  key: key as AxisInput['key'],
  available: true,
  score: 70,
  omittedTerms: [],
  ...over,
})

const allSix = (score = 70): AxisInput[] => SCORED_AXIS_KEYS.map((k) => axis(k, { score }))

const term = (leans: 'high' | 'low'): OmittedTerm => ({
  term: 'unused-success',
  cause: 'not-implemented',
  leans,
})

describe('the weights', () => {
  it('sum to 100', () => {
    const sum = Object.values(AXIS_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(100)
  })

  it('covers exactly the six scored axes', () => {
    expect([...SCORED_AXIS_KEYS]).toEqual([
      'firstPassLanding',
      'wastedMotion',
      'selfVerification',
      'artifactUptake',
      'environmentMetabolism',
      'recurrencePrevention',
    ])
  })
})

describe('composing', () => {
  it('returns the common score when every axis agrees', () => {
    const c = composite({ axes: allSix(70), gateReason: null })
    expect(c.score).toBeCloseTo(70)
    expect(c.tier).toBe('A')
    expect(c.suppressedReason).toBeNull()
  })

  it('renormalises the survivors to 100 without adding or removing anything', () => {
    // Two missing. The remaining weights are scaled up in proportion; nothing
    // is credited and nothing is docked.
    const axes = allSix(80).map((a, i) => (i < 2 ? { ...a, available: false, score: null } : a))
    const c = composite({ axes, gateReason: null })
    const sum = Object.values(c.effectiveWeights).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(100, 1)
    expect(c.score).toBeCloseTo(80)
    expect(c.axesUsed).toHaveLength(4)
  })

  it('emits weights that sum to exactly 100, for every subset', () => {
    // Rounding each share independently loses the remainder. Four axes at
    // 17.5/17.5/17.5/16.25 give 25.45 x3 + 23.64 = 99.99, and V-18 refused
    // exactly that the first time a live composite ran over four axes -- the
    // rule was right and the emitter was wrong.
    for (let missing = 0; missing <= MAX_MISSING_AXES; missing += 1) {
      const axes = allSix(70).map((a, i) => (i < missing ? { ...a, available: false, score: null } : a))
      const c = composite({ axes, gateReason: null })
      const sum = Object.values(c.effectiveWeights).reduce((a, b) => a + b, 0)
      expect(Math.abs(sum - 100), `${6 - missing} axes`).toBeLessThanOrEqual(0.01)
    }
  })

  it('weights a strong axis by its weight, not equally', () => {
    const axes = allSix(0)
    axes[0] = { ...axes[0]!, score: 100 } // firstPassLanding, 18.75
    const c = composite({ axes, gateReason: null })
    expect(c.score).toBeCloseTo(18.75, 1)
  })
})

describe('when the six are not there', () => {
  it('gives no total past the missing-axis cap', () => {
    // Three missing lets 39% of a total ride on one axis; two leaves 63.75
    // nominal weight and no axis above a 30% share.
    const axes = allSix().map((a, i) => (i < 3 ? { ...a, available: false, score: null } : a))
    const c = composite({ axes, gateReason: null })
    expect(c.score).toBeNull()
    expect(c.suppressedReason).toBe('too-many-missing-axes')
    expect(MAX_MISSING_AXES).toBe(2)
  })

  it('still gives one at exactly the cap', () => {
    const axes = allSix().map((a, i) => (i < MAX_MISSING_AXES ? { ...a, available: false, score: null } : a))
    const c = composite({ axes, gateReason: null })
    expect(c.score).not.toBeNull()
    expect(c.nominalWeightSum).toBeGreaterThanOrEqual(MIN_NOMINAL_WEIGHT_SUM)
  })

  it('does not score a missing axis as zero', () => {
    // Zero would punish an environment for what it could not measure.
    const axes = allSix(80).map((a, i) => (i === 0 ? { ...a, available: false, score: null } : a))
    const c = composite({ axes, gateReason: null })
    expect(c.score).toBeCloseTo(80)
  })

  it('does not fill a missing axis with a good value either', () => {
    // The half v1 left unguarded. Filling with the best value makes the
    // environment that measures nothing come out on top, which is the machine
    // this product exists to refuse.
    const axes = allSix(40).map((a, i) => (i === 0 ? { ...a, available: false, score: null } : a))
    const c = composite({ axes, gateReason: null })
    expect(c.score).toBeCloseTo(40)
    expect(c.score).toBeLessThan(100)
  })

  it('reports the gate reason rather than inventing one', () => {
    // The three gate conditions are the gate's to name. Re-deriving them here
    // would be a second copy to keep in step.
    const c = composite({ axes: allSix(), gateReason: 'too-few-active-days' })
    expect(c.score).toBeNull()
    expect(c.suppressedReason).toBe('too-few-active-days')
  })

  it('never returns a null score without a reason', () => {
    for (const n of [3, 4, 5, 6]) {
      const axes = allSix().map((a, i) => (i < n ? { ...a, available: false, score: null } : a))
      const c = composite({ axes, gateReason: null })
      expect(c.score, `${n} missing`).toBeNull()
      expect(c.suppressedReason, `${n} missing`).not.toBeNull()
    }
  })

  it('is this machine\'s correct answer today', () => {
    // Five of six axes are unbuilt, so there is no total. That is the first
    // release working, not failing.
    const axes = SCORED_AXIS_KEYS.map((k) =>
      k === 'wastedMotion' ? axis(k, { score: 57.1 }) : axis(k, { available: false, score: null }),
    )
    const c = composite({ axes, gateReason: null })
    expect(c.score).toBeNull()
    expect(c.suppressedReason).toBe('too-many-missing-axes')
    expect(c.excluded).toHaveLength(5)
  })
})

describe('which way the total leans', () => {
  it('says nothing when nothing was dropped', () => {
    expect(composite({ axes: allSix(), gateReason: null }).leans).toBeNull()
  })

  it('leans high when only positive terms were dropped', () => {
    const axes = allSix()
    axes[0] = { ...axes[0]!, omittedTerms: [term('high')] }
    expect(composite({ axes, gateReason: null }).leans).toBe('high')
  })

  it('is mixed when both directions are present, not whichever weighs more', () => {
    // Axis 2 drops three positive numerator terms and one winsorisation. The
    // spec settles this case by name: a total containing it is mixed, and is
    // neither high nor low. Saying it cannot be told is the correct state, not
    // a precision to be improved.
    const axes = allSix()
    axes[0] = { ...axes[0]!, omittedTerms: [term('high'), term('high'), term('high'), term('low')] }
    expect(composite({ axes, gateReason: null }).leans).toBe('mixed')
  })

  it('counts only the axes that were used', () => {
    const axes = allSix()
    axes[0] = { ...axes[0]!, available: false, score: null, omittedTerms: [term('high')] }
    expect(composite({ axes, gateReason: null }).leans).toBeNull()
  })

  it('reports a leaning even when no total was produced', () => {
    // The axes still carry their shifts, and a reader looking at the breakdown
    // needs the same warning the total would have carried.
    const axes = allSix().map((a, i) => (i < 4 ? { ...a, available: false, score: null } : a))
    axes[5] = { ...axes[5]!, omittedTerms: [term('low')] }
    expect(composite({ axes, gateReason: null }).leans).toBe('low')
  })

  it('agrees with the real axis 2 table', () => {
    // The leanings the implementation actually ships, run through the
    // aggregator. Three high and one low make mixed.
    const real = OMITTED_TERMS.map(
      (t): OmittedTerm => ({ term: t, cause: 'not-implemented', leans: OMITTED_TERM_LEANINGS[t] }),
    )
    expect(aggregateLeaning([axis('wastedMotion', { omittedTerms: real })])).toBe('mixed')
  })
})

describe('outcome and design', () => {
  it('gives an outcome score with three of its four axes', () => {
    const axes = allSix(60).map((a) =>
      a.key === 'artifactUptake' ? { ...a, available: false, score: null } : a,
    )
    expect(composite({ axes, gateReason: null }).outcomeScore).toBeCloseTo(60)
  })

  it('withholds it with only two', () => {
    const axes = allSix(60).map((a) =>
      a.key === 'artifactUptake' || a.key === 'selfVerification'
        ? { ...a, available: false, score: null }
        : a,
    )
    expect(composite({ axes, gateReason: null }).outcomeScore).toBeNull()
  })

  it('will not call one axis the design score', () => {
    // The same objection that keeps a deduction-style axis with a dropped term
    // out of the total: the name stays and the quantity behind it changes.
    const axes = allSix(60).map((a) =>
      a.key === 'recurrencePrevention' ? { ...a, available: false, score: null } : a,
    )
    expect(composite({ axes, gateReason: null }).designScore).toBeNull()
  })
})

describe('tiers', () => {
  it('places each band, inclusive at the bottom', () => {
    expect(tierOf(85)).toBe('S')
    expect(tierOf(84.99)).toBe('A')
    expect(tierOf(70)).toBe('A')
    expect(tierOf(69.99)).toBe('B')
    expect(tierOf(55)).toBe('B')
    expect(tierOf(40)).toBe('C')
    expect(tierOf(39.99)).toBe('D')
    expect(tierOf(0)).toBe('D')
  })
})
