/**
 * The shape every number in a submission has to arrive in.
 *
 * Four definitional incidents in two days produced figures that were each
 * correct on their own machine and meaningless against the other's: a scan range
 * moved a failure rate 1.46x, a denominator choice moved it 1.96x, a human-turn
 * definition moved a count 2.63x, and a record-rate denominator moved a ratio
 * 6.9x. In every case the data was right and only the comparison broke, so the
 * fix is not to send more carefully but to make an under-specified number
 * impossible to construct.
 *
 * Hence: no bare numbers cross this boundary. A figure is either a Metric, which
 * carries the denominator it was divided by and what that denominator means, or
 * a Count, which has to say why it has no denominator. Both name the log field
 * they were read from.
 */

/**
 * The exact strings from submission_payload_spec_v1 §3.1. A closed union rather
 * than free text: the receiving side compares these to decide whether two
 * environments measured the same thing, and a paraphrase would silently fail
 * that comparison while looking correct in the payload.
 *
 * Adding a metric means adding its meaning here first. That is deliberate — the
 * type refuses to let a rate ship before its denominator has been written down.
 */
export const DENOMINATOR_MEANINGS = [
  'window 内の tool_result ブロック総数（キーの有無を問わない）',
  '🚨 事故#2 の当事者。**両方送る**。どちらが正かは受け取り側が決める',
  '書いたスキルのうち実際に発火した種類数。🚨 **行数ではない**',
  '繋いだサーバーのうち実際に呼ばれた数',
  '権限拒否のうち人間が止めた割合',
  '🚨 手戻りではなくファイル集中度。打ち消し判定は別途',
  'ガードレールが実際に応答を差し戻した割合。🚨 `preventedContinuation` は使わない（2環境とも全 false）',
  // §2 — the manifest carries three rates of its own, and they are the two
  // detectors for incidents #3 and #4. Their meanings are as load-bearing as
  // the metric ones, so they live in the same closed union.
  'origin フィールドが付いている user 行の割合。低いほど human 判定が過小になる',
  '作業した証拠のある日のうち、外部ログに入っている割合',
  '暦日のうち記録がある日の割合（作業頻度を答える別指標）',
] as const

export type DenominatorMeaning = (typeof DENOMINATOR_MEANINGS)[number]

/**
 * Why a count has no denominator. Spec §3.1 marks four of the eleven required
 * metrics with an em dash in the denominator column; they are counts, not rates,
 * and forcing them through Metric would mean inventing a meaning string that
 * satisfies V-3 without saying anything true.
 */
export const NO_DENOMINATOR_REASONS = [
  'reference-value',
  'tuple-not-a-rate',
  'raw-token-counts',
] as const

export type NoDenominatorReason = (typeof NO_DENOMINATOR_REASONS)[number]

/**
 * Log fields the collector is allowed to read.
 *
 * Three fields are absent on purpose and must stay absent. Each looks like the
 * obvious source for something the product measures and each returns a number
 * that is wrong in a way no test catches, because the wrongness is a constant
 * zero rather than an error:
 *
 *   isSidechain                 — false on every main-transcript row; subagent
 *                                 detection goes by path
 *   toolUseResult.interrupted   — present 9,995 times across two machines, true
 *                                 zero times
 *   preventedContinuation       — all false on both machines even on the rows
 *                                 where a hook did push a response back; the
 *                                 event is in hookErrors instead
 *
 * FORBIDDEN_SOURCE_FIELDS below states them, and a test asserts the two sets do
 * not intersect. Naming the field a metric came from is the only audit trail
 * that a reading did not quietly come from one of these.
 */
export const SOURCE_FIELDS = [
  'message.content[].tool_result.is_error',
  'message.content[].tool_result',
  'attributionSkill',
  'attributionMcpServer',
  'origin.kind',
  'toolDenialKind',
  'message.usage',
  'message.content[].tool_use.input.file_path',
  'hookErrors',
  'system.subtype=stop_hook_summary',
  'permissions',
  'path:subagents/',
  // Date sources behind the manifest's own rates. Named separately because
  // which of them went into activeDays is what decides whether the record rate
  // can exceed 1 — it reached 107.1% here when the denominator was max() of two
  // of them and the numerator came from the third.
  'externalLog.dates',
  'git.commitDates',
  'jsonl.timestamps',
] as const

export type SourceField = (typeof SOURCE_FIELDS)[number]

/** Fields that must never appear as a SourceField. See the note above. */
export const FORBIDDEN_SOURCE_FIELDS = [
  'isSidechain',
  'toolUseResult.interrupted',
  'preventedContinuation',
] as const

export type ForbiddenSourceField = (typeof FORBIDDEN_SOURCE_FIELDS)[number]

/** A figure that is a ratio. Carries what it was divided by, and what that means. */
export interface Metric {
  readonly numerator: number
  readonly denominator: number
  readonly denominatorMeaning: DenominatorMeaning
  readonly sourceField: SourceField
  /**
   * How this one was counted, when it differs from the manifest's.
   *
   * Absent means the manifest's `countBasis` applies, which is what the manifest
   * says. Present means this count was taken on a different basis and says so
   * where a reader will look — the alternative is a single manifest-level word
   * covering two periods, which is the under-specified number this module
   * exists to make unbuildable.
   */
  readonly basis?: CountBasis
}

// ── how a count was counted ───────────────────────────────────────────────────

/**
 * The four things that decide what a count comes out as.
 *
 * A rate carries `denominatorMeaning`; a count carried nothing, and the cost
 * showed up in the specs themselves: `permission-rule` appears there as 40, 41,
 * 44 and 45. None is wrong. Counting the same quantity on one machine gives 39
 * through 52 — 1.33x — depending on these four, and all four published figures
 * sit inside that band. They answer different questions, and none of them wrote
 * down which.
 */
export const COUNT_SCOPES = ['all', 'main'] as const
export const COUNT_PERIODS = ['window', 'allTime'] as const

/**
 * `row` and `toolUseId` are not the same count.
 *
 * Two `permission-rule` rows sharing one `tool_use_id` were measured on the
 * other machine, so rows gave 52 where ids gave 51. A count with no unit carries
 * a plus-or-minus one before anything else has gone wrong.
 */
export const COUNT_UNITS = ['toolUseId', 'row'] as const

/**
 * A failure where no decision was reached — `Tool permission stream closed` and
 * kin. Excluded from counts and kept by name in coverage: moved to another box,
 * not deleted. There are 11 of them on this machine.
 */
export const COUNT_EXCLUSIONS = ['infrastructure-error'] as const

export type CountScope = (typeof COUNT_SCOPES)[number]
export type CountPeriod = (typeof COUNT_PERIODS)[number]
export type CountUnit = (typeof COUNT_UNITS)[number]
export type CountExclusion = (typeof COUNT_EXCLUSIONS)[number]

export interface CountBasis {
  readonly scope: CountScope
  readonly period: CountPeriod
  readonly unit: CountUnit
  readonly excludes: readonly CountExclusion[]
}

/** A figure that is not a ratio, and says so rather than inventing a denominator. */
export interface Count {
  readonly value: number
  readonly noDenominatorReason: NoDenominatorReason
  readonly sourceField: SourceField
  /**
   * Present only when this count departs from the submission's default basis.
   *
   * The default sits once in `scanManifest.countBasis`. Writing it on every
   * field would bury the ones that differ among the ones that do not.
   */
  readonly basis?: CountBasis
}

export class MetricError extends Error {}

/**
 * Build a Metric.
 *
 * Rejects a denominator below its numerator. That is not defensive tidiness: a
 * record rate arrived at 15/14 = 107.1% on this machine because the denominator
 * was max(git days, jsonl days) and the numerator counted days that existed in
 * neither. V-5 catches it at the receiving end; catching it here means it never
 * gets built.
 *
 * A zero denominator is rejected too. Spec §3.1 gives skillFired the denominator
 * `.claude/skills/*\/SKILL.md`, which matches 0 files on this machine — the
 * skills here are flat `.claude/skills/*.md`, 27 of them. A zero denominator
 * passes V-4 and passes W-6, whose guard only fires above 100, so it would ship
 * as a silent hole.
 */
export function makeMetric(m: Metric): Metric {
  if (!Number.isFinite(m.numerator) || !Number.isFinite(m.denominator)) {
    throw new MetricError(`non-finite metric from ${m.sourceField}`)
  }
  if (m.numerator < 0 || m.denominator < 0) {
    throw new MetricError(`negative metric from ${m.sourceField}`)
  }
  if (m.denominator === 0) {
    throw new MetricError(
      `zero denominator from ${m.sourceField} — emit a not_applicable axis instead of a rate over nothing`,
    )
  }
  if (m.numerator > m.denominator) {
    throw new MetricError(
      `numerator ${m.numerator} exceeds denominator ${m.denominator} from ${m.sourceField}`,
    )
  }
  return m
}

/** Build a Count. */
export function makeCount(c: Count): Count {
  if (!Number.isFinite(c.value)) {
    throw new MetricError(`non-finite count from ${c.sourceField}`)
  }
  if (c.value < 0) {
    throw new MetricError(`negative count from ${c.sourceField}`)
  }
  return c
}
