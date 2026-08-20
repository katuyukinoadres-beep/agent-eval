import { describe, expect, it } from 'vitest'
import type { Count, Metric } from '@/payload/metric.js'

/**
 * A type-level positive control.
 *
 * The point of Metric and Count is that an under-specified figure should be
 * unbuildable, not merely discouraged. That claim is only worth something if the
 * type actually rejects the bad shapes, so each block below asserts a rejection
 * with @ts-expect-error: if the type ever loosens enough to accept one of them,
 * the suppression becomes unused and `npm run typecheck` fails.
 *
 * Verified by weakening the type: widening denominatorMeaning to `string` makes
 * the first block compile, which turns its @ts-expect-error into TS2578 and the
 * suite red. The checks detect the loosening rather than assuming it cannot
 * happen.
 */

describe('the payload types reject what the incidents produced', () => {
  it('is enforced by tsc, not by this assertion', () => {
    // vitest needs one runtime assertion to attribute the file; the real checks
    // are the suppressions below, which only tsc evaluates.
    expect(true).toBe(true)
  })
})

// A meaning the receiving side cannot compare against another environment's.
// Free text here is how two machines end up "measuring the same thing" while
// dividing by different denominators — the shape of four incidents in two days.
const paraphrasedMeaning: Metric = {
  numerator: 243,
  denominator: 5254,
  // @ts-expect-error denominatorMeaning is a closed union, not free text
  denominatorMeaning: 'tool_result の総数',
  sourceField: 'message.content[].tool_result.is_error',
}

// A rate with no denominator at all. This is the raw shape that let a failure
// rate move 1.96x depending on which denominator the reader assumed.
// @ts-expect-error a Metric without a denominator is not a Metric
const denominatorless: Metric = {
  numerator: 243,
  denominatorMeaning: 'window 内の tool_result ブロック総数（キーの有無を問わない）',
  sourceField: 'message.content[].tool_result.is_error',
}

// Reading from a field that returns a constant zero. Naming the source is the
// only audit trail that a number did not come from one of the three dead ones.
const fromDeadBoolean: Count = {
  value: 0,
  noDenominatorReason: 'reference-value',
  // @ts-expect-error isSidechain is false on every main-transcript row
  sourceField: 'isSidechain',
}

// A count that does not say why it has no denominator, which is how a count and
// a rate become indistinguishable downstream.
// @ts-expect-error noDenominatorReason is required
const unexplainedCount: Count = {
  value: 319,
  sourceField: 'attributionSkill',
}

// Conversation text reaching a payload leaf. The product's premise is that this
// never leaves the machine; the type is the structural guard, since V-8's own
// threshold is undefined in the spec.
const leakedText: Count = {
  value: 1,
  noDenominatorReason: 'reference-value',
  // @ts-expect-error a payload leaf is never free text
  sourceField: 'user said: rebuild the ledger and send it to 加藤さん',
}

// Referenced so the declarations are not dead code. The assertions that matter
// ran at compile time, above.
export const _rejected = [
  paraphrasedMeaning,
  denominatorless,
  fromDeadBoolean,
  unexplainedCount,
  leakedText,
] as const
