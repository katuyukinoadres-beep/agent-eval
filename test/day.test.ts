import { describe, expect, it } from 'vitest'
import { DAY_RE, dayOf, offsetLabelOf, offsetMinutesOf } from '@/collect/day.js'

/**
 * The day boundary decides whether the window is a window.
 *
 * Measured on this corpus: 10 human-turn days under UTC and 11 under +09:00,
 * against a window of the most recent 10 active days. Under UTC the window
 * therefore selects everything, and a filter that does nothing at all would
 * pass every test written against this machine. The offset is the difference
 * between a working window and a dead one here, which is why it is published
 * rather than assumed.
 */

describe('reading the offset', () => {
  it('reads Z as zero and a written offset as itself', () => {
    expect(offsetMinutesOf('2026-08-23T00:00:00.000Z')).toBe(0)
    expect(offsetMinutesOf('2026-08-23T09:00:00+09:00')).toBe(540)
    expect(offsetMinutesOf('2026-08-23T09:00:00-05:00')).toBe(-300)
    expect(offsetMinutesOf('2026-08-23T09:00:00+05:30')).toBe(330)
  })

  it('falls back to UTC rather than guessing', () => {
    expect(offsetMinutesOf('2026-08-23T09:00:00')).toBe(0)
    expect(offsetMinutesOf('')).toBe(0)
  })

  it('refuses an offset no timezone has', () => {
    // A malformed suffix that parses as a number would otherwise shift a day by
    // an arbitrary amount, quietly.
    expect(offsetMinutesOf('2026-08-23T09:00:00+99:00')).toBe(0)
  })

  it('reports the label it used, so a reader never infers it', () => {
    expect(offsetLabelOf('2026-08-23T00:00:00.000Z')).toBe('Z')
    expect(offsetLabelOf('2026-08-23T09:00:00+09:00')).toBe('+09:00')
    expect(offsetLabelOf('2026-08-23T09:00:00')).toBe('Z')
  })
})

describe('the day a timestamp falls on', () => {
  it('changes with the boundary, which is the whole point', () => {
    // 15:30 UTC is the next day in Tokyo. On this corpus that single rule is
    // what turns 10 active days into 11.
    const ts = '2026-08-18T15:30:00.000Z'
    expect(dayOf(ts, 0)).toBe('2026-08-18')
    expect(dayOf(ts, 540)).toBe('2026-08-19')
  })

  it('goes backwards for a western offset', () => {
    expect(dayOf('2026-08-18T02:00:00.000Z', -300)).toBe('2026-08-17')
  })

  it('reads a timestamp that carries its own offset', () => {
    // Same instant, written two ways. The day must not depend on the spelling.
    expect(dayOf('2026-08-19T00:30:00+09:00', 540)).toBe('2026-08-19')
    expect(dayOf('2026-08-18T15:30:00.000Z', 540)).toBe('2026-08-19')
  })

  it('is null rather than a guess when there is no timestamp', () => {
    // 11.08% of rows here carry none. They belong in a bucket of their own, not
    // in whichever day happened to be nearby.
    expect(dayOf(undefined, 0)).toBeNull()
    expect(dayOf(null, 0)).toBeNull()
    expect(dayOf('', 0)).toBeNull()
    expect(dayOf(1_700_000_000, 0)).toBeNull()
    expect(dayOf('not a date', 0)).toBeNull()
  })

  it('does not accept a string that merely starts with ten plausible characters', () => {
    // The rule this replaces was `ts.slice(0, 10)`, which parses nothing: it
    // would have returned '9999-99-99' from '9999-99-99T00:00:00Z'.
    expect(dayOf('9999-99-99T00:00:00Z', 0)).toBeNull()
    expect(DAY_RE.test('9999-99-99')).toBe(true)
  })
})
