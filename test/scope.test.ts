import { describe, expect, it } from 'vitest'
import { daysRolled, windowScope } from '@/collect/scope.js'

/**
 * The window is the most recent ten *active* days — days carrying at least one
 * human turn — not the most recent ten calendar days. This corpus spans 47
 * calendar days and has 11 active ones, so a span-based window would put a
 * five-week gap inside the thing it measures.
 */

const days = (...d: readonly string[]) => d

/** A run day after everything, so every fixture day counts as complete. */
const LATER = '2099-01-01'

describe('choosing the window', () => {
  it('takes the most recent n active days', () => {
    const s = windowScope(days('2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'), 2, 'Z', LATER)
    expect(s?.ordered).toEqual(['2026-08-03', '2026-08-04'])
    expect(s?.start).toBe('2026-08-03')
    expect(s?.end).toBe('2026-08-04')
    expect(s?.activeDaysInWindow).toBe(2)
    expect(s?.activeDaysAll).toBe(4)
  })

  it('is inclusive at both ends', () => {
    const s = windowScope(days('2026-08-01', '2026-08-02'), 2, 'Z', LATER)
    expect(s?.days.has('2026-08-01')).toBe(true)
    expect(s?.days.has('2026-08-02')).toBe(true)
  })

  it('counts active days, not the span between them', () => {
    // The case this rule exists for. Four active days five weeks apart are four
    // days of work, not thirty-eight.
    const s = windowScope(days('2026-07-08', '2026-07-09', '2026-08-16', '2026-08-17'), 3, 'Z', LATER)
    expect(s?.ordered).toEqual(['2026-07-09', '2026-08-16', '2026-08-17'])
    expect(s?.days.has('2026-07-20')).toBe(false)
  })

  it('sorts chronologically however the days arrive', () => {
    const s = windowScope(days('2026-08-04', '2026-08-01', '2026-08-03'), 2, 'Z', LATER)
    expect(s?.ordered).toEqual(['2026-08-03', '2026-08-04'])
  })

  it('deduplicates, because a day is a day however many rows it holds', () => {
    const s = windowScope(days('2026-08-01', '2026-08-01', '2026-08-02'), 10, 'Z', LATER)
    expect(s?.activeDaysAll).toBe(2)
  })

  it('says when the corpus is shorter than the window asked for', () => {
    const short = windowScope(days('2026-08-01', '2026-08-02'), 10, 'Z', LATER)
    expect(short?.truncated).toBe(true)
    expect(short?.activeDaysInWindow).toBe(2)
    const full = windowScope(days('2026-08-01', '2026-08-02'), 2, 'Z', LATER)
    expect(full?.truncated).toBe(false)
  })

  it('selects everything when the window is at least as long as the corpus', () => {
    // The state this machine is in under a UTC day boundary: 10 active days
    // against a window of 10. A filter that does nothing looks correct here,
    // which is why this case is named rather than left implicit.
    const all = windowScope(days('a', 'b', 'c'), 3, 'Z', LATER)
    expect(all?.activeDaysInWindow).toBe(all?.activeDaysAll)
    expect(all?.truncated).toBe(false)
  })

  it('is null when there is nothing to window', () => {
    // An empty window is not a window, and one with undefined ends would put
    // two undefined values into a payload as though they were days.
    expect(windowScope([], 10, 'Z', LATER)).toBeNull()
    expect(windowScope(days('2026-08-01'), 0, 'Z', LATER)).toBeNull()
  })

  it('carries the boundary it was cut on', () => {
    expect(windowScope(days('2026-08-01'), 1, '+09:00', LATER)?.dayBoundary).toBe('+09:00')
  })
})

describe('how far the window rolled', () => {
  const now = windowScope(days('2026-08-03', '2026-08-04', '2026-08-05'), 3, 'Z', LATER)

  it('counts the days the previous window did not have', () => {
    expect(daysRolled(now!, ['2026-08-03', '2026-08-04', '2026-08-05'])).toBe(0)
    expect(daysRolled(now!, ['2026-08-02', '2026-08-03', '2026-08-04'])).toBe(1)
    expect(daysRolled(now!, ['2026-07-01'])).toBe(3)
  })

  it('is null rather than zero when the previous set is unknown', () => {
    // Every snapshot written before the day set was stored. Null and zero must
    // be different: an all-time previous signature set intersected with a
    // window-scoped current one inflates the carried share, and "we cannot
    // tell" is not "nothing rolled".
    expect(daysRolled(now!, null)).toBeNull()
    expect(daysRolled(now!, [])).toBe(3)
  })
})

describe('the day the run happens on', () => {
  /**
   * A day still being written is a fraction of a day. Measured on this corpus,
   * the median day is 6.9% written by 09:00, 37.8% by noon, 46.3% by 15:00 and
   * 76.1% by 18:00 — so counting the current day as one active day measures the
   * hour of the run.
   *
   * The cost is not the missing fraction, it is the eviction: a partial day
   * takes a window slot from a complete one. On 2026-08-24 a day holding 77
   * rows pushed a day holding 2,285 out of the window — 5.7% of the corpus left
   * because 0.2% of it arrived.
   */
  it('leaves the in-flight day out of the window and names it', () => {
    const s = windowScope(
      days('2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'),
      3,
      'Z',
      '2026-08-23',
    )
    expect(s?.ordered).toEqual(['2026-08-20', '2026-08-21', '2026-08-22'])
    expect(s?.days.has('2026-08-23')).toBe(false)
    expect(s?.inFlightDay).toBe('2026-08-23')
    expect(s?.includesInFlightDay).toBe(false)
  })

  it('does not let a partial day evict a complete one', () => {
    // The exact shape measured on this machine: eleven active days, the newest
    // barely started. Including it drops the oldest; excluding it does not.
    const active = days(
      '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11',
      '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
      '2026-08-20', '2026-08-23', '2026-08-24',
    )
    const s = windowScope(active, 10, 'Z', '2026-08-24')
    expect(s?.days.has('2026-07-08')).toBe(true)
    expect(s?.days.has('2026-08-24')).toBe(false)
    expect(s?.activeDaysInWindow).toBe(10)
  })

  it('gives the same window twice on the same day', () => {
    // The property a tool that compares windows needs most: two runs on one day
    // select exactly the same evidence, so a delta between them is zero for a
    // reason rather than by luck.
    const active = days('2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23')
    const morning = windowScope(active, 3, 'Z', '2026-08-23')
    const evening = windowScope(active, 3, 'Z', '2026-08-23')
    expect(morning?.ordered).toEqual(evening?.ordered)
  })

  it('reports no in-flight day when the run day carried no work', () => {
    const s = windowScope(days('2026-08-20', '2026-08-21'), 3, 'Z', '2026-08-25')
    expect(s?.inFlightDay).toBeNull()
    expect(s?.ordered).toEqual(['2026-08-20', '2026-08-21'])
  })

  it('uses the in-flight day when there is no complete one, and says so', () => {
    // A first run. Refusing here would tell a new user to come back tomorrow.
    const s = windowScope(days('2026-08-23'), 10, 'Z', '2026-08-23')
    expect(s?.ordered).toEqual(['2026-08-23'])
    expect(s?.includesInFlightDay).toBe(true)
    expect(s?.inFlightDay).toBe('2026-08-23')
  })

  it('does not call a window truncated by the day it never offered', () => {
    // Three complete days against a window of three is a full window, even
    // though a fourth active day exists and is in flight.
    const s = windowScope(
      days('2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'),
      3,
      'Z',
      '2026-08-23',
    )
    expect(s?.truncated).toBe(false)
    expect(s?.activeDaysAll).toBe(4)
  })
})
