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
import { ensureStateDir } from './snapshot/stateDir.js'
import { loadKey } from './snapshot/key.js'
import { signerFor } from './snapshot/mac.js'
import { buildSnapshot } from './snapshot/build.js'
import { defaultSnapshotIo, readHead, writeSnapshot, type WriteOutcome } from './snapshot/write.js'
import { verifyChain, type ChainVerdict } from './snapshot/verify.js'
import { payloadDigest } from './snapshot/canonical.js'
import { firstLine } from './snapshot/types.js'
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
    measuredAt: overrides.measuredAt ?? new Date().toISOString(),
    submissionId: overrides.submissionId ?? crypto.randomUUID(),
    windowDays: overrides.windowDays ?? 10,
    stateDir: overrides.stateDir ?? null,
    useStore: overrides.useStore ?? false,
  }
}

export function run(options: RunOptions): RunResult {
  const inventory = walkProjects(join(options.home, '.claude', 'projects'))

  // The signer is built here and handed down. The reducer never holds the key,
  // and the plaintext signature tuples never come back out of it.
  let sign = null as ReturnType<typeof signerFor> | null
  let store: { readonly stateDir: string; readonly snapshotDir: string } | null = null
  let key: ReturnType<typeof loadKey> | null = null
  if (options.useStore) {
    const dirs = ensureStateDir(options.home, options.stateDir)
    store = { stateDir: dirs.stateDir, snapshotDir: dirs.snapshotDir }
    key = loadKey(options.home, dirs.stateDir)
    sign = signerFor(key.master)
  }

  const counts = scan(inventory, undefined, sign)

  const git = gitCommitDates(options.repos)
  const log = readClosingLog(options.closingLogPath)
  const scopes = readScopes(options.cwd, options.home, options.os)
  const cleanup = findCleanupPeriod(settingsPaths(options.cwd, options.home, options.os))

  const window = assembleWindow({
    jsonlDates: counts.dates,
    userRowDates: counts.userRowDates,
    humanTurnDates: counts.humanTurnDates,
    gitDates: git.dates,
    externalDates: log.dates,
    externalExists: log.exists,
    externalRows: log.rows,
    cleanupPeriodDays: cleanup.days,
    cleanupFoundAt: cleanup.foundAt,
    windowDays: options.windowDays,
  })

  // §8.6 -- the artifact set is what axis 4 divides by, so it has to be
  // computed here rather than left to a later stage.
  const artifacts = settleArtifacts({
    paths: counts.editedPaths,
    windowEnd: `${counts.dates[counts.dates.length - 1] ?? options.measuredAt.slice(0, 10)}T23:59:59Z`,
    lastMention: counts.lastMention,
  })

  const { payload, gate } = assemble({
    inventory,
    counts,
    artifacts,
    window,
    permissions: tallyPermissions(scopes),
    skills: countSkills(join(options.cwd, '.claude')),
    hooks: countHooks(scopes),
    mcp: countMcpServers(mcpSourcePaths(options.cwd, options.home)),
    os: options.os,
    shell: 'unknown',
    agentTools: ['claude-code'],
    measuredAt: options.measuredAt,
    submissionId: options.submissionId,
    hashProject,
  })

  // Round-tripped through JSON first, because that is how a receiver will see
  // it. A payload that only validates as a live object has not been checked in
  // the shape it ships in.
  const validation = validate(JSON.parse(JSON.stringify(payload)) as unknown)

  let snapshot: WriteOutcome | null = null
  let chain: ChainVerdict | null = null
  if (store !== null && key !== null) {
    // Built and written inside a try that cannot reach the caller: the payload
    // must still come out on a day the store cannot be written.
    try {
      const head = readHead(store.snapshotDir, defaultSnapshotIo)
      const built = buildSnapshot({
        counts,
        axes: payload.axes,
        gate,
        countBasis: COUNT_BASIS,
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
    } catch (e) {
      snapshot = {
        kind: 'refused',
        reason: 'identity-violation',
        detail: firstLine(e),
      }
    }
  }

  return {
    payload,
    validation,
    gateReasons: gate.reasons.map(String),
    stateDir: store?.stateDir ?? null,
    signaturesSigned: counts.signaturesSigned,
    snapshot,
    chain,
  }
}
