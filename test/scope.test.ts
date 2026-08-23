import { describe, expect, it } from 'vitest'
import { daysRolled, windowScope } from '@/collect/scope.js'

/**
 * The window is the most recent ten *active* days — days carrying at least one
 * human turn — not the most recent ten calendar days. This corpus spans 47
 * calendar days and has 11 active ones, so a span-based window would put a
 * five-week gap inside the thing it measures.
 */

const days = (...d: readonly string[]) => d

describe('choosing the window', () => {
  it('takes the most recent n active days', () => {
    const s = windowScope(days('2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'), 2, 'Z')
    expect(s?.ordered).toEqual(['2026-08-03', '2026-08-04'])
    expect(s?.start).toBe('2026-08-03')
    expect(s?.end).toBe('2026-08-04')
    expect(s?.activeDaysInWindow).toBe(2)
    expect(s?.activeDaysAll).toBe(4)
  })

  it('is inclusive at both ends', () => {
    const s = windowScope(days('2026-08-01', '2026-08-02'), 2, 'Z')
    expect(s?.days.has('2026-08-01')).toBe(true)
    expect(s?.days.has('2026-08-02')).toBe(true)
  })

  it('counts active days, not the span between them', () => {
    // The case this rule exists for. Four active days five weeks apart are four
    // days of work, not thirty-eight.
    const s = windowScope(days('2026-07-08', '2026-07-09', '2026-08-16', '2026-08-17'), 3, 'Z')
    expect(s?.ordered).toEqual(['2026-07-09', '2026-08-16', '2026-08-17'])
    expect(s?.days.has('2026-07-20')).toBe(false)
  })

  it('sorts chronologically however the days arrive', () => {
    const s = windowScope(days('2026-08-04', '2026-08-01', '2026-08-03'), 2, 'Z')
    expect(s?.ordered).toEqual(['2026-08-03', '2026-08-04'])
  })

  it('deduplicates, because a day is a day however many rows it holds', () => {
    const s = windowScope(days('2026-08-01', '2026-08-01', '2026-08-02'), 10, 'Z')
    expect(s?.activeDaysAll).toBe(2)
  })

  it('says when the corpus is shorter than the window asked for', () => {
    const short = windowScope(days('2026-08-01', '2026-08-02'), 10, 'Z')
    expect(short?.truncated).toBe(true)
    expect(short?.activeDaysInWindow).toBe(2)
    const full = windowScope(days('2026-08-01', '2026-08-02'), 2, 'Z')
    expect(full?.truncated).toBe(false)
  })

  it('selects everything when the window is at least as long as the corpus', () => {
    // The state this machine is in under a UTC day boundary: 10 active days
    // against a window of 10. A filter that does nothing looks correct here,
    // which is why this case is named rather than left implicit.
    const all = windowScope(days('a', 'b', 'c'), 3, 'Z')
    expect(all?.activeDaysInWindow).toBe(all?.activeDaysAll)
    expect(all?.truncated).toBe(false)
  })

  it('is null when there is nothing to window', () => {
    // An empty window is not a window, and one with undefined ends would put
    // two undefined values into a payload as though they were days.
    expect(windowScope([], 10, 'Z')).toBeNull()
    expect(windowScope(days('2026-08-01'), 0, 'Z')).toBeNull()
  })

  it('carries the boundary it was cut on', () => {
    expect(windowScope(days('2026-08-01'), 1, '+09:00')?.dayBoundary).toBe('+09:00')
  })
})

describe('how far the window rolled', () => {
  const now = windowScope(days('2026-08-03', '2026-08-04', '2026-08-05'), 3, 'Z')

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
