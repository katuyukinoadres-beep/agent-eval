/**
 * Applying the window to a scan.
 *
 * The scan never filters. It reads every row, in order, into counters that are
 * keyed by the day the row belongs to; this selects the days the window covers
 * and re-sums. Everything that goes wrong when rows are dropped mid-pass —
 * orphaned bundles from a severed parentUuid chain, a repeat charged against
 * the wrong first occurrence, a session's first-seen error classes relaxing, an
 * artifact's `lastWrite` moving backwards past its censor — cannot arise,
 * because the reducer's corpus is the same either way.
 *
 * `restrict(counts, null)` is the all-time view, and it must be identical to
 * what the scan reported before any of this existed. That equality is the one
 * assertion standing between this refactor and a silent change to every number
 * the tool produces, and it is worth more here than usual: this machine has ten
 * complete active days against a window of ten, so the real window selects
 * everything and a filter that did nothing at all would look correct.
 */

import type { DayCounts, ScanCounts } from './scan.js'
import type { WindowScope } from './scope.js'

/**
 * Which families of count this view actually windowed.
 *
 * Returned with the view rather than assumed by the reader. A count that should
 * say all-time and does not is indistinguishable from a windowed one, so the
 * answer travels with the data instead of being re-derived downstream.
 */
export interface WindowBasis {
  /** Null for the all-time view. */
  readonly days: readonly string[] | null
  /** Field families this view restricted. */
  readonly windowed: readonly string[]
  /**
   * Field families this view left at their corpus-wide value, and why.
   *
   * Named individually. The dominant way this change goes wrong is one counter
   * left all-time inside a windowed axis, and the only defence is a list that
   * has to be edited when a counter moves.
   */
  readonly allTime: readonly string[]
}

/** Rows with no parsable timestamp. Never in any window, always counted. */
export const UNDATED = 'undated'

/**
 * Counts that cannot be windowed, with the reason each one cannot.
 *
 * `linesParseFailed` is the sharpest: a line that will not parse has no
 * timestamp, so a windowed version is zero by construction and the
 * parse-failure gate becomes a detector that returns a well-formed zero. The
 * file counters come from `statSync` and belong to files rather than to rows.
 */
export const ALL_TIME_REASONS: Readonly<Record<string, string>> = {
  linesRead: 'the gate is judged over the corpus, and undated rows belong to no window',
  linesParseFailed: 'an unparsable line has no timestamp, so a windowed count is zero by construction',
  filesUnreadable: 'per file, from the walk, not per row',
  filesWithoutRows: 'per file, from the walk, not per row',
  bytesRead: 'per file, from statSync',
  mainLines: 'per file line tally, and one side of the lines-close identity',
  subLines: 'per file line tally, and one side of the lines-close identity',
  sessionIdMismatchRows: 'a parser sanity counter over the whole corpus',
  listingChars: 'the skill listing is written at session start, not on a day of work',
  listingTruncated: 'the same',
  sessionIds: 'the cluster set, and one side of the sessions-close identity',
  ambiguousBasenames: 'a property of every path ever seen, not of a day',
}

const sumOver = (
  perDay: Readonly<Record<string, DayCounts>>,
  days: readonly string[] | null,
  pick: (c: DayCounts) => number,
): number => {
  let n = 0
  for (const [day, counts] of Object.entries(perDay)) {
    // The undated bucket is in no window, and in the all-time view it is in.
    if (days !== null && !days.includes(day)) continue
    n += pick(counts)
  }
  return n
}

const anyOver = (
  perDay: Readonly<Record<string, DayCounts>>,
  days: readonly string[] | null,
  pick: (c: DayCounts) => boolean,
): boolean => {
  for (const [day, counts] of Object.entries(perDay)) {
    if (days !== null && !days.includes(day)) continue
    if (pick(counts)) return true
  }
  return false
}

const mergeMaps = (
  perDay: Readonly<Record<string, DayCounts>>,
  days: readonly string[] | null,
  pick: (c: DayCounts) => Map<string, number>,
): Readonly<Record<string, number>> => {
  const out = new Map<string, number>()
  for (const [day, counts] of Object.entries(perDay)) {
    if (days !== null && !days.includes(day)) continue
    for (const [k, n] of pick(counts)) out.set(k, (out.get(k) ?? 0) + n)
  }
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The row-level counts this view windows. Everything else is copied through. */
const WINDOWED_FAMILIES = ['rowCounters', 'tokenTotals', 'denialKinds'] as const

/**
 * Families still taken from the corpus because they are not day-keyed yet.
 *
 * Listed rather than left implicit. Each is a count an axis divides by, and a
 * windowed numerator over an all-time denominator is a rate nobody can name.
 */
const NOT_YET_WINDOWED = [
  'taskBundles',
  'wasted',
  'errorRepeats',
  'signatures',
  'verification',
  'editedPaths',
  'perSession',
  'perProject',
  'metabolism',
  'manualEdits',
] as const

export interface Restricted {
  readonly counts: ScanCounts
  readonly basis: WindowBasis
}

export function restrict(counts: ScanCounts, scope: WindowScope | null): Restricted {
  const days = scope === null ? null : scope.ordered
  const perDay = counts.perDay

  const basis: WindowBasis = {
    days,
    windowed: scope === null ? [] : [...WINDOWED_FAMILIES],
    allTime:
      scope === null
        ? [...WINDOWED_FAMILIES, ...NOT_YET_WINDOWED, ...Object.keys(ALL_TIME_REASONS)]
        : [...NOT_YET_WINDOWED, ...Object.keys(ALL_TIME_REASONS)],
  }

  // The all-time view is the scan exactly as it reported itself. Rebuilding it
  // from the day buckets would make the negative control test the rebuild
  // rather than the original.
  if (scope === null) return { counts, basis }

  return {
    counts: {
      ...counts,
      toolResultTotal: sumOver(perDay, days, (c) => c.toolResultTotal),
      toolUseTotal: sumOver(perDay, days, (c) => c.toolUseTotal),
      toolUseFiltered: sumOver(perDay, days, (c) => c.toolUseFiltered),
      toolResultWithIsErrorKey: sumOver(perDay, days, (c) => c.toolResultWithIsErrorKey),
      toolResultIsErrorTrue: sumOver(perDay, days, (c) => c.toolResultIsErrorTrue),
      attributionSkillRows: sumOver(perDay, days, (c) => c.attributionSkillRows),
      userRows: sumOver(perDay, days, (c) => c.userRows),
      originBearingUserRows: sumOver(perDay, days, (c) => c.originBearingUserRows),
      humanTurns: sumOver(perDay, days, (c) => c.humanTurns),
      originHumanRows: sumOver(perDay, days, (c) => c.originHumanRows),
      denialRows: sumOver(perDay, days, (c) => c.denialRows),
      denialUserRejected: sumOver(perDay, days, (c) => c.denialUserRejected),
      denialKinds: mergeMaps(perDay, days, (c) => c.denialKinds),
      toolActivityRows: sumOver(perDay, days, (c) => c.toolActivityRows),
      environmentNoiseRows: sumOver(perDay, days, (c) => c.environmentNoiseRows),
      stopHookSummaryRows: sumOver(perDay, days, (c) => c.stopHookSummaryRows),
      hookErrorsNonEmpty: sumOver(perDay, days, (c) => c.hookErrorsNonEmpty),
      tokens: {
        input: sumOver(perDay, days, (c) => c.input),
        output: sumOver(perDay, days, (c) => c.output),
        cacheRead: sumOver(perDay, days, (c) => c.cacheRead),
        cacheCreation: sumOver(perDay, days, (c) => c.cacheCreation),
      },
      manualEdits: {
        ...counts.manualEdits,
        userModifiedPresent: sumOver(perDay, days, (c) => c.userModifiedPresent),
        userModifiedTrue: sumOver(perDay, days, (c) => c.userModifiedTrue),
      },
      verification: {
        ...counts.verification,
        todoWriteUsed: anyOver(perDay, days, (c) => c.todoWriteUsed),
      },
    },
    basis,
  }
}

/** Rows the window left out, by day. Published so a hole has a position. */
export function rowsOutOfWindow(
  counts: ScanCounts,
  scope: WindowScope | null,
): { readonly total: number; readonly undated: number; readonly byDay: Readonly<Record<string, number>> } {
  const out: Record<string, number> = {}
  let total = 0
  let undated = 0
  for (const [day, c] of Object.entries(counts.perDay)) {
    const inWindow = scope !== null && scope.days.has(day)
    if (inWindow) continue
    if (day === UNDATED) undated += c.rows
    else out[day] = c.rows
    total += c.rows
  }
  return { total, undated, byDay: out }
}
