/**
 * The environment-wide gate.
 *
 * Three conditions, all stated in the axes spec §窓. None is invented here, and
 * that matters more than it sounds: a gate decides whether an environment gets a
 * total at all, so a threshold chosen for convenience would silently exclude
 * real machines or admit unreadable ones.
 *
 * The gate produces a three-value verdict over the whole environment. It does
 * not replace the per-axis verdicts — an environment can pass the gate and still
 * have every axis unavailable, which is what this machine does.
 */

import type { Availability, WalkedRoot } from '../payload/types.js'

/** Above this share of unparseable lines, nothing read from the log is trusted. */
export const PARSE_FAILURE_GATE = 0.05

/** Below this many active days, the environment gets a breakdown but no total. */
export const MIN_ACTIVE_DAYS = 5

export type GateReason =
  | 'parse-failure-rate'
  | 'subagents-not-walked'
  | 'too-few-active-days'

export const GATE_REASONS: Readonly<Record<GateReason, string>> = {
  'parse-failure-rate': `over ${PARSE_FAILURE_GATE * 100}% of lines failed to parse`,
  'subagents-not-walked': 'no walked glob covers subagent transcripts',
  'too-few-active-days': `fewer than ${MIN_ACTIVE_DAYS} active days`,
}

export interface GateInputs {
  readonly linesRead: number
  readonly linesParseFailed: number
  readonly rootsWalked: readonly WalkedRoot[]
  /** Human-turn days. The window's own definition, not the evidence-day union. */
  readonly activeDays: number
}

export interface GateVerdict {
  readonly availability: Availability
  /** Every condition that fired, not just the first. */
  readonly reasons: readonly GateReason[]
  /** Whether a total score may be produced at all. */
  readonly totalAllowed: boolean
}

/**
 * True when some walked glob covers subagent transcripts.
 *
 * Presence, not match count. A glob that matched nothing is a different fact —
 * W-2 reports that — and conflating them would mark a machine unreadable for
 * having no subagents rather than for never having looked.
 */
export function walkedSubagents(roots: readonly WalkedRoot[]): boolean {
  return roots.some((r) => r.glob.includes('subagents'))
}

export function gate(inputs: GateInputs): GateVerdict {
  const { linesRead, linesParseFailed, rootsWalked, activeDays } = inputs
  const reasons: GateReason[] = []

  // Guarded rather than assumed: an empty log divides by zero, and a NaN
  // compares false against every threshold, so the gate would pass silently.
  const failureRate = linesRead > 0 ? linesParseFailed / linesRead : 0
  if (failureRate > PARSE_FAILURE_GATE) reasons.push('parse-failure-rate')
  if (!walkedSubagents(rootsWalked)) reasons.push('subagents-not-walked')

  // parse_failed outranks not_applicable: if the log could not be read, the day
  // count derived from it is not evidence of anything either.
  if (reasons.length > 0) {
    return { availability: 'parse_failed', reasons, totalAllowed: false }
  }

  if (activeDays < MIN_ACTIVE_DAYS) {
    return { availability: 'not_applicable', reasons: ['too-few-active-days'], totalAllowed: false }
  }

  return { availability: 'available', reasons: [], totalAllowed: true }
}
