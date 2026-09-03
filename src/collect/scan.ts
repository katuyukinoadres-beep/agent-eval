/**
 * Reads every enumerated transcript exactly once and reduces it to counts.
 *
 * One pass, one open per file. Not for speed — the whole corpus here is 72MB —
 * but because a second pass is where two passes disagree. The measurement that
 * started this project was a subagent count of 27,751 from one pass and 0 from
 * another over the same machine on the same day, differing only in which files
 * they walked.
 *
 * Nothing decides anything from a field outside READ_KEYS. Three fields are
 * excluded by name and a test asserts they stay excluded; each is the obvious
 * source for something measured here and each returns a constant zero.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FileEntry, Inventory } from './walk.js'
import { dayOf, type Day } from './day.js'
import { notHumanBecause, userText } from './humanTurn.js'
import { bundleTracker, isEnvironmentNoise, type BundleTracker } from './bundle.js'
import { readWrite, recordWrite, type MutPathTally, type PathTally } from './artifact.js'
import { normalisePath, referenceIndex, type Mention, type ReferenceIndex } from './reference.js'
import { classifyError, repeatRate, type ErrorClass, type RepeatRate } from './errorClass.js'
import {
  ATTRIBUTIONS,
  IN_AXIS2_NUMERATOR,
  IN_REPAIR_SPLIT,
  isExternalTool,
  SUPPLIES_SIGNATURE,
  attribute,
  closure,
  emptyTally,
  type AttributionTally,
} from './attribution.js'
import { LARGE_OUTPUT_BYTES, isInvestigation, wastedTracker, type WastedCounts, type WastedTracker } from './wasted.js'
import type { Signer } from '../snapshot/mac.js'
import type { Hmac128 } from '../snapshot/types.js'

/**
 * Every jsonl key this reducer is allowed to look at.
 *
 * An allowlist rather than a denylist so a field has to be argued for before it
 * can influence a number, and so the three below can be shown absent rather than
 * merely unmentioned.
 */
export const READ_KEYS = [
  'type',
  'subtype',
  'version',
  'timestamp',
  'sessionId',
  'origin',
  'message',
  'attributionSkill',
  'attributionMcpServer',
  'toolDenialKind',
  'hookErrors',
  // The working directory the session ran in. Argued for, because it is a
  // filesystem path and every other path in this file is banned.
  //
  // It is read to find where the machine's skills, hooks and settings actually
  // live. Without it those were read from `process.cwd()`, so the counts moved
  // with the shell's location: 0 skills from one directory and 27 from another,
  // on an unchanged machine.
  //
  // It never leaves the process. The value is used to build local filesystem
  // paths and is dropped; what reaches the payload is counts. `test/assets.test.ts`
  // fixes that, because a comment saying so is worth nothing on its own.
  'cwd',
  // P5 — the conversation tree. Reading order instead puts 4.19% of rows in
  // the wrong bundle.
  'uuid',
  'parentUuid',
  // P3 — a bad connection is not low quality work.
  'isApiErrorMessage',
  // Axis 5 — skill_listing carries the asset set and hook_success the hook
  // firings. Only names, counts and lengths are taken from either.
  'attachment',
  // P6 — where a write landed and how large it was. Only `filePath`,
  // `structuredPatch[].newLines` and `file.numLines` are touched inside it; see
  // FORBIDDEN_SUBFIELDS.
  'toolUseResult',
] as const

export type ReadKey = (typeof READ_KEYS)[number]

/**
 * Fields that must never influence a count.
 *
 *   isSidechain               false on every main-transcript row on both
 *                             machines; position in the tree decides instead
 *   toolUseResult.interrupted 9,995 occurrences across two machines, 0 true
 *                             (the parent object is read for P6; only this
 *                             field within it is off limits)
 *   preventedContinuation     all false on both machines even on the rows where
 *                             a hook did push a response back — the event is in
 *                             hookErrors, which is in the allowlist above
 *
 * None of the three errors when read. Each returns a well-formed zero, which is
 * why a denylist that is only a comment does not hold.
 */
export const FORBIDDEN_KEYS = ['isSidechain', 'toolUseResult.interrupted', 'preventedContinuation'] as const

/**
 * Fields inside `toolUseResult` that carry file or console content.
 *
 * `toolUseResult` was banned outright until P6 needed the size of a write. The
 * ban was the right instinct and the wrong shape: the object also holds
 * `originalFile`, `newString`, `oldString`, `content`, `stdout` and `stderr`,
 * which are the file and the terminal. 180 of the 355 edited paths on this
 * machine sit outside the working tree, so their contents are somebody's
 * business and not this tool's.
 *
 * Named individually rather than covered by a rule about the parent, because a
 * ban on the parent is what sent P6 looking for line counts somewhere worse.
 */
export const FORBIDDEN_SUBFIELDS = [
  'lines',
  'originalFile',
  'newString',
  'oldString',
  'content',
  'stdout',
  'stderr',
] as const

/**
 * One Claude Code version's slice of the corpus.
 *
 * The tool already knew which version wrote every row; it just threw the
 * information away after counting rows. Cutting the same counters by version
 * instead of only by day is what turns "my agent got worse lately" from a
 * feeling into a number, because a version boundary is the one change that is
 * definitely not the user's doing.
 *
 * `failures` and `toolUse` are the raw terms, never a rate. A rate computed
 * here would not be axis 2's W -- that has a different denominator (task
 * bundles) and an attribution table applied -- and two quantities with the same
 * name and different denominators is the exact failure this project measured at
 * 1.96x.
 */
export interface VersionSlice {
  /** Rows this version wrote. The same number `toolVersions` reports. */
  readonly rows: number
  /** Failures charged to the environment, after the attribution table. */
  readonly failures: number
  /** Filtered tool_use blocks: the denominator this slice's rate may use. */
  readonly toolUse: number
  /** When this version was in use. Null when none of its rows carried a date. */
  readonly firstDay: string | null
  readonly lastDay: string | null
}

interface MutVersionSlice {
  rows: number
  failures: number
  toolUse: number
  firstDay: string | null
  lastDay: string | null
}

export interface ScanCounts {
  readonly linesRead: number
  readonly linesParseFailed: number
  /**
   * Files the walk found and the scan could not open.
   *
   * Counted, because the alternative is a total that omits them with nothing
   * to say so. `filesRead` counts what was enumerated; the difference is here.
   */
  readonly filesUnreadable: number
  /** Files that opened and yielded no usable row. Counted for the same reason. */
  readonly filesWithoutRows: number
  readonly bytesRead: number
  readonly mainLines: number
  readonly subLines: number

  readonly toolResultTotal: number
  /** Every tool_use block. A reference value, per v2 §3.2. */
  readonly toolUseTotal: number
  /**
   * tool_use blocks after the attribution table's external exclusion.
   *
   * The quantity v1 and v2 both name for axis 2's availability. The gate used
   * to be fed `toolResultTotal`, which is a different block type, unfiltered,
   * and explicitly designated a reference value.
   */
  readonly toolUseFiltered: number
  readonly toolResultWithIsErrorKey: number
  readonly toolResultIsErrorTrue: number

  readonly attributionSkillRows: number
  readonly attributionSkillDistinct: number
  readonly mcpServerDistinct: number

  /** Rows carrying an `origin` object at all — the denominator of coverage. */
  readonly userRows: number
  readonly originBearingUserRows: number
  /**
   * Human turns per P1 of the v1 axes document.
   *
   * Not `origin.kind === 'human'`. That reading gives 250 here against P1's 413
   * — 1.65x low — because the key is absent from 96.8% of user rows. v1 states
   * outright that a missing key must not be read as "not human".
   */
  readonly humanTurns: number
  /**
   * Rows carrying `origin.kind === 'human'`, kept as the supporting signal v1
   * says it is. The gap against humanTurns is how much origin coverage costs.
   */
  readonly originHumanRows: number
  /** Why user rows were excluded from P1, so a filter that ate 90% says so. */
  readonly notHumanCounts: Readonly<Record<string, number>>
  /**
   * P5 task bundles — one human turn to the next, along the parentUuid chain.
   *
   * The denominator of axis 2, and part of axis 4's. v1 moved it off total tool
   * calls because with that denominator the cheapest way to raise a score was to
   * fire hundreds of calls that could not fail.
   */
  readonly taskBundles: number
  /** Bundles begun by a row whose parent was not in the file. Zero here. */
  readonly rootBundles: number
  /**
   * Bundles by the day they opened on, with roots and orphans split out.
   *
   * What the window selects over. Counted at emit from one map rather than
   * tallied as the scan goes, so a bundle and its day cannot disagree.
   */
  readonly bundlesPerDay: Readonly<Record<string, { task: number; root: number; orphan: number }>>
  readonly orphanBundles: number
  /** P3 rows dropped from every numerator and denominator: 15 here. */
  readonly environmentNoiseRows: number
  /**
   * P6 — per edited path: when it was last written, how many lines, in which
   * bundle. The censoring and existence checks that turn these into settled
   * artifacts happen later; nothing here touches the filesystem.
   */
  readonly editedPaths: Readonly<Record<string, PathTally>>
  /** Latest mention of any path-shaped token, for P6's uptake condition (a). */
  readonly lastMention: (path: string) => string | null
  /** The latest mention with its bundle, for axis 4's cross-bundle rule. */
  readonly lastMentionIn: (path: string) => Mention | null
  /** Whether a request other than the writing one referred to a path afterwards. */
  readonly mentionedElsewhereAfter: (path: string, bundle: number | null, after: string) => boolean
  /** Basenames seen under more than one full path, so the fallback can be sized. */
  readonly ambiguousBasenames: number
  /** Distinct path-shaped tokens seen, so an empty index reads as empty. */
  readonly referenceTokens: number
  /**
   * Axis 2's within-window repeat rate, over signatures of (tool, class,
   * target). Error text is classified here and never carried further.
   */
  readonly errorRepeats: RepeatRate
  /** Axis 2's numerator terms, before weighting. */
  readonly wasted: WastedCounts
  /** The same, by the day each bundle opened on. The window selects over this. */
  readonly wastedPerDay: Readonly<Record<string, WastedCounts>>
  /**
   * The same terms again, split by session cluster.
   *
   * The bootstrap resamples sessions and recomputes a ratio estimator from the
   * members it drew, so it needs each session's numerator and denominator
   * separately. An aggregate cannot be resampled: there is one of it. Without
   * this no interval is computable, and the raw logs it would have to be
   * recomputed from are pruned.
   */
  readonly perSession: Readonly<Record<string, SessionTally>>
  /**
   * Days each session had a non-zero denominator on, per axis.
   *
   * A cluster is a session with a denominator *for that axis*, so the window
   * has to judge it over the window. Sets rather than tallies, because the only
   * question ever asked of them is whether the count is above zero.
   */
  /**
   * Name-keyed collections with the days each name occurred on.
   *
   * A window selects over these rather than summing them: a skill that fired
   * six weeks ago is not a fired asset for a utilisation rate taken from the
   * last ten active days, and a distinct-name count cannot be added up.
   */
  readonly dayedNames: {
    readonly skillFirings: Readonly<Record<string, readonly string[]>>
    readonly hookFirings: Readonly<Record<string, readonly string[]>>
    readonly mcpFirings: Readonly<Record<string, readonly string[]>>
    readonly editedNames: Readonly<Record<string, readonly string[]>>
    readonly staleRecoveredPaths: Readonly<Record<string, readonly string[]>>
  }
  readonly clusterDays: {
    readonly bundles: Readonly<Record<string, readonly string[]>>
    readonly intervals: Readonly<Record<string, readonly string[]>>
    readonly errors: Readonly<Record<string, readonly string[]>>
  }
  /**
   * Error signatures, MAC'd.
   *
   * The plaintext tuple never leaves this function. `repeatRate` is computed
   * from the tuples in scope here and only the aggregates and these MACs come
   * out, which is what makes the set safe to persist: cross-window recurrence
   * is a set intersection and needs equality, nothing more.
   *
   * Empty when no signer was supplied, with `signaturesSigned` saying so — an
   * empty set and an unsigned run produce the same array and mean opposite
   * things.
   */
  readonly signatures: readonly Hmac128[]
  /**
   * Signatures this window saw at least twice.
   *
   * v1's `S_t`. The cross-window rate is `|S_t ∩ S_(t-1)| / |S_t|`, and it is
   * the ≥2 set on purpose: a failure that happened once is not yet a pattern,
   * and intersecting one-offs would measure coincidence.
   */
  readonly signaturesRepeated: readonly Hmac128[]
  /**
   * Signature keys by day, so a window can recompute a rate that does not add.
   *
   * Local and opaque. Never put in a payload; a test asserts it.
   */
  readonly signatureKeysPerDay: Readonly<Record<string, readonly string[]>>
  /** The MACs by day, for the windowed recurrence set. */
  readonly macsPerDay: Readonly<Record<string, readonly Hmac128[]>>
  readonly signaturesSigned: boolean
  /** Rows carrying a tool_use or tool_result block — axis 2's evidence lines. */
  readonly toolActivityRows: number
  /**
   * Axis 5's asset set and its firings.
   *
   * Assets come from `skill_listing.names` rather than from disk: a skill moved
   * to a neighbouring directory disappears from a disk count and takes its
   * unfired status with it, so hiding and tidying up would score alike. What is
   * listed is what was loaded.
   */
  readonly metabolism: MetabolismCounts
  /**
   * Traces that a person edited a file by hand, for axis 4's (c) term.
   *
   * v1 names two: an `edited_text_file` attachment and `staleRecovered`. A
   * third field, `toolUseResult.userModified`, means the same thing and is
   * present 766 times here -- and true zero times. It is the fourth boolean in
   * this log found to be uniformly dead, after isSidechain,
   * toolUseResult.interrupted and preventedContinuation, so it is recorded as
   * such and not used.
   *
   * The attachment carries a `filename`, not a path, so matching against a
   * written path is by basename. That over-matches two files of one name in
   * different directories, which pushes the overwrite share up and the score
   * down.
   */
  readonly manualEdits: ManualEditCounts
  /** Axis 3's raw counts: edit intervals, the ones a verification touched, and repair. */
  readonly verification: VerificationCounts
  /** The same, by the day each interval or episode opened on. */
  readonly verificationPerDay: Readonly<Record<string, Omit<VerificationCounts, 'todoWriteUsed'>>>

  readonly denialRows: number
  readonly denialUserRejected: number
  /**
   * Every `toolDenialKind` value seen, with its count.
   *
   * Emitted rather than folded into a boolean because the spec names two kinds
   * and this machine produces four. Which values exist decides how 95 of 412
   * failures are attributed, and an implementation that silently drops the ones
   * it does not recognise reports a different number without saying so.
   */
  readonly denialKinds: Readonly<Record<string, number>>

  readonly editedFilesDistinct: number
  readonly editedFilesRepeated: number

  readonly stopHookSummaryRows: number
  readonly hookErrorsNonEmpty: number

  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheCreation: number
  }

  readonly toolVersions: Readonly<Record<string, number>>
  /**
   * Distinct working directories seen in the transcripts.
   *
   * Skills, hooks and settings live under a project directory, so reading them
   * from the process's own cwd reports whatever the user happened to be sitting
   * in. Running from the tool's own checkout gave `skillsDefined: 0` while the
   * project beside it had 27 -- a headline number that moved with the shell's
   * location, which is not a property of the environment being measured.
   */
  readonly cwds: readonly string[]
  /** The same corpus cut by the version that wrote it. See `VersionSlice`. */
  readonly versionSlices: Readonly<Record<string, VersionSlice>>
  /**
   * Session clusters, folded to the parent session.
   *
   * The bootstrap resamples over these, so the count decides whether a rate
   * gets a confidence interval at all. v2 §6.3 fixes the unit as
   * `session_id（sub は親 session_id に畳む）`.
   *
   * Taken from where the file sits, not from the `sessionId` on the row. On
   * this machine the two agree — 12 and 12, with no id appearing only under
   * subagents — but they agree by circumstance. A subagent transcript that
   * carried its own id would raise the cluster count with nothing to say it
   * had, and the cluster count is what gates the minimum denominator.
   */
  readonly sessionIds: readonly string[]
  /**
   * Rows whose own `sessionId` is not the session their file belongs to.
   *
   * Zero here. It exists so the agreement above is checked on every run rather
   * than assumed from one measurement, and `scan.test.ts` builds a corpus where
   * it is non-zero so the check is known to be able to fire.
   */
  readonly sessionIdMismatchRows: number
  readonly dates: readonly string[]
  /**
   * Days carrying a user row of any kind — the ceiling on human-turn days under
   * this scan.
   *
   * Carried because `humanTurnDates` is a function of `origin` coverage, which
   * is 3.11% here. Measured on this machine: 5 human-turn days against 9 days
   * with user rows. The four missing ones are in July, where the log has user
   * rows and no `origin` object on any of them.
   *
   * The gap matters because the spec gates the whole environment on
   * `activeDays < 5`. At 5 measured, one day either way decides whether anything
   * is scored, and which side it lands on is set by which tool versions wrote
   * the log rather than by how much work happened. Emitting both lets a receiver
   * see that rather than infer it.
   */
  readonly userRowDates: readonly string[]
  /**
   * Days carrying at least one human turn under P1 — `notHumanBecause` returns
   * null. The window's own unit.
   *
   * Not `origin.kind === 'human'`, which is what this said for a long time
   * while the code did something else. That field is present on 2.7% of user
   * rows here, so an implementer following the docstring would have landed on
   * about five active days instead of eleven -- one away from the five-day
   * suppression gate.
   */
  readonly humanTurnDates: readonly Day[]
  /** The same cut on UTC, so the effect of the boundary is visible. */
  readonly humanTurnDatesUtc: readonly Day[]
  /**
   * Every day-keyed counter, by day, plus the `undated` bucket.
   *
   * The window is a selection over these rather than a filter over rows. Rows
   * are never dropped during the pass, so the parentUuid chain, the repeat
   * detector's first occurrences, the per-session first-seen classes and the
   * artifact censor all see the corpus they always saw. Only the attribution of
   * a count to a day is windowed.
   */
  readonly perDay: Readonly<Record<string, DayCounts>>
  /**
   * Per-project line tallies, keyed by project directory name.
   *
   * The aggregate cannot show a partial miss. Four of five projects on this
   * machine hold nothing and one holds every line, so a glob that missed four of
   * them leaves a total that looks healthy. W-2 checks the sub-line share per
   * project for exactly that reason, and it needs these.
   */
  readonly perProject: Readonly<Record<string, ProjectTally>>
}

/**
 * One session cluster's contribution to axis 2.
 *
 * Keyed by the session the file belongs to, folded from the path, so a
 * subagent transcript lands in its parent's cluster.
 */
export interface SessionTally {
  /**
   * Edit intervals this session opened.
   *
   * Per session because a cluster is a session with a non-zero denominator
   * *for that axis*, and the axes do not share a denominator. Counting every
   * session that produced a line over-counts clusters for every axis, in the
   * direction that lets a minimum pass.
   */
  readonly intervals: number
  readonly bundles: number
  readonly failures: number
  readonly writeRepeats: number
  readonly investigationRepeats: number
  readonly timedOut: number
  readonly largeOutput: number
  readonly errors: number
  readonly lines: number
}

interface MutSessionTally {
  intervals: number
  bundles: number
  failures: number
  writeRepeats: number
  investigationRepeats: number
  timedOut: number
  largeOutput: number
  errors: number
  lines: number
}

export interface MetabolismCounts {
  /** Skill names that appeared in a skill_listing. */
  readonly skillsListed: readonly string[]
  /** Largest skill_listing seen, in characters. The denominator of the dead-weight ratio. */
  readonly listingChars: number
  /** True when a listing hit the 20,001-character cap, so the upper side is unmeasurable. */
  readonly listingTruncated: boolean
  /** Firings per skill name, from attributionSkill. */
  readonly skillFirings: Readonly<Record<string, number>>
  /** Firings per hook, from hook_success attachments. */
  readonly hookFirings: Readonly<Record<string, number>>
  /** Calls per MCP server, from attributionMcpServer. */
  readonly mcpFirings: Readonly<Record<string, number>>
  /**
   * Effective input tokens per assistant call: input plus cache reads.
   *
   * Kept as a reference figure. v1 §8 and v2 §3.5 both define the context tax
   * as `median(per task bundle)`, and the two differ by an order of magnitude,
   * so the per-call series is reported and the per-bundle one is scored.
   *
   * The comment that used to defend the per-call reading argued from the
   * main-only median of 415k against a 120k ceiling -- "both land on the floor,
   * so the reading does not change the verdict". The tool runs at scope `all`,
   * where the per-call median is 114,635 and the trapezoid gives 70.1 while the
   * per-bundle sum is past the ceiling and gives 20. It changed the verdict by
   * 50 points on the axis it was defending.
   */
  readonly effectiveInputPerCall: readonly number[]
  /** Effective input summed per task bundle. */
  readonly effectiveInputPerBundle: readonly number[]
  /** The largest effective input any one call in the bundle saw. A context size. */
  readonly peakInputPerBundle: readonly number[]
  /** The same without cache reads. v2 §3.5(b) requires both. */
  readonly inputPerBundleWithoutCache: readonly number[]
}

export interface ManualEditCounts {
  /** Basenames from edited_text_file attachments, lowercased. */
  readonly editedNames: readonly string[]
  /** Full paths whose write reported staleRecovered. */
  readonly staleRecoveredPaths: readonly string[]
  /** Rows carrying `userModified`, and rows where it was true. 766 and 0 here. */
  readonly userModifiedPresent: number
  readonly userModifiedTrue: number
}

export interface VerificationCounts {
  /**
   * Edit intervals: from a write to a path until the next write to the same
   * path, or the end of the transcript.
   *
   * Not cut at human turns. 945 of 1,108 sessions on the machine v1 measured
   * had exactly one human turn, so cutting there collapses most sessions into
   * a single interval and leaves the denominator at 1.
   */
  readonly intervals: number
  /** Intervals where the edited path, or its parent, later appeared in a tool argument. */
  readonly verifiedIntervals: number
  /** Whether TodoWrite was used at all. v1 deducts five points when it was not. */
  readonly todoWriteUsed: boolean
  /**
   * Failures a later success on the same target cleared, inside three attempts,
   * with no human turn between, and whose error class was new to the session.
   *
   * The last clause is v1's anti-gaming rule: without it, alternating a command
   * that always fails with one that always succeeds drives the rate to 1.0.
   */
  readonly selfRepaired: number
  /** Failures where a human turn came before the recovery. */
  readonly humanRescued: number
  /** Failures nothing cleared. The only part of the split that is deducted for. */
  readonly unresolved: number
  /**
   * Failures that were cleared but do not count towards the repair rate:
   * cleared past the third attempt, or of a class the session had already seen.
   *
   * They stay in the denominator and enter neither numerator. Booking them as
   * unresolved would deduct for a failure the agent actually fixed, which is a
   * penalty for recovering slowly or for recovering from something familiar.
   */
  readonly repairedNotCounted: number
}

export interface ProjectTally {
  readonly lines: number
  readonly subLines: number
  readonly humanRows: number
}

interface MutProjectTally { lines: number; subLines: number; humanRows: number }

/** The three date sets, gathered in one pass so they cannot drift apart. */
interface DateSets {
  readonly all: Set<Day>
  readonly userRow: Set<Day>
  readonly humanTurn: Set<Day>
  /**
   * The same human-turn days cut on UTC, whatever boundary was asked for.
   *
   * Published beside the real one so the divergence is on screen rather than
   * inferred. On this corpus the two are 11 and 10 against a window of 10 --
   * the boundary is the difference between a window that selects a subset and
   * one that selects everything.
   */
  readonly humanTurnUtc: Set<Day>
}

/**
 * Counters that belong to a calendar day.
 *
 * Kept per day rather than summed, so the window is a selection over aggregates
 * instead of a filter over rows. Nothing is dropped during the pass: the
 * reducer sees the same corpus it always did, so the parentUuid chain, the
 * repeat detector's first occurrences, the per-session first-seen classes and
 * the artifact censor all keep working. Only the attribution of a count to a
 * day is windowed.
 */
export interface DayCounts {
  toolResultTotal: number
  toolUseTotal: number
  toolUseFiltered: number
  toolResultWithIsErrorKey: number
  toolResultIsErrorTrue: number
  attributionSkillRows: number
  userRows: number
  originBearingUserRows: number
  humanTurns: number
  originHumanRows: number
  denialRows: number
  denialUserRejected: number
  denialKinds: Map<string, number>
  toolActivityRows: number
  userModifiedPresent: number
  userModifiedTrue: number
  todoWriteUsed: boolean
  environmentNoiseRows: number
  stopHookSummaryRows: number
  hookErrorsNonEmpty: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** Rows charged to this day. The windowed counterpart of `linesRead`. */
  rows: number
}

/**
 * Counters that belong to the corpus and cannot be windowed.
 *
 * Declared rather than defaulted into. `linesParseFailed` is the sharpest case:
 * a line that will not parse has no timestamp, so a windowed version is zero by
 * construction and the parse-failure gate becomes decoration — a detector
 * returning a well-formed zero. The file counters come from `statSync` and
 * belong to files rather than rows.
 */
interface AllTime {
  linesRead: number
  linesParseFailed: number
  filesUnreadable: number
  filesWithoutRows: number
  bytesRead: number
  mainLines: number
  subLines: number
  sessionIdMismatchRows: number
  taskBundles: number
  listingChars: number
  listingTruncated: boolean
  intervals: number
  verifiedIntervals: number
  selfRepaired: number
  humanRescued: number
  unresolved: number
  repairedNotCounted: number
  rootBundles: number
  orphanBundles: number
}

interface MutCwds {
  /**
   * Working directories the transcripts were recorded in.
   *
   * Keyed case-insensitively, because Windows writes the same directory with
   * either drive-letter case and this machine has both: lowercase on 55,346
   * rows and uppercase on 15,366. Counting them separately would report two
   * projects where there is one, and read the same skills twice. The value
   * keeps the first spelling seen, so what comes out is a real path rather
   * than a lowercased reconstruction.
   */
  readonly cwds: Map<string, string>
}

interface Mut extends AllTime, MutCwds {
  /** Per-day counters, and the `undated` bucket for rows with no timestamp. */
  readonly byDay: Map<string, DayCounts>
  /** The bucket for a day, created on first use. Null is the undated bucket. */
  on(day: string | null): DayCounts
}

const UNDATED = 'undated'

const emptyDayCounts = (): DayCounts => ({
  toolResultTotal: 0,
  toolUseTotal: 0,
  toolUseFiltered: 0,
  toolResultWithIsErrorKey: 0,
  toolResultIsErrorTrue: 0,
  attributionSkillRows: 0,
  userRows: 0,
  originBearingUserRows: 0,
  humanTurns: 0,
  originHumanRows: 0,
  denialRows: 0,
  denialUserRejected: 0,
  denialKinds: new Map<string, number>(),
  toolActivityRows: 0,
  userModifiedPresent: 0,
  userModifiedTrue: 0,
  todoWriteUsed: false,
  environmentNoiseRows: 0,
  stopHookSummaryRows: 0,
  hookErrorsNonEmpty: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  rows: 0,
})

/** The text of a tool_result, flattened. Read locally, classified, discarded. */
function resultText(block: Record<string, unknown>): string {
  const content = block['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (isObj(part) && typeof part['text'] === 'string') out += part['text']
  }
  return out
}

/**
 * The third term of a signature: what the failing call was aimed at.
 *
 * An extension for a file operation, a command's first token for a shell one —
 * v1's definition. Hashing it matters for the second: a first token is often
 * the name of a private script. The signatures never leave this process, since
 * they exist to produce one ratio, but hashing keeps a stray log line from
 * carrying it.
 *
 * An earlier version hashed the tool name instead, which put no information in
 * the term at all: constant per tool, so a signature was really (tool, class)
 * and two failures against different targets could not be told apart.
 */
export function targetOf(toolName: string, input: unknown): string {
  if (!isObj(input)) return ''
  if (toolName === 'Bash') {
    const command = input['command']
    if (typeof command !== 'string') return ''
    const first = command.trim().split(/\s+/)[0] ?? ''
    // Strip a directory so `scripts/x.py` and `./x.py` are the same target.
    return first.split(/[\\/]/).pop() ?? ''
  }
  const path = input['file_path'] ?? input['notebook_path'] ?? input['path']
  if (typeof path !== 'string') return ''
  const base = path.split(/[\\/]/).pop() ?? ''
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

// hashTarget was here: an unsalted 8-hex sha256 of the target, defended on the
// ground that it never left this process. That defence held until a snapshot
// wrote a file. It is replaced by a MAC over the whole signature tuple under a
// machine-local key -- 8 hex over a space of file extensions and command names
// is small enough to enumerate, and the tuple MAC covers the target anyway.

interface MutManualEdits {
  editedNames: Set<string>
  staleRecoveredPaths: Set<string>
}

interface MutMetabolism {
  skillsListed: Set<string>
  skillFirings: Map<string, number>
  hookFirings: Map<string, number>
  mcpFirings: Map<string, number>
  effectiveInputPerCall: number[]
  effectiveInputPerBundle: Map<number, number>
  peakInputPerBundle: Map<number, number>
  inputPerBundleWithoutCache: Map<number, number>
}

/**
 * A failure waiting to see whether anything cleared it.
 *
 * `firstSeenClass` is v1's anti-gaming clause: S's numerator counts only
 * failures whose error class was new to the session. Without it, alternating a
 * command that always fails with one that always succeeds drives S to 1.0.
 */
/**
 * A write waiting to see whether anything looked at it again.
 *
 * `openedOn` is the day the write happened. The interval is charged there, and
 * a verification that arrives later still counts — including one dated after
 * the window ends. An interval opened on day 3 and verified on day 12 is a
 * verified interval on day 3; cutting the verification off at the boundary
 * would make every window's newest edits look unverified, which is the
 * right-edge bias that filtering rows would have introduced.
 */
interface OpenEdit {
  verified: boolean
  openedOn: Day | null
}

interface PendingFailure {
  attempts: number
  humanSince: boolean
  firstSeenClass: boolean
  /** The day the first failing attempt happened. Where the episode is charged. */
  openedOn: Day | null
}

/** Axis 3's counters for one day. */
interface VerificationDay {
  intervals: number
  verifiedIntervals: number
  selfRepaired: number
  humanRescued: number
  unresolved: number
  repairedNotCounted: number
}

const emptyVerificationDay = (): VerificationDay => ({
  intervals: 0,
  verifiedIntervals: 0,
  selfRepaired: 0,
  humanRescued: 0,
  unresolved: 0,
  repairedNotCounted: 0,
})

interface MutWasted {
  failures: number
  hookOriginated: number
  /** Every is_error seen, counted before any attribution. The closure check needs it. */
  errorsObserved: number
  attribution: AttributionTally
  writeRepeats: number
  investigationRepeats: number
  timedOut: number
  largeOutput: number
  callsPerBundle: Map<string, number>
}

/**
 * What joins a signature's three parts before it is MAC'd.
 *
 * A character that cannot occur in a tool name, an error class or a target, so
 * `("a", "b:c", "")` and `("a:b", "c", "")` cannot collapse into one signature.
 */
const SIG_SEPARATOR = String.fromCharCode(0)

/** A failure a hook produced. 17 here; v1 measured 29 on the other machine. */
/** Where the other machine's skill_listing sat exactly, so past it is a truncation. */
const LISTING_CAP = 20_001

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const INSPECT_TOOLS = new Set(['Read', 'Grep', 'Bash', 'Glob'])
/** v1: a failure cleared within three attempts is a repair. */
const MAX_REPAIR_ATTEMPTS = 3


/** The MACs seen at least twice, sorted. v1's `S_t`. */
const repeatedOf = (macs: readonly Hmac128[]): readonly Hmac128[] => {
  const seen = new Map<string, number>()
  for (const mac of macs) seen.set(mac, (seen.get(mac) ?? 0) + 1)
  return [...seen.entries()]
    .filter(([, n]) => n >= 2)
    .map(([mac]) => mac as Hmac128)
    .sort()
}

/** How a bundle came to exist. A delegation is opened by the request that spawned it. */
type BundleKind = 'human' | 'root' | 'orphan' | 'delegation'

/** Name-keyed collections that a window selects rather than sums. */
type DayedKind = 'skillFirings' | 'hookFirings' | 'mcpFirings' | 'editedNames' | 'staleRecoveredPaths'

/**
 * A local, opaque key for one failure signature.
 *
 * Truncated, and never emitted: the payload carries the MAC and the aggregate
 * rate, and this exists only so a window can recompute a rate that does not add
 * up. Same construction as the `other:<digest>` bucket in `errorClass`.
 */
const signatureKey = (tuple: readonly [string, ErrorClass, string]): string =>
  createHash('sha256').update(tuple.join(SIG_SEPARATOR), 'utf8').digest('hex').slice(0, 16)

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** How many times a file was edited, keyed by path. Only the counts leave here. */
type EditTally = Map<string, number>

function reduceLine(
  raw: string,
  kind: FileEntry['kind'],
  m: Mut,
  skills: Set<string>,
  mcp: Set<string>,
  versions: Map<string, MutVersionSlice>,
  sessions: Set<string>,
  dates: DateSets,
  edits: EditTally,
  proj: MutProjectTally,
  fileSession: string,
  st: MutSessionTally,
  notHuman: Map<string, number>,
  bundles: BundleTracker,
  bundleDay: Map<number, { day: Day | null; kind: BundleKind }>,
  subBundle: number | null,
  paths: Map<string, MutPathTally>,
  refs: ReferenceIndex,
  toolOf: Map<string, { name: string; target: string }>,
  tuples: Array<readonly [string, ErrorClass, string]>,
  macs: Hmac128[],
  signatureKeysPerDay: Map<string, string[]>,
  macsPerDay: Map<string, Hmac128[]>,
  sign: Signer | null,
  wasted: WastedTracker,
  wOf: (bundle: number | null) => MutWasted,
  met: MutMetabolism,
  manual: MutManualEdits,
  openEdits: Map<string, OpenEdit>,
  verificationOn: (day: Day | null) => VerificationDay,
  noteCluster: (kind: 'bundles' | 'intervals' | 'errors', session: string, day: Day | null) => void,
  noteDayed: (kind: DayedKind, name: string, day: Day | null) => void,
  closeInterval: (open: OpenEdit) => void,
  pending: Map<string, PendingFailure>,
  seenClasses: Set<string>,
  dayOffsetMinutes: number,
): void {
  const line = raw.trim()
  if (line.length === 0) return

  m.linesRead += 1
  proj.lines += 1
  st.lines += 1
  if (kind === 'main') m.mainLines += 1
  else {
    m.subLines += 1
    proj.subLines += 1
  }

  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    // Counted, never guessed at. A line that would not parse is reported as a
    // parse failure rather than skipped, because a parser returning a quiet zero
    // is the failure this whole product exists to make visible.
    m.linesParseFailed += 1
    return
  }
  if (!isObj(row)) {
    m.linesParseFailed += 1
    return
  }

  // The day first, because every counter below belongs to one. Rows with no
  // parsable timestamp go to the undated bucket, which is never in any window.
  const tsEarly = row['timestamp']
  const day = dayOf(tsEarly, dayOffsetMinutes)
  const dayUtc = dayOffsetMinutes === 0 ? day : dayOf(tsEarly, 0)
  const d = m.on(day)
  d.rows += 1

  const rowUuid = typeof row['uuid'] === 'string' ? (row['uuid'] as string) : null
  const rowParent = typeof row['parentUuid'] === 'string' ? (row['parentUuid'] as string) : null

  // P3 — a bad connection is not low quality work. Dropped from every
  // numerator and denominator, and counted so the drop is visible.
  //
  // Still placed in a bundle first. P3 says to exclude these rows from the
  // counts, not to remove them from the conversation tree: dropping them from
  // the chain orphans their children, which showed up as 7 orphan bundles
  // against a measured zero unresolvable parents.
  if (isEnvironmentNoise(row)) {
    d.environmentNoiseRows += 1
    if (kind === 'main') bundles.assign(rowUuid, rowParent, false)
    return
  }

  const cwd = row['cwd']
  if (typeof cwd === 'string' && cwd !== '') {
    const key = cwd.toLowerCase()
    if (!m.cwds.has(key)) m.cwds.set(key, cwd)
  }

  const version = row['version']
  let slice: MutVersionSlice | null = null
  if (typeof version === 'string') {
    slice = versions.get(version) ?? { rows: 0, failures: 0, toolUse: 0, firstDay: null, lastDay: null }
    slice.rows += 1
    if (day !== null) {
      if (slice.firstDay === null || day < slice.firstDay) slice.firstDay = day
      if (slice.lastDay === null || day > slice.lastDay) slice.lastDay = day
    }
    versions.set(version, slice)
  }

  // The cluster is the file's session, folded from the path. The row's own id
  // is compared against it rather than trusted, because a divergence would move
  // the cluster count silently and the cluster count gates the minimum
  // denominator.
  sessions.add(fileSession)
  const sessionId = row['sessionId']
  if (typeof sessionId === 'string' && sessionId !== fileSession) m.sessionIdMismatchRows += 1

  const ts = tsEarly
  if (day !== null) dates.all.add(day)

  const skill = row['attributionSkill']
  if (typeof skill === 'string' && skill.length > 0) {
    d.attributionSkillRows += 1
    skills.add(skill)
    met.skillFirings.set(skill, (met.skillFirings.get(skill) ?? 0) + 1)
    noteDayed('skillFirings', skill, day)
  }

  // Axis 5's asset set. `names` is on the attachment already, so the listing's
  // text is only measured, never parsed for names.
  const attachment = row['attachment']
  if (isObj(attachment)) {
    if (attachment['type'] === 'skill_listing') {
      const names = attachment['names']
      if (Array.isArray(names)) {
        for (const n of names) if (typeof n === 'string') met.skillsListed.add(n)
      }
      const content = attachment['content']
      if (typeof content === 'string') {
        if (content.length > m.listingChars) m.listingChars = content.length
        // The cap the other machine's listing sat exactly on. Past it the
        // upper side of the dead-weight ratio cannot be measured at all.
        if (content.length >= LISTING_CAP) m.listingTruncated = true
      }
    } else if (attachment['type'] === 'edited_text_file') {
      // `filename`, not a path. Matching is by basename below, and that is
      // stated rather than hidden.
      const filename = attachment['filename']
      if (typeof filename === 'string' && filename.length > 0) {
        manual.editedNames.add(filename.split(/[\/]/).pop()?.toLowerCase() ?? '')
        noteDayed('editedNames', filename.split(/[\/]/).pop()?.toLowerCase() ?? '', day)
      }
    } else if (attachment['type'] === 'hook_success') {
      const name = attachment['hookName']
      if (typeof name === 'string' && name.length > 0) {
        met.hookFirings.set(name, (met.hookFirings.get(name) ?? 0) + 1)
        noteDayed('hookFirings', name, day)
      }
    }
  }

  const server = row['attributionMcpServer']
  if (typeof server === 'string' && server.length > 0) {
    mcp.add(server)
    met.mcpFirings.set(server, (met.mcpFirings.get(server) ?? 0) + 1)
    noteDayed('mcpFirings', server, day)
  }

  // Row level, not inside toolUseResult. The other machine measured 0 against
  // the nested path and 62 against the row; a path nobody writes down is a path
  // each implementation guesses differently.
  const denial = row['toolDenialKind']
  const denialKind = typeof denial === 'string' && denial.length > 0 ? denial : null
  if (denialKind !== null) {
    d.denialRows += 1
    if (denialKind === 'user-rejected') d.denialUserRejected += 1
    // Kept by name. The spec's union has two members and this machine emits
    // four; the two extra carry 95 of 412 failures here and none at all on the
    // machine the spec was written against. A value nobody enumerated is how an
    // environment-specific figure gets read as an environment difference.
    d.denialKinds.set(denialKind, (d.denialKinds.get(denialKind) ?? 0) + 1)
  }

  let human = false
  if (row['type'] === 'user') {
    d.userRows += 1
    if (day !== null) dates.userRow.add(day)
    const origin = row['origin']
    if (isObj(origin)) {
      d.originBearingUserRows += 1
      // Supporting signal only. v1: a missing key does not mean not human.
      if (origin['kind'] === 'human') d.originHumanRows += 1
    }
    const why = notHumanBecause(row, kind === 'sub')
    if (why === null) {
      human = true
      d.humanTurns += 1
      // A human turn between a failure and its recovery makes the recovery a
      // rescue rather than a repair. v1 splits the two and deducts for neither.
      for (const st of pending.values()) st.humanSince = true
      proj.humanRows += 1
      if (day !== null) dates.humanTurn.add(day)
      if (dayUtc !== null) dates.humanTurnUtc.add(dayUtc)
    } else {
      notHuman.set(why, (notHuman.get(why) ?? 0) + 1)
    }
  }

  // P5 — every row joins a bundle, so a later stage can group by it.
  //
  // Main transcripts carry the parentUuid chain. A subagent file does not: it
  // is work inside one request rather than a sequence of them, and every row in
  // it belongs to the delegation that spawned it. Giving them all `null`
  // collapsed 294 files into one pseudo-bundle, which put every subagent
  // artifact the machine ever produced under a single three-per-bundle cap and
  // made repeat detection compare unrelated agents with each other.
  const assigned = kind === 'main' ? bundles.assign(rowUuid, rowParent, human) : null
  const bundle = kind === 'main' ? (assigned?.id ?? null) : subBundle

  // A bundle belongs to the day of the row that opened it, and is recorded once.
  // Every count that divides by bundles has to leave the window together with
  // the bundle it divides by: charging a repeat to the row's day while the
  // bundle it belongs to sits on another lets a numerator count on a day its
  // denominator does not, and W moves for a boundary reason with nothing to
  // show it.
  if (assigned !== null && assigned.kind !== 'inherited' && !bundleDay.has(assigned.id)) {
    bundleDay.set(assigned.id, { day, kind: assigned.kind })
    noteCluster('bundles', fileSession, day)
  }
  // A delegation's id is allocated when its file opens, but its day is the day
  // of its first row. Stamping it at file-open charged a bundle to the window
  // before a single line had been read, so a delegation whose rows all fall
  // outside the window still inflated the denominator.
  if (kind === 'sub' && subBundle !== null && !bundleDay.has(subBundle)) {
    bundleDay.set(subBundle, { day, kind: 'delegation' })
    noteCluster('bundles', fileSession, day)
    // Counted against the parent session here rather than at file-open, so the
    // per-session tally and the machine-wide one register the same bundle at
    // the same moment. `axis-denominator-close` compares them.
    st.bundles += 1
  }

  // Axis 2's numerator lives on the same day as the bundle it will be divided
  // by. Charging it to the row's day instead lets a repeat count on a day its
  // bundle does not, which inflates W for a boundary reason with no counter
  // moving to show it.
  const w = wOf(bundle)

  // P6 — a write's landing place and size, from the result rather than the
  // call: the call says where, the result says how much.
  const result = row['toolUseResult']
  if (isObj(result)) {
    // Counted, not consulted. Present 766 times and true 0 times here, which is
    // the fourth uniformly dead boolean this log has produced.
    if ('userModified' in result) {
      d.userModifiedPresent += 1
      if (result['userModified'] === true) d.userModifiedTrue += 1
    }
    if (result['staleRecovered'] === true) {
      const fp = result['filePath']
      if (typeof fp === 'string') {
        manual.staleRecoveredPaths.add(fp)
        noteDayed('staleRecoveredPaths', fp, day)
      }
    }
    if (result['timedOutAfterMs'] !== undefined && result['timedOutAfterMs'] !== null) {
      w.timedOut += 1
      st.timedOut += 1
    }
    const size = result['persistedOutputSize']
    if (typeof size === 'number' && size > LARGE_OUTPUT_BYTES) {
      w.largeOutput += 1
      st.largeOutput += 1
    }
  }

  const write = readWrite(row['toolUseResult'])
  if (write !== null) recordWrite(paths, write, typeof ts === 'string' ? ts : null, bundle)

  // P6 uptake (a) — a path mentioned after it was written was used. Human text
  // and tool arguments both count; a person naming a file and a command taking
  // it as an argument are the same signal.
  if (human) refs.note(userText(row), typeof ts === 'string' ? ts : null, bundle)

  if (row['subtype'] === 'stop_hook_summary') {
    d.stopHookSummaryRows += 1
    const errs = row['hookErrors']
    // Non-empty hookErrors, not preventedContinuation. The boolean is false on
    // every one of these rows on both machines, including the ones where a hook
    // really did refuse the response.
    if (Array.isArray(errs) && errs.length > 0) d.hookErrorsNonEmpty += 1
  }

  const message = row['message']
  if (!isObj(message)) return

  const usage = message['usage']
  if (isObj(usage)) {
    const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
    d.input += n('input_tokens')
    d.output += n('output_tokens')
    d.cacheRead += n('cache_read_input_tokens')
    d.cacheCreation += n('cache_creation_input_tokens')
    const effective = n('input_tokens') + n('cache_read_input_tokens')
    if (effective > 0) met.effectiveInputPerCall.push(effective)
    // Per bundle, which is what the axis is defined on. A row with no bundle
    // belongs to no request, so it is left out rather than pooled -- pooling it
    // would make one synthetic bundle carry every unattributable row.
    if (bundle !== null) {
      if (effective > 0) {
        met.effectiveInputPerBundle.set(bundle, (met.effectiveInputPerBundle.get(bundle) ?? 0) + effective)
        // The largest context this request ever operated at. Summing counts the
        // same cached context once per call inside the bundle; the peak is the
        // size, and size is what the trapezoid's thresholds are in.
        met.peakInputPerBundle.set(bundle, Math.max(met.peakInputPerBundle.get(bundle) ?? 0, effective))
      }
      const plain = n('input_tokens')
      if (plain > 0) {
        met.inputPerBundleWithoutCache.set(bundle, (met.inputPerBundleWithoutCache.get(bundle) ?? 0) + plain)
      }
    }
  }

  const content = message['content']
  if (!Array.isArray(content)) return
  // Counted once per row, not per block: lineStates has to sum to linesRead.
  if (content.some((b) => isObj(b) && (b['type'] === 'tool_use' || b['type'] === 'tool_result'))) {
    d.toolActivityRows += 1
  }
  for (const block of content) {
    if (!isObj(block)) continue
    if (block['type'] === 'tool_result') {
      d.toolResultTotal += 1
      if ('is_error' in block) {
        d.toolResultWithIsErrorKey += 1
        const okId = block['tool_use_id']
        if (block['is_error'] !== true && typeof okId === 'string') {
          const okCall = toolOf.get(okId)
          const okKey = `${okCall?.name ?? 'unknown'} ${okCall?.target ?? ''}`
          const settled = pending.get(okKey)
          if (settled !== undefined) {
            // v1's three-way split, plus the bucket its two clauses imply.
            //
            // A human turn in between makes it a rescue, which v1 counts apart
            // and deducts for neither. Within three attempts, no human turn and
            // a class new to the session is a self-repair. Everything else was
            // still cleared, so it cannot be called unresolved -- that term is
            // the only one the score deducts for, and deducting for a failure
            // the agent fixed would be a penalty for recovering slowly or for
            // recovering from something familiar.
            // Charged to the day the episode opened, so the failure and its
            // recovery land together however far apart they are.
            const bucket = verificationOn(settled.openedOn)
            if (settled.humanSince) bucket.humanRescued += 1
            else if (settled.attempts <= MAX_REPAIR_ATTEMPTS && settled.firstSeenClass) {
              bucket.selfRepaired += 1
            } else bucket.repairedNotCounted += 1
            pending.delete(okKey)
          }
        }
        if (block['is_error'] === true) {
          d.toolResultIsErrorTrue += 1
          w.errorsObserved += 1
          const text = resultText(block)
          // Joined to the call by tool_use_id. Without the join the class is
          // known and the tool is not, and (class, target) alone collapses a
          // Bash failure and an Edit failure into one signature.
          const errId = block['tool_use_id']
          const call = typeof errId === 'string' ? toolOf.get(errId) : undefined
          const errorClass = classifyError(text)

          // One event, one axis, decided before anything is charged. A call a
          // permission rule refused used to be charged to the agent as wasted
          // motion *and* credited to the environment as a guardrail working.
          // 407 failures here attribute to 187.
          const attributed = attribute({
            denialKind,
            text,
            tool: call?.name ?? null,
            errorClass,
          })
          w.attribution[attributed] += 1

          if (IN_AXIS2_NUMERATOR[attributed]) {
            w.failures += 1
            st.failures += 1
            // Charged through the same table as axis 2, so the slice cannot
            // drift from the axis by counting denials the axis excludes.
            if (slice !== null) slice.failures += 1
          } else {
            // Everything the table takes out of axis 2: denials of every kind,
            // the network, and the stale reads axis 3 scores instead.
            w.hookOriginated += 1
          }
          st.errors += 1
          noteCluster('errors', fileSession, day)

          // Only what axis 2 charged supplies a signature. A refused call in the
          // recurrence set would make one guardrail firing twice look like the
          // same failure coming back.
          // Axis 3's split. Only failures the work produced: a denied call
          // never ran, so there is nothing for anyone to recover from.
          if (IN_REPAIR_SPLIT[attributed]) {
            const key = `${call?.name ?? 'unknown'} ${call?.target ?? ''}`
            const open = pending.get(key)
            if (open === undefined) {
              pending.set(key, {
                attempts: 1,
                humanSince: false,
                firstSeenClass: !seenClasses.has(errorClass),
                openedOn: day,
              })
            } else {
              open.attempts += 1
            }
            seenClasses.add(errorClass)
          }

          if (SUPPLIES_SIGNATURE[attributed]) {
            // The plaintext tuple stays in this frame. `repeatRate` reads it
            // below; only the MAC and the aggregates come out.
            const tuple: readonly [string, ErrorClass, string] = [
              call?.name ?? 'unknown',
              errorClass,
              call?.target ?? '',
            ]
            tuples.push(tuple)
            // Keyed by the failing row's own day, not by its bundle. `rIn` is
            // `1 - distinct/count` over this same set, so numerator and
            // denominator share an anchor by construction — and axis 6, which
            // the set also feeds, divides by nothing bundle-shaped.
            const dayKey = day ?? 'undated'
            const perDay = signatureKeysPerDay.get(dayKey) ?? []
            perDay.push(signatureKey(tuple))
            signatureKeysPerDay.set(dayKey, perDay)
            if (sign !== null) {
              macs.push(sign('sig/e', tuple.join(SIG_SEPARATOR)))
              const macDay = macsPerDay.get(dayKey) ?? []
              macDay.push(sign('sig/e', tuple.join(SIG_SEPARATOR)))
              macsPerDay.set(dayKey, macDay)
            }
          }
        }
      }
    } else if (block['type'] === 'tool_use') {
      const id = block['id']
      const toolName = block['name']
      d.toolUseTotal += 1
      // Axis 2's availability is defined on filtered tool_use. The network is
      // not the environment under test, so it does not count towards having
      // enough evidence to judge one.
      if (typeof toolName !== 'string' || !isExternalTool(toolName)) {
        d.toolUseFiltered += 1
        if (slice !== null) slice.toolUse += 1
      }
      if (typeof id === 'string' && typeof toolName === 'string') {
        toolOf.set(id, { name: toolName, target: targetOf(toolName, block['input']) })
      }
      if (toolName === 'TodoWrite') d.todoWriteUsed = true
      if (typeof toolName === 'string' && isObj(block['input'])) {
        const input = block['input'] as Record<string, unknown>
        if (EDIT_TOOLS.has(toolName)) {
          const path = input['file_path'] ?? input['notebook_path']
          if (typeof path === 'string' && path.length > 0) {
            const key = normalisePath(path)
            // A second write to the same path closes the first interval.
            const previous = openEdits.get(key)
            if (previous !== undefined) {
              closeInterval(previous)
              st.intervals += 1
              noteCluster('intervals', fileSession, previous.openedOn)
            }
            openEdits.set(key, { verified: false, openedOn: day })
          }
        } else if (INSPECT_TOOLS.has(toolName)) {
          // The path itself or its parent directory appearing in any argument.
          // No command dictionary: v1 dropped one because most Bash calls on the
          // machine it was fitted to were python invocations, so the next piece
          // of work after an edit counted as verification of it.
          const args = Object.values(input)
            .filter((v): v is string => typeof v === 'string')
            .join(' ')
          const haystack = normalisePath(args)
          for (const [key, open] of openEdits) {
            const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
            if (haystack.includes(key) || (parent !== '' && haystack.includes(parent))) {
              open.verified = true
            }
          }
        }

        // A tool's arguments count as a reference too: v1 names Read, Grep and
        // Bash arguments alongside human text.
        for (const v of Object.values(input)) {
          if (typeof v === 'string' && v.length > 0) {
            refs.note(v, typeof ts === 'string' ? ts : null, bundle)
          }
        }
        const key = bundle === null ? 'none' : String(bundle)
        w.callsPerBundle.set(key, (w.callsPerBundle.get(key) ?? 0) + 1)
        if (wasted.call(bundle, toolName, block['input'])) {
          if (isInvestigation(toolName)) {
            w.investigationRepeats += 1
            st.investigationRepeats += 1
          } else {
            w.writeRepeats += 1
            st.writeRepeats += 1
          }
        }
      }
      const name = block['name']
      if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
        const input = block['input']
        if (isObj(input)) {
          const path = input['file_path'] ?? input['notebook_path']
          // The path is tallied and discarded. Only "how many files" and "how
          // many of them more than once" survive this function.
          if (typeof path === 'string' && path.length > 0) {
            edits.set(path, (edits.get(path) ?? 0) + 1)
          }
        }
      }
    }
  }
}

/**
 * Read every file in the inventory once.
 *
 * `read` is injectable so a test can count opens per path. The default is a
 * single readFileSync per file, and the test asserts exactly that — a reducer
 * that quietly took a second pass would still produce correct-looking totals.
 */
export function scan(
  inv: Inventory,
  read: ((path: string) => string) | undefined = undefined,
  /**
   * Injected, so the key never enters this function and the plaintext tuple
   * never leaves it. Null means no signer was available: signatures come back
   * empty and `signaturesSigned` says why, because an empty set and an unsigned
   * run are the same array and opposite facts.
   */
  sign: Signer | null = null,
  /**
   * Minutes east of UTC that the calendar day is cut on.
   *
   * Required rather than defaulted: a default would pick UTC silently, and on
   * this corpus UTC gives 10 human-turn days where the report's own offset
   * gives 11 — against a ten-day window, the difference between selecting a
   * subset and selecting everything. See `offsetMinutesOf`.
   */
  dayOffsetMinutes: number,
): ScanCounts {
  const byDay = new Map<string, DayCounts>()
  const m: Mut = {
    linesRead: 0, linesParseFailed: 0, filesUnreadable: 0, filesWithoutRows: 0, bytesRead: 0, mainLines: 0, subLines: 0,
    sessionIdMismatchRows: 0, taskBundles: 0, listingChars: 0, listingTruncated: false,
    intervals: 0, verifiedIntervals: 0,
    selfRepaired: 0, humanRescued: 0, unresolved: 0, repairedNotCounted: 0, rootBundles: 0, orphanBundles: 0,
    cwds: new Map<string, string>(),
    byDay,
    on(day: string | null): DayCounts {
      const key = day ?? UNDATED
      let bucket = byDay.get(key)
      if (bucket === undefined) {
        bucket = emptyDayCounts()
        byDay.set(key, bucket)
      }
      return bucket
    },
  }
  /** The per-day denial-kind maps merged. */
  const mergedDenialKinds = (): Map<string, number> => {
    const out = new Map<string, number>()
    for (const c of byDay.values()) {
      for (const [k, n] of c.denialKinds) out.set(k, (out.get(k) ?? 0) + n)
    }
    return out
  }

  /** Every day-keyed counter summed. What the all-time view reports. */
  const total = (pick: (c: DayCounts) => number): number => {
    let n = 0
    for (const c of byDay.values()) n += pick(c)
    return n
  }
  const skills = new Set<string>()
  const mcp = new Set<string>()
  const versions = new Map<string, MutVersionSlice>()
  const sessions = new Set<string>()
  const dates: DateSets = { all: new Set(), userRow: new Set(), humanTurn: new Set(), humanTurnUtc: new Set() }
  const edits: EditTally = new Map()
  const perProject = new Map<string, MutProjectTally>()
  const notHuman = new Map<string, number>()
  const paths = new Map<string, MutPathTally>()
  const refs = referenceIndex()
  const toolOf = new Map<string, { name: string; target: string }>()
  const tuples: Array<readonly [string, ErrorClass, string]> = []
  const macs: Hmac128[] = []
  /**
   * Signature keys by the day the failure happened on.
   *
   * `rIn` is `1 - distinct/count`, which is not additive: summing per-day
   * distinct counts over-counts every signature that appears on two days. The
   * window therefore has to re-derive it from the members, which means the
   * members have to survive per day.
   *
   * The key is a truncated local digest of the same tuple the MAC is taken
   * over, not the tuple. It stays inside this process — `assemble` and
   * `buildSnapshot` both pick their fields by name and neither reaches for it —
   * and a test asserts it never appears in a payload.
   */
  const signatureKeysPerDay = new Map<string, string[]>()
  const macsPerDay = new Map<string, Hmac128[]>()
  const perSession = new Map<string, MutSessionTally>()
  const seenClassBySession = new Map<string, Set<string>>()
  const subBundles = new Map<string, number>()
  /**
   * Each bundle's opening day, recorded once.
   *
   * The tallies for task bundles, chain roots and orphans are derived from this
   * at emit rather than counted as they go, so a bundle and everything charged
   * to it leave the window together.
   */
  const bundleDay = new Map<number, { day: Day | null; kind: BundleKind }>()
  /**
   * Which days each session had a non-zero denominator on, per axis.
   *
   * A cluster is a session with a denominator *for that axis*, and the window
   * has to judge that over the window: counting sessions that had a bundle at
   * any time in the corpus, against a denominator taken from ten days, is a
   * minimum judged on one basis and a rate taken on another.
   *
   * Day sets rather than per-day tallies, because the consumer only ever asks
   * whether the count is above zero.
   */
  const clusterDays = {
    bundles: new Map<string, Set<string>>(),
    intervals: new Map<string, Set<string>>(),
    errors: new Map<string, Set<string>>(),
  }
  /**
   * Named things and the days they happened on.
   *
   * The firing maps and the manual-edit sets are keyed by name, so the window
   * cannot be a sum — it is a selection over which names fired inside it. A
   * skill that fired six weeks ago is not a fired asset for a utilisation rate
   * taken from the last ten active days.
   */
  const dayed: Record<DayedKind, Map<string, Set<string>>> = {
    skillFirings: new Map(),
    hookFirings: new Map(),
    mcpFirings: new Map(),
    editedNames: new Map(),
    staleRecoveredPaths: new Map(),
  }
  const noteDayed = (kind: DayedKind, name: string, day: Day | null): void => {
    const set = dayed[kind].get(name) ?? new Set<string>()
    set.add(day ?? 'undated')
    dayed[kind].set(name, set)
  }

  const noteCluster = (kind: keyof typeof clusterDays, session: string, day: Day | null): void => {
    const key = day ?? 'undated'
    const set = clusterDays[kind].get(session) ?? new Set<string>()
    set.add(key)
    clusterDays[kind].set(session, set)
  }
  /**
   * Axis 3's counters by the day the interval or the episode opened on.
   *
   * The classification is unchanged and still computed over the whole corpus:
   * `humanSince`, `seenClasses` and the attempt count all see every row, so
   * v1's first-seen-class rule keeps binding and a rescue is still a rescue.
   * Only where the result is charged is windowed.
   */
  const verificationByDay = new Map<string, VerificationDay>()
  const verificationOn = (day: Day | null): VerificationDay => {
    const key = day ?? 'undated'
    let bucket = verificationByDay.get(key)
    if (bucket === undefined) {
      bucket = emptyVerificationDay()
      verificationByDay.set(key, bucket)
    }
    return bucket
  }
  const closeInterval = (open: OpenEdit): void => {
    const bucket = verificationOn(open.openedOn)
    bucket.intervals += 1
    if (open.verified) bucket.verifiedIntervals += 1
  }
  const manual: MutManualEdits = { editedNames: new Set(), staleRecoveredPaths: new Set() }
  const met: MutMetabolism = {
    skillsListed: new Set(),
    skillFirings: new Map(),
    hookFirings: new Map(),
    mcpFirings: new Map(),
    effectiveInputPerCall: [],
    effectiveInputPerBundle: new Map<number, number>(),
    peakInputPerBundle: new Map<number, number>(),
    inputPerBundleWithoutCache: new Map<number, number>(),
  }
  const wasted = wastedTracker()
  const emptyWasted = (): MutWasted => ({
    failures: 0, hookOriginated: 0, errorsObserved: 0, attribution: emptyTally(),
    writeRepeats: 0, investigationRepeats: 0,
    timedOut: 0, largeOutput: 0, callsPerBundle: new Map<string, number>(),
  })
  /**
   * Axis 2's counters, keyed by the day the bundle opened on.
   *
   * Anchored by the denominator they are divided by. `w = numerator / bundles`,
   * so a numerator term charged to the row's day while its bundle sits on
   * another would let the numerator count on a day the denominator does not,
   * and W would move for a boundary reason with no counter showing it.
   */
  const wByDay = new Map<string, MutWasted>()
  const wOf = (bundle: number | null): MutWasted => {
    const key = (bundle === null ? null : (bundleDay.get(bundle)?.day ?? null)) ?? 'undated'
    let bucket = wByDay.get(key)
    if (bucket === undefined) {
      bucket = emptyWasted()
      wByDay.set(key, bucket)
    }
    return bucket
  }
  /** Every day's counters folded into one. What the all-time view reports. */
  const wTotal = (): MutWasted => {
    const out = emptyWasted()
    for (const b of wByDay.values()) {
      out.failures += b.failures
      out.hookOriginated += b.hookOriginated
      out.errorsObserved += b.errorsObserved
      out.writeRepeats += b.writeRepeats
      out.investigationRepeats += b.investigationRepeats
      out.timedOut += b.timedOut
      out.largeOutput += b.largeOutput
      for (const id of ATTRIBUTIONS) out.attribution[id] += b.attribution[id]
      for (const [k, n] of b.callsPerBundle) out.callsPerBundle.set(k, (out.callsPerBundle.get(k) ?? 0) + n)
    }
    return out
  }
  let bundleSeq = 0
  const nextBundleId = (): number => { bundleSeq += 1; return bundleSeq }

  for (const file of inv.files) {
    // Read first, and count a failure.
    //
    // The read used to sit after the bytes were added and after a per-session
    // entry had been created, and its catch incremented nothing. An unreadable
    // transcript then left `filesRead` counting it, `linesParseFailed` at zero,
    // the gate green, and every count short together so the identities still
    // closed -- indistinguishable from a quiet month. Worse, the orphaned
    // session entry broke `sessions-close` and refused the whole snapshot, so
    // one zero-byte file cost every later window its baseline for as long as
    // it existed.
    let text = ''
    try {
      text = (read ?? ((p: string) => readFileSync(p, 'utf8')))(file.path)
    } catch {
      m.filesUnreadable += 1
      continue
    }
    m.bytesRead += file.bytes

    let proj = perProject.get(file.project)
    if (proj === undefined) {
      proj = { lines: 0, subLines: 0, humanRows: 0 }
      perProject.set(file.project, proj)
    }
    const bundles = bundleTracker(nextBundleId)
    const openEdits = new Map<string, OpenEdit>()
    const pending = new Map<string, PendingFailure>()
    // Per session, not per file: v1 says "first seen in that session", and a
    // session is one main transcript plus the subagent files hanging off it.
    let seenClasses = seenClassBySession.get(file.sessionId)
    if (seenClasses === undefined) {
      seenClasses = new Set<string>()
      seenClassBySession.set(file.sessionId, seenClasses)
    }
    let st = perSession.get(file.sessionId)
    if (st === undefined) {
      st = {
        intervals: 0, bundles: 0, failures: 0, writeRepeats: 0, investigationRepeats: 0,
        timedOut: 0, largeOutput: 0, errors: 0, lines: 0,
      }
      perSession.set(file.sessionId, st)
    }
    // One bundle per delegation, shared by every agent transcript under it, and
    // allocated once so a second file in the same group joins rather than opens
    // its own. Counted against the parent session, which is where the request
    // that made the delegation came from.
    let subBundle: number | null = null
    if (file.kind === 'sub' && file.group !== null) {
      const existing = subBundles.get(file.group)
      if (existing === undefined) {
        subBundle = nextBundleId()
        subBundles.set(file.group, subBundle)
      } else {
        subBundle = existing
      }
    }
    for (const line of text.split('\n')) {
      reduceLine(line, file.kind, m, skills, mcp, versions, sessions, dates, edits, proj, file.sessionId, st, notHuman, bundles, bundleDay, subBundle, paths, refs, toolOf, tuples, macs, signatureKeysPerDay, macsPerDay, sign, wasted, wOf, met, manual, openEdits, verificationOn, noteCluster, noteDayed, closeInterval, pending, seenClasses, dayOffsetMinutes)
    }
    // Intervals still open when the transcript ends are closed here: a write
    // whose file was never touched again is an unverified interval, not a
    // missing one.
    for (const open of openEdits.values()) {
      closeInterval(open)
      st.intervals += 1
    }
    // Failures nothing ever cleared. Charged to the day each one opened on, so
    // a failure that arrived inside the window and was never fixed counts
    // there rather than at the end of the scan.
    for (const open of pending.values()) {
      const bucket = verificationOn(open.openedOn)
      bucket.unresolved += 1
    }
    // Every bundle that exists, not only the ones a human turn opened. A chain
    // root and an orphan are bundles: their calls are charged to axis 2's
    // numerator, so leaving them out of the denominator raises W by counting
    // work against fewer requests than actually happened.
    // A file that opened and produced nothing leaves no session behind. The
    // per-session entry is created before the lines are read, and an orphaned
    // one breaks `sessions-close` and refuses the entire snapshot.
    if (!sessions.has(file.sessionId) && st.lines === 0) {
      perSession.delete(file.sessionId)
      m.filesWithoutRows += 1
    }
    // Per-session tallies still count as they go; the machine-wide ones are
    // derived from `bundleDay` at emit so a bundle and its day cannot disagree.
    st.bundles += bundles.opened() + bundles.roots() + bundles.orphans()
  }

  const countKind = (want: BundleKind): number => {
    let n = 0
    for (const b of bundleDay.values()) if (b.kind === want) n += 1
    return n
  }

  /**
   * Bundles by the day they opened on.
   *
   * The window selects over this. A bundle and everything charged to it have to
   * leave the window together — charging a repeat to the row's day while its
   * bundle sits on another lets a numerator count on a day its denominator does
   * not, and W moves for a boundary reason with nothing to show it.
   */
  const bundlesPerDay = (): Record<string, { task: number; root: number; orphan: number }> => {
    const out: Record<string, { task: number; root: number; orphan: number }> = {}
    for (const b of bundleDay.values()) {
      const key = b.day ?? 'undated'
      const bucket = (out[key] ??= { task: 0, root: 0, orphan: 0 })
      bucket.task += 1
      if (b.kind === 'root') bucket.root += 1
      if (b.kind === 'orphan') bucket.orphan += 1
    }
    return out
  }

  /** Every day's axis-3 counters folded into one. What the all-time view reports. */
  const verificationTotal = (): VerificationDay => {
    const out = emptyVerificationDay()
    for (const b of verificationByDay.values()) {
      out.intervals += b.intervals
      out.verifiedIntervals += b.verifiedIntervals
      out.selfRepaired += b.selfRepaired
      out.humanRescued += b.humanRescued
      out.unresolved += b.unresolved
      out.repairedNotCounted += b.repairedNotCounted
    }
    return out
  }

  let repeated = 0
  for (const count of edits.values()) if (count > 1) repeated += 1

  return {
    linesRead: m.linesRead,
    linesParseFailed: m.linesParseFailed,
    filesUnreadable: m.filesUnreadable,
    filesWithoutRows: m.filesWithoutRows,
    bytesRead: m.bytesRead,
    mainLines: m.mainLines,
    subLines: m.subLines,
    toolResultTotal: total((c) => c.toolResultTotal),
    toolUseTotal: total((c) => c.toolUseTotal),
    toolUseFiltered: total((c) => c.toolUseFiltered),
    toolResultWithIsErrorKey: total((c) => c.toolResultWithIsErrorKey),
    toolResultIsErrorTrue: total((c) => c.toolResultIsErrorTrue),
    attributionSkillRows: total((c) => c.attributionSkillRows),
    attributionSkillDistinct: skills.size,
    mcpServerDistinct: mcp.size,
    userRows: total((c) => c.userRows),
    originBearingUserRows: total((c) => c.originBearingUserRows),
    humanTurns: total((c) => c.humanTurns),
    originHumanRows: total((c) => c.originHumanRows),
    notHumanCounts: Object.fromEntries([...notHuman.entries()].sort()),
    taskBundles: bundleDay.size,
    toolActivityRows: total((c) => c.toolActivityRows),
    metabolism: {
      skillsListed: [...met.skillsListed].sort(),
      listingChars: m.listingChars,
      listingTruncated: m.listingTruncated,
      skillFirings: Object.fromEntries([...met.skillFirings.entries()].sort()),
      hookFirings: Object.fromEntries([...met.hookFirings.entries()].sort()),
      mcpFirings: Object.fromEntries([...met.mcpFirings.entries()].sort()),
      effectiveInputPerCall: met.effectiveInputPerCall,
      effectiveInputPerBundle: [...met.effectiveInputPerBundle.values()],
      peakInputPerBundle: [...met.peakInputPerBundle.values()],
      inputPerBundleWithoutCache: [...met.inputPerBundleWithoutCache.values()],
    },
    manualEdits: {
      editedNames: [...manual.editedNames].sort(),
      staleRecoveredPaths: [...manual.staleRecoveredPaths].sort(),
      userModifiedPresent: total((c) => c.userModifiedPresent),
      userModifiedTrue: total((c) => c.userModifiedTrue),
    },
    verification: {
      intervals: verificationTotal().intervals,
      verifiedIntervals: verificationTotal().verifiedIntervals,
      todoWriteUsed: [...byDay.values()].some((c) => c.todoWriteUsed),
      selfRepaired: verificationTotal().selfRepaired,
      humanRescued: verificationTotal().humanRescued,
      unresolved: verificationTotal().unresolved,
      repairedNotCounted: verificationTotal().repairedNotCounted,
    },
    rootBundles: countKind('root'),
    orphanBundles: countKind('orphan'),
    bundlesPerDay: bundlesPerDay(),
    environmentNoiseRows: total((c) => c.environmentNoiseRows),
    editedPaths: Object.fromEntries([...paths.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    lastMention: refs.lastMention,
    lastMentionIn: refs.lastMentionIn,
    mentionedElsewhereAfter: refs.mentionedElsewhereAfter,
    ambiguousBasenames: refs.ambiguousBasenames(),
    referenceTokens: refs.size(),
    errorRepeats: repeatRate(tuples),
    signatureKeysPerDay: Object.fromEntries(
      [...signatureKeysPerDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    macsPerDay: Object.fromEntries([...macsPerDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    wasted: (() => {
      const w = wTotal()
      return {
      failures: w.failures,
      hookOriginated: w.hookOriginated,
      errorsObserved: w.errorsObserved,
      attribution: { ...w.attribution },
      closure: closure(w.attribution, w.errorsObserved),
      writeRepeats: w.writeRepeats,
      investigationRepeats: w.investigationRepeats,
      timedOut: w.timedOut,
      largeOutput: w.largeOutput,
      callsPerBundle: Object.fromEntries(w.callsPerBundle),
      }
    })(),
    /**
     * The same, by the day each bundle opened on. What the window selects over.
     *
     * `closure` is recomputed per day rather than apportioned, because a
     * partition that closes in aggregate can fail for one day — which is the
     * class of mistake day-keying introduces.
     */
    wastedPerDay: Object.fromEntries(
      [...wByDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, b]) => [
          day,
          {
            failures: b.failures,
            hookOriginated: b.hookOriginated,
            errorsObserved: b.errorsObserved,
            attribution: { ...b.attribution },
            closure: closure(b.attribution, b.errorsObserved),
            writeRepeats: b.writeRepeats,
            investigationRepeats: b.investigationRepeats,
            timedOut: b.timedOut,
            largeOutput: b.largeOutput,
            callsPerBundle: Object.fromEntries(b.callsPerBundle),
          },
        ]),
    ),
    dayedNames: {
      skillFirings: Object.fromEntries([...dayed.skillFirings].map(([k, v]) => [k, [...v].sort()])),
      hookFirings: Object.fromEntries([...dayed.hookFirings].map(([k, v]) => [k, [...v].sort()])),
      mcpFirings: Object.fromEntries([...dayed.mcpFirings].map(([k, v]) => [k, [...v].sort()])),
      editedNames: Object.fromEntries([...dayed.editedNames].map(([k, v]) => [k, [...v].sort()])),
      staleRecoveredPaths: Object.fromEntries(
        [...dayed.staleRecoveredPaths].map(([k, v]) => [k, [...v].sort()]),
      ),
    },
    clusterDays: {
      bundles: Object.fromEntries([...clusterDays.bundles].map(([k, v]) => [k, [...v].sort()])),
      intervals: Object.fromEntries([...clusterDays.intervals].map(([k, v]) => [k, [...v].sort()])),
      errors: Object.fromEntries([...clusterDays.errors].map(([k, v]) => [k, [...v].sort()])),
    },
    verificationPerDay: Object.fromEntries(
      [...verificationByDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    perSession: Object.fromEntries([...perSession.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    signatures: macs,
    signaturesRepeated: repeatedOf(macs),
    signaturesSigned: sign !== null,
    denialRows: total((c) => c.denialRows),
    denialUserRejected: total((c) => c.denialUserRejected),
    denialKinds: Object.fromEntries([...mergedDenialKinds().entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    editedFilesDistinct: edits.size,
    editedFilesRepeated: repeated,
    stopHookSummaryRows: total((c) => c.stopHookSummaryRows),
    hookErrorsNonEmpty: total((c) => c.hookErrorsNonEmpty),
    tokens: {
      input: total((c) => c.input),
      output: total((c) => c.output),
      cacheRead: total((c) => c.cacheRead),
      cacheCreation: total((c) => c.cacheCreation),
    },
    cwds: [...m.cwds.values()].sort(),
    toolVersions: Object.fromEntries([...versions.entries()].map(([v, s]) => [v, s.rows]).sort()),
    versionSlices: Object.fromEntries(
      [...versions.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([v, s]) => [v, { rows: s.rows, failures: s.failures, toolUse: s.toolUse, firstDay: s.firstDay, lastDay: s.lastDay }]),
    ),
    sessionIds: [...sessions].sort(),
    sessionIdMismatchRows: m.sessionIdMismatchRows,
    dates: [...dates.all].sort(),
    userRowDates: [...dates.userRow].sort(),
    humanTurnDates: [...dates.humanTurn].sort(),
    humanTurnDatesUtc: [...dates.humanTurnUtc].sort(),
    perDay: Object.fromEntries([...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    perProject: Object.fromEntries([...perProject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}
