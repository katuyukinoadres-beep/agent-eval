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
export const NOT_IMPLEMENTED_HERE = ['V-8', 'V-12'] as const

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
}

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
