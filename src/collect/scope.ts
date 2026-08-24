/**
 * Which days the window covers.
 *
 * The spec cuts the window in *active days* — a calendar day carrying at least
 * one human turn — and takes the most recent ten of them (v2, C-04). Not
 * calendar days: this corpus spans 47 calendar days and has 11 active ones, and
 * a span-based window would put a five-week gap inside the thing it measures.
 *
 * Membership is by SET, not by range. A calendar day between the first and last
 * active day that carries no human turn — a long unattended run, say — is not
 * in the window, and nothing anchored to it counts. That is the only reading
 * under which `windowDays` is a count of active days rather than of a span, and
 * the cost is real: those days can be dense in failures. It is published as a
 * number rather than left as a policy inside a branch.
 *
 * Both ends are inclusive, and the window is built from *complete* active days
 * only. The day a run happens on is still being written, and counting it as one
 * active day measures the hour of the run rather than the environment: the
 * median day here is 6.9% written by 09:00, 37.8% by noon, 46.3% by 15:00 and
 * 76.1% by 18:00.
 *
 * The cost of including it is not the missing fraction, it is the eviction. A
 * partial day takes a slot, and the slot it takes belongs to a complete one.
 * Measured on this corpus on 2026-08-24: a day holding 77 rows pushed a day
 * holding 2,285 rows out of the window — 5.7% of the corpus left because 0.2%
 * of it arrived.
 *
 * So the in-flight day is reported and not scored, and the window is a function
 * of complete days alone. Two runs on the same day then select exactly the same
 * evidence, which is the property a tool that compares windows needs most.
 *
 * The exception is a first run with no complete active day at all. Refusing
 * there would mean a new user is told to come back tomorrow, so the in-flight
 * day is used and `includesInFlightDay` says so.
 */

import type { Day } from './day.js'

export interface WindowScope {
  /** The selected active days. Membership is by this set. */
  readonly days: ReadonlySet<Day>
  /** The same, oldest first, so a per-day series has an order to publish in. */
  readonly ordered: readonly Day[]
  readonly start: Day
  readonly end: Day
  /** What was asked for. The spec's constant, not a setting. */
  readonly windowDays: number
  /** How many were available: `min(windowDays, activeDaysAll)`. */
  readonly activeDaysInWindow: number
  /** Active days in the whole corpus. The spec's `window.activeDays`. */
  readonly activeDaysAll: number
  /** True when the corpus has fewer active days than the window asked for. */
  readonly truncated: boolean
  /** The offset the days were cut on, as written. Published, never inferred. */
  readonly dayBoundary: string
  /**
   * The day the run happened on, when it carries work. Reported, not scored.
   *
   * Null when the run's own day has no human turn — a run on a quiet morning
   * about yesterday's work.
   */
  readonly inFlightDay: Day | null
  /**
   * True when the window had to use the in-flight day for want of a complete
   * one. Only a first run, and it is said rather than hidden.
   */
  readonly includesInFlightDay: boolean
}

/**
 * The window over a set of active days.
 *
 * `humanTurnDates` is what the scan already returns, so this costs no extra
 * read and no extra pass. Sorting `YYYY-MM-DD` lexicographically is sorting it
 * chronologically, which is the one thing that format is for.
 *
 * Null when there are no active days at all: an empty window is not a window,
 * and returning one with `start === end === undefined` would put two undefined
 * values into a payload as though they were days.
 */
export function windowScope(
  humanTurnDates: readonly Day[],
  windowDays: number,
  dayBoundary: string,
  /** The day the run happens on. Everything on or after it is still in flight. */
  measuredOn: Day,
): WindowScope | null {
  const active = [...new Set(humanTurnDates)].sort()
  if (active.length === 0 || windowDays <= 0) return null

  // Complete days only. A day still being written is a fraction of a day, and
  // spending a window slot on it evicts a whole one.
  const complete = active.filter((d) => d < measuredOn)
  const inFlightDay = active.includes(measuredOn) ? measuredOn : null
  const includesInFlightDay = complete.length === 0
  const usable = includesInFlightDay ? active : complete

  const ordered = usable.slice(Math.max(0, usable.length - windowDays))
  const start = ordered[0] as Day
  const end = ordered[ordered.length - 1] as Day

  return {
    days: new Set(ordered),
    ordered,
    start,
    end,
    windowDays,
    activeDaysInWindow: ordered.length,
    activeDaysAll: active.length,
    // Against the days that could have filled it, not against every day seen:
    // the in-flight day was never a candidate, so counting it here would report
    // a truncation that is not one.
    truncated: usable.length < windowDays,
    dayBoundary,
    inFlightDay,
    includesInFlightDay,
  }
}

/**
 * How many of this window's days the previous window did not have.
 *
 * Null when the previous window's day set is unknown — which is every snapshot
 * written before the set was stored. Null is not zero: an all-time previous
 * signature set intersected with a window-scoped current one inflates the
 * carried share, so "we cannot tell" has to be distinguishable from "nothing
 * rolled".
 */
export function daysRolled(now: WindowScope, previous: readonly Day[] | null): number | null {
  if (previous === null) return null
  const before = new Set(previous)
  let rolled = 0
  for (const d of now.days) if (!before.has(d)) rolled += 1
  return rolled
}
