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

import { closure, emptyTally, ATTRIBUTIONS } from './attribution.js'
import type { WastedCounts } from './wasted.js'
import type { Hmac128 } from '../snapshot/types.js'
import type { DayCounts, ScanCounts } from './scan.js'
import { dayOf } from './day.js'
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
  'perSession.counts':
    'the per-session tallies stay corpus-wide; only the cluster day sets are windowed, and they are what the minimum reads',
  'errorRepeats.byFamily': 'the family split is reported over the corpus; only the rate is windowed',
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
const WINDOWED_FAMILIES = ['rowCounters', 'tokenTotals', 'denialKinds', 'taskBundles', 'wasted', 'errorRepeats', 'signatures', 'verification', 'editedPaths', 'manualEdits', 'clusterDays'] as const

/**
 * Families still taken from the corpus because they are not day-keyed yet.
 *
 * Listed rather than left implicit. Each is a count an axis divides by, and a
 * windowed numerator over an all-time denominator is a rate nobody can name.
 */
const NOT_YET_WINDOWED = [
  'perSession.counts',
  'perProject',
  'metabolism',
  'manualEdits',
] as const

export interface Restricted {
  readonly counts: ScanCounts
  readonly basis: WindowBasis
}

/**
 * Axis 2's counters over the selected days.
 *
 * `closure` is recomputed from the filtered tally rather than summed from the
 * per-day ones. A partition that closes in aggregate can be wrong for a single
 * day, and a `balanced` carried forward from the daily buckets would be true
 * for free — which is worse than no check, because it reports success.
 */
function wastedOver(
  perDay: Readonly<Record<string, WastedCounts>>,
  days: readonly string[],
): WastedCounts {
  const attribution = emptyTally()
  const callsPerBundle: Record<string, number> = {}
  let failures = 0
  let hookOriginated = 0
  let errorsObserved = 0
  let writeRepeats = 0
  let investigationRepeats = 0
  let timedOut = 0
  let largeOutput = 0
  for (const day of days) {
    const b = perDay[day]
    if (b === undefined) continue
    failures += b.failures
    hookOriginated += b.hookOriginated
    errorsObserved += b.errorsObserved
    writeRepeats += b.writeRepeats
    investigationRepeats += b.investigationRepeats
    timedOut += b.timedOut
    largeOutput += b.largeOutput
    for (const id of ATTRIBUTIONS) attribution[id] += b.attribution[id]
    for (const [k, n] of Object.entries(b.callsPerBundle)) {
      callsPerBundle[k] = (callsPerBundle[k] ?? 0) + n
    }
  }
  return {
    failures,
    hookOriginated,
    errorsObserved,
    attribution,
    closure: closure(attribution, errorsObserved),
    writeRepeats,
    investigationRepeats,
    timedOut,
    largeOutput,
    callsPerBundle,
  }
}

/**
 * `rIn` over the selected days, recomputed from the members.
 *
 * The families are re-derived too. Summing per-day `byFamily` maps is safe
 * because a family count is additive; the distinct count is not, which is the
 * whole reason the member keys survive per day.
 */
function repeatRateOver(counts: ScanCounts, days: readonly string[]): ScanCounts['errorRepeats'] {
  const seen = new Set<string>()
  let errors = 0
  for (const day of days) {
    for (const key of counts.signatureKeysPerDay[day] ?? []) {
      seen.add(key)
      errors += 1
    }
  }
  const byFamily: Record<string, number> = {}
  for (const day of days) {
    const perDay = counts.wastedPerDay[day]
    if (perDay === undefined) continue
    // Families are not day-keyed on their own; the aggregate is kept as it is
    // and the window reports the corpus split. Named in `allTime` below.
    void perDay
  }
  return {
    errors,
    distinctSignatures: seen.size,
    // Zero errors is not a repeat rate of 1. Nothing recurred because nothing
    // happened, and reporting 1 would read as "every failure was a repeat".
    rIn: errors === 0 ? 0 : 1 - seen.size / errors,
    byFamily: Object.keys(byFamily).length === 0 ? counts.errorRepeats.byFamily : byFamily,
  }
}

/** The signatures a window saw at least twice. v1's `S_t`, over the window. */
function repeatedOver(counts: ScanCounts, days: readonly string[]): readonly Hmac128[] {
  const seen = new Map<Hmac128, number>()
  for (const day of days) {
    for (const mac of counts.macsPerDay[day] ?? []) seen.set(mac, (seen.get(mac) ?? 0) + 1)
  }
  return [...seen.entries()]
    .filter(([, n]) => n >= 2)
    .map(([mac]) => mac)
    .sort()
}

/** Axis 3's counters over the selected days. Plain sums: every term is additive. */
function verificationOver(
  counts: ScanCounts,
  days: readonly string[],
): Omit<ScanCounts['verification'], 'todoWriteUsed'> {
  let intervals = 0
  let verifiedIntervals = 0
  let selfRepaired = 0
  let humanRescued = 0
  let unresolved = 0
  let repairedNotCounted = 0
  for (const day of days) {
    const b = counts.verificationPerDay[day]
    if (b === undefined) continue
    intervals += b.intervals
    verifiedIntervals += b.verifiedIntervals
    selfRepaired += b.selfRepaired
    humanRescued += b.humanRescued
    unresolved += b.unresolved
    repairedNotCounted += b.repairedNotCounted
  }
  return { intervals, verifiedIntervals, selfRepaired, humanRescued, unresolved, repairedNotCounted }
}

/** Each session's days, cut to the window. A session with none drops out. */
function withinWindow(
  bySession: Readonly<Record<string, readonly string[]>>,
  days: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {}
  for (const [session, had] of Object.entries(bySession)) {
    const kept = had.filter((d) => days.includes(d))
    if (kept.length > 0) out[session] = kept
  }
  return out
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

  // Non-null past this point, which the day-indexed lookups below rely on.
  const selected: readonly string[] = scope.ordered

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
      // Intervals and repair episodes are charged to the day they opened on, so
      // a verification or a recovery that arrives later still lands with the
      // thing it belongs to. Cutting the follow-up at the boundary would make
      // every window's newest edits read unverified.
      verification: {
        ...verificationOver(counts, selected),
        todoWriteUsed: anyOver(perDay, days, (c) => c.todoWriteUsed),
      },
      // Membership by the day of the last write, and the tally itself is left
      // whole. `lastWrite` stays the corpus-wide maximum and `newLines` stays
      // cumulative: an artifact's weight has to be the same figure in every
      // window that contains it, and the right-censor turns on the real last
      // write rather than on the last one inside some boundary.
      // A cluster is a session with a denominator for that axis, judged over
      // the same days the denominator was taken from. Counting sessions that
      // had a bundle at any time, against a rate taken from ten days, is a
      // minimum judged on one basis and a rate on another.
      clusterDays: {
        bundles: withinWindow(counts.clusterDays.bundles, selected),
        intervals: withinWindow(counts.clusterDays.intervals, selected),
        errors: withinWindow(counts.clusterDays.errors, selected),
      },
      editedPaths: Object.fromEntries(
        Object.entries(counts.editedPaths).filter(([, tally]) => {
          // Cut on the window's own boundary. Slicing ten characters off the
          // timestamp gives the UTC day regardless, which is the bug the day
          // function exists to remove.
          const day = dayOf(tally.lastWrite, scope.offsetMinutes)
          return day !== null && selected.includes(day)
        }),
      ),
      // Bundles and the terms divided by them leave the window together. A
      // windowed denominator under a corpus-wide numerator inflates W, and no
      // counter moves to show it.
      taskBundles: selected.reduce((n, d) => n + (counts.bundlesPerDay[d]?.task ?? 0), 0),
      rootBundles: selected.reduce((n, d) => n + (counts.bundlesPerDay[d]?.root ?? 0), 0),
      orphanBundles: selected.reduce((n, d) => n + (counts.bundlesPerDay[d]?.orphan ?? 0), 0),
      wasted: wastedOver(counts.wastedPerDay, selected),
      // Re-derived from the members, never summed. `rIn` is `1 - distinct/count`
      // and a signature that appears on two days is one signature, so adding
      // per-day distinct counts over-counts it.
      errorRepeats: repeatRateOver(counts, selected),
      signatures: selected.flatMap((d) => [...(counts.macsPerDay[d] ?? [])]),
      signaturesRepeated: repeatedOver(counts, selected),
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
