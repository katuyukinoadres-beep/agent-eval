import { describe, expect, it } from 'vitest'
import {
  RECURRENCE_OMISSION_LEANINGS,
  WEIGHT_RECURRENCE,
  recurrence,
  type RecurrenceInputs,
} from '@/score/recurrence.js'

/**
 * Axis 6's numerator was replaced once, and the reason is a warning about what
 * a plausible formula can hide.
 *
 * The original counted whether a correction got written into a persistent file.
 * Measured against real data, 1 of 142 negative redirects was followed by such a
 * write in the same session -- 0.7% against a formula calibrated at 0.45. Every
 * user would have scored zero on the term forever, and the zero would have
 * looked like a finding about them rather than about the formula.
 */

const base: RecurrenceInputs = {
  rIn: 0.5,
  rCross: null,
  periodsDiffer: true,
  errors: 300,
  firstWindow: true,
  hasExternalHookLog: false,
}

const at = (over: Partial<RecurrenceInputs>): RecurrenceInputs => ({ ...base, ...over })

describe('the recurrence rate', () => {
  it('scores the complement of the repeat rate', () => {
    expect(recurrence(at({ rIn: 0 })).score).toBeCloseTo(100)
    expect(recurrence(at({ rIn: 1 })).score).toBeCloseTo(0)
    expect(recurrence(at({ rIn: 0.5 })).score).toBeCloseTo(50)
  })

  it('says which rate it used', () => {
    // r_in and r_cross answer different questions, and a window scored on one
    // must never be compared with a window scored on the other.
    expect(recurrence(at({ rCross: null })).rateKind).toBe('within-window')
    expect(recurrence(at({ rCross: 0.2 })).rateKind).toBe('cross-window')
  })

  it('decides that on the rate it has, not on a flag', () => {
    // `firstWindow: false` with no comparable previous set would otherwise
    // label an r_in as an r_cross, and two incomparable windows would be
    // differenced as though they measured the same thing.
    expect(recurrence(at({ firstWindow: false, rCross: null })).rateKind).toBe('within-window')
  })

  it('scores the cross-window rate when it has one', () => {
    // The rate this axis is actually for. r_in only stands in.
    expect(recurrence(at({ rIn: 0.9, rCross: 0.1 })).rate).toBeCloseTo(0.1)
    expect(recurrence(at({ rIn: 0.9, rCross: 0.1 })).score).toBeCloseTo(90)
  })

  it('marks a window scored on the stand-in as a baseline rather than a result', () => {
    // "We registered these; next time you are scored on whether they are gone"
    // is a different claim from "you scored 50".
    expect(recurrence(at({ rCross: null })).baselineOnly).toBe(true)
    expect(recurrence(at({ rCross: 0.2 })).baselineOnly).toBe(false)
  })
})

describe('a window with no failures', () => {
  it('has no score rather than a perfect one', () => {
    // Nothing can recur, so there is nothing to measure. Reporting 100 would
    // put the best possible mark on the window with the least evidence -- the
    // same shape as filling a gap with its best value.
    const r = recurrence(at({ errors: 0 }))
    expect(r.score).toBeNull()
    expect(r.unavailable).toBe('no-failures')
  })
})

describe('what it does not compute', () => {
  it('names the explanation-repetition term, and refuses to guess its direction', () => {
    // L3 needs MinHash over 3-grams at 0.75 plus a co-occurrence Jaccard at
    // 0.6 for the cases where someone says "that file" instead of naming it.
    //
    // The axis is a convex combination renormalised over its survivors, so
    // dropping this term raises the score exactly when L3 is below the
    // renormalised score -- a comparison against a value that is not computed.
    // It was marked `high`, which asserts the answer to the question the
    // omission exists to record. Near L3 = 0 the omission costs about 16 points.
    const r = recurrence(base)
    expect(r.omitted).toContain('axis6-explanation-repetition')
    expect(RECURRENCE_OMISSION_LEANINGS['axis6-explanation-repetition']).toBe('unknown')
  })

  it('gives the optional external log no direction at all', () => {
    // Layer B sits on top rather than inside the combination, so its absence
    // leaves the score exactly where layer A puts it. The paragraph above the
    // table said so while the table said `high`.
    expect(RECURRENCE_OMISSION_LEANINGS['axis6-external-hook-log']).toBe('none')
  })

  it('names the external hook log only when there is none', () => {
    expect(recurrence(at({ hasExternalHookLog: false })).omitted).toContain('axis6-external-hook-log')
    expect(recurrence(at({ hasExternalHookLog: true })).omitted).not.toContain('axis6-external-hook-log')
  })

  it('renormalises the surviving term to the whole', () => {
    // With only the recurrence term left its coefficient becomes 1, so a clean
    // window reaches 100 rather than the 70 its nominal weight would allow.
    expect(recurrence(at({ rIn: 0 })).score).toBeCloseTo(100)
    expect(WEIGHT_RECURRENCE).toBe(0.7)
  })
})

describe('the score', () => {
  it('stays inside 0 and 100', () => {
    for (const rIn of [-0.5, 0, 0.5, 1, 1.5]) {
      const s = recurrence(at({ rIn })).score as number
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(100)
    }
  })
})

describe('when the two windows are not different periods', () => {
  /**
   * The scan counts over all time, so two consecutive runs see the same corpus
   * a few minutes apart. Every repeated signature carries over by construction:
   * a measured r_cross of 1.0 and a score of zero, which is a fact about the
   * counting basis and not about the environment.
   *
   * Measured on this machine: a second window scored 0 on axis 6 and moved the
   * composite by -12.73 with nothing about the environment having changed.
   */
  it('refuses the cross-window rate and says why', () => {
    const r = recurrence(at({ rIn: 0.4, rCross: 1, periodsDiffer: false }))
    expect(r.rateKind).toBe('within-window')
    expect(r.rate).toBeCloseTo(0.4)
    expect(r.omitted).toContain('axis6-window-not-rolled')
  })

  it('takes it once the periods do differ', () => {
    const r = recurrence(at({ rIn: 0.4, rCross: 1, periodsDiffer: true }))
    expect(r.rateKind).toBe('cross-window')
    expect(r.rate).toBeCloseTo(1)
    expect(r.omitted).not.toContain('axis6-window-not-rolled')
  })
})
