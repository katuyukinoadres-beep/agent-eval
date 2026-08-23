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
 * Both ends are inclusive, and the newest day is included while it is still
 * being written. That makes the boundary depend on the hour a run happens, so
 * two runs on the same day select the same days and must not be differenced —
 * refused by comparing the stored day sets rather than by excluding the day.
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
): WindowScope | null {
  const active = [...new Set(humanTurnDates)].sort()
  if (active.length === 0 || windowDays <= 0) return null

  const ordered = active.slice(Math.max(0, active.length - windowDays))
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
    truncated: active.length < windowDays,
    dayBoundary,
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
