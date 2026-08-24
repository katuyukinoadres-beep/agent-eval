/**
 * The end-to-end run: walk, read, collect, assemble, validate.
 *
 * The last step is the point. The tool validates its own output with the same
 * rules it would apply to a payload arriving from someone else's machine, and
 * refuses to print one that fails. A sender that exempts itself from its own
 * checks is how every incident in DECISION_LOG.md got out.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { dayOf, localIso, offsetLabelOf, offsetMinutesOf } from './collect/day.js'
import { restrict, rowsOutOfWindow } from './collect/restrict.js'
import { daysRolled, windowScope } from './collect/scope.js'
import { walkProjects } from './collect/walk.js'
import { scan } from './collect/scan.js'
import { gitCommitDates } from './collect/git.js'
import { readClosingLog } from './collect/closingLog.js'
import { findCleanupPeriod, settingsPaths } from './collect/settings.js'
import { assembleWindow } from './collect/window.js'
import {
  countHooks,
  countMcpServers,
  countSkills,
  mcpSourcePaths,
  tallyPermissions,
  type ScopeDocument,
} from './collect/environment.js'
import { assemble } from './payload/assemble.js'
import { settleArtifacts } from './score/artifact.js'
import { ensureStateDir, StateDirError } from './snapshot/stateDir.js'
import { loadKey } from './snapshot/key.js'
import { signerFor } from './snapshot/mac.js'
import { buildSnapshot } from './snapshot/build.js'
import {
  defaultSnapshotIo,
  readHead,
  readLatestBody,
  readLatestSidecar,
  writeSnapshot,
  type WriteOutcome,
} from './snapshot/write.js'
import { compare, type Comparison, type WindowView } from './score/comparison.js'

/** Domain for the basis digest, built without an inline escape. */
const COUNT_BASIS_DOMAIN = 'agent-eval/count-basis/1' + String.fromCharCode(10)
import { digestOf } from './snapshot/canonical.js'
import { verifyChain, type ChainVerdict } from './snapshot/verify.js'
import { payloadDigest } from './snapshot/canonical.js'
import { filesystemReason } from './snapshot/types.js'
import { COUNT_BASIS } from './payload/assemble.js'
import { VERSION } from './version.js'
import { validate, type Verdict } from './validate/index.js'
import type { Payload } from './payload/types.js'

export interface RunOptions {
  readonly home: string
  readonly cwd: string
  readonly os: string
  /** Repositories to take commit dates from. Empty means git does not contribute. */
  readonly repos: readonly string[]
  /** Path to the external log, or null when the environment keeps none. */
  readonly closingLogPath: string | null
  /** Supplied rather than read from the clock, so a run is reproducible. */
  readonly measuredAt: string
  readonly submissionId: string
  readonly windowDays: number
  /** Where the store lives, when it is not under home. Surfaced as --state-dir. */
  readonly stateDir: string | null
  /**
   * Whether to touch the state directory at all.
   *
   * Off by default for now: creating a key and a store is a side effect on the
   * user's machine, and a scan that only prints should not have one until the
   * snapshot it exists for is being written.
   */
  readonly useStore: boolean
}

export interface RunResult {
  readonly payload: Payload
  readonly validation: Verdict
  readonly gateReasons: readonly string[]
  /** Where the store is, when one was opened. Null when --store was not asked for. */
  readonly stateDir: string | null
  /** True when signatures were MAC'd. False means the set is empty for want of a key. */
  readonly signaturesSigned: boolean
  /**
   * What happened to the snapshot.
   *
   * Null only when no store was asked for. A snapshot that silently failed to
   * write is discovered a window later, when the comparison it existed for
   * cannot be made -- so the outcome is carried out and printed.
   */
  readonly snapshot: WriteOutcome | null
  /** The chain as it stands after this run, or null when no store was opened. */
  readonly chain: ChainVerdict | null
  /**
   * This window against the previous one, or null when no store was opened.
   *
   * Carries its own refusal reason rather than being absent: "there was no
   * previous window" and "the two could not be compared" are different facts.
   */
  readonly comparison: Comparison | null
}

/**
 * Hashes a project directory name.
 *
 * Salted with nothing, deliberately: the same project on two machines must hash
 * alike or cross-environment comparison is impossible. What the hash buys is
 * that the *name* does not travel — those names are working directories, and
 * they carry the home directory, the OS user name, and often a client's.
 */
export const hashProject = (name: string): string =>
  createHash('sha256').update(name, 'utf8').digest('hex')

const readScopes = (cwd: string, home: string, os: string): ScopeDocument[] => {
  const docs: ScopeDocument[] = []
  for (const { scope, path } of settingsPaths(cwd, home, os)) {
    try {
      const doc: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
        docs.push({ scope, doc: doc as Record<string, unknown> })
      }
    } catch {
      // Absent is the common case; unreadable is reported by findCleanupPeriod,
      // which sweeps the same list.
    }
  }
  return docs
}

export function defaultOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  const home = overrides.home ?? homedir()
  return {
    home,
    cwd: overrides.cwd ?? process.cwd(),
    os: overrides.os ?? platform(),
    repos: overrides.repos ?? [],
    closingLogPath: overrides.closingLogPath ?? null,
    // Stamped in this machine's own offset, not UTC. The day boundary is taken
    // from here, and an active day is a day of somebody's work -- which ends at
    // their midnight. A UTC stamp on a machine nine hours ahead splits every
    // evening across two days, and the window counts days: measured on this
    // corpus, 10 active days under UTC against 11 under the local offset, with
    // a window of the most recent 10.
    measuredAt: overrides.measuredAt ?? localIso(new Date()),
    submissionId: overrides.submissionId ?? crypto.randomUUID(),
    windowDays: overrides.windowDays ?? 10,
    stateDir: overrides.stateDir ?? null,
    useStore: overrides.useStore ?? false,
  }
}

/**
 * The parts of a snapshot a comparison needs, from either a freshly built one
 * or one read back off disk.
 *
 * One reader for both, so the two windows are never described by two different
 * pieces of code -- which is how a field comes to be read one way on the way in
 * and another on the way out.
 */
function viewOf(body: Record<string, unknown> | { readonly axes: unknown }): WindowView {
  const b = body as Record<string, unknown>
  const axes = (b['axes'] ?? {}) as Record<string, Record<string, unknown>>
  const key = (b['key'] ?? {}) as Record<string, unknown>
  const completeness = (b['completeness'] ?? {}) as Record<string, unknown>
  return {
    axes: Object.fromEntries(
      Object.entries(axes).map(([k, a]) => [
        k,
        {
          state: (a['state'] ?? 'not-implemented') as 'measured' | 'not-applicable' | 'not-implemented',
          scoreE4: typeof a['scoreE4'] === 'number' ? a['scoreE4'] : null,
          formulaFingerprint: typeof a['formulaFingerprint'] === 'string' ? a['formulaFingerprint'] : null,
          // Read, not invented. This was hardcoded true for every axis, so a
          // real shortfall and the assumption of one were the same value and
          // the rule that depends on it could never fire either way.
          //
          // A record that predates the field is treated as short: an old
          // snapshot cannot say it met a minimum nobody stored.
          belowMinDenominator: a['belowMinDenominator'] !== false,
        },
      ]),
    ),
    // Digested rather than compared field by field, so a basis that gains a
    // field later still compares as different.
    countBasisDigest: digestOf(COUNT_BASIS_DOMAIN, b['countBasis'] ?? null),
    keyFingerprint: typeof key['fingerprint'] === 'string' ? key['fingerprint'] : '',
    compositeComparable: completeness['compositeComparable'] === true,
    compositeE4: typeof b['compositeE4'] === 'number' ? b['compositeE4'] : null,
  }
}

export function run(options: RunOptions): RunResult {
  const inventory = walkProjects(join(options.home, '.claude', 'projects'))

  // The signer is built here and handed down. The reducer never holds the key,
  // and the plaintext signature tuples never come back out of it.
  let sign = null as ReturnType<typeof signerFor> | null
  let store: { readonly stateDir: string; readonly snapshotDir: string } | null = null
  let key: ReturnType<typeof loadKey> | null = null
  // Opening the store is allowed to fail. It used to throw sixty lines above
  // the try that exists for exactly this, so a home directory that is version
  // controlled, or read-only, or already holding a tracked state dir, killed
  // the run with an uncaught error carrying an absolute path and a stack --
  // and produced no payload, in a function whose own comment says the payload
  // must still come out on a day the store cannot be written.
  let storeRefusal: WriteOutcome | null = null
  if (options.useStore) {
    try {
      const dirs = ensureStateDir(options.home, options.stateDir)
      store = { stateDir: dirs.stateDir, snapshotDir: dirs.snapshotDir }
      key = loadKey(options.home, dirs.stateDir)
      sign = signerFor(key.master)
    } catch (e) {
      store = null
      key = null
      sign = null
      storeRefusal = {
        kind: 'refused',
        reason: 'state-dir-unwritable',
        // A StateDirError carries advice and, deliberately, no path. Anything
        // else is a filesystem error whose message embeds one, so it becomes a
        // fixed phrase chosen by errno.
        detail: e instanceof StateDirError ? e.message : filesystemReason(e),
      }
    }
  }

  // The day boundary comes from the report's own timestamp, so a run and the
  // window it cuts agree about where a day ends. It is published, never
  // inferred: the same corpus has 10 human-turn days under UTC and 11 under
  // +09:00, against a window of the most recent 10.
  const dayOffsetMinutes = offsetMinutesOf(options.measuredAt)
  const dayBoundary = offsetLabelOf(options.measuredAt)
  const counts = scan(inventory, undefined, sign, dayOffsetMinutes)

  const git = gitCommitDates(options.repos)
  const log = readClosingLog(options.closingLogPath)
  const scopes = readScopes(options.cwd, options.home, options.os)
  const cleanup = findCleanupPeriod(settingsPaths(options.cwd, options.home, options.os))

  const window = assembleWindow({
    jsonlDates: counts.dates,
    userRowDates: counts.userRowDates,
    humanTurnDates: counts.humanTurnDates,
    humanTurnDatesUtc: counts.humanTurnDatesUtc,
    dayBoundary,
    measuredOn: dayOf(options.measuredAt, dayOffsetMinutes) ?? options.measuredAt.slice(0, 10),
    gitDates: git.dates,
    externalDates: log.dates,
    externalExists: log.exists,
    externalRows: log.rows,
    cleanupPeriodDays: cleanup.days,
    cleanupFoundAt: cleanup.foundAt,
    windowDays: options.windowDays,
  })

  // The window, applied. Only the day-keyed counters move; every other field in
  // the returned view is the corpus-wide value, and `restrict` names which is
  // which so a reader never has to infer it.
  //
  // Computed before the artifact set, because that set is axis 4's denominator
  // and has to be the windowed one.
  const scope = windowScope(
    counts.humanTurnDates,
    options.windowDays,
    dayBoundary,
    dayOf(options.measuredAt, dayOffsetMinutes) ?? options.measuredAt.slice(0, 10),
  )
  const windowedCounts = restrict(counts, scope).counts
  const outOfWindow = rowsOutOfWindow(counts, scope)

  // §8.6 -- the artifact set is what axis 4 divides by, so it has to be
  // computed here rather than left to a later stage.
  const artifacts = settleArtifacts({
    paths: windowedCounts.editedPaths,
    windowEnd: `${counts.dates[counts.dates.length - 1] ?? options.measuredAt.slice(0, 10)}T23:59:59Z`,
    lastMention: counts.lastMention,
  })

  // Read before assembling, because axis 6's rate needs the previous window's
  // signature set and the axis is scored inside `assemble`. Reading it after
  // meant the cross-window rate could never be computed at all, so the axis the
  // product is built on always scored its within-window stand-in.
  //
  // The key gates it: MACs made under two different keys are not comparable,
  // and an empty intersection reads as "no failure recurred".
  const previousSidecar =
    store === null || key === null ? null : readLatestSidecar(store.snapshotDir, defaultSnapshotIo)
  const previousBody = store === null ? null : readLatestBody(store.snapshotDir, defaultSnapshotIo)
  const previousKey = (previousBody?.['key'] as Record<string, unknown> | undefined)?.['fingerprint']
  const sameKey = typeof previousKey === 'string' && previousKey === key?.ref.fingerprint

  /**
   * Whether the previous window covered different days from this one.
   *
   * A trailing ten-active-day window run twice in one day selects the same ten
   * days; run tomorrow it shares nine. A cross-window rate over those measures
   * the overlap, not the environment — so only fully disjoint windows are
   * compared, which is the one rule that needs no correction factor nobody has
   * measured.
   *
   * A previous snapshot with no stored day set gives null rather than zero.
   * Every snapshot written before the set existed is in that state, and an
   * all-time previous set intersected with a window-scoped current one inflates
   * the carried share.
   */
  const previousSpan = previousBody?.['span'] as Record<string, unknown> | undefined
  const previousWindowDays = Array.isArray(previousSpan?.['windowActiveDays'])
    ? (previousSpan['windowActiveDays'] as unknown[]).filter((d): d is string => typeof d === 'string')
    : null
  const rolled = scope === null ? null : daysRolled(scope, previousWindowDays)
  const windowsDisjoint = rolled !== null && scope !== null && rolled >= scope.windowDays

  const { payload, gate } = assemble({
    inventory,
    counts,
    artifacts,
    window,
    permissions: tallyPermissions(scopes),
    // Both directories skills can live in, so the denominator covers the same
    // ground as a numerator collected across every project on the machine.
    skills: countSkills([join(options.cwd, '.claude'), join(options.home, '.claude')]),
    hooks: countHooks(scopes),
    mcp: countMcpServers(mcpSourcePaths(options.cwd, options.home)),
    os: options.os,
    shell: 'unknown',
    agentTools: ['claude-code'],
    measuredAt: options.measuredAt,
    windowedCounts,
    undatedRows: outOfWindow.undated,
    rowsOutOfWindow: outOfWindow,
    submissionId: options.submissionId,
    hashProject,
    // Only a disjoint previous window supplies a set to intersect. Anything
    // less and the carried share is mostly the overlap.
    previousRepeated:
      windowsDisjoint && sameKey && previousSidecar !== null ? previousSidecar.repeated : null,
    windowsDisjoint,
    daysRolled: rolled,
  })

  // Round-tripped through JSON first, because that is how a receiver will see
  // it. A payload that only validates as a live object has not been checked in
  // the shape it ships in.
  const validation = validate(JSON.parse(JSON.stringify(payload)) as unknown)

  let snapshot: WriteOutcome | null = storeRefusal
  let chain: ChainVerdict | null = null
  let comparison: Comparison | null = null
  if (store !== null && key !== null) {
    // Built and written inside a try that cannot reach the caller: the payload
    // must still come out on a day the store cannot be written.
    try {
      const head = readHead(store.snapshotDir, defaultSnapshotIo)
      // Read before writing: the baseline is the window before this one.
      const previous = previousBody
      const built = buildSnapshot({
        counts,
        axes: payload.axes,
        gate,
        countBasis: COUNT_BASIS,
        windowActiveDays: scope === null ? [] : [...scope.ordered],
        compositeE4:
          payload.composite.score === null ? null : Math.round(payload.composite.score * 10_000),
        chain: { seq: head.seq, prev: head.prev },
        key: key.ref,
        toolVersion: VERSION,
        os: options.os,
        writtenOn: options.measuredAt,
        filesRead: inventory.files.length,
        payloadDigest: payloadDigest(payload),
        sign,
      })
      snapshot = writeSnapshot({
        snapshotDir: store.snapshotDir,
        snapshot: built.snapshot,
        sidecar: built.sidecar,
      })
      chain = verifyChain(store.snapshotDir, defaultSnapshotIo)
      comparison = compare(viewOf(built.snapshot), previous === null ? null : viewOf(previous))
    } catch (e) {
      snapshot = {
        kind: 'refused',
        reason: 'identity-violation',
        detail: filesystemReason(e),
      }
    }
  }

  return {
    payload,
    validation,
    gateReasons: gate.reasons.map(String),
    comparison,
    stateDir: store?.stateDir ?? null,
    signaturesSigned: counts.signaturesSigned,
    snapshot,
    chain,
  }
}
