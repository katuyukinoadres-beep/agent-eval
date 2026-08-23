/**
 * Getting a snapshot onto disk without ever leaving a half-written one there.
 *
 * A torn file only ever exists under a `tmp-` name, which nothing references.
 * The sidecar is renamed before the body, so a crash between them leaves an
 * uncommitted sidecar (swept later, its stem never claimed) rather than a body
 * committing to a file that is not there.
 *
 * The lock and the sweep key on whether a pid is alive, not on elapsed time. A
 * wall-clock steal means a forward clock jump larger than the threshold takes a
 * live lock and produces exactly the fork the lock exists to prevent, and every
 * threshold anyone would pick is a number nobody can defend.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonical, bodyHash } from './canonical.js'
import type { Snapshot, Prev } from './record.js'
import type { Hmac128, Sha256 } from './types.js'
import { sha256 } from './types.js'

export const HEAD_FILE = 'HEAD.json'
export const LOCK_FILE = '.lock'
const TMP_PREFIX = 'tmp-'

export interface SnapshotIo {
  readonly readFile: (p: string) => string
  readonly writeFile: (p: string, data: string) => void
  readonly writeFileExclusive: (p: string, data: string) => void
  readonly rename: (from: string, to: string) => void
  readonly readdir: (p: string) => readonly string[]
  readonly unlink: (p: string) => void
  readonly exists: (p: string) => boolean
  readonly pid: () => number
  readonly pidAlive: (pid: number) => boolean
  readonly uuid: () => string
}

export const defaultSnapshotIo: SnapshotIo = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, d) => writeFileSync(p, d, 'utf8'),
  // 'wx' fails when the target exists, which is what makes the lock a lock.
  writeFileExclusive: (p, d) => writeFileSync(p, d, { encoding: 'utf8', flag: 'wx' }),
  rename: (a, b) => renameSync(a, b),
  readdir: (p) => (existsSync(p) ? readdirSync(p) : []),
  unlink: (p) => {
    try {
      unlinkSync(p)
    } catch {
      // Already gone is the outcome asked for.
    }
  },
  exists: (p) => existsSync(p),
  pid: () => process.pid,
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  uuid: () => randomUUID(),
}

export type RefusalReason =
  | 'state-dir-unwritable'
  | 'locked'
  | 'identity-violation'
  | 'name-taken'

export type WriteOutcome =
  | { readonly kind: 'written'; readonly seq: number; readonly hash: Sha256; readonly blocksAbsent: number }
  /** Carries no path: a path holds the OS username, and run output gets pasted into issues. */
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly detail: string }

export interface Head {
  readonly seq: number
  readonly hash: Sha256
  readonly keyEpoch: number
}

const SNAPSHOT_NAME = /^(\d{6})-([0-9a-f]{12})\.json$/

export const snapshotName = (seq: number, hash: Sha256): string =>
  `${String(seq).padStart(6, '0')}-${hash.slice('sha256:'.length, 'sha256:'.length + 12)}.json`

export const sidecarName = (seq: number, hash: Sha256): string =>
  snapshotName(seq, hash).replace(/\.json$/, '.sig.json')

/** Every committed snapshot in the directory, by sequence. */
export function listSnapshots(dir: string, io: SnapshotIo): ReadonlyArray<{ seq: number; file: string }> {
  return io
    .readdir(dir)
    .map((f) => ({ f, m: SNAPSHOT_NAME.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => ({ seq: Number.parseInt(m[1] as string, 10), file: f }))
    .sort((a, b) => a.seq - b.seq)
}

/**
 * Where the chain stands, rebuilt from the directory when HEAD is unusable.
 *
 * A missing or corrupt HEAD is self-healing because the sequence is in every
 * filename. A genuine break still surfaces, as a `broken` prev on the next
 * snapshot rather than as a silently fresh chain.
 */
export function readHead(dir: string, io: SnapshotIo): { prev: Prev; seq: number } {
  const files = listSnapshots(dir, io)
  if (files.length === 0) return { prev: { kind: 'genesis' }, seq: 1 }

  const last = files[files.length - 1] as { seq: number; file: string }
  const expectedSeq = last.seq + 1

  let body: unknown
  try {
    body = JSON.parse(io.readFile(join(dir, last.file)))
  } catch {
    return { prev: { kind: 'broken', expectedSeq, why: 'file-unreadable' }, seq: expectedSeq }
  }
  if (body === null || typeof body !== 'object') {
    return { prev: { kind: 'broken', expectedSeq, why: 'file-unreadable' }, seq: expectedSeq }
  }

  // Recomputed from the content, never taken from the stored field. A stored
  // hash that is trusted is a hash that can be edited to match an edited body.
  const { selfHash, ...rest } = body as Record<string, unknown>
  const recomputed = bodyHash(rest)
  if (recomputed !== selfHash) {
    return { prev: { kind: 'broken', expectedSeq, why: 'hash-mismatch' }, seq: expectedSeq }
  }
  return { prev: { kind: 'linked', hash: sha256(recomputed) }, seq: expectedSeq }
}

interface Lock {
  readonly release: () => void
}

function acquire(dir: string, io: SnapshotIo): Lock | null {
  const path = join(dir, LOCK_FILE)
  const mine = String(io.pid())
  try {
    io.writeFileExclusive(path, `${mine}\n`)
    return { release: () => io.unlink(path) }
  } catch {
    // Held. Steal only from a process that is gone -- otherwise this is the
    // fork the lock exists to prevent.
    let holder = Number.NaN
    try {
      holder = Number.parseInt(io.readFile(path).trim(), 10)
    } catch {
      holder = Number.NaN
    }
    if (Number.isFinite(holder) && io.pidAlive(holder)) return null
    io.unlink(path)
    try {
      io.writeFileExclusive(path, `${mine}\n`)
      return { release: () => io.unlink(path) }
    } catch {
      return null
    }
  }
}

/** Removes temporaries left by runs that died. The only files this deletes. */
export function sweepTemporaries(dir: string, io: SnapshotIo): number {
  let removed = 0
  for (const name of io.readdir(dir)) {
    if (!name.startsWith(TMP_PREFIX)) continue
    const pid = Number.parseInt(name.slice(TMP_PREFIX.length).split('-')[0] ?? '', 10)
    if (Number.isFinite(pid) && io.pidAlive(pid)) continue
    io.unlink(join(dir, name))
    removed += 1
  }
  return removed
}

export interface WriteInputs {
  readonly snapshotDir: string
  readonly snapshot: Snapshot
  readonly sidecar: readonly Hmac128[] | null
}

/**
 * Writes one snapshot.
 *
 * Never throws into the caller. A payload must still be produced on a day the
 * store cannot be written, and a snapshot that failed silently is the exact
 * failure this codebase is built to prevent -- it is discovered a window later,
 * when the comparison it existed for cannot be made.
 */
export function writeSnapshot(inputs: WriteInputs, io: SnapshotIo = defaultSnapshotIo): WriteOutcome {
  const { snapshotDir: dir, snapshot, sidecar } = inputs
  let lock: Lock | null = null
  try {
    if (!io.exists(dir)) mkdirSync(dir, { recursive: true })

    lock = acquire(dir, io)
    if (lock === null) {
      return { kind: 'refused', reason: 'locked', detail: 'another run holds the lock' }
    }

    sweepTemporaries(dir, io)

    const seq = snapshot.chain.seq
    const bodyName = snapshotName(seq, snapshot.selfHash)
    if (io.exists(join(dir, bodyName))) {
      // A snapshot is immutable. Never clobber one.
      return { kind: 'refused', reason: 'name-taken', detail: `sequence ${seq} already exists` }
    }

    const stamp = `${TMP_PREFIX}${io.pid()}-${io.uuid()}`
    const bodyTmp = join(dir, `${stamp}.json`)
    const sideTmp = join(dir, `${stamp}.sig.json`)

    io.writeFile(bodyTmp, canonical(snapshot))
    if (sidecar !== null) io.writeFile(sideTmp, canonical(sidecar))

    // Sidecar first: a crash between the two leaves an uncommitted sidecar,
    // which is swept, rather than a body committing to a file that is missing.
    if (sidecar !== null) io.rename(sideTmp, join(dir, sidecarName(seq, snapshot.selfHash)))
    io.rename(bodyTmp, join(dir, bodyName))

    const headTmp = join(dir, `${stamp}.head.json`)
    const head: Head = { seq, hash: snapshot.selfHash, keyEpoch: snapshot.key.epoch }
    io.writeFile(headTmp, canonical(head))
    io.rename(headTmp, join(dir, HEAD_FILE))

    return {
      kind: 'written',
      seq,
      hash: snapshot.selfHash,
      blocksAbsent: snapshot.completeness.blocksAbsent.length,
    }
  } catch (e) {
    return {
      kind: 'refused',
      reason: 'state-dir-unwritable',
      detail: e instanceof Error ? (e.message.split('\n')[0] ?? '').slice(0, 200) : 'unknown',
    }
  } finally {
    lock?.release()
  }
}
