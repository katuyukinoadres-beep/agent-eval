import { describe, expect, it } from 'vitest'
import { assembleWindow, calendarSpan, longestRun, methodFor, type WindowInputs } from '@/collect/window.js'

/**
 * This is where the 107.1% was actually built.
 *
 * The record rate reached 107.1% because the numerator was counted from the
 * external log and the denominator from `max(git, jsonl)`. Three days lived only
 * in the log — 2026-04-17/18/19, before the first commit, with transcripts long
 * since pruned — so they raised the numerator and not the denominator.
 *
 * The fix is not a check. The numerator is produced by intersecting the log's
 * dates with the denominator set, so it is a subset by operation. A test that
 * feeds it external-only days and watches the ratio stay at or below 1 is
 * testing the construction, not a guard bolted on after it.
 */

const base: WindowInputs = {
  jsonlDates: ['2026-08-16', '2026-08-17', '2026-08-18'],
  userRowDates: ['2026-08-16', '2026-08-17', '2026-08-18'],
  humanTurnDates: ['2026-08-17', '2026-08-18'],
  humanTurnDatesUtc: [],
  dayBoundary: 'Z',
  measuredOn: '2099-01-01',
  gitDates: [],
  externalDates: [],
  externalExists: false,
  externalRows: 0,
  cleanupPeriodDays: null,
  cleanupFoundAt: null,
  windowDays: 10,
}

const withInputs = (over: Partial<WindowInputs>): WindowInputs => ({ ...base, ...over })

describe('the record rate cannot exceed one', () => {
  // Two independent things hold it below 1, and either alone is enough:
  // the log's dates are unioned into the denominator, and the numerator is an
  // intersection with that denominator. Asserting only `numerator <=
  // denominator` therefore proves nothing — it passes with either mechanism
  // removed. Each is pinned by what it uniquely produces instead.
  const shape = withInputs({
    externalExists: true,
    externalRows: 9,
    // The real days: 2026-04-17/18/19 predate the first commit and their
    // transcripts are long since pruned, so the log is the only source that
    // still has them.
    externalDates: ['2026-04-17', '2026-04-18', '2026-04-19', '2026-08-16'],
  })

  it('puts a log-only day in the denominator instead of dropping it', () => {
    // This is the difference from max(). Under max the three April days raised
    // the numerator and not the denominator, which is the whole of the 107.1%.
    // Removing the union line takes this from 6 to 3.
    const a = assembleWindow(shape)
    expect(a.evidenceDays).toBe(6)
    expect(a.recordedDays).toBe(4)
    expect(a.recordRate.denominator).toBe(6)
  })

  it('reports log-only days as non-zero on the shape that actually ships', () => {
    // Measured against the denominator this would be zero here, and zero on
    // every real machine, because the log is unioned into the denominator
    // before the comparison. That is what a dead field reads: `isSidechain`,
    // `toolUseResult.interrupted` and `preventedContinuation` all returned a
    // constant zero and looked like working detectors for months.
    //
    // So it is measured against jsonl and git — the sources the log outlives —
    // where it can still be non-zero. Three, here, and 4 on the real machine.
    const a = assembleWindow(shape)
    expect(a.externalOnlyDays).toBe(3)
  })

  it('counts only the log days the denominator holds', () => {
    // The state where the two mechanisms come apart: a caller that hands over
    // dates while saying the log does not exist. The union then excludes them,
    // and the intersection is the only thing standing between the numerator and
    // a ratio above 1. Removing the intersection takes recordedDays to 4 over a
    // denominator of 3.
    const a = assembleWindow(withInputs({
      externalExists: false,
      externalRows: 9,
      externalDates: ['2026-04-17', '2026-04-18', '2026-04-19', '2026-08-16'],
    }))
    expect(a.evidenceDays).toBe(3)
    expect(a.recordedDays).toBe(1)
    expect(a.externalOnlyDays).toBe(3)
    expect(a.recordRate.numerator).toBeLessThanOrEqual(a.recordRate.denominator)
  })
})

describe('the method names what the denominator actually contains', () => {
  it('names git only when git produced dates', () => {
    const withGit = assembleWindow(withInputs({
      gitDates: ['2026-04-20'],
      externalExists: true,
      externalRows: 1,
      externalDates: ['2026-08-16'],
    }))
    expect(withGit.evidenceDaysMethod).toBe('union-of-observed(git, jsonl, externalLog)')
    expect(withGit.evidenceDays).toBe(4)

    // A git client that ran and returned nothing must not leave `git` in the
    // label: the method would claim a source the denominator does not hold.
    const noGit = assembleWindow(withInputs({
      gitDates: [],
      externalExists: true,
      externalRows: 1,
      externalDates: ['2026-08-16'],
    }))
    expect(noGit.evidenceDaysMethod).toBe('union-of-observed(jsonl, externalLog)')
  })

  it('falls back to jsonl alone when there is no log', () => {
    expect(assembleWindow(base).evidenceDaysMethod).toBe('union-of-observed(jsonl)')
  })

  it('maps every combination to a method the spec defines', () => {
    for (const g of [true, false]) {
      for (const e of [true, false]) {
        expect(methodFor(g, e)).toMatch(/^union-of-observed\(/)
      }
    }
  })
})

describe('windowSource follows what the settings sweep found', () => {
  it('is observed when no scope defined the period', () => {
    const a = assembleWindow(base)
    expect(a.window.windowSource).toBe('observed')
    expect(a.window.cleanupPeriodDays).toBeNull()
  })

  it('is setting when one did, and carries the value', () => {
    const a = assembleWindow(withInputs({ cleanupPeriodDays: 14, cleanupFoundAt: 'user' }))
    expect(a.window.windowSource).toBe('setting')
    expect(a.window.cleanupPeriodDays).toBe(14)
  })

  it('refuses to carry a period it did not find, whatever it was handed', () => {
    // The contradiction base itself shipped with: a source of `setting` beside
    // a null period. Here the period arrives without a scope and is dropped
    // rather than reported as configured.
    const a = assembleWindow(withInputs({ cleanupPeriodDays: 14, cleanupFoundAt: null }))
    expect(a.window.windowSource).toBe('observed')
    expect(a.window.cleanupPeriodDays).toBeNull()
  })
})

describe('the three day counts nest', () => {
  it('human-turn days sit inside user-row days sit inside evidence days', () => {
    // 5 / 9 / 16 on this machine. The middle term exists because the first is a
    // function of origin coverage, which is 3.11% here.
    const a = assembleWindow(withInputs({
      humanTurnDates: ['2026-08-17'],
      userRowDates: ['2026-08-16', '2026-08-17', '2026-08-18'],
      gitDates: ['2026-04-20'],
      externalExists: true,
      externalRows: 2,
      externalDates: ['2026-08-16'],
    }))
    expect(a.window.activeDays).toBe(1)
    expect(a.window.userRowDays).toBe(3)
    expect(a.evidenceDays).toBe(4)
    expect(a.window.activeDays).toBeLessThanOrEqual(a.window.userRowDays)
    expect(a.window.userRowDays).toBeLessThanOrEqual(a.evidenceDays)
  })

  it('deduplicates, so a repeated day is one day', () => {
    const a = assembleWindow(withInputs({ humanTurnDates: ['2026-08-17', '2026-08-17'] }))
    expect(a.window.activeDays).toBe(1)
  })
})

describe('span and run', () => {
  it('counts a calendar span inclusive of both ends', () => {
    expect(calendarSpan(['2026-08-16', '2026-08-18'])).toBe(3)
    expect(calendarSpan(['2026-08-16'])).toBe(1)
    expect(calendarSpan([])).toBe(0)
  })

  it('finds the longest consecutive run, not the total', () => {
    expect(longestRun(['2026-08-01', '2026-08-02', '2026-08-05'])).toBe(2)
    expect(longestRun(['2026-08-01', '2026-08-03', '2026-08-05'])).toBe(1)
    expect(longestRun([])).toBe(0)
  })

  it('handles a run crossing a month boundary', () => {
    // Arithmetic on the day number alone breaks here; this uses epoch millis.
    expect(longestRun(['2026-07-31', '2026-08-01', '2026-08-02'])).toBe(3)
  })

  it('gaps are the span minus the days that had something in them', () => {
    const a = assembleWindow(withInputs({ jsonlDates: ['2026-08-16', '2026-08-20'] }))
    expect(a.window.calendarSpanDays).toBe(5)
    expect(a.window.gapCount).toBe(3)
  })
})
