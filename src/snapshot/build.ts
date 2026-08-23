/**
 * Assembling a snapshot from what a run measured.
 *
 * Each block is built inside a `try`, and a block that throws is recorded as
 * absent with its cause rather than losing the file. That asymmetry is
 * deliberate: `scan` and `span` can be rebuilt from the logs until pruning, but
 * the signature set cannot be rebuilt at all and is axis 6's only cross-window
 * input. The irreplaceable block must not be hostage to a replaceable one.
 */

import { AXIS_KEYS, type Axes, type AxisKey } from '../payload/types.js'
import type { CountBasis } from '../payload/metric.js'
import type { ScanCounts } from '../collect/scan.js'
import type { GateVerdict } from '../score/gate.js'
import { MIN_FILTERED_CALLS, OMITTED_TERM_LEANINGS, W_REF, WEIGHT_R_IN, WEIGHT_W } from '../score/wastedMotion.js'
import {
  MIN_INTERVALS,
  TODO_PENALTY,
  WEIGHT_RESOLVED,
  WEIGHT_SELF_REPAIR,
  WEIGHT_VERIFIED,
} from '../score/verification.js'
import { MIN_BUNDLES, WEIGHT_NOT_OVERWRITTEN, WEIGHT_REUSE } from '../score/uptake.js'
import { WEIGHT_EXPLANATION, WEIGHT_RECURRENCE } from '../score/recurrence.js'
import {
  TRAPEZOID_CEILING_TOKENS,
  TRAPEZOID_FLOOR_TOKENS,
  TRAPEZOID_MIN_SCORE,
  TRAPEZOID_STEP_PENALTY,
  TRAPEZOID_STEP_TOKENS,
} from '../score/metabolism.js'
import {
  WEIGHT_FAILURE,
  WEIGHT_INVESTIGATION_REPEAT,
  WEIGHT_LARGE_OUTPUT,
  WEIGHT_TIMEOUT,
  WEIGHT_WRITE_REPEAT,
} from '../collect/wasted.js'
import type { Signer } from './mac.js'
import { bodyHash, sidecarHash } from './canonical.js'
import {
  ABSENT_BLOCKS,
  SCORED_AXES,
  SCHEMA_VERSION,
  checkIdentities,
  emptyAxes,
  formulaFingerprint,
  type AbsentBlock,
  type AbsenceCause,
  type AxisRecord,
  type BlockAbsence,
  type ChainLink,
  type Identity,
  type IdentityCheck,
  type KeyRef,
  type ObservedSpan,
  type ScanRecord,
  type SessionRecord,
  type SignatureSets,
  type Snapshot,
  type ScoredAxis,
} from './record.js'
import { day, dayOf, e4, int, semver, type Day, type Hmac128, type Sha256 } from './types.js'

/**
 * The constants axis 2's score actually depends on.
 *
 * Not the tool version, which is `0.0.0` and cannot change; not the parser
 * version, which is `1` and cannot either. These are the numbers that move the
 * result, and until they were fingerprinted a change to any of them would have
 * made every past snapshot quietly incomparable.
 */
/** Kept as a name for the axis-2 entry, which the tests reach for directly. */
export const WASTED_MOTION_CONSTANTS = {
  // Scaled, because every one of these is a fraction and the canonical form
  // takes integers only. The first record built refused on
  // `weightInvestigationRepeat: 0.2` -- which is exactly the case the E4 scale
  // exists for, and the suffix is what carries the scale to a later reader.
  wRefE4: e4(W_REF),
  weightWE4: e4(WEIGHT_W),
  weightRInE4: e4(WEIGHT_R_IN),
  weightFailureE4: e4(WEIGHT_FAILURE),
  weightWriteRepeatE4: e4(WEIGHT_WRITE_REPEAT),
  weightInvestigationRepeatE4: e4(WEIGHT_INVESTIGATION_REPEAT),
  weightTimeoutE4: e4(WEIGHT_TIMEOUT),
  weightLargeOutputE4: e4(WEIGHT_LARGE_OUTPUT),
  minFilteredCalls: MIN_FILTERED_CALLS,
} as const

/**
 * The constants each axis's score depends on, one entry per axis that has a
 * formula.
 *
 * Every axis needs this, not just the first one built. An axis carrying a
 * measured score and a null fingerprint is one whose definition can change
 * between windows with nothing to say it did -- which is the whole failure the
 * fingerprint exists to stop, reintroduced per axis.
 *
 * Scaled, because these are fractions and the canonical form takes integers.
 */
export const AXIS_CONSTANTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  wastedMotion: {
    wRefE4: e4(W_REF),
    weightWE4: e4(WEIGHT_W),
    weightRInE4: e4(WEIGHT_R_IN),
    weightFailureE4: e4(WEIGHT_FAILURE),
    weightWriteRepeatE4: e4(WEIGHT_WRITE_REPEAT),
    weightInvestigationRepeatE4: e4(WEIGHT_INVESTIGATION_REPEAT),
    weightTimeoutE4: e4(WEIGHT_TIMEOUT),
    weightLargeOutputE4: e4(WEIGHT_LARGE_OUTPUT),
    minFilteredCalls: MIN_FILTERED_CALLS,
  },
  selfVerification: {
    weightVerifiedE4: e4(WEIGHT_VERIFIED),
    weightSelfRepairE4: e4(WEIGHT_SELF_REPAIR),
    weightResolvedE4: e4(WEIGHT_RESOLVED),
    minIntervals: MIN_INTERVALS,
    todoPenalty: TODO_PENALTY,
  },
  artifactUptake: {
    weightReuseE4: e4(WEIGHT_REUSE),
    weightNotOverwrittenE4: e4(WEIGHT_NOT_OVERWRITTEN),
    minBundles: MIN_BUNDLES,
  },
  environmentMetabolism: {
    trapezoidFloorTokens: TRAPEZOID_FLOOR_TOKENS,
    trapezoidCeilingTokens: TRAPEZOID_CEILING_TOKENS,
    trapezoidStepTokens: TRAPEZOID_STEP_TOKENS,
    trapezoidStepPenaltyE4: e4(TRAPEZOID_STEP_PENALTY),
    trapezoidMinScore: TRAPEZOID_MIN_SCORE,
  },
  recurrencePrevention: {
    weightRecurrenceE4: e4(WEIGHT_RECURRENCE),
    weightExplanationE4: e4(WEIGHT_EXPLANATION),
  },
}

export interface BuildInputs {
  readonly counts: ScanCounts
  readonly axes: Axes
  readonly gate: GateVerdict
  readonly countBasis: CountBasis
  readonly chain: ChainLink
  readonly key: KeyRef
  readonly toolVersion: string
  readonly os: string
  /** Injected, never read from a clock here. */
  readonly writtenOn: string
  readonly filesRead: number
  readonly payloadDigest: Sha256 | null
  readonly sign: Signer | null
}

export interface Built {
  readonly snapshot: Snapshot
  /** The distinct signature MACs, committed to by the body and stored beside it. */
  readonly sidecar: readonly Hmac128[] | null
}

const osOf = (platform: string): 'win32' | 'darwin' | 'linux' | 'other' =>
  platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other'

/** Runs a block builder, turning a throw into a recorded absence. */
function block<T>(
  name: AbsentBlock,
  absences: BlockAbsence[],
  cause: AbsenceCause,
  build: () => T,
): T | null {
  try {
    return build()
  } catch (e) {
    absences.push({
      block: name,
      cause: cause === 'not-implemented' ? 'threw' : cause,
      // One line, and no stack: a stack carries the checkout directory.
      detail: e instanceof Error ? e.message.split('\n')[0]?.slice(0, 200) ?? '' : 'unknown',
    })
    return null
  }
}

const spanOf = (counts: ScanCounts): ObservedSpan => {
  const days = counts.dates.filter((d): d is string => dayOf(d) !== null)
  const malformed = counts.dates.length - days.length
  const first = days.length > 0 ? day(days[0] as string) : null
  const last = days.length > 0 ? day(days[days.length - 1] as string) : null
  const spanDays =
    first === null || last === null
      ? 0
      : Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1
  return {
    firstDay: first,
    lastDay: last,
    calendarDays: int(spanDays),
    humanTurnDays: int(counts.humanTurnDates.length),
    userRowDays: int(counts.userRowDates.length),
    evidenceDays: int(counts.dates.length),
    daysMalformed: int(malformed),
  }
}

const scanOf = (counts: ScanCounts, gate: GateVerdict, filesRead: number): ScanRecord => ({
  filesRead: int(filesRead),
  linesRead: int(counts.linesRead),
  linesParseFailed: int(counts.linesParseFailed),
  mainLines: int(counts.mainLines),
  subLines: int(counts.subLines),
  bytesRead: int(counts.bytesRead),
  toolVersionDistinct: int(Object.keys(counts.toolVersions).length),
  gateAvailability: gate.availability,
  gateReasons: [...gate.reasons].sort(),
})

/**
 * Sessions, MAC'd and ordered by the MAC.
 *
 * Ordered by the value that ships rather than by the plaintext id, because
 * ordering by the id would leak the ids' relative order into a file that is
 * meant not to carry them.
 */
const sessionsOf = (counts: ScanCounts, sign: Signer): readonly SessionRecord[] =>
  Object.entries(counts.perSession)
    .map(([id, t]): SessionRecord => ({
      id: sign('session', id),
      lines: int(t.lines),
      bundles: int(t.bundles),
      errors: int(t.errors),
      failures: int(t.failures),
      writeRepeats: int(t.writeRepeats),
      investigationRepeats: int(t.investigationRepeats),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const axesOf = (payloadAxes: Axes, counts: ScanCounts): Record<AxisKey, AxisRecord> => {
  const out = emptyAxes()
  for (const key of AXIS_KEYS) {
    const a = payloadAxes[key]
    if (a.availability === 'not_applicable' && a.score === null && a.detail === null) {
      // Left as not-implemented: no formula ran, so there is nothing to
      // fingerprint and no number that a later window could compare against.
      continue
    }
    const constants = AXIS_CONSTANTS[key]
    const fingerprint = constants === undefined ? null : formulaFingerprint(key, constants)
    out[key] = {
      state: a.availability === 'available' ? 'measured' : 'not-applicable',
      formulaFingerprint: fingerprint,
      numeratorE4: a.detail?.['wastedTotal'] === undefined ? null : e4(a.detail['wastedTotal']),
      denominator: a.detail?.['bundleCount'] ?? null,
      scoreE4: a.score === null ? null : e4(a.score),
      sampling: { clusters: int(counts.sessionIds.length) },
      omittedTerms: a.omittedTerms.map((t) => ({
        term: t.term,
        cause: t.cause,
        leans: OMITTED_TERM_LEANINGS[t.term as keyof typeof OMITTED_TERM_LEANINGS] ?? t.leans,
      })),
    }
  }
  return out
}

const signaturesOf = (counts: ScanCounts): { sets: SignatureSets; members: readonly Hmac128[] } => {
  const members = [...new Set(counts.signatures)].sort()
  return {
    sets: {
      memberCount: int(members.length),
      errors: int(counts.errorRepeats.errors),
      byFamily: Object.entries(counts.errorRepeats.byFamily)
        .map(([family, count]) => ({ family, count: int(count) }))
        .sort((a, b) => (a.family < b.family ? -1 : 1)),
    },
    members,
  }
}

export function buildSnapshot(inputs: BuildInputs): Built {
  const { counts, axes: payloadAxes, gate, sign } = inputs
  const absences: BlockAbsence[] = []

  const sessions =
    sign === null
      ? (absences.push({ block: 'sessions', cause: 'no-signer', detail: 'no key was available' }), null)
      : block('sessions', absences, 'threw', () => sessionsOf(counts, sign))

  const signatures =
    sign === null || !counts.signaturesSigned
      ? (absences.push({ block: 'signatures', cause: 'no-signer', detail: 'no key was available' }), null)
      : block('signatures', absences, 'threw', () => signaturesOf(counts))

  const axes = block('axes', absences, 'threw', () => axesOf(payloadAxes, counts)) ?? emptyAxes()

  // Blocks with no implementation yet. Named rather than silently missing: a
  // reader must be able to tell "this environment had none" from "this version
  // did not look".
  for (const b of ['artifacts', 'commands', 'environment'] as const) {
    absences.push({ block: b, cause: 'not-implemented', detail: 'not built in this version' })
  }

  const measured = SCORED_AXES.filter((k) => axes[k].state === 'measured')
  const axesAbsent = SCORED_AXES.filter((k) => axes[k].state !== 'measured')

  const span = spanOf(counts)
  const scan = scanOf(counts, gate, inputs.filesRead)

  const sidecar = signatures?.members ?? null
  const sidecars =
    signatures === null || sidecar === null
      ? []
      : [{ kind: 'sig' as const, digest: sidecarHash(sidecar), members: int(sidecar.length) }]

  // Checked before the body is hashed. An internally inconsistent snapshot is
  // worse than none, because it will be compared against later.
  const checks: IdentityCheck[] = [
    { name: 'lines-close', relation: 'equal', left: scan.mainLines + scan.subLines, right: scan.linesRead },
    // A subset relation, not an equality: human-turn days sit inside user-row
    // days and are usually fewer.
    { name: 'day-nesting', relation: 'atMost', left: span.humanTurnDays, right: span.userRowDays },
  ]
  if (sessions !== null) {
    checks.push({ name: 'sessions-close', relation: 'equal', left: sessions.length, right: counts.sessionIds.length })
    checks.push({
      name: 'axis-denominator-close',
      relation: 'equal',
      left: sessions.reduce((n, s) => n + s.bundles, 0),
      right: counts.taskBundles,
    })
  }
  if (signatures !== null && sidecar !== null) {
    checks.push({ name: 'signature-members', relation: 'equal', left: signatures.sets.memberCount, right: sidecar.length })
  }
  const identities: readonly Identity[] = checkIdentities(checks)

  const body = {
    schemaVersion: SCHEMA_VERSION as '1',
    builder: {
      toolVersion: semver(inputs.toolVersion),
      parserVersion: '1' as const,
      writtenOn: day(inputs.writtenOn.slice(0, 10)) as Day,
      os: osOf(inputs.os),
    },
    chain: inputs.chain,
    key: inputs.key,
    countBasis: inputs.countBasis,
    completeness: {
      schemaComplete: measured.length === SCORED_AXES.length,
      // A composite over one axis and a composite over six are different
      // quantities. Storing the refusal makes it mechanical rather than
      // remembered.
      compositeComparable: measured.length === SCORED_AXES.length,
      axesAbsent: axesAbsent as readonly ScoredAxis[],
      evaluatedOver: SCORED_AXES,
      blocksAbsent: absences
        .slice()
        .sort((a, b) => ABSENT_BLOCKS.indexOf(a.block) - ABSENT_BLOCKS.indexOf(b.block)),
    },
    span,
    scan,
    sessions: sessions ?? [],
    axes,
    signatures: signatures?.sets ?? null,
    sidecars,
    identities,
    payloadDigest: inputs.payloadDigest,
  }

  return { snapshot: { ...body, selfHash: bodyHash(body) }, sidecar }
}
