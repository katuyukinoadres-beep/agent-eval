/**
 * Reading a chain back and saying what it does and does not establish.
 *
 * Every hash is recomputed from the content it covers. A stored hash that is
 * trusted is a hash that can be edited to match an edited body, which makes the
 * whole structure decorative.
 *
 * What this establishes is that the files have not changed since they were
 * written, by anything short of their owner. What it does not establish is in
 * `NOT_ESTABLISHED`, and it is not a disclaimer — a report that words a
 * self-consistency claim as an authenticity one is making a claim the mechanism
 * cannot support.
 */

import { bodyHash, sidecarHash } from './canonical.js'
import { listSnapshots, sidecarName, type SnapshotIo } from './write.js'
import { join } from 'node:path'
import { firstLine, type Sha256 } from './types.js'

export type ChainBreak =
  | { readonly kind: 'hash-mismatch'; readonly seq: number }
  | { readonly kind: 'missing-seq'; readonly seq: number }
  | { readonly kind: 'forked'; readonly seq: number; readonly children: number }
  | { readonly kind: 'unreadable'; readonly seq: number; readonly detail: string }
  | { readonly kind: 'sidecar-mismatch'; readonly seq: number }
  | { readonly kind: 'sidecar-missing'; readonly seq: number }
  | { readonly kind: 'key-epoch-change'; readonly seq: number; readonly from: number; readonly to: number }
  | { readonly kind: 'key-identity-conflict'; readonly seq: number }
  | { readonly kind: 'clock-regression'; readonly seq: number }

export interface ChainVerdict {
  readonly length: number
  readonly continuous: boolean
  /**
   * Trailing run of unbroken links.
   *
   * The figure eligibility rests on, because a wipe costs the wiper at least
   * two windows and this is what counts them.
   */
  readonly consecutiveTail: number
  readonly breaks: readonly ChainBreak[]
  /**
   * What was actually looked at.
   *
   * A verdict with no stated range is a verdict nothing can be compared with,
   * and a zero from a scan that never ran looks exactly like a clean chain.
   */
  readonly scanned: { readonly files: number; readonly bytes: number }
}

/**
 * What a local chain cannot tell you, in the words a report must use.
 *
 * The key is local and the hash function public, so anyone with write access to
 * the store and the key can produce a self-consistent forged history. Depositing
 * chain hashes with a server is the answer the spec gives and defers.
 */
export const NOT_ESTABLISHED = [
  'the-owner-rebuilding-it',
  'the-whole-store-being-deleted',
  'a-restore-from-backup',
  'figures-that-were-wrong-when-written',
] as const

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

interface Loaded {
  readonly seq: number
  readonly body: Record<string, unknown>
  readonly recomputed: Sha256
  readonly bytes: number
}

export function verifyChain(dir: string, io: SnapshotIo): ChainVerdict {
  const files = listSnapshots(dir, io)
  const breaks: ChainBreak[] = []
  const loaded: Loaded[] = []
  let bytes = 0

  for (const { seq, file } of files) {
    let text = ''
    try {
      text = io.readFile(join(dir, file))
    } catch (e) {
      breaks.push({ kind: 'unreadable', seq, detail: firstLine(e) })
      continue
    }
    bytes += Buffer.byteLength(text, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      breaks.push({ kind: 'unreadable', seq, detail: firstLine(e) })
      continue
    }
    if (!isObj(parsed)) {
      breaks.push({ kind: 'unreadable', seq, detail: 'not an object' })
      continue
    }
    const { selfHash, ...rest } = parsed
    const recomputed = bodyHash(rest)
    if (recomputed !== selfHash) {
      // The body says one thing and its own hash says another. Recorded and
      // still loaded, so the links either side can be checked too.
      breaks.push({ kind: 'hash-mismatch', seq })
    }
    loaded.push({ seq, body: parsed, recomputed, bytes: Buffer.byteLength(text, 'utf8') })
  }

  // Gaps in the sequence. A deletion from the middle or the tail leaves one.
  for (let i = 1; i < loaded.length; i += 1) {
    const prev = loaded[i - 1] as Loaded
    const here = loaded[i] as Loaded
    for (let missing = prev.seq + 1; missing < here.seq; missing += 1) {
      breaks.push({ kind: 'missing-seq', seq: missing })
    }
  }

  // Forks: two bodies naming the same parent. The lock exists to prevent this;
  // one that happened anyway is reported rather than resolved.
  const children = new Map<string, number>()
  for (const l of loaded) {
    const chain = l.body['chain']
    const prev = isObj(chain) ? chain['prev'] : undefined
    if (isObj(prev) && prev['kind'] === 'linked' && typeof prev['hash'] === 'string') {
      children.set(prev['hash'], (children.get(prev['hash']) ?? 0) + 1)
    }
  }
  for (const l of loaded) {
    const chain = l.body['chain']
    const prev = isObj(chain) ? chain['prev'] : undefined
    if (!isObj(prev) || prev['kind'] !== 'linked' || typeof prev['hash'] !== 'string') continue
    const n = children.get(prev['hash']) ?? 0
    if (n > 1 && !breaks.some((b) => b.kind === 'forked' && b.seq === l.seq)) {
      breaks.push({ kind: 'forked', seq: l.seq, children: n })
    }
    // The link itself: this body's stated parent against the parent's own
    // recomputed hash, never against the parent's stored one.
    const parent = loaded.find((x) => x.recomputed === prev['hash'])
    if (parent === undefined) breaks.push({ kind: 'hash-mismatch', seq: l.seq })
  }

  // Sidecars, against the commitment inside the body that names them.
  for (const l of loaded) {
    const commitments = l.body['sidecars']
    if (!Array.isArray(commitments) || commitments.length === 0) continue
    const name = sidecarName(l.seq, l.recomputed)
    let text = ''
    try {
      text = io.readFile(join(dir, name))
    } catch {
      breaks.push({ kind: 'sidecar-missing', seq: l.seq })
      continue
    }
    bytes += Buffer.byteLength(text, 'utf8')
    let members: unknown
    try {
      members = JSON.parse(text)
    } catch {
      breaks.push({ kind: 'sidecar-mismatch', seq: l.seq })
      continue
    }
    const first = commitments[0]
    if (isObj(first) && sidecarHash(members) !== first['digest']) {
      breaks.push({ kind: 'sidecar-mismatch', seq: l.seq })
    }
  }

  // Key changes and a clock that ran backwards. Both are recorded, never
  // corrected: silently correcting a clock is how a plausible wrong number
  // gets made.
  for (let i = 1; i < loaded.length; i += 1) {
    const a = loaded[i - 1] as Loaded
    const b = loaded[i] as Loaded
    const ka = isObj(a.body['key']) ? (a.body['key'] as Record<string, unknown>) : null
    const kb = isObj(b.body['key']) ? (b.body['key'] as Record<string, unknown>) : null
    if (ka !== null && kb !== null && ka['fingerprint'] !== kb['fingerprint']) {
      breaks.push(
        ka['epoch'] === kb['epoch']
          ? { kind: 'key-identity-conflict', seq: b.seq }
          : {
              kind: 'key-epoch-change',
              seq: b.seq,
              from: typeof ka['epoch'] === 'number' ? ka['epoch'] : 0,
              to: typeof kb['epoch'] === 'number' ? kb['epoch'] : 0,
            },
      )
    }
    const da = isObj(a.body['builder']) ? (a.body['builder'] as Record<string, unknown>)['writtenOn'] : undefined
    const db = isObj(b.body['builder']) ? (b.body['builder'] as Record<string, unknown>)['writtenOn'] : undefined
    if (typeof da === 'string' && typeof db === 'string' && db < da) {
      breaks.push({ kind: 'clock-regression', seq: b.seq })
    }
  }

  const broken = new Set(breaks.map((b) => b.seq))
  let tail = 0
  for (let i = loaded.length - 1; i >= 0; i -= 1) {
    if (broken.has((loaded[i] as Loaded).seq)) break
    tail += 1
  }

  return {
    length: loaded.length,
    continuous: breaks.length === 0,
    consecutiveTail: tail,
    breaks: breaks.sort((a, b) => a.seq - b.seq || (a.kind < b.kind ? -1 : 1)),
    scanned: { files: files.length, bytes },
  }
}
