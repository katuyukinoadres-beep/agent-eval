/**
 * The minimum denominator, and the reason an axis has no number.
 *
 * Three conditions ANDed, from the axes spec §C-09: at least 20 clusters, a
 * denominator of at least 200, and a numerator of at least 5. The cluster term
 * is the one that does the work — the spec fixed on session-level clustering
 * with bootstrap because the design effect ran from 1.11 to 2.69 across seven
 * indicators, so a Wilson interval over raw rows would understate the width by
 * up to 2.7x.
 *
 * This machine has 11 clusters. Every first-wave axis is therefore unavailable
 * here regardless of what the rate would have been, which is why base ships with
 * every axis `not_applicable` rather than with scores.
 */

import type { UnavailableReason } from '../payload/types.js'

/** Session-level clusters — sessions with a non-zero denominator for this axis. */
export const MIN_CLUSTERS = 20
export const MIN_DENOMINATOR = 200
export const MIN_NUMERATOR = 5

export const UNAVAILABLE_REASONS: Readonly<Record<UnavailableReason, string>> = {
  'too-few-clusters': `fewer than ${MIN_CLUSTERS} session clusters`,
  'denominator-below-minimum': `denominator under ${MIN_DENOMINATOR}`,
  'numerator-below-minimum': `numerator under ${MIN_NUMERATOR}`,
  'insufficient-tool-uses': 'fewer than 50 tool_use blocks after filtering',
  'insufficient-edit-intervals': 'fewer than 25 edit intervals',
  'insufficient-assets': 'fewer than 3 assets defined',
  'no-external-log': 'no external hook log in this environment',
  'first-window': 'needs a previous window to compare against',
  'definition-pending': 'the definition this axis needs is not settled yet',
  'environment-gated': 'the environment-wide gate withheld every axis',
}

export interface Sample {
  readonly clusters: number
  readonly denominator: number
  readonly numerator: number
}

export interface MinimumVerdict {
  readonly meetsMinimum: boolean
  /** Every condition that failed, so a near miss is distinguishable from a rout. */
  readonly reasons: readonly UnavailableReason[]
}

export function meetsMinimum(sample: Sample): MinimumVerdict {
  const reasons: UnavailableReason[] = []
  if (sample.clusters < MIN_CLUSTERS) reasons.push('too-few-clusters')
  if (sample.denominator < MIN_DENOMINATOR) reasons.push('denominator-below-minimum')
  if (sample.numerator < MIN_NUMERATOR) reasons.push('numerator-below-minimum')
  return { meetsMinimum: reasons.length === 0, reasons }
}
