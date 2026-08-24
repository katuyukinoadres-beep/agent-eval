/**
 * The submission payload.
 *
 * Two rules shape every declaration here.
 *
 * A payload leaf is never free text. Conversation bodies, code, file paths and
 * hashes of any of them must not leave the machine, and the spec asks the client
 * to make that structurally impossible rather than to check for it on receipt.
 * So leaves are numbers, closed unions, or one of the few branded strings below
 * whose constructors validate their shape. Nothing here accepts a bare `string`.
 *
 * A number never travels without its denominator. See ./metric.ts.
 */

import type { Count, CountBasis, Metric, CountPeriod } from './metric.js'
import type { Composite, OmittedTerm } from '../score/composite.js'

// ── branded leaves ────────────────────────────────────────────────────────────
// The handful of leaves that genuinely have to be strings. Each is built through
// a constructor that rejects the wrong shape, so an arbitrary string cannot be
// assigned to one by accident.

declare const brand: unique symbol

export type Iso8601 = string & { readonly [brand]: 'Iso8601' }
export type Uuid = string & { readonly [brand]: 'Uuid' }
export type ProjectId = string & { readonly [brand]: 'ProjectId' }

export class PayloadError extends Error {}

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROJECT_ID = /^sha256:[0-9a-f]{64}$/

export function iso8601(s: string): Iso8601 {
  if (!ISO8601.test(s)) throw new PayloadError(`not an ISO-8601 instant: ${s}`)
  return s as Iso8601
}

export function uuid(s: string): Uuid {
  if (!UUID.test(s)) throw new PayloadError(`not a UUID v4: ${s}`)
  return s as Uuid
}

/**
 * A project directory name, hashed.
 *
 * The spec's own §5 example carries `"name": "C--Windows-System32"`, which is a
 * cwd with the separators swapped. Sending that ships the home directory, the OS
 * username and the absolute path of every project on the machine — against §1's
 * own list of what must never leave. Only the hash has a type here; there is no
 * field a raw path could occupy.
 *
 * What it is not: a value that cannot be turned back into a path. The hash is
 * unsalted, deliberately, so the same project hashes alike on two machines and
 * can be compared -- which leaves the preimage space enumerable over username
 * and repository lists. That is the same argument this codebase makes for
 * keying the signature MACs, over a smaller space. A receiver who guesses the
 * directory name can confirm the guess. Salting per submission key would close
 * it and would end cross-environment comparison with it; the trade is stated
 * here rather than described as a guarantee it does not give.
 */
export function projectId(s: string): ProjectId {
  if (!PROJECT_ID.test(s)) throw new PayloadError(`not a sha256 project id: ${s}`)
  return s as ProjectId
}

// ── closed unions ─────────────────────────────────────────────────────────────

export type Scope = 'main' | 'sub' | 'all'
export type WindowUnit = 'activeDays' | 'calendarDays'
export type Availability = 'available' | 'not_applicable' | 'parse_failed'

/**
 * Where windowDays came from.
 *
 * The two spec documents disagree on the second value: the payload spec §2 says
 * `"setting" | "observed"`, the axes spec says `"setting" | "measured"` in both
 * places it names them. They mean the same thing, which is exactly why the
 * disagreement is dangerous — a receiver comparing the strings finds no match
 * and silently drops one side rather than erroring.
 *
 * The payload spec governs the payload, so `observed` is what ships. Recorded
 * here rather than resolved quietly, because if the receiver was built from the
 * axes document this is a one-line change and nobody would otherwise know to
 * make it. Asked as part of AB-87.
 */
export type WindowSource = 'setting' | 'observed'

/**
 * How the window's activeDays was counted.
 *
 * Its own type, and a single-member one, because the spec uses the name
 * `activeDays` for two different quantities in the same environment:
 * `window.activeDays` is 17 (days carrying a human turn) and
 * `externalLog.activeDays` is 18 (days carrying evidence of any kind). A
 * receiver that reads "activeDays" without noting which object it came from is
 * off by 5.9% and has no way to tell.
 *
 * Keeping the two methods in separate types means neither value can be built
 * carrying the other's label.
 */
export type WindowDaysMethod = 'human-turn-days'

/**
 * How the evidence-day denominator was arrived at.
 *
 * A closed union because the denominator it produces decides the record rate,
 * and `max(git, jsonl)` returned 107.1% on this machine — the numerator counted
 * days that survived only in the external log, which the raw transcripts had
 * already been pruned of. Union of observed sources keeps the numerator a subset
 * of the denominator, so the ratio cannot exceed 1 by construction.
 *
 * It is still only a lower bound on real working days: a day that left neither a
 * commit nor a log is invisible in principle. Recording the method means a later
 * definition change can be stratified rather than silently mixed in.
 */
export type ActiveDaysMethod =
  | 'union-of-observed(git, jsonl, externalLog)'
  | 'union-of-observed(jsonl, externalLog)'
  | 'union-of-observed(jsonl)'

/**
 * Why an axis has no score.
 *
 * It deliberately separates two things that both produce `not_applicable`:
 * the environment does not have enough of something (measured, against
 * thresholds the spec gives), and the definition needed to compute it is not
 * settled yet.
 *
 * Reporting both as a bare `not_applicable` would tell someone their
 * environment is too small about an axis that was never implemented. The
 * three-value enum has no room for a fourth state — V-7 refuses one — so the
 * distinction lives in this field instead.
 */
export type { Composite, OmittedTerm }

export type UnavailableReason =
  | 'too-few-clusters'
  | 'denominator-below-minimum'
  | 'numerator-below-minimum'
  | 'insufficient-tool-uses'
  | 'insufficient-edit-intervals'
  | 'insufficient-assets'
  // Axis 4's own two conditions. They used to be reported as
  // `insufficient-assets` (an axis-5 threshold v2 abolished, whose text advises
  // defining more assets) and `definition-pending` (which says the definition
  // is unsettled -- it is settled; the environment is small).
  | 'no-artifacts'
  | 'too-few-bundles'
  | 'no-external-log'
  // Axis 6's own condition. It used to report `no-external-log`, which advises
  // installing a log that would not change the outcome, while layer B's absence
  // is already in `omittedTerms`.
  | 'no-failures'
  | 'first-window'
  | 'definition-pending'
  | 'environment-gated'

export const AXIS_KEYS = [
  // first wave — scored
  'firstPassLanding',
  'wastedMotion',
  'selfVerification',
  'artifactUptake',
  'environmentMetabolism',
  'recurrencePrevention',
  // second wave — computed but not displayed in the first release
  'pendingDecisions',
  'userRejected',
  'askUserQuestionCustomRate',
  // not scored
  'coverageGate',
  'safetyCheck',
] as const

export type AxisKey = (typeof AXIS_KEYS)[number]

// ── scanManifest ──────────────────────────────────────────────────────────────

/** One walked glob and how many files it actually matched. */
export interface WalkedRoot {
  readonly glob: string
  readonly matchCount: number
}

export interface Window {
  readonly unit: WindowUnit
  readonly windowDays: number
  readonly windowSource: WindowSource
  /** null where the key is absent — it does not exist in this machine's settings. */
  readonly cleanupPeriodDays: number | null
  readonly calendarSpanDays: number
  /**
   * Days carrying at least one human turn — the window's own definition, and
   * the scope every axis denominator is taken over.
   *
   * NOT the record rate's denominator. That one is `externalLog.activeDays`,
   * which is larger: a day can leave a commit or a log row without anyone
   * speaking. Measured here: 17 against 18.
   */
  readonly activeDays: number
  readonly activeDaysMethod: WindowDaysMethod
  /**
   * The offset the calendar day was cut on, as written: `Z`, `+09:00`.
   *
   * Published because it decides what a day is, and therefore what the window
   * contains. Measured on this corpus: 10 active days under UTC, 10 under
   * +05:30, 11 under +09:00 and 9 under -05:00 — against a window of the most
   * recent 10. The boundary alone decides whether the window selects a subset
   * or the whole corpus.
   */
  readonly dayBoundary: string
  /**
   * `activeDays` recut on UTC, whatever boundary was used.
   *
   * Beside it rather than instead of it, so the divergence is on screen. Two
   * submissions cut on different boundaries are not comparable, and without
   * this a reader cannot tell that is what happened.
   */
  readonly activeDaysUtc: number
  /**
   * Active days actually inside the window: `min(windowDays, activeDays)`.
   *
   * Distinct from `activeDays`, which is the corpus. When the two are equal the
   * window selected everything and cut nothing -- which is this machine's state
   * today, and the reason a figure that did not move is not evidence the window
   * works.
   */
  readonly activeDaysInWindow: number
  /** True when the corpus has fewer active days than the window asked for. */
  readonly truncated: boolean
  /** The oldest and newest active day inside the window, inclusive. */
  readonly windowStart: string | null
  readonly windowEnd: string | null
  /**
   * The day this run happened on, when it carried work. Reported, not scored.
   *
   * The window is built from complete days: the median day here is 6.9% written
   * by 09:00 and 76.1% by 18:00, so counting the current one as a full active
   * day measures the hour of the run. Worse, it evicts a complete day to do it
   * — measured on 2026-08-24, a day of 77 rows pushed a day of 2,285 out.
   */
  readonly inFlightDay: string | null
  /** True only on a first run, where no complete active day exists yet. */
  readonly includesInFlightDay: boolean
  /**
   * Days carrying a user row of any kind — the ceiling on `activeDays` under
   * this scan, and the figure that says how much of it origin coverage decided.
   *
   * Measured here: 5 human-turn days against 9 days with user rows, because
   * `origin` is present on 3.11% of user rows. The four missing days are July,
   * where every user row predates the field.
   *
   * The spec gates the environment on `activeDays < 5`. This machine measures
   * exactly 5, so one day either way decides whether anything is scored at all —
   * and which side it falls on is set by which tool versions wrote the log, not
   * by how much work happened. Sending both numbers lets that be seen instead of
   * inferred.
   */
  readonly userRowDays: number
  readonly contiguousDays: number
  /**
   * How many days inside the span have no activity, not which ones.
   *
   * The dated list the spec sketches lines up against a public contribution
   * graph well enough to identify whose machine this is, and the population
   * analysis it would support is not worth that.
   */
  readonly gapCount: number
}

export interface ExternalLog {
  readonly exists: boolean
  readonly rows: number
  readonly recordedDays: number
  /**
   * Days carrying evidence of work from any source — the record rate's
   * denominator, and a different number from `window.activeDays`.
   *
   * Carried explicitly rather than left implicit inside `recordRate` so the two
   * can be checked against each other (V-13). The spec's own sample states it
   * twice, and a denominator that only exists inside a fraction is a denominator
   * nothing can cross-check.
   */
  readonly activeDays: number
  readonly activeDaysMethod: ActiveDaysMethod
  /**
   * Of days with evidence of work, the share that reached the external log.
   *
   * Null when there is no day to divide by. It used to floor the denominator at
   * one while `activeDays` beside it shipped the true zero, so a machine with
   * no logs emitted a payload its own validator refused under V-13 — which is
   * the first run of every fresh install.
   */
  readonly recordRate: Metric | null
  /** Of calendar days, the share with any record. Work frequency, not coverage. */
  readonly recordRateCalendar: Metric | null
}

/**
 * How the failed tool calls split across the attribution table.
 *
 * Reported because §5.2 requires the subtraction to be machine-verified and
 * because the split is the largest single lever on axis 2: the same 412
 * failures produce a numerator of 412, 282 or 190 depending on which of them
 * are charged to the agent.
 */
export interface FailureAttribution {
  /** Failures counted before any attribution ran. */
  readonly observed: number
  readonly inAxis2Numerator: number
  readonly excluded: number
  /** False means events were lost, and no axis built on them may be emitted. */
  readonly balanced: boolean
  /** The per-id split, keyed by the table's ids. */
  readonly byId: Readonly<Record<string, number>>
  /**
   * Every `toolDenialKind` value this machine emitted, with its count.
   *
   * The spec names `permission-rule` and `user-rejected`. This machine also
   * emits `automode-blocked` and `automode-unavailable`, which carry 95 of 412
   * failures here and none on the machine the spec was written against.
   */
  readonly denialKinds: Readonly<Record<string, number>>
}

/**
 * A count whose declared meaning and actual basis disagree.
 *
 * `DENOMINATOR_MEANINGS` is a closed union on purpose: a receiver compares the
 * exact string to decide whether two environments measured the same thing, so
 * paraphrasing one would break that comparison while looking correct. Which
 * means a meaning that says `window 内の` cannot simply be reworded when the
 * build counts over all time — the honest move is to say so in a field a
 * receiver can act on.
 *
 * Without this, a payload asserts window scoping in prose while
 * `countBasis.period` says `allTime`, and a receiver matching on the meaning
 * string compares it against a genuinely windowed submission.
 */
export interface BasisMismatch {
  /** Where the count sits in the payload. */
  readonly path: string
  /** The period the declared meaning implies. */
  readonly declared: CountPeriod
  /** The period this build actually counted over. */
  readonly actual: CountPeriod
  /** Why, in one line. */
  readonly reason: string
}

export interface ScanManifest {
  readonly parserVersion: '1'
  readonly scope: Scope
  /** Every glob actually walked, with its own match count. */
  readonly rootsWalked: readonly WalkedRoot[]
  readonly recursive: true
  readonly filesRead: number
  readonly linesRead: number
  readonly linesParseFailed: number
  /**
   * Files the walk found and the scan could not open.
   *
   * `filesRead` counts what was enumerated, so without this the two figures
   * agree while the lines are missing, and a corpus that failed to open reads
   * as a quiet month.
   */
  readonly filesUnreadable: number
  /** Files that opened and yielded no usable row. */
  readonly filesWithoutRows: number
  readonly bytesRead: number
  readonly mainFiles: number
  readonly mainLines: number
  readonly subFiles: number
  readonly subLines: number
  /** Detects the non-recursive glob that started all this. */
  readonly subLineRatio: number
  readonly toolVersions: Readonly<Record<string, number>>
  readonly toolVersionDistinct: number
  /** Share of user rows carrying `origin`; low values mean human counts undercount. */
  readonly originFieldCoverage: Metric
  /**
   * How every count in this submission was counted, unless the count says
   * otherwise.
   *
   * One place, because the alternative was measured: the same quantity moved
   * 1.33x across four published figures, none of which stated its basis.
   */
  readonly countBasis: CountBasis
  /**
   * Counts whose declared meaning does not match the basis they were taken on.
   *
   * Empty is the goal. A non-empty list is a build that has not finished
   * windowing, said out loud rather than left for a receiver to discover by
   * comparing two submissions that were never comparable.
   */
  readonly basisMismatch: readonly BasisMismatch[]
  readonly failureAttribution: FailureAttribution
  readonly window: Window
  readonly externalLog: ExternalLog
  readonly measuredAt: Iso8601
}

// ── metrics ───────────────────────────────────────────────────────────────────

/**
 * The eleven required metrics of spec §3.1. Seven are rates; four are marked
 * with an em dash in the denominator column and are counts.
 *
 * `booleanDerived` rides on the type rather than in a list inside the validator.
 * W-6 warns when a boolean-derived numerator is zero over a large denominator,
 * and a hand-maintained list of which metrics those are drifts — the moment
 * `toolError` fell off it, a 0/27,775 would pass unremarked, which is the shape
 * of the incident W-6 exists for.
 */
export interface BooleanDerived {
  readonly booleanDerived: true
}

/**
 * Permission entries by class, never the entries themselves.
 *
 * A permission line routinely contains a script path, and those are on §1's
 * never-send list. Counting them by what they permit keeps the signal — an
 * allowlist of 263 entries containing `Bash(python:*)` delegates more than one
 * of 51 that contains no interpreter at all — without shipping the strings.
 */
export interface PermissionCounts {
  readonly allow: Count
  readonly deny: Count
  readonly ask: Count
  /** Arbitrary code execution: `Bash(python:*)`, `Bash(*)`, `Bash(sh:*)` and kin. */
  readonly unrestrictedExec: Count
  /** Prefix wildcard bounded to one CLI: `Bash(git push*)`. */
  readonly cliWildcard: Count
  /** Pinned to a named script: `node scripts/foo.mjs:*`. */
  readonly scriptPathFixed: Count
}

/**
 * Raw token counts, never a total.
 *
 * Summing them is what the existing leaderboards do, and 94.7-97.0% of the sum
 * is cache reads on both measured machines — a number that grows with
 * conversation length and says nothing about quality. Kept split so the receiver
 * can compare like for like.
 */
export interface TokenCounts {
  readonly input: Count
  readonly output: Count
  readonly cacheRead: Count
  readonly cacheCreation: Count
}

/**
 * Every rate here is nullable, and the null is not defensive coding.
 *
 * Each denominator can genuinely be zero: a project with no skills, a machine
 * with no MCP servers, a window where nothing was ever denied. The first draft
 * of the assembler wrote `Math.max(1, denominator)` to get past makeMetric's
 * refusal of a zero denominator, and the run that found it reported
 * `skillFired: 3/1` — three skills fired out of one defined, on a directory with
 * none. A floor of 1 does not avoid the absence; it renames it as the smallest
 * possible presence and multiplies the rate accordingly.
 *
 * `null` says the environment has no denominator for this. 0/0 would read as a
 * measured zero, and a floor of 1 reads as 300%.
 */
export interface Metrics {
  readonly toolError: (Metric & BooleanDerived) | null
  readonly toolErrorAlt: (Metric & BooleanDerived) | null
  readonly skillFired: Metric | null
  readonly skillRows: Count
  readonly mcpUsed: Metric | null
  readonly humanTurns: Count
  readonly denialUserRejected: (Metric & BooleanDerived) | null
  readonly permissions: PermissionCounts
  readonly editPaths: Metric | null
  readonly tokens: TokenCounts
  readonly hookPushback: (Metric & BooleanDerived) | null
}

// ── axes ──────────────────────────────────────────────────────────────────────

/**
 * Availability decided per line, then summed.
 *
 * Not per environment: one machine's logs here span twelve tool versions
 * (2.1.112 through 2.1.234) and `origin` only appears from 2.1.220, so a
 * per-environment verdict lets the newer rows paper over what the older ones
 * never carried.
 */
export interface LineStates {
  readonly available: number
  readonly not_applicable: number
  readonly parse_failed: number
}

export interface Axis {
  readonly availability: Availability
  readonly lineStates: LineStates
  /**
   * The rate this axis scores, or null when it has none to give.
   *
   * A Metric rather than loose numerator/denominator/denominatorMeaning fields,
   * so the rule that every rate states what it divided by reaches the axes too —
   * they are the product's actual output, and leaving them outside that rule
   * would exempt the numbers that matter most.
   */
  readonly metric: Metric | null
  /** Absent while the rate-to-score formula for this axis is still unresolved. */
  readonly score: number | null
  readonly confidenceInterval: readonly [number, number] | null
  readonly belowMinDenominator: boolean
  /**
   * Every condition that withheld a score, not just the first.
   *
   * Empty when the axis is available. A near miss on one threshold and a miss on
   * all three are different facts about an environment, and an axis that reports
   * only that it is unavailable cannot tell anyone which they have.
   */
  readonly unavailableReasons: readonly UnavailableReason[]
  /**
   * The parts the score was computed from, so a receiver can recompute it.
   *
   * Numbers only, and deliberately not named `numerator` / `denominator`. Axis
   * 2's rate is wasted moves per task bundle — 1.16 here — and a ratio that
   * legitimately exceeds 1 is not a proportion. V-5 refuses a numerator above
   * its denominator, correctly, because the 107.1% it was written for was a
   * proportion that could not exceed 1 and did. Marking this pair exempt would
   * put a hole in that rule wide enough for the next 107% to walk through, so
   * the fields carry names that say what they are instead.
   */
  readonly detail: Readonly<Record<string, number>> | null
  /**
   * Terms of this axis's formula that were not computed, each with the
   * direction it moves the score.
   *
   * Without it, two environments reporting the same named score can have
   * computed it from different formulas and neither side can tell. "Not
   * implemented" alone does not say which side of the truth the reader is on.
   */
  readonly omittedTerms: readonly OmittedTerm[]
}

export type Axes = Readonly<Record<AxisKey, Axis>>

// ── environment ───────────────────────────────────────────────────────────────

export interface ProjectSummary {
  readonly id: ProjectId
  readonly files: number
  readonly lines: number
  readonly bytes: number
  readonly humanRows: number
  readonly subLineRatio: number
}

export interface Environment {
  readonly os: string
  readonly shell: string
  readonly agentTools: readonly string[]
  readonly projectCount: number
  /** Every project on the machine. Partial submissions are refused, so no threshold is needed. */
  readonly projects: readonly ProjectSummary[]
  readonly topProjectByteShare: number
  readonly skillsDefined: number
  readonly hooksDefined: number
}

// ── the payload ───────────────────────────────────────────────────────────────

export interface Payload {
  readonly schemaVersion: '1.0'
  readonly runTimestamp: Iso8601
  readonly submissionId: Uuid
  readonly scanManifest: ScanManifest
  readonly metrics: Metrics
  readonly axes: Axes
  readonly composite: Composite
  readonly environment: Environment
}
