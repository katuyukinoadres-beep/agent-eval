import { describe, expect, it } from 'vitest'
import {
  MIN_INTERVALS,
  TODO_PENALTY,
  TODO_PENALTY_V1,
  V_EFF_FLOOR,
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
 *
 * The failure split was dead for the whole of the first build: nothing ever
 * wrote the pending map, so all three counts were zero on every run, both rate
 * terms fell out, and the axis silently became `100 * V_eff`. An environment
 * that recovered from every failure and one that recovered from none scored
 * identically. The tests below pin each count to something only it produces.
 */

const base: VerificationInputs = {
  intervals: 100,
  verifiedIntervals: 50,
  selfRepaired: 6,
  humanRescued: 2,
  unresolved: 2,
  repairedNotCounted: 0,
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

describe('the effectiveness multiplier', () => {
  it('takes its floor rather than its ceiling while G is unmeasured', () => {
    // G is the share of verifications that caught something, and the multiplier
    // it feeds runs from 0.7 to 1.0. Leaving it at 1.0 asserts that every
    // verification caught something, on no evidence -- the same shape as
    // filling a gap with its best value. The floor asserts the opposite, which
    // is the end this errs towards.
    const r = verification(
      at({ verifiedIntervals: 100, selfRepaired: 0, humanRescued: 0, unresolved: 0, repairedNotCounted: 0 }),
    )
    expect(V_EFF_FLOOR).toBe(0.7)
    expect(r.score).toBeCloseTo(70)
  })

  it('says so in the omissions, and in the direction it now leans', () => {
    expect(verification(base).omitted).toContain('axis3-effectiveness')
    expect(VERIFICATION_OMISSION_LEANINGS['axis3-effectiveness']).toBe('low')
  })
})

describe('the split of failures', () => {
  it('credits a repair the agent made itself', () => {
    const r = verification(at({ selfRepaired: 10, humanRescued: 0, unresolved: 0 }))
    expect(r.selfRepairRate).toBe(1)
    expect(r.unresolvedRate).toBe(0)
    expect(r.failures).toBe(10)
  })

  it('deducts for neither a rescue nor a repair, only for what stayed broken', () => {
    // v1 splits them and deducts only on the unresolved share. Being helped is
    // not a fault.
    const rescued = verification(at({ selfRepaired: 0, humanRescued: 10, unresolved: 0 }))
    const stuck = verification(at({ selfRepaired: 0, humanRescued: 0, unresolved: 10 }))
    expect(rescued.score).toBeGreaterThan(stuck.score as number)
  })

  it('keeps a cleared failure out of the unresolved term even when it earns no credit', () => {
    // The bucket v1's two clauses imply. A failure cleared on the fifth attempt,
    // or one whose error class the session had already seen, is not a
    // self-repair -- but it was fixed, and `unresolved` is the only term the
    // score deducts for. Booking it there would penalise recovering slowly, or
    // recovering from something familiar.
    const notCounted = verification(
      at({ selfRepaired: 0, humanRescued: 0, unresolved: 0, repairedNotCounted: 10 }),
    )
    const stuck = verification(
      at({ selfRepaired: 0, humanRescued: 0, unresolved: 10, repairedNotCounted: 0 }),
    )
    expect(notCounted.failures).toBe(10)
    expect(notCounted.unresolvedRate).toBe(0)
    expect(stuck.unresolvedRate).toBe(1)
    expect(notCounted.score).toBeGreaterThan(stuck.score as number)
  })

  it('counts it in the denominator, so it still dilutes the repair rate', () => {
    // It is not free either. Ten clean repairs is a rate of 1; five of them
    // arriving late halves it.
    expect(verification(at({ selfRepaired: 10, humanRescued: 0, unresolved: 0 })).selfRepairRate).toBe(1)
    expect(
      verification(at({ selfRepaired: 5, humanRescued: 0, unresolved: 0, repairedNotCounted: 5 }))
        .selfRepairRate,
    ).toBe(0.5)
  })

  it('drops both terms when there were no failures at all', () => {
    // A repair rate of 0 over no failures would read as never recovering, which
    // is the worst possible value for the quietest possible window.
    const r = verification(at({ selfRepaired: 0, humanRescued: 0, unresolved: 0 }))
    expect(r.selfRepairRate).toBeNull()
    expect(r.unresolvedRate).toBeNull()
    expect(r.score).not.toBeNull()
  })

  it('records that the formula changed when it did', () => {
    // With both repair terms gone the axis is 100*V_eff, which is not the
    // formula it declares. Applying it quietly is how a build ships a different
    // axis under the same name for a year.
    expect(verification(at({ selfRepaired: 0, humanRescued: 0, unresolved: 0 })).omitted).toContain(
      'axis3-no-failures',
    )
    expect(verification(base).omitted).not.toContain('axis3-no-failures')
  })
})

describe('the TodoWrite deduction', () => {
  it('is suspended, and says so rather than disappearing', () => {
    // v1 deducts five. v2 §9.2 suspends the deduction pending a decision and
    // keeps the flag as a breakdown line. Not deducting reads high, so it is
    // listed with that direction rather than dropped.
    const used = verification(base)
    const not = verification(at({ todoWriteUsed: false }))
    expect(TODO_PENALTY).toBe(0)
    expect(TODO_PENALTY_V1).toBe(5)
    expect(used.score).toBeCloseTo(not.score as number)
    expect(not.omitted).toContain('axis3-todo-penalty-suspended')
    expect(used.omitted).not.toContain('axis3-todo-penalty-suspended')
    expect(VERIFICATION_OMISSION_LEANINGS['axis3-todo-penalty-suspended']).toBe('high')
  })

  it('does not take the score below zero', () => {
    const r = verification(
      at({ verifiedIntervals: 0, selfRepaired: 0, humanRescued: 0, unresolved: 10, todoWriteUsed: false }),
    )
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

  it('gives every omission it reports a direction, and they are not all the same', () => {
    // Not "they all read high" any more: the effectiveness floor and the
    // zero-failure case read low, and a list claiming one direction for all of
    // them would be wrong in both.
    for (const o of verification(at({ todoWriteUsed: false })).omitted) {
      expect(['high', 'low'], o).toContain(VERIFICATION_OMISSION_LEANINGS[o])
    }
    const dirs = new Set(
      verification(
        at({ selfRepaired: 0, humanRescued: 0, unresolved: 0, todoWriteUsed: false }),
      ).omitted.map((o) => VERIFICATION_OMISSION_LEANINGS[o]),
    )
    expect(dirs).toEqual(new Set(['high', 'low']))
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

  it('keeps the measured verified share on this machine', () => {
    // 896 intervals, 310 of them verified. Pinned so a change to the interval
    // rule shows up as a changed number rather than as a quiet drift.
    const r = verification(
      at({ intervals: 896, verifiedIntervals: 310, selfRepaired: 0, humanRescued: 0, unresolved: 0 }),
    )
    expect(r.v).toBeCloseTo(0.346, 3)
  })
})
