/**
 * The attribution table — which axis each failed tool call belongs to.
 *
 * One event, one primary axis. Everything else may display it, but nothing else
 * may add it to a numerator or a denominator. Without this rule a call that a
 * permission rule refused is charged to the agent as wasted motion *and*
 * credited to the environment as a guardrail working, and one event moves two
 * scores in opposite directions.
 *
 * The correction is not marginal. Measured here, 407 failed calls attribute to
 * 187 in axis 2's numerator; the implementation this replaces put all 407
 * there, 2.18x the settled figure. On the other machine the same table moved
 * 603 to 472.
 *
 * Two rules are worth stating because getting either wrong is silent.
 *
 * `toolDenialKind` sits at row level, not inside `toolUseResult`. The other
 * machine measured 0 against the nested path and 62 against the row. A path
 * nobody writes down is a path each implementation guesses differently.
 *
 * And denials are decided before the body is read. The body pattern this
 * replaces, `(Pre|Post)ToolUse:`, matched 0 of 407 failures here and 35 of 62
 * denials there: it was fitted to text one environment happens to emit. The
 * structured field is a strict superset of it in both.
 */

import type { ErrorClass } from './errorClass.js'

/**
 * Denial kinds the spec names.
 *
 * Not the whole set, which is the point of writing it down. This machine also
 * produces `automode-blocked` (71) and `automode-unavailable` (24), neither of
 * which appears in the spec because the environment it was written against
 * emits neither. Those land in `E2b`.
 */
export const SPEC_DENIAL_KINDS = ['permission-rule', 'user-rejected'] as const

/** Attribution ids, in the order they are evaluated. */
export const ATTRIBUTIONS = ['E1', 'E2', 'E2b', 'E3', 'E4', 'E7', 'E6', 'E5', 'E8_E9'] as const

export type Attribution = (typeof ATTRIBUTIONS)[number]

/** The fixed evaluation order, named so a test can assert the code follows it. */
export const EVALUATION_ORDER: readonly Attribution[] = [
  'E1',
  'E2',
  'E2b',
  'E3',
  'E4',
  'E7',
  'E6',
  'E5',
  'E8_E9',
]

/** What each attribution is for, keyed by the closed union. */
export const ATTRIBUTION_PRIMARY: Readonly<Record<Attribution, string>> = {
  E1: 'safety check (hook denial), unscored evidence of operation',
  E2: 'safety check (permission rule)',
  E2b: 'safety check (a denial kind the spec does not name)',
  E3: 'human-side H2 breakdown only',
  E4: 'no axis at all; axis 0 coverage note',
  E7: 'axis 3 numerator, as evidence of a verification that did not happen',
  E6: 'axis 2 numerator',
  E5: 'axis 2 numerator',
  E8_E9: 'axis 2 numerator; supplies signatures to axis 6 layer A',
}

/**
 * Which attributions enter axis 2's numerator.
 *
 * Keyed by the union rather than by `string`: an id added to `ATTRIBUTIONS`
 * without a decision here fails to compile, which is the only thing that keeps
 * this table honest as it grows.
 */
export const IN_AXIS2_NUMERATOR: Readonly<Record<Attribution, boolean>> = {
  E1: false,
  E2: false,
  E2b: false,
  E3: false,
  E4: false,
  E7: false,
  E6: true,
  E5: true,
  E8_E9: true,
}

/**
 * Whether the call stays in axis 2's denominator.
 *
 * E7 is the one that differs: out of the numerator, kept in the denominator,
 * because a stale read is real work that happened. Axis 2 divides by bundles
 * rather than by calls, so this does not move W today. It is recorded because
 * the spec draws the distinction and a call-based denominator would need it.
 */
export const IN_AXIS2_DENOMINATOR: Readonly<Record<Attribution, boolean>> = {
  E1: false,
  E2: false,
  E2b: false,
  E3: false,
  E4: false,
  E7: true,
  E6: true,
  E5: true,
  E8_E9: true,
}

/**
 * Which attributions supply a signature to the recurrence set.
 *
 * The table names only E8/E9 as feeding axis 6 layer A. This widens it to
 * everything that entered axis 2's numerator, because the alternative is that a
 * timeout recurring ten times is not a recurrence, which is not what the axis
 * claims to measure. The widening is written out term by term rather than
 * aliased to `IN_AXIS2_NUMERATOR`, so that changing one does not silently
 * change the other. It moves the signature count here from 109 to 187 and is
 * the one place this file departs from the written table.
 */
export const SUPPLIES_SIGNATURE: Readonly<Record<Attribution, boolean>> = {
  E1: false,
  E2: false,
  E2b: false,
  E3: false,
  E4: false,
  E7: false,
  E6: true,
  E5: true,
  E8_E9: true,
}

/** Tools whose failures belong to no axis: the network, not the environment. */
export const EXTERNAL_TOOLS = ['WebFetch', 'WebSearch'] as const
const MCP_PREFIX = 'mcp__'

export const isExternalTool = (tool: string): boolean =>
  (EXTERNAL_TOOLS as readonly string[]).includes(tool) || tool.startsWith(MCP_PREFIX)

/** Error classes that are evidence of a verification that did not happen. */
export const VERIFICATION_MISS_CLASSES = ['edit_string_not_found', 'edit_stale_read'] as const

/** Error classes naming a dependency the environment did not provide. */
export const DEPENDENCY_CLASSES = ['cmd_not_found', 'no_such_file'] as const

/** The text a hook writes when it refuses. Read only after a denial is seen. */
const HOOK_ORIGINATED = /(Pre|Post)ToolUse:/

export interface AttributionInput {
  /** `toolDenialKind` from the row, not from `toolUseResult`. Null when absent. */
  readonly denialKind: string | null
  /** The failure text. Consulted for E1, and only once a denial is present. */
  readonly text: string
  /** The tool the call joined to, or null when the join failed. */
  readonly tool: string | null
  readonly errorClass: ErrorClass
}

/**
 * Attributes one failed call.
 *
 * Fixed order, first match wins, denials decided before the body is read:
 * E1, E2, E2b, E3, E4, E7, E6, E5, E8/E9. Three implementations following this
 * order produce the same number, which is the whole reason it is written down.
 */
export function attribute(input: AttributionInput): Attribution {
  const { denialKind, text, tool, errorClass } = input

  // Denials first, and by the structured field. A denied call never ran, so it
  // cannot be motion the agent wasted.
  if (denialKind !== null) {
    if (denialKind === 'permission-rule') return HOOK_ORIGINATED.test(text) ? 'E1' : 'E2'
    if (denialKind === 'user-rejected') return 'E3'
    // A kind the spec does not name. Excluded rather than dropped into the
    // residue: every kind the spec does name is excluded without exception, and
    // 95 of 407 failures here carry one of these. Charging them to the agent
    // would score an environment running under auto mode worse than one that is
    // not, for refusals neither of them chose.
    return 'E2b'
  }

  // The network is not the environment under test.
  if (tool !== null && isExternalTool(tool)) return 'E4'

  if ((VERIFICATION_MISS_CLASSES as readonly string[]).includes(errorClass)) return 'E7'
  if (errorClass === 'timeout') return 'E6'
  if ((DEPENDENCY_CLASSES as readonly string[]).includes(errorClass)) return 'E5'
  return 'E8_E9'
}

export type AttributionTally = Record<Attribution, number>

export const emptyTally = (): AttributionTally => ({
  E1: 0,
  E2: 0,
  E2b: 0,
  E3: 0,
  E4: 0,
  E7: 0,
  E6: 0,
  E5: 0,
  E8_E9: 0,
})

export interface Closure {
  /** Failed calls the scan counted, arrived at without using the tally. */
  readonly observed: number
  /** What the tally accounts for. */
  readonly attributed: number
  /** Those that reached axis 2's numerator. */
  readonly numerator: number
  /** Those attributed elsewhere or nowhere. */
  readonly excluded: number
  /** Whether the partition accounts for every failure the scan saw. */
  readonly balanced: boolean
}

/**
 * The subtraction the spec requires to be machine-verified.
 *
 * `observed` has to come from somewhere other than the tally. Summing the tally
 * and comparing it with its own sum is a check that cannot fail, and a check
 * that cannot fail is worse than no check: it reports success on a partition
 * that lost half its events.
 *
 * A table that does not close has lost events, and a lost event is
 * indistinguishable from an event that never happened. When this reports
 * `balanced: false` the axis value must not be emitted, because a numerator
 * drawn from an incomplete partition has no denominator anyone can name.
 */
export function closure(tally: AttributionTally, observed: number): Closure {
  let numerator = 0
  let excluded = 0
  for (const id of ATTRIBUTIONS) {
    if (IN_AXIS2_NUMERATOR[id]) numerator += tally[id]
    else excluded += tally[id]
  }
  const attributed = numerator + excluded
  return { observed, attributed, numerator, excluded, balanced: attributed === observed }
}
