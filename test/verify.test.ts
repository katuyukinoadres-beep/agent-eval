import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NOT_ESTABLISHED, verifyChain } from '@/snapshot/verify.js'
import { defaultSnapshotIo, writeSnapshot } from '@/snapshot/write.js'
import { buildSnapshot, type BuildInputs } from '@/snapshot/build.js'
import { canonical, bodyHash } from '@/snapshot/canonical.js'
import { KEY_BYTES, fingerprintOf, signerFor } from '@/snapshot/mac.js'
import { BASE_PAYLOAD } from '@/payload/base.js'
import { COUNT_BASIS } from '@/payload/assemble.js'

/**
 * What the chain establishes, and — as much of the point — what it does not.
 *
 * The key is local and the hash function is public, so anyone with write access
 * to the store and the key can produce a self-consistent forged history. This is
 * tamper-evident against accident and a casual edit, not tamper-proof against
 * its owner, and a report that words it the other way is claiming more than the
 * mechanism can carry.
 */

const dirs: string[] = []
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agent-eval-verify-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const KEY = Buffer.alloc(KEY_BYTES, 5)
const SIGN = signerFor(KEY)

const counts = {
  linesRead: 100, linesParseFailed: 0, bytesRead: 5_000, mainLines: 60, subLines: 40,
  toolResultTotal: 300, toolResultWithIsErrorKey: 200, toolResultIsErrorTrue: 10,
  attributionSkillRows: 4, attributionSkillDistinct: 2, mcpServerDistinct: 1,
  userRows: 20, originBearingUserRows: 2, humanTurns: 6, originHumanRows: 2,
  notHumanCounts: {}, denialRows: 2, denialUserRejected: 1, denialKinds: {},
  editedFilesDistinct: 3, editedFilesRepeated: 1,
  stopHookSummaryRows: 2, hookErrorsNonEmpty: 1, sessionIdMismatchRows: 0,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
  toolVersions: { '2.1.233': 100 },
  sessionIds: ['s1'],
  dates: ['2026-08-19'],
  userRowDates: ['2026-08-19'],
  humanTurnDates: ['2026-08-19'],
  perProject: {},
  perSession: {
    s1: { bundles: 5, failures: 3, writeRepeats: 1, investigationRepeats: 1, timedOut: 0, largeOutput: 0, errors: 3, lines: 100 },
  },
  signatures: [SIGN('sig/e', 'a'), SIGN('sig/e', 'b')],
  signaturesSigned: true,
  taskBundles: 5, rootBundles: 0, orphanBundles: 0, toolActivityRows: 50,
  environmentNoiseRows: 0, editedPaths: {}, lastMention: () => null, lastMentionIn: () => null, referenceTokens: 0,
  errorRepeats: { errors: 3, distinctSignatures: 2, rIn: 0.33, byFamily: { timeout: 3 } },
  metabolism: {
    skillsListed: [], listingChars: 0, listingTruncated: false,
    skillFirings: {}, hookFirings: {}, mcpFirings: {}, effectiveInputPerCall: [],
  },
  manualEdits: {
    editedNames: [], staleRecoveredPaths: [], userModifiedPresent: 0, userModifiedTrue: 0,
  },
  verification: {
    intervals: 30, verifiedIntervals: 10, todoWriteUsed: true,
    // Three episodes against the three failures the attribution routed to axis
    // 3's split. The identity is a subset relation and this fixture sits on the
    // boundary, which is where it is worth pinning.
    selfRepaired: 2, humanRescued: 1, unresolved: 0, repairedNotCounted: 0,
  },
  wasted: {
    failures: 3, hookOriginated: 0, writeRepeats: 1, investigationRepeats: 1,
    timedOut: 0, largeOutput: 0, callsPerBundle: { b1: 4 },
    errorsObserved: 3,
    attribution: { E1: 0, E2: 0, E2b: 0, E3: 0, E4: 0, E7: 0, E6: 0, E5: 0, E8_E9: 3 },
    closure: { observed: 3, attributed: 3, numerator: 3, excluded: 0, balanced: true },
  },
}

const build = (over: Partial<BuildInputs> = {}) =>
  buildSnapshot({
    counts,
    axes: BASE_PAYLOAD.axes,
    gate: { availability: 'available', reasons: [], totalAllowed: true },
    countBasis: COUNT_BASIS,
    chain: { seq: 1, prev: { kind: 'genesis' } },
    key: { epoch: 1, fingerprint: fingerprintOf(KEY) },
    toolVersion: '0.0.0',
    os: 'linux',
    writtenOn: '2026-08-23T12:00:00+09:00',
    filesRead: 1,
    payloadDigest: null,
    sign: SIGN,
    ...over,
  } as unknown as BuildInputs)

/** Writes n linked snapshots and returns the directory. */
function chainOf(n: number): string {
  const dir = freshDir()
  let prev: BuildInputs['chain']['prev'] = { kind: 'genesis' }
  for (let seq = 1; seq <= n; seq += 1) {
    const built = build({
      chain: { seq, prev },
      writtenOn: `2026-08-${String(22 + seq).padStart(2, '0')}T12:00:00+09:00`,
    })
    writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar })
    prev = { kind: 'linked', hash: built.snapshot.selfHash }
  }
  return dir
}

const bodyFiles = (dir: string): string[] =>
  readdirSync(dir).filter((f) => /^\d{6}-[0-9a-f]{12}\.json$/.test(f)).sort()

describe('a chain nobody touched', () => {
  it('is continuous, with a tail as long as itself', () => {
    const v = verifyChain(chainOf(3), defaultSnapshotIo)
    expect(v.length).toBe(3)
    expect(v.continuous).toBe(true)
    expect(v.consecutiveTail).toBe(3)
    expect(v.breaks).toEqual([])
  })

  it('says what it looked at', () => {
    // A verdict with no stated range cannot be compared with another, and a
    // zero from a scan that never ran looks exactly like a clean chain.
    const v = verifyChain(chainOf(2), defaultSnapshotIo)
    expect(v.scanned.files).toBe(2)
    expect(v.scanned.bytes).toBeGreaterThan(0)
  })

  it('reports an empty store as empty rather than as clean', () => {
    const v = verifyChain(freshDir(), defaultSnapshotIo)
    expect(v.length).toBe(0)
    expect(v.consecutiveTail).toBe(0)
  })
})

describe('editing an earlier snapshot', () => {
  it('invalidates it and everything after it', () => {
    // The property the chain exists for: rewriting the past costs the whole
    // history, not just the row that was rewritten.
    const dir = chainOf(2)
    const first = join(dir, bodyFiles(dir)[0] as string)
    const body = JSON.parse(readFileSync(first, 'utf8')) as Record<string, unknown>
    ;(body['scan'] as Record<string, unknown>)['linesRead'] = 999_999
    writeFileSync(first, canonical(body), 'utf8')

    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.continuous).toBe(false)
    expect(v.breaks.some((b) => b.kind === 'hash-mismatch' && b.seq === 1)).toBe(true)
    expect(v.breaks.some((b) => b.kind === 'hash-mismatch' && b.seq === 2)).toBe(true)
    expect(v.consecutiveTail).toBe(0)
  })

  it('is caught even when the stored hash was rewritten to match', () => {
    // The forgery someone would actually attempt. The body hashes to its own
    // stored value, so nothing is wrong with it alone -- the child is what
    // catches it.
    const dir = chainOf(2)
    const first = join(dir, bodyFiles(dir)[0] as string)
    const parsed = JSON.parse(readFileSync(first, 'utf8')) as Record<string, unknown>
    const { selfHash: _drop, ...rest } = parsed
    ;(rest['scan'] as Record<string, unknown>)['linesRead'] = 42
    writeFileSync(first, canonical({ ...rest, selfHash: bodyHash(rest) }), 'utf8')

    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((b) => b.kind === 'hash-mismatch' && b.seq === 2)).toBe(true)
  })
})

describe('deleting', () => {
  it('reports a gap in the middle', () => {
    const dir = chainOf(3)
    unlinkSync(join(dir, bodyFiles(dir)[1] as string))
    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((b) => b.kind === 'missing-seq' && b.seq === 2)).toBe(true)
  })

  it('reports a sidecar that went without a record of going', () => {
    const dir = chainOf(1)
    const side = readdirSync(dir).find((f) => f.endsWith('.sig.json')) as string
    unlinkSync(join(dir, side))
    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((b) => b.kind === 'sidecar-missing')).toBe(true)
  })

  it('reports an edited sidecar', () => {
    // Emptying the signature set is a named attack: it drives cross-window
    // recurrence to zero, which is a perfect score.
    const dir = chainOf(1)
    const side = readdirSync(dir).find((f) => f.endsWith('.sig.json')) as string
    writeFileSync(join(dir, side), '[]', 'utf8')
    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((b) => b.kind === 'sidecar-mismatch')).toBe(true)
  })
})

describe('a body that cannot be read', () => {
  it('is a break, not a shorter chain', () => {
    const dir = chainOf(2)
    writeFileSync(join(dir, bodyFiles(dir)[0] as string), '{ not json', 'utf8')
    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((b) => b.kind === 'unreadable' && b.seq === 1)).toBe(true)
    expect(v.continuous).toBe(false)
  })

  it('carries no stack in the detail it reports', () => {
    // A stack holds the checkout directory.
    const dir = chainOf(1)
    writeFileSync(join(dir, bodyFiles(dir)[0] as string), '{ not json', 'utf8')
    const v = verifyChain(dir, defaultSnapshotIo)
    const detail = v.breaks.find((b) => b.kind === 'unreadable')
    expect(JSON.stringify(detail)).not.toContain('agent-eval-verify-')
  })
})

describe('a key that changed', () => {
  it('is named rather than left to empty an intersection', () => {
    const dir = freshDir()
    const a = build({ chain: { seq: 1, prev: { kind: 'genesis' } } })
    writeSnapshot({ snapshotDir: dir, snapshot: a.snapshot, sidecar: a.sidecar })
    const other = Buffer.alloc(KEY_BYTES, 6)
    const b = build({
      chain: { seq: 2, prev: { kind: 'linked', hash: a.snapshot.selfHash } },
      key: { epoch: 2, fingerprint: fingerprintOf(other) },
      writtenOn: '2026-08-24T12:00:00+09:00',
    })
    writeSnapshot({ snapshotDir: dir, snapshot: b.snapshot, sidecar: b.sidecar })

    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((x) => x.kind === 'key-epoch-change')).toBe(true)
  })

  it('names the worse case, where the epochs agree and the keys do not', () => {
    const dir = freshDir()
    const a = build({ chain: { seq: 1, prev: { kind: 'genesis' } } })
    writeSnapshot({ snapshotDir: dir, snapshot: a.snapshot, sidecar: a.sidecar })
    const other = Buffer.alloc(KEY_BYTES, 6)
    const b = build({
      chain: { seq: 2, prev: { kind: 'linked', hash: a.snapshot.selfHash } },
      key: { epoch: 1, fingerprint: fingerprintOf(other) },
      writtenOn: '2026-08-24T12:00:00+09:00',
    })
    writeSnapshot({ snapshotDir: dir, snapshot: b.snapshot, sidecar: b.sidecar })

    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((x) => x.kind === 'key-identity-conflict')).toBe(true)
  })
})

describe('a clock that ran backwards', () => {
  it('is recorded, never corrected', () => {
    // Silently correcting a clock is how a plausible wrong number gets made.
    const dir = freshDir()
    const a = build({ chain: { seq: 1, prev: { kind: 'genesis' } }, writtenOn: '2026-08-24T12:00:00+09:00' })
    writeSnapshot({ snapshotDir: dir, snapshot: a.snapshot, sidecar: a.sidecar })
    const b = build({
      chain: { seq: 2, prev: { kind: 'linked', hash: a.snapshot.selfHash } },
      writtenOn: '2026-08-20T12:00:00+09:00',
    })
    writeSnapshot({ snapshotDir: dir, snapshot: b.snapshot, sidecar: b.sidecar })

    const v = verifyChain(dir, defaultSnapshotIo)
    expect(v.breaks.some((x) => x.kind === 'clock-regression' && x.seq === 2)).toBe(true)
  })
})

describe('what it does not establish', () => {
  it('names each thing, so a report cannot imply otherwise', () => {
    // Not a disclaimer. A report wording a self-consistency claim as an
    // authenticity one is claiming more than the mechanism can carry.
    expect([...NOT_ESTABLISHED]).toEqual([
      'the-owner-rebuilding-it',
      'the-whole-store-being-deleted',
      'a-restore-from-backup',
      'figures-that-were-wrong-when-written',
    ])
  })

  it('cannot tell a rebuilt history from a real one', () => {
    // Demonstrated rather than asserted: a chain rebuilt from scratch verifies
    // exactly as clean as one that grew.
    const rebuilt = verifyChain(chainOf(3), defaultSnapshotIo)
    expect(rebuilt.continuous).toBe(true)
    expect(rebuilt.consecutiveTail).toBe(3)
  })
})
