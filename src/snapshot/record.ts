/**
 * What a window leaves behind.
 *
 * The raw logs are pruned, so this file is the only thing a later window can
 * compare against. Two consequences shape every decision below.
 *
 * A value not recorded today is gone. That is why all eleven axes appear from
 * the first snapshot, most of them saying `not-implemented` — an axis that
 * shows up later with no history is an axis whose first window can never be
 * compared to anything.
 *
 * And a value recorded wrongly is wrong forever. That is why nothing here is a
 * bare number: an absent block says it is absent, an unimplemented axis says so
 * rather than reading as a measured zero, and every score carries a fingerprint
 * of the constants it was computed under.
 */

import type { AxisKey, Availability } from '../payload/types.js'
import { AXIS_KEYS } from '../payload/types.js'
import type { CountBasis } from '../payload/metric.js'
import type { OmittedTerm } from '../score/composite.js'
import { digestOf } from './canonical.js'
import type { Day, E4, Hmac128, Sha256, SemVer } from './types.js'

/** The six that carry a weight. The rest are computed and not displayed. */
export const SCORED_AXES = [
  'firstPassLanding',
  'wastedMotion',
  'selfVerification',
  'artifactUptake',
  'environmentMetabolism',
  'recurrencePrevention',
] as const satisfies readonly AxisKey[]

export type ScoredAxis = (typeof SCORED_AXES)[number]

export const SCHEMA_VERSION = '1'

// ── the blocks that can be absent ─────────────────────────────────────────────

/**
 * Blocks are built independently and a failure in one does not lose the file.
 *
 * They are not equally recoverable. `scan` and `span` can be rebuilt from the
 * logs until pruning; the signature set cannot be rebuilt at all, and it is
 * axis 6's only cross-window input. So the irreplaceable block is never held
 * hostage to a replaceable one throwing.
 */
export const ABSENT_BLOCKS = [
  'sessions',
  'signatures',
  'artifacts',
  'commands',
  'environment',
  'axes',
] as const

export type AbsentBlock = (typeof ABSENT_BLOCKS)[number]

export type AbsenceCause = 'not-implemented' | 'threw' | 'unserialisable' | 'no-signer'

export interface BlockAbsence {
  readonly block: AbsentBlock
  readonly cause: AbsenceCause
  /** One line, no stack, no paths. Stacks carry the checkout directory. */
  readonly detail: string
}

// ── the record ────────────────────────────────────────────────────────────────

export interface Builder {
  readonly toolVersion: SemVer
  readonly parserVersion: '1'
  /**
   * The day, not the instant.
   *
   * Two hundred timestamps to the second is a record of when someone works. The
   * day is enough to order snapshots and to say how far apart two windows are.
   */
  readonly writtenOn: Day
  readonly os: 'win32' | 'darwin' | 'linux' | 'other'
}

export type BreakCause = 'head-missing' | 'file-missing' | 'file-unreadable' | 'hash-mismatch'

/**
 * Genesis and a lost history are separate constructors, not both a null hash.
 *
 * A first window and a wiped store produce the same `null` and mean opposite
 * things, and emptying the store is one of the named attacks.
 */
export type Prev =
  | { readonly kind: 'genesis' }
  | { readonly kind: 'linked'; readonly hash: Sha256 }
  | { readonly kind: 'broken'; readonly expectedSeq: number; readonly why: BreakCause }

export interface ChainLink {
  readonly seq: number
  readonly prev: Prev
}

export interface KeyRef {
  readonly epoch: number
  readonly fingerprint: Sha256
}

export interface Completeness {
  /** True only when every scored axis is measured. False for a long time yet. */
  readonly schemaComplete: boolean
  /**
   * Whether this snapshot produced a composite at all.
   *
   * Whether two composites may be *compared* is a separate question, decided by
   * the comparison from the axis sets stored beside this flag: a composite over
   * four axes and one over six are different quantities. Folding both questions
   * into one boolean made it false on every run.
   */
  readonly compositeComparable: boolean
  /** Scored axes with no measurement. In SCORED_AXES order. */
  readonly axesAbsent: readonly ScoredAxis[]
  /** The set the two flags above were evaluated over, named rather than assumed. */
  readonly evaluatedOver: readonly ScoredAxis[]
  readonly blocksAbsent: readonly BlockAbsence[]
}

/**
 * The observed span, which is not a window.
 *
 * `windowDays` rides in the payload and is never applied as a filter, so these
 * counts cover every transcript that survived pruning. Calling this block
 * `window` would be the same defect `countBasis` exists to stop.
 */
export interface ObservedSpan {
  readonly firstDay: Day | null
  readonly lastDay: Day | null
  readonly calendarDays: number
  readonly humanTurnDays: number
  readonly userRowDays: number
  readonly evidenceDays: number
  /** Timestamps that would not parse. One counter, never one lost window. */
  readonly daysMalformed: number
}

export interface ScanRecord {
  readonly filesRead: number
  readonly linesRead: number
  readonly linesParseFailed: number
  readonly mainLines: number
  readonly subLines: number
  readonly bytesRead: number
  readonly toolVersionDistinct: number
  readonly gateAvailability: Availability
  readonly gateReasons: readonly string[]
}

export interface SessionRecord {
  /** MAC'd under the session domain. The id itself is a uuid that identifies a run. */
  readonly id: Hmac128
  readonly lines: number
  readonly bundles: number
  readonly errors: number
  readonly failures: number
  readonly writeRepeats: number
  readonly investigationRepeats: number
}

export type AxisState = 'measured' | 'not-applicable' | 'not-implemented'

export interface AxisSampling {
  /** Sessions with a non-zero denominator for this axis. */
  readonly clusters: number
}

export interface AxisRecord {
  readonly state: AxisState
  /**
   * What the score was computed under.
   *
   * Neither `toolVersion` nor `parserVersion` can gate a definition change:
   * both are string literals with one possible value. The constant that
   * actually moves axis 2's score is `W_REF`, and before this it was recorded
   * nowhere. Change it and every past snapshot becomes incomparable with every
   * future one, with nothing to say so.
   *
   * Null for an axis with no formula yet.
   */
  readonly formulaFingerprint: Sha256 | null
  /** Scaled by 10,000. Null when the axis has no rate. */
  readonly numeratorE4: E4 | null
  readonly denominator: number | null
  readonly scoreE4: E4 | null
  /**
   * Whether this axis missed one of the three minimum conditions.
   *
   * Stored rather than re-derived, and read from the axis rather than assumed:
   * a comparison uses it to decide whether a delta may be named, and asserting
   * it made every axis look short whether it was or not.
   */
  readonly belowMinDenominator: boolean
  readonly sampling: AxisSampling | null
  readonly omittedTerms: readonly OmittedTerm[]
}

export interface SignatureFamily {
  readonly family: string
  readonly count: number
}

/**
 * What the sidecar holds, beside the body it is committed to.
 *
 * `members` is every distinct signature; `repeated` is v1's `S_t`, the ones
 * seen at least twice. The cross-window rate intersects `repeated` sets, and
 * it has to be stored because a later window cannot recover this one's.
 */
export interface Sidecar {
  readonly members: readonly Hmac128[]
  readonly repeated: readonly Hmac128[]
}

export interface SignatureSets {
  /** Distinct signature MACs. The members live in the sidecar. */
  readonly memberCount: number
  /** Of those, the ones seen at least twice. v1's `S_t`. */
  readonly repeatedCount: number
  readonly errors: number
  readonly byFamily: readonly SignatureFamily[]
}

export interface SidecarCommitment {
  readonly kind: 'sig'
  readonly digest: Sha256
  readonly members: number
}

export interface Snapshot {
  readonly schemaVersion: '1'
  readonly builder: Builder
  readonly chain: ChainLink
  readonly key: KeyRef
  readonly countBasis: CountBasis
  /**
   * The composite, in ten-thousandths, or null when it was withheld.
   *
   * A later window needs this to take a delta, and nothing else keeps it.
   */
  readonly compositeE4: number | null
  readonly completeness: Completeness
  readonly span: ObservedSpan
  readonly scan: ScanRecord
  readonly sessions: readonly SessionRecord[]
  readonly axes: Readonly<Record<AxisKey, AxisRecord>>
  readonly signatures: SignatureSets | null
  readonly sidecars: readonly SidecarCommitment[]
  readonly identities: readonly Identity[]
  /** The payload this run emitted, if it emitted one. */
  readonly payloadDigest: Sha256 | null
  /** Not part of what it covers. */
  readonly selfHash: Sha256
}

// ── identities ────────────────────────────────────────────────────────────────

/**
 * Relations that hold by construction, checked before the record is hashed.
 *
 * The validator is built almost entirely out of these, on one principle: a
 * relation that cannot be violated by correct data is a detector for incorrect
 * data. An internally inconsistent snapshot is worse than none, because it will
 * be compared against later.
 */
export const IDENTITY_NAMES = [
  'lines-close',
  'sessions-close',
  'day-nesting',
  'signature-members',
  'axis-denominator-close',
  'signature-repeated-within-members',
  // The attribution partition against the failures counted before it ran.
  'attribution-closes',
  // Axis 3's four buckets against the failures the attribution routed to them.
  'repair-split-within-failures',
] as const

export type IdentityName = (typeof IDENTITY_NAMES)[number]

/**
 * How two sides of an identity relate.
 *
 * Not all of them are equalities. `day-nesting` is a subset relation --
 * human-turn days sit inside user-row days -- and checking it as an equality
 * refuses correct data from any environment where the two differ, which is the
 * ordinary case. It passed on the first real machine only because the two
 * happened to be 10 and 10.
 */
export type IdentityRelation = 'equal' | 'atMost'

export interface Identity {
  readonly name: IdentityName
  readonly relation: IdentityRelation
  readonly left: number
  readonly right: number
  readonly toleranceE4: number
  /** Only true can be stored: a violation refuses the write. */
  readonly holds: true
}

export class IdentityViolation extends Error {
  readonly identity: IdentityName
  readonly left: number
  readonly right: number

  constructor(identity: IdentityName, left: number, right: number) {
    super(`identity ${identity} failed: ${left} against ${right}`)
    this.identity = identity
    this.left = left
    this.right = right
  }
}

export interface IdentityCheck {
  readonly name: IdentityName
  readonly relation: IdentityRelation
  readonly left: number
  readonly right: number
  readonly toleranceE4?: number
}

/** Throws on the first violation. The write is refused rather than recorded. */
export function checkIdentities(checks: readonly IdentityCheck[]): readonly Identity[] {
  const out: Identity[] = []
  for (const c of checks) {
    const tolerance = c.toleranceE4 ?? 0
    const violated =
      c.relation === 'equal'
        ? Math.abs(c.left - c.right) > tolerance
        : c.left - c.right > tolerance
    if (violated) throw new IdentityViolation(c.name, c.left, c.right)
    out.push({
      name: c.name,
      relation: c.relation,
      left: c.left,
      right: c.right,
      toleranceE4: tolerance,
      holds: true,
    })
  }
  return out
}

// ── the formula fingerprint ───────────────────────────────────────────────────

/**
 * A digest of the constants a score depends on.
 *
 * The version strings cannot do this job: `VERSION` is `0.0.0` and
 * `parserVersion` is `1`, both literal types with one inhabitant. What moves
 * axis 2's number is `W_REF`, the five term weights, and the exclusion set —
 * and none of them was written down anywhere until now.
 *
 * Two snapshots whose fingerprints differ are not comparable on that axis, and
 * the comparison rule refuses them by name rather than reporting a change that
 * is a change of definition.
 */
export function formulaFingerprint(
  axis: AxisKey,
  constants: Readonly<Record<string, number | string>>,
): Sha256 {
  // Keys sorted by the canonical serialiser, so the order they are written in
  // here cannot change the fingerprint.
  return digestOf('agent-eval/formula/1\n', { axis, constants })
}

export const emptyAxisRecord = (): AxisRecord => ({
  state: 'not-implemented',
  formulaFingerprint: null,
  numeratorE4: null,
  denominator: null,
  scoreE4: null,
  // An axis with no formula has no denominator to be short of, and `true` is
  // the reading that refuses to name a change rather than the one that allows
  // it.
  belowMinDenominator: true,
  sampling: null,
  omittedTerms: [],
})

/** All eleven, absent by default. An axis that appears later with no history has none. */
export const emptyAxes = (): Record<AxisKey, AxisRecord> =>
  Object.fromEntries(AXIS_KEYS.map((k) => [k, emptyAxisRecord()])) as Record<AxisKey, AxisRecord>
