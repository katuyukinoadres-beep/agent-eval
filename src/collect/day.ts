/**
 * Turning a timestamp into the calendar day it belongs to.
 *
 * One place, because the answer decides what the window contains and the two
 * plausible answers differ. This corpus has **10** human-turn days when the day
 * boundary is UTC and **11** when it is +09:00 — and the window is the most
 * recent ten active days, so under UTC the window selects the whole corpus and
 * a filter that does nothing at all looks correct. The offset is the difference
 * between a working window and a dead one on this machine.
 *
 * What this replaces is `ts.slice(0, 10)`, which parses nothing and names no
 * timezone. It is a UTC day, silently, and nothing in the payload said so.
 */

/** A calendar day, `YYYY-MM-DD`, in the boundary the caller chose. */
export type Day = string

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const MINUTES = 60_000
/** Beyond this the value is not a timezone offset. Kiritimati is +14:00. */
const MAX_OFFSET_MINUTES = 14 * 60

/**
 * The offset an ISO 8601 timestamp declares, in minutes east of UTC.
 *
 * `Z` is zero. A missing or unreadable offset is also zero, because a day
 * boundary has to be *some* boundary and UTC is the one that needs no
 * assumption about where the machine is — but the value that was used is
 * published, so a reader never has to infer which it was.
 */
export function offsetMinutesOf(iso: string): number {
  if (iso.endsWith('Z')) return 0
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso)
  if (m === null) return 0
  const hours = Number.parseInt(m[2] as string, 10)
  const minutes = Number.parseInt(m[3] as string, 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0
  const total = hours * 60 + minutes
  if (total > MAX_OFFSET_MINUTES) return 0
  return m[1] === '-' ? -total : total
}

/** The offset as it is written, for publishing. `Z` when there is none. */
export function offsetLabelOf(iso: string): string {
  if (iso.endsWith('Z')) return 'Z'
  const m = /([+-]\d{2}:\d{2})$/.exec(iso)
  return m === null ? 'Z' : (m[1] as string)
}

/**
 * An instant written in this machine's own offset, `2026-08-23T22:14:07+09:00`.
 *
 * The report's timestamp is what the day boundary is taken from, and an active
 * day is a day of somebody's work — which ends at their midnight, not at UTC's.
 * Stamping the report in UTC on a machine nine hours ahead splits every evening
 * across two days, and the window counts days.
 *
 * On this corpus the choice is the difference between 10 active days and 11,
 * against a window of the most recent 10: under UTC the window selects the
 * whole corpus and does nothing at all.
 */
export function localIso(at: Date): string {
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm = String(Math.abs(offset) % 60).padStart(2, '0')
  const local = new Date(at.getTime() + offset * MINUTES).toISOString().slice(0, -1)
  return `${local}${sign}${hh}:${mm}`
}

/**
 * The day a timestamp falls on, under the given boundary.
 *
 * Null rather than a guess when the value is not a string, does not parse, or
 * produces something that is not a day. 11.08% of rows on this machine carry no
 * parsable timestamp, and they belong in a bucket of their own rather than in
 * whichever day happened to be nearby.
 */
export function dayOf(ts: unknown, offsetMinutes: number): Day | null {
  if (typeof ts !== 'string' || ts.length === 0) return null
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return null
  const shifted = new Date(ms + offsetMinutes * MINUTES).toISOString().slice(0, 10)
  return DAY_RE.test(shifted) ? shifted : null
}
