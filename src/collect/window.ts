/**
 * Assembles the window and the external-log block from the pieces.
 *
 * This is where the record rate that reached 107.1% is actually constructed, so
 * the construction is arranged to make that impossible rather than to check for
 * it afterwards: the numerator is built by intersecting the log's dates with the
 * denominator set, so it is a subset by operation and not by inspection. A
 * numerator computed independently and then compared is a numerator that can
 * disagree.
 */

import type { ActiveDaysMethod, Window, WindowSource } from '../payload/types.js'
import { windowScope } from './scope.js'
import { makeMetric } from '../payload/metric.js'
import type { Metric } from '../payload/metric.js'
import type { SettingsScope } from './settings.js'

export interface WindowInputs {
  /** Every date any transcript line carried. */
  readonly jsonlDates: readonly string[]
  /** Days carrying a user row of any kind. */
  readonly userRowDates: readonly string[]
  /** The same human-turn days recut on UTC, so the boundary's effect is visible. */
  readonly humanTurnDatesUtc: readonly string[]
  /** The offset the days were cut on, as written. Published, never inferred. */
  readonly dayBoundary: string
  /**
   * Days carrying at least one human turn under P1. The window's own unit.
   *
   * Not `origin.kind === 'human'`, which is what this said while the code did
   * something else. That field is on 2.7% of user rows here, so following the
   * comment lands on about five active days instead of eleven — one away from
   * the five-day suppression gate.
   */
  readonly humanTurnDates: readonly string[]
  readonly gitDates: readonly string[]
  readonly externalDates: readonly string[]
  readonly externalExists: boolean
  readonly externalRows: number
  readonly cleanupPeriodDays: number | null
  readonly cleanupFoundAt: SettingsScope | null
  /** How many active days the analysis looks back over. */
  readonly windowDays: number
}

export interface AssembledWindow {
  readonly window: Window
  /** Days with evidence of work from any source — the record rate's denominator. */
  readonly evidenceDays: number
  readonly evidenceDaysMethod: ActiveDaysMethod
  readonly recordRate: Metric
  readonly recordRateCalendar: Metric
  readonly recordedDays: number
  /**
   * Rows in the external log, carried through unchanged.
   *
   * A row count, where every other number here is a day count. They differ by
   * 2.8x on this machine — 42 rows over 15 days — and either reads plausibly as
   * the other, so it keeps a name that cannot be confused with `recordedDays`.
   */
  readonly externalRows: number
  /**
   * Days the external log is the only surviving record of — measured against
   * the raw sources (jsonl and git), not against the denominator.
   *
   * This is the reason the denominator is a union rather than a max. Under
   * `max` these days landed in the numerator and not the denominator, which is
   * the whole of the 107.1%.
   *
   * Measured against the denominator instead, it would read zero on every real
   * machine — the log is part of that union by then. Zero is also what a dead
   * field reads, so it is measured where it can still be non-zero.
   */
  readonly externalOnlyDays: number
}

const DAY_MS = 86_400_000

/** Calendar days spanned, inclusive of both ends. Zero when nothing was observed. */
export function calendarSpan(dates: readonly string[]): number {
  if (dates.length === 0) return 0
  const sorted = [...dates].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (first === undefined || last === undefined) return 0
  const a = Date.parse(`${first}T00:00:00Z`)
  const b = Date.parse(`${last}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / DAY_MS) + 1
}

/** The longest run of consecutive calendar days present in the set. */
export function longestRun(dates: readonly string[]): number {
  const sorted = [...new Set(dates)].sort()
  let best = 0
  let run = 0
  let prev = Number.NaN
  for (const d of sorted) {
    const t = Date.parse(`${d}T00:00:00Z`)
    if (Number.isNaN(t)) continue
    run = !Number.isNaN(prev) && t - prev === DAY_MS ? run + 1 : 1
    prev = t
    if (run > best) best = run
  }
  return best
}

/**
 * Which sources actually contributed, named in the order the spec writes them.
 *
 * Derived from what produced dates, not from what was asked for. A git client
 * that ran and returned nothing must not leave `git` in the label — the method
 * would then claim a source the denominator does not contain.
 */
export function methodFor(hasGit: boolean, hasExternal: boolean): ActiveDaysMethod {
  if (hasGit && hasExternal) return 'union-of-observed(git, jsonl, externalLog)'
  if (hasExternal) return 'union-of-observed(jsonl, externalLog)'
  // No union member exists for git-without-external, so such an environment
  // reports the jsonl-only method and loses the git days rather than shipping a
  // label the receiver cannot parse. Raised with the spec's author.
  return 'union-of-observed(jsonl)'
}

export function assembleWindow(inputs: WindowInputs): AssembledWindow {
  const {
    jsonlDates, userRowDates, humanTurnDates, humanTurnDatesUtc, dayBoundary,
    gitDates, externalDates,
    externalExists, externalRows, cleanupPeriodDays, cleanupFoundAt, windowDays,
  } = inputs

  const hasGit = gitDates.length > 0
  const hasExternal = externalExists && externalDates.length > 0
  const method = methodFor(hasGit, hasExternal)

  // The denominator set. `git` is folded in only when the label says so, so the
  // set and its description cannot describe different unions.
  const evidence = new Set<string>(jsonlDates)
  if (method === 'union-of-observed(git, jsonl, externalLog)') for (const d of gitDates) evidence.add(d)
  if (hasExternal) for (const d of externalDates) evidence.add(d)

  // The numerator, by intersection. Not a count taken from the log — a day the
  // log holds that the denominator does not is dropped here rather than raising
  // the ratio above 1.
  let recordedDays = 0
  for (const d of new Set(externalDates)) if (evidence.has(d)) recordedDays += 1

  // Days the log is the sole surviving record of, measured against the raw
  // sources rather than against the denominator.
  //
  // Against the denominator it would be zero on every real machine, because the
  // log is unioned into the denominator a few lines above. A field that is
  // structurally zero in production is the shape this tool exists to find:
  // `isSidechain`, `toolUseResult.interrupted` and `preventedContinuation` all
  // read as working detectors right up until someone asks what would make them
  // fire.
  const raw = new Set<string>(jsonlDates)
  for (const d of gitDates) raw.add(d)
  let externalOnly = 0
  for (const d of new Set(externalDates)) if (!raw.has(d)) externalOnly += 1

  const evidenceDays = evidence.size
  const spanDays = calendarSpan([...evidence])

  const windowSource: WindowSource = cleanupFoundAt === null ? 'observed' : 'setting'

  // The days the window actually covers. Computed here rather than assumed,
  // because `activeDays` and `activeDaysInWindow` being equal is a fact about
  // this corpus -- ten active days against a window of ten -- and not a
  // property of the window. A figure that did not move is not evidence the
  // window works.
  const scope = windowScope(humanTurnDates, windowDays, dayBoundary)

  const window: Window = {
    unit: 'activeDays',
    windowDays,
    windowSource,
    cleanupPeriodDays: cleanupFoundAt === null ? null : cleanupPeriodDays,
    calendarSpanDays: spanDays,
    activeDays: new Set(humanTurnDates).size,
    activeDaysMethod: 'human-turn-days',
    dayBoundary,
    activeDaysUtc: new Set(humanTurnDatesUtc).size,
    activeDaysInWindow: scope?.activeDaysInWindow ?? 0,
    truncated: scope?.truncated ?? true,
    windowStart: scope?.start ?? null,
    windowEnd: scope?.end ?? null,
    userRowDays: new Set(userRowDates).size,
    contiguousDays: longestRun([...evidence]),
    gapCount: Math.max(0, spanDays - evidenceDays),
  }

  return {
    window,
    evidenceDays,
    evidenceDaysMethod: method,
    recordedDays,
    externalOnlyDays: externalOnly,
    recordRate: makeMetric({
      numerator: recordedDays,
      denominator: Math.max(1, evidenceDays),
      denominatorMeaning: '作業した証拠のある日のうち、外部ログに入っている割合',
      sourceField: 'externalLog.dates',
    }),
    recordRateCalendar: makeMetric({
      numerator: recordedDays,
      denominator: Math.max(1, spanDays),
      denominatorMeaning: '暦日のうち記録がある日の割合（作業頻度を答える別指標）',
      sourceField: 'jsonl.timestamps',
    }),
    externalRows,
  }
}
