import { describe, expect, it } from 'vitest'
import {
  MIN_INTERVALS,
  TODO_PENALTY,
  VERIFICATION_OMISSION_LEANINGS,
  verification,
  type VerificationInputs,
} from '@/score/verification.js'

/**
 * Axis 3, and the two reversals in its design that matter more than its
 * formula.
 *
 * There is no command dictionary. Fitted to one machine, most Bash calls were
 * python invocations, so whatever work came after an edit -- sending mail,
 * saving a file -- counted as verification of it at full weight. On a machine
 * in another language or another line of work, the same dictionary matches
 * nothing and the term is permanently zero. It fails in both directions.
 *
 * There is no cap for having no executions. Minutes, articles and draft emails
 * have no one-command check, and a cap would hold anyone doing secretarial or
 * writing work at a C forever however carefully they worked.
 */

const base: VerificationInputs = {
  intervals: 100,
  verifiedIntervals: 50,
  selfRepaired: 6,
  humanRescued: 2,
  unresolved: 2,
  todoWriteUsed: true,
  firstWindow: true,
}

const at = (over: Partial<VerificationInputs>): VerificationInputs => ({ ...base, ...over })

describe('the verified share', () => {
  it('is verified intervals over all of them', () => {
    expect(verification(base).v).toBeCloseTo(0.5)
  })

  it('has no score below twenty-five intervals', () => {
    const r = verification(at({ intervals: MIN_INTERVALS - 1 }))
    expect(r.score).toBeNull()
    expect(r.unavailable).toBe('too-few-intervals')
  })

  it('has one at exactly twenty-five', () => {
    expect(verification(at({ intervals: MIN_INTERVALS, verifiedIntervals: 10 })).score).not.toBeNull()
  })
})

describe('the three-way split of failures', () => {
  it('credits a repair the agent made itself', () => {
    const r = verification(at({ selfRepaired: 10, humanRescued: 0, unresolved: 0 }))
    expect(r.selfRepairRate).toBe(1)
    expect(r.unresolvedRate).toBe(0)
  })

  it('deducts for neither a rescue nor a repair, only for what stayed broken', () => {
    // v1 splits the three and deducts only on the unresolved share. Being
    // helped is not a fault.
    const rescued = verification(at({ selfRepaired: 0, humanRescued: 10, unresolved: 0 }))
    const stuck = verification(at({ selfRepaired: 0, humanRescued: 0, unresolved: 10 }))
    expect(rescued.score).toBeGreaterThan(stuck.score as number)
  })

  it('drops both terms when there were no failures at all', () => {
    // A repair rate of 0 over no failures would read as never recovering, which
    // is the worst possible value for the quietest possible window.
    const r = verification(at({ selfRepaired: 0, humanRescued: 0, unresolved: 0 }))
    expect(r.selfRepairRate).toBeNull()
    expect(r.unresolvedRate).toBeNull()
    expect(r.score).not.toBeNull()
  })

  it('scores a clean window on verification alone', () => {
    // With no failures the surviving term is the verified share, renormalised
    // to the whole.
    const r = verification(at({ verifiedIntervals: 100, selfRepaired: 0, humanRescued: 0, unresolved: 0 }))
    expect(r.score).toBeCloseTo(100)
  })
})

describe('the TodoWrite deduction', () => {
  it('costs five points when it was never used', () => {
    const used = verification(base)
    const not = verification(at({ todoWriteUsed: false }))
    expect((used.score as number) - (not.score as number)).toBeCloseTo(TODO_PENALTY)
  })

  it('does not take the score below zero', () => {
    const r = verification(at({ verifiedIntervals: 0, selfRepaired: 0, humanRescued: 0, unresolved: 10, todoWriteUsed: false }))
    expect(r.score).toBeGreaterThanOrEqual(0)
  })
})

describe('what it does not compute', () => {
  it('names the command history as a first-window omission', () => {
    // Condition (ii): an execution counts only if that command has exited
    // non-zero at least once before, so a decoration that always passes does
    // not count. It needs a previous window.
    expect(verification(base).omitted).toContain('axis3-command-history')
    expect(verification(at({ firstWindow: false })).omitted).not.toContain('axis3-command-history')
  })

  it('says every omission reads high', () => {
    // All three make verification easier to earn or leave a multiplier at 1
    // instead of its floor. A reader seeing 34.45 without them would take it
    // for a plain measurement.
    for (const o of verification(base).omitted) {
      expect(VERIFICATION_OMISSION_LEANINGS[o], o).toBe('high')
    }
  })

  it('marks the command history as a window shortfall, not an unbuilt feature', () => {
    // The two causes change differently: one is fixed for a build, the other
    // changes as data accumulates.
    expect(verification(base).omitted[0]).toBe('axis3-command-history')
  })
})

describe('the score', () => {
  it('stays inside 0 and 100 across the corners', () => {
    for (const verified of [0, 100]) {
      for (const unresolved of [0, 10]) {
        const r = verification(
          at({ verifiedIntervals: verified, selfRepaired: 10 - unresolved, unresolved, humanRescued: 0 }),
        )
        expect(r.score).toBeGreaterThanOrEqual(0)
        expect(r.score).toBeLessThanOrEqual(100)
      }
    }
  })

  it('is measured on this machine at 34.45', () => {
    // 896 intervals, 310 of them verified. Pinned so a change to the interval
    // rule shows up as a changed number rather than as a quiet drift.
    const r = verification(
      at({ intervals: 896, verifiedIntervals: 310, selfRepaired: 0, humanRescued: 0, unresolved: 0 }),
    )
    expect(r.v).toBeCloseTo(0.346, 3)
  })
})
