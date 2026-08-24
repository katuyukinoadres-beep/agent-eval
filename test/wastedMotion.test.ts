import { describe, expect, it } from 'vitest'
import {
  OMITTED_TERMS,
  W_REF,
  wastedMotion,
  winsorise,
} from '@/score/wastedMotion.js'
import { inputKey, isInvestigation, wastedTracker } from '@/collect/wasted.js'
import type { WastedCounts } from '@/collect/wasted.js'

/**
 * The first axis that produces a score, which makes it the first place a number
 * can be wrong in a way somebody acts on.
 *
 * Four terms v1 defines are not computed, and three of them lean the same way:
 * each is a positive numerator term, so leaving it out makes W smaller and the
 * score higher. The fourth — winsorisation — leans the other way. Both
 * directions are stated in `OMITTED_TERMS` rather than left to be found.
 */

const counts = (over: Partial<WastedCounts> = {}): WastedCounts => ({
  failures: 0,
  hookOriginated: 0,
  errorsObserved: 0,
  attribution: { E1: 0, E2: 0, E2b: 0, E3: 0, E4: 0, E7: 0, E6: 0, E5: 0, E8_E9: 0 },
  closure: { observed: 0, attributed: 0, numerator: 0, excluded: 0, balanced: true },
  writeRepeats: 0,
  investigationRepeats: 0,
  timedOut: 0,
  largeOutput: 0,
  callsPerBundle: {},
  ...over,
})

describe('the numerator weights each kind of waste differently', () => {
  it('charges a failure in full', () => {
    expect(wastedMotion(counts({ failures: 10 }), 0, 10).numerator).toBe(10)
  })

  it('charges a repeated write more than a repeated search', () => {
    // Running Grep again with different terms is how investigation works.
    // Writing the same content to the same path twice is not.
    const write = wastedMotion(counts({ writeRepeats: 10 }), 0, 10).numerator
    const search = wastedMotion(counts({ investigationRepeats: 10 }), 0, 10).numerator
    expect(write).toBeCloseTo(7)
    expect(search).toBeCloseTo(2)
    expect(write).toBeGreaterThan(search)
  })

  it('charges a timeout in full and a huge output at half', () => {
    expect(wastedMotion(counts({ timedOut: 3 }), 0, 10).numerator).toBeCloseTo(3)
    expect(wastedMotion(counts({ largeOutput: 3 }), 0, 10).numerator).toBeCloseTo(1.5)
  })

  it('leaves hook-originated failures out entirely', () => {
    // A guardrail firing is the guardrail working. They are already absent from
    // `failures`, so a machine with nothing but hook refusals scores clean.
    const r = wastedMotion(counts({ hookOriginated: 40 }), 0, 10)
    expect(r.numerator).toBe(0)
    expect(r.score).toBe(100)
  })
})

describe('the score', () => {
  it('is 100 when nothing was wasted and nothing repeated', () => {
    expect(wastedMotion(counts(), 0, 10).score).toBe(100)
  })

  it('saturates the W term rather than running past it', () => {
    // min(1, W / W_ref). Ten times the reference is not ten times the penalty.
    const atRef = wastedMotion(counts({ failures: 30 }), 0, 10).score
    const wayPast = wastedMotion(counts({ failures: 300 }), 0, 10).score
    expect(atRef).toBeCloseTo(35)
    expect(wayPast).toBeCloseTo(35)
  })

  it('never goes negative', () => {
    // Both terms saturating takes the formula below zero, and a negative score
    // on a 0..100 scale reads as a bug rather than as a very bad result.
    expect(wastedMotion(counts({ failures: 1_000 }), 1, 10).score).toBe(0)
  })

  it('splits the deduction 0.65 / 0.35 between waste and repetition', () => {
    const onlyRepeats = wastedMotion(counts(), 1, 10).score
    expect(onlyRepeats).toBeCloseTo(65)
  })

  it('has no score without bundles to divide by', () => {
    // Not zero. Zero is the worst possible result, and no denominator is not a
    // result at all.
    expect(wastedMotion(counts({ failures: 5 }), 0, 0).score).toBeNull()
  })

  it('keeps W_ref visible, because v1 calls it provisional', () => {
    expect(W_REF).toBe(3)
  })
})

describe('what it does not compute', () => {
  it('names every omitted term', () => {
    // Three of these make the score too high and one makes it too low. A reader
    // deserves the direction, not just the absence.
    expect([...OMITTED_TERMS]).toEqual([
      'unused-success',
      'verification-exclusion',
      'user-script-decay',
      'winsorisation',
    ])
  })

  it('reports the winsorisation it did not apply', () => {
    // Nine ones and a hundred: p90 by nearest rank is the ninth value, so the
    // outlier is above the cap.
    const population = Object.fromEntries(
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 100].map((n, i) => [`b${i}`, n]),
    )
    const w = winsorise(population)
    expect(w.bundles).toBe(10)
    expect(w.cap).toBe(1)
    expect(w.capped).toBe(1)
  })

  it('does not put the cap at the maximum, which would make it uncapped', () => {
    // `floor(0.9n)` returns the top element whenever 0.9n is an integer, so
    // nothing can ever exceed the cap. It read plausibly on 357 real bundles
    // and only showed on ten.
    const w = winsorise(Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n, i) => [`b${i}`, n])))
    expect(w.cap).toBeLessThan(10)
    expect(w.capped).toBeGreaterThan(0)
  })

  it('handles an empty population without dividing by nothing', () => {
    expect(winsorise({})).toEqual({ bundles: 0, cap: 0, capped: 0 })
  })

  it('handles a single bundle', () => {
    expect(winsorise({ a: 7 })).toEqual({ bundles: 1, cap: 7, capped: 0 })
  })
})

describe('repeat detection', () => {
  it('sees the same call twice in one bundle', () => {
    const t = wastedTracker()
    expect(t.call(1, 'Grep', { pattern: 'x' })).toBe(false)
    expect(t.call(1, 'Grep', { pattern: 'x' })).toBe(true)
  })

  it('does not see it across bundles', () => {
    // A bundle is one request. The same Grep in two requests is two
    // investigations; keying globally would charge the first as the second.
    const t = wastedTracker()
    t.call(1, 'Grep', { pattern: 'x' })
    expect(t.call(2, 'Grep', { pattern: 'x' })).toBe(false)
  })

  it('treats a different argument as a different call', () => {
    const t = wastedTracker()
    t.call(1, 'Grep', { pattern: 'x' })
    expect(t.call(1, 'Grep', { pattern: 'y' })).toBe(false)
  })

  it('ignores the order properties happen to be written in', () => {
    expect(inputKey('Edit', { a: 1, b: 2 })).toBe(inputKey('Edit', { b: 2, a: 1 }))
  })

  it('keeps the same argument to different tools apart', () => {
    expect(inputKey('Read', { file_path: '/x' })).not.toBe(inputKey('Edit', { file_path: '/x' }))
  })

  it('carries nothing of the argument into the key', () => {
    const key = inputKey('Bash', { command: 'node scripts/deploy.mjs' })
    expect(key).not.toContain('deploy')
    expect(key).not.toContain('scripts')
  })
})

describe('which tools count as investigation', () => {
  it('is v1\'s four', () => {
    for (const t of ['Read', 'Grep', 'WebSearch', 'WebFetch']) {
      expect(isInvestigation(t), t).toBe(true)
    }
  })

  it('treats everything else as write or execute', () => {
    // Including Glob and TodoWrite, which v1 does not name. Following the list
    // as written rather than extending it: a repeat charged at 0.7 instead of
    // 0.2 is a decision, and guessing at it here would be an unrecorded one.
    for (const t of ['Edit', 'Write', 'Bash', 'Glob', 'TodoWrite']) {
      expect(isInvestigation(t), t).toBe(false)
    }
  })
})
