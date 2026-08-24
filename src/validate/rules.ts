/**
 * The rejection rules, applied by the receiver.
 *
 * The reason validation lives here rather than in the sender's care is that the
 * sender's care has now failed four times, twice within hours of the same person
 * writing the rule against it. A payload whose definitions are not stated does
 * not enter the population, and no amount of discipline upstream is asked to
 * substitute for that.
 *
 * These run against `unknown`. A real payload arrives as parsed JSON from a
 * machine this code did not build, so nothing may be assumed about its shape —
 * including that it is an object.
 */

export const RULE_IDS = [
  'V-1',
  'V-2',
  'V-3',
  'V-4',
  'V-5',
  'V-6',
  'V-7',
  'V-9',
  'V-10',
  'V-11',
  'V-13',
  'V-14',
  'V-15',
  'V-16',
  'V-17',
  'V-18',
  'V-19',
  'V-20',
  'V-22',
  'V-24',
  'V-25',
] as const

export type RuleId = (typeof RULE_IDS)[number]

/**
 * V-8 (conversation text, code or hashes in the payload) is deliberately absent.
 * The spec defines neither a length threshold nor a field set for it, and a
 * check with an invented threshold would report a number nobody could defend.
 * The guard for that failure is structural instead: payload leaves are numbers,
 * closed unions or validated branded strings, so there is no field free text can
 * occupy. See src/payload/types.ts.
 *
 * V-12 (a metric with no sourceField) belongs with the warnings rather than
 * here — an older parser that predates the field would be rejected outright, and
 * losing the submission is worse than flagging it.
 */
export const NOT_IMPLEMENTED_HERE = ['V-8', 'V-12', 'V-21', 'V-23'] as const

/**
 * V-21 and V-23 check the `comparison` block, which needs a previous window to
 * compare against. Nothing writes one yet -- that is P4 -- so there is no
 * comparison to check and a rule that always passes would read as coverage.
 */

export const RULE_REASONS: Readonly<Record<RuleId, string>> = {
  'V-1': 'scanManifest is absent — a payload whose scan range is unstated cannot be compared with any other',
  'V-2': 'scanManifest is missing a required field',
  'V-3': 'a rate carries no denominatorMeaning — two machines can divide by different things and both look right',
  'V-4': 'a rate arrived without its numerator and denominator, so it cannot be recomputed under another definition',
  'V-5': 'a numerator exceeds its denominator — this reached 107.1% on a real machine',
  'V-6': 'the project list does not match projectCount — partial submissions are refused, which is what removes the need for a threshold',
  'V-7': 'an availability value outside the three-value enum',
  'V-9': 'main and sub line counts do not sum to linesRead — the shape a non-recursive glob leaves behind',
  'V-10': 'an axis line tally does not close against linesRead — rows were dropped without being reported',
  'V-11': 'activeDaysMethod names a source outside the known set, or is not a union of observed sources',
  'V-13': 'the record rate divides by a number the payload does not otherwise state — externalLog.activeDays and recordRate.denominator must be the same figure',
  'V-14': 'more human-turn days than evidence days, which cannot happen: a day with a human turn left a transcript, so it is already an evidence day',
  'V-15': 'windowSource and cleanupPeriodDays contradict each other — a window claimed to come from a setting must say which value it read',
  'V-16': 'the three day counts are not nested — human-turn days sit inside user-row days, which sit inside evidence days, by construction',
  'V-17': 'a composite score exists over three or more missing axes, or on under 63.75 nominal weight — 39% of the total can ride on one axis there',
  'V-18': 'effectiveWeights do not sum to 100, or their keys are not axesUsed',
  'V-19': 'the composite does not match a recomputation from axesUsed and effectiveWeights',
  'V-20': 'a null composite with no suppressedReason — "no score" without saying why',
  'V-22': 'an excluded axis is available, or an axis used is not — the two vocabularies disagree',
  'V-24': 'an axis used dropped a term but the composite states no leaning, so a systematically shifted number reads as a plain one',
  'V-25': 'countBasis is missing or names a scope, period or unit outside its union — a count with no stated basis moved 1.33x across four published figures',
}

/**
 * The unions countBasis draws on. V-3 for counts.
 *
 * `unit` is the one that surprises: two `permission-rule` rows sharing a
 * `tool_use_id` were measured, so rows gave 52 where ids gave 51. A count with
 * no unit is already plus-or-minus one.
 */
export const COUNT_BASIS_FIELDS = {
  scope: ['all', 'main'],
  period: ['window', 'allTime'],
  unit: ['toolUseId', 'row'],
} as const

export const COUNT_BASIS_EXCLUSIONS = ['infrastructure-error'] as const

/**
 * The spec names two different quantities `activeDays` in the same environment:
 * 17 under `window` (days carrying a human turn, the scope every axis
 * denominator is taken over) and 18 under `externalLog` (days carrying evidence
 * of any kind, the record rate's denominator).
 *
 * Both are correct and they answer different questions. The hazard is that a
 * receiver reading `activeDays` without noting its parent object is off by 5.9%
 * with nothing to signal it — the same shape as the four measured incidents that
 * put this validator here. V-13 and V-14 tie each value to something else in the
 * payload so a swap cannot pass unnoticed.
 */
export const WINDOW_DAYS_METHOD = 'human-turn-days'

/** The scanManifest fields §2 marks as required. Any one missing rejects the payload. */
export const REQUIRED_MANIFEST_FIELDS = [
  'parserVersion',
  'scope',
  'rootsWalked',
  'recursive',
  'filesRead',
  'linesRead',
  'linesParseFailed',
  'mainFiles',
  'mainLines',
  'subFiles',
  'subLines',
  'subLineRatio',
  'toolVersions',
  'toolVersionDistinct',
  'originFieldCoverage',
  'window',
  'externalLog',
  'countBasis',
] as const

export const VALID_AVAILABILITY = ['available', 'not_applicable', 'parse_failed'] as const

/**
 * Sources activeDays may be a union of.
 *
 * Closed because the denominator it produces decides the record rate, and
 * `max(git, jsonl)` returned 107.1% here — the numerator counted days that only
 * the external log still remembered. A method naming a source outside this set
 * cannot be checked for that property, so it is refused rather than trusted.
 */
export const KNOWN_DAY_SOURCES = ['git', 'jsonl', 'externalLog'] as const

export const ACTIVE_DAYS_METHOD = /^union-of-observed\(([a-zA-Z, ]+)\)$/

// ── warnings ──────────────────────────────────────────────────────────────────
// A warning accepts the payload and marks it, so the receiver can exclude it
// from a statistic without losing the submission. Everything here describes a
// reading that is probably wrong rather than certainly malformed.

export const FLAG_IDS = ['W-1', 'W-2', 'W-3', 'W-5', 'W-6', 'W-7', 'W-8', 'W-9'] as const

export type FlagId = (typeof FLAG_IDS)[number]

/**
 * W-4 (record rate below a sparse/dense threshold) is not implemented. The
 * threshold is undefined in the spec and n=2 is not enough to set one — the same
 * reasoning that removed the submission-unit threshold. The rate ships as-is.
 */
export const FLAGS_NOT_IMPLEMENTED = ['W-4'] as const

export const FLAG_REASONS: Readonly<Record<FlagId, string>> = {
  'W-1': 'origin coverage under 10% — human counts read low, and how low depends on which versions wrote the log',
  'W-2': 'the sub-line share is at an impossible edge for this scope, which is what a mis-levelled glob looks like',
  'W-3': 'more than five tool versions in one log — check that availability was judged per line, not per environment',
  'W-5': 'over 1% of lines failed to parse',
  'W-6': 'a boolean-derived numerator is zero over a large denominator — indistinguishable from a field that never fires',
  'W-7': 'a rate with a zero denominator, which passes V-4 and sits under W-6 threshold',
  'W-8': 'an axis excluded from the composite is parse_failed rather than merely not_applicable — the log could not be read, not the environment quiet',
  // Local, not from the spec. The numbered W rules above are the spec's; this
  // one exists because the sending side can be honest about a gap the spec
  // never anticipated: a meaning string that promises a window over a count
  // that was taken over the whole corpus.
  'W-9': 'a count declares a period its basis does not match — comparing it with a genuinely windowed submission compares two different quantities',
}

/** v2 §12.2: below this nominal weight, one axis can carry 39% of the total. */
export const MIN_NOMINAL_WEIGHT = 63.75
export const MAX_MISSING_AXES = 2
/** V-19's tolerance, and V-18's. The spec gives both. */
export const COMPOSITE_TOLERANCE = 0.05
export const WEIGHT_SUM_TOLERANCE = 0.01

export const SUPPRESSED_REASONS = [
  'parse-failure-rate',
  'subagents-not-walked',
  'too-few-active-days',
  'too-many-missing-axes',
] as const

export const ORIGIN_COVERAGE_FLOOR = 0.1
export const TOOL_VERSION_CEILING = 5
export const PARSE_FAILURE_CEILING = 0.01
/** W-6 only means something once the denominator is large enough for zero to be surprising. */
export const BOOLEAN_ZERO_DENOMINATOR_FLOOR = 100
