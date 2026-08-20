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
}

export interface RunResult {
  readonly payload: Payload
  readonly validation: Verdict
  readonly gateReasons: readonly string[]
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
  }
}

export function run(options: RunOptions): RunResult {
  const inventory = walkProjects(join(options.home, '.claude', 'projects'))
  const counts = scan(inventory)

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

  const { payload, gate } = assemble({
    inventory,
    counts,
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

  return {
    payload,
    validation,
    gateReasons: gate.reasons.map(String),
  }
}
