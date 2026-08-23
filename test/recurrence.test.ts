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
    expect(recurrence(at({ firstWindow: true })).rateKind).toBe('within-window')
    expect(recurrence(at({ firstWindow: false })).rateKind).toBe('cross-window')
  })

  it('marks a first window as a baseline rather than a result', () => {
    // "We registered these; next time you are scored on whether they are gone"
    // is a different claim from "you scored 50".
    expect(recurrence(at({ firstWindow: true })).baselineOnly).toBe(true)
    expect(recurrence(at({ firstWindow: false })).baselineOnly).toBe(false)
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
  it('names the explanation-repetition term and says it reads high', () => {
    // L3 needs MinHash over 3-grams at 0.75 plus a co-occurrence Jaccard at
    // 0.6 for the cases where someone says "that file" instead of naming it.
    // It enters as a deduction, so dropping it reads high.
    const r = recurrence(base)
    expect(r.omitted).toContain('axis6-explanation-repetition')
    expect(RECURRENCE_OMISSION_LEANINGS['axis6-explanation-repetition']).toBe('high')
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
