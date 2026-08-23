/**
 * The raw counts behind axis 2's numerator — wasted motion per task bundle.
 *
 * v1 weights repeats differently by what the tool does, and the reason is worth
 * keeping in front of the code: running Grep again with different terms, or
 * re-reading the same file, is how investigation works. Writing the same content
 * to the same path twice is not. So investigation repeats cost 0.2 and
 * write-or-execute repeats cost 0.7.
 *
 * The denominator is bundles, not calls. With calls as the denominator the
 * cheapest way to raise a score was to fire hundreds that could not fail, and
 * that had no other cost at all.
 */

import { createHash } from 'node:crypto'
import type { AttributionTally, Closure } from './attribution.js'

/** v1's investigation set. Everything else is treated as write-or-execute. */
export const INVESTIGATION_TOOLS = ['Read', 'Grep', 'WebSearch', 'WebFetch'] as const

export const WEIGHT_FAILURE = 1.0
export const WEIGHT_WRITE_REPEAT = 0.7
export const WEIGHT_INVESTIGATION_REPEAT = 0.2
export const WEIGHT_TIMEOUT = 1.0
export const WEIGHT_LARGE_OUTPUT = 0.5

/** Above this many bytes of persisted output, a call is charged 0.5. */
export const LARGE_OUTPUT_BYTES = 100_000

export const isInvestigation = (tool: string): boolean =>
  (INVESTIGATION_TOOLS as readonly string[]).includes(tool)

/** Separates fields that must not run together. Named, so it is visible in review. */
const FIELD_SEPARATOR = String.fromCharCode(0)
/**
 * A stable key for "the same call again".
 *
 * The input is serialised with its keys sorted, so two calls that differ only in
 * property order are one call. Hashed because the input holds file paths and
 * command lines; only the digest is compared, and nothing derived from it
 * leaves this process.
 */
export function inputKey(tool: string, input: unknown): string {
  const canonical = JSON.stringify(input, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
  return createHash('sha256').update(`${tool}${FIELD_SEPARATOR}${canonical ?? ''}`, 'utf8').digest('hex').slice(0, 16)
}

export interface WastedCounts {
  /** Failures charged 1.0, after the attribution table has taken its share out. */
  readonly failures: number
  /**
   * Failures the attribution table took out of axis 2.
   *
   * Denials of every kind, the network, and the stale reads axis 3 scores
   * instead. 220 of 407 here.
   *
   * The name is historical: this used to hold only failures matching
   * `(Pre|Post)ToolUse:` in their text, which matched 0 of 407 on this machine
   * and 35 of 62 denials on the other. The body pattern was fitted to text one
   * environment happens to emit; `attribution` below is the honest breakdown.
   */
  readonly hookOriginated: number
  /**
   * Every failure seen, counted before any attribution ran.
   *
   * Kept separately so the closure check has something to compare against that
   * the tally did not produce. Summing the tally and comparing it with its own
   * sum is a check that cannot fail.
   */
  readonly errorsObserved: number
  /** How the failures split across the table. */
  readonly attribution: AttributionTally
  /**
   * Whether the partition accounts for every failure.
   *
   * When this does not balance the axis value must not be emitted: a lost event
   * is indistinguishable from an event that never happened.
   */
  readonly closure: Closure
  readonly writeRepeats: number
  readonly investigationRepeats: number
  readonly timedOut: number
  readonly largeOutput: number
  /** Calls per bundle, for the winsorised denominator. */
  readonly callsPerBundle: Readonly<Record<string, number>>
}

export interface WastedTracker {
  /** Records a call. Returns true if this exact call already happened in this bundle. */
  readonly call: (bundle: number | null, tool: string, input: unknown) => boolean
  readonly seenBundles: () => number
}

/**
 * Repeat detection, scoped to a bundle.
 *
 * Scoped because a bundle is one request. The same Grep in two different
 * requests is two investigations; the same Grep twice inside one request is a
 * repeat. Keying globally would charge the first as the second.
 */
export function wastedTracker(): WastedTracker {
  const seen = new Set<string>()
  const bundles = new Set<number | null>()
  return {
    call: (bundle, tool, input) => {
      bundles.add(bundle)
      const key = `${bundle ?? 'none'}${FIELD_SEPARATOR}${inputKey(tool, input)}`
      if (seen.has(key)) return true
      seen.add(key)
      return false
    },
    seenBundles: () => bundles.size,
  }
}
