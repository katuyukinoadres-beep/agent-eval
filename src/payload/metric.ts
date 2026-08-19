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
}

/** A figure that is not a ratio, and says so rather than inventing a denominator. */
export interface Count {
  readonly value: number
  readonly noDenominatorReason: NoDenominatorReason
  readonly sourceField: SourceField
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
