/**
 * The state directory, which cannot exist without the thing that protects it.
 *
 * "Create the directory, then write the guard" leaves an unguarded directory if
 * anything happens between the two steps — and the directory holds MACs of
 * session ids, project names and command names. So it is built under a staging
 * name and becomes visible at its final name only by `rename`, which is atomic
 * on NTFS and POSIX, and by then the guard is already inside it.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const STATE_DIR_NAME = '.agent-eval'
export const SNAPSHOT_DIR_NAME = 'snapshots'

/**
 * The key lives outside the store.
 *
 * So that `~/.agent-eval/` can be tarred, backed up, synced, or attached to a
 * support request without unmasking anything in it. A key inside the store
 * travels with every copy of the store.
 */
export const KEY_FILE_NAME = '.agent-eval-key'

/** Exactly this, on its own line. Anything else and the guard is rewritten. */
export const GITIGNORE_BODY = '*\n'

export const stateDirFor = (home: string): string => join(home, STATE_DIR_NAME)
export const keyFileFor = (home: string): string => join(home, KEY_FILE_NAME)

export class StateDirError extends Error {}

export interface StateDirIo {
  readonly exists: (path: string) => boolean
  readonly mkdir: (path: string) => void
  readonly writeFile: (path: string, body: string, mode?: number) => void
  readonly readFile: (path: string) => string
  readonly rename: (from: string, to: string) => void
  readonly rm: (path: string) => void
  readonly readdir: (path: string) => readonly string[]
  readonly pid: () => number
  readonly uuid: () => string
  /** True when this pid is a live process. Used only to sweep abandoned staging. */
  readonly alive: (pid: number) => boolean
  /** True when the store is tracked by a git repository. See `refuseIfTracked`. */
  readonly tracked: (path: string) => boolean
}

const liveProcess = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const isTracked = (path: string): boolean => {
  try {
    execFileSync('git', ['-C', path, 'ls-files', '--error-unmatch', path], {
      stdio: 'ignore',
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

export const defaultIo: StateDirIo = {
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeFile: (p, body, mode) => writeFileSync(p, body, mode === undefined ? 'utf8' : { encoding: 'utf8', mode }),
  readFile: (p) => readFileSync(p, 'utf8'),
  rename: (a, b) => renameSync(a, b),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  readdir: (p) => (existsSync(p) ? readdirSync(p) : []),
  pid: () => process.pid,
  uuid: () => randomUUID(),
  alive: liveProcess,
  tracked: isTracked,
}

const STAGING_PREFIX = `${STATE_DIR_NAME}.new-`

/**
 * Removes staging directories left by runs that died.
 *
 * Keyed on whether the pid is still alive, so a concurrent run's staging is
 * never swept out from under it.
 */
export function sweepStaging(parent: string, io: StateDirIo = defaultIo): number {
  let removed = 0
  for (const name of io.readdir(parent)) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const pid = Number.parseInt(name.slice(STAGING_PREFIX.length).split('-')[0] ?? '', 10)
    if (Number.isFinite(pid) && io.alive(pid)) continue
    io.rm(join(parent, name))
    removed += 1
  }
  return removed
}

/**
 * Re-reads the guard on every run and rewrites it if it is gone or wrong.
 *
 * Checked every time rather than once at creation, because the failure this
 * protects against is someone's editor, backup tool or `git clean` removing a
 * dotfile months later, and nothing would announce that.
 */
export function assertGuarded(stateDir: string, io: StateDirIo = defaultIo): boolean {
  const path = join(stateDir, '.gitignore')
  let body = ''
  try {
    body = io.readFile(path)
  } catch {
    body = ''
  }
  const guarded = body.split('\n').some((line) => line.trim() === '*')
  if (guarded) return false
  io.writeFile(path, GITIGNORE_BODY)
  return true
}

/**
 * Refuses only when the store is actually tracked by git.
 *
 * Not "a .git exists at or above the store": someone who version-controls their
 * home directory has `~/.git`, and refusing on that would refuse on every run
 * forever, costing them the one thing this module exists to preserve. Being
 * inside a repository is not the risk; being committed is.
 */
export function refuseIfTracked(stateDir: string, io: StateDirIo = defaultIo): void {
  if (!io.exists(stateDir)) return
  if (!io.tracked(stateDir)) return
  throw new StateDirError(
    `${stateDir} is tracked by git. It holds MACs of session ids, project names and command ` +
      `names, and committing it publishes them. Untrack it, or point elsewhere with --state-dir.`,
  )
}

export interface StateDirResult {
  readonly stateDir: string
  readonly snapshotDir: string
  readonly created: boolean
  /** True when the guard was missing or wrong and had to be rewritten. */
  readonly guardRewritten: boolean
  readonly stagingSwept: number
}

/**
 * Returns a state directory that is guaranteed to contain its guard.
 *
 * The directory is assembled under a staging name and renamed into place, so
 * it never appears at its real path in an unguarded state. If another process
 * wins the race, the loser removes its staging and checks the winner's guard
 * rather than overwriting it.
 */
export function ensureStateDir(
  home: string,
  override: string | null = null,
  io: StateDirIo = defaultIo,
): StateDirResult {
  const stateDir = override ?? stateDirFor(home)
  const parent = dirname(stateDir)
  const stagingSwept = sweepStaging(parent, io)

  if (io.exists(stateDir)) {
    refuseIfTracked(stateDir, io)
    const guardRewritten = assertGuarded(stateDir, io)
    const snapshotDir = join(stateDir, SNAPSHOT_DIR_NAME)
    if (!io.exists(snapshotDir)) io.mkdir(snapshotDir)
    return { stateDir, snapshotDir, created: false, guardRewritten, stagingSwept }
  }

  const staging = join(parent, `${STAGING_PREFIX}${io.pid()}-${io.uuid()}`)
  io.mkdir(staging)
  io.writeFile(join(staging, '.gitignore'), GITIGNORE_BODY)
  io.mkdir(join(staging, SNAPSHOT_DIR_NAME))

  try {
    io.rename(staging, stateDir)
  } catch {
    // Another run got there first. Its directory already carries the guard by
    // the same construction; drop ours rather than clobbering it.
    io.rm(staging)
    refuseIfTracked(stateDir, io)
    const guardRewritten = assertGuarded(stateDir, io)
    return {
      stateDir,
      snapshotDir: join(stateDir, SNAPSHOT_DIR_NAME),
      created: false,
      guardRewritten,
      stagingSwept,
    }
  }

  refuseIfTracked(stateDir, io)
  return {
    stateDir,
    snapshotDir: join(stateDir, SNAPSHOT_DIR_NAME),
    created: true,
    guardRewritten: false,
    stagingSwept,
  }
}
