import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AXIS_CONSTANTS, buildSnapshot, WASTED_MOTION_CONSTANTS, type BuildInputs } from '@/snapshot/build.js'
import { defaultSnapshotIo, listSnapshots, readHead, writeSnapshot } from '@/snapshot/write.js'
import { bodyHash, canonical } from '@/snapshot/canonical.js'
import { IdentityViolation, SCORED_AXES, formulaFingerprint } from '@/snapshot/record.js'
import { KEY_BYTES, fingerprintOf, signerFor } from '@/snapshot/mac.js'
import { sha256 } from '@/snapshot/types.js'
import { BASE_PAYLOAD } from '@/payload/base.js'
import { COUNT_BASIS } from '@/payload/assemble.js'

/**
 * A snapshot is the only thing a later window can compare against, because the
 * raw logs are pruned. So two properties matter more than any other: a
 * half-written one must never be readable, and a value that was not recorded
 * must not read as a value that was measured to be zero.
 */

const dirs: string[] = []
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agent-eval-snap-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const KEY = Buffer.alloc(KEY_BYTES, 3)
const SIGN = signerFor(KEY)

const counts = {
  linesRead: 100, linesParseFailed: 0, filesUnreadable: 0, filesWithoutRows: 0, bytesRead: 5_000, mainLines: 60, subLines: 40,
  toolResultTotal: 300, toolUseTotal: 300, toolUseFiltered: 300, toolResultWithIsErrorKey: 200, toolResultIsErrorTrue: 10,
  attributionSkillRows: 4, attributionSkillDistinct: 2, mcpServerDistinct: 1,
  userRows: 20, originBearingUserRows: 2, humanTurns: 6, originHumanRows: 2,
  notHumanCounts: {}, denialRows: 2, denialUserRejected: 1, denialKinds: {},
  editedFilesDistinct: 3, editedFilesRepeated: 1,
  stopHookSummaryRows: 2, hookErrorsNonEmpty: 1, sessionIdMismatchRows: 0,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
  toolVersions: { '2.1.233': 100 },
  sessionIds: ['s1', 's2'],
  dates: ['2026-08-19', '2026-08-20'],
  userRowDates: ['2026-08-19', '2026-08-20'],
  humanTurnDates: ['2026-08-19'], humanTurnDatesUtc: [],
  perProject: {},
  perSession: {
    s1: { intervals: 6, bundles: 3, failures: 2, writeRepeats: 1, investigationRepeats: 0, timedOut: 0, largeOutput: 0, errors: 2, lines: 60 },
    s2: { intervals: 4, bundles: 2, failures: 1, writeRepeats: 0, investigationRepeats: 1, timedOut: 0, largeOutput: 0, errors: 1, lines: 40 },
  },
  signatures: [SIGN('sig/e', 'a'), SIGN('sig/e', 'b')],
  signaturesRepeated: [],
  signaturesSigned: true,
  taskBundles: 5, rootBundles: 0, orphanBundles: 0, toolActivityRows: 50,
  environmentNoiseRows: 0, editedPaths: {}, lastMention: () => null, lastMentionIn: () => null,
  mentionedElsewhereAfter: () => false, ambiguousBasenames: 0, referenceTokens: 0,
  errorRepeats: { errors: 3, distinctSignatures: 2, rIn: 0.33, byFamily: { timeout: 3 } },
  metabolism: {
    skillsListed: [], listingChars: 0, listingTruncated: false,
    skillFirings: {}, hookFirings: {}, mcpFirings: {}, effectiveInputPerCall: [], peakInputPerBundle: [], effectiveInputPerBundle: [], inputPerBundleWithoutCache: [],
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

const inputs = (over: Partial<BuildInputs> = {}): BuildInputs =>
  ({
    counts,
    axes: BASE_PAYLOAD.axes,
    gate: { availability: 'available', reasons: [], totalAllowed: true },
    countBasis: COUNT_BASIS,
    chain: { seq: 1, prev: { kind: 'genesis' } },
    key: { epoch: 1, fingerprint: fingerprintOf(KEY) },
    toolVersion: '0.0.0',
    os: 'linux',
    writtenOn: '2026-08-23T12:00:00+09:00',
    filesRead: 2,
    payloadDigest: null,
    sign: SIGN,
    ...over,
  }) as unknown as BuildInputs

describe('what a snapshot records', () => {
  it('carries every scored axis from the first window', () => {
    // An axis that appears later with no history is an axis whose first window
    // can never be compared to anything.
    const { snapshot } = buildSnapshot(inputs())
    for (const k of SCORED_AXES) expect(snapshot.axes[k], k).toBeDefined()
  })

  it('says an unimplemented axis is unimplemented, not zero', () => {
    const { snapshot } = buildSnapshot(inputs())
    const a = snapshot.axes.selfVerification
    expect(a.state).toBe('not-implemented')
    expect(a.scoreE4).toBeNull()
    expect(a.numeratorE4).toBeNull()
  })

  it('names the blocks it did not build', () => {
    // A reader has to be able to tell "this environment had none" from "this
    // version did not look".
    const { snapshot } = buildSnapshot(inputs())
    const absent = snapshot.completeness.blocksAbsent.map((b) => b.block)
    expect(absent).toContain('artifacts')
    expect(absent).toContain('commands')
  })

  it('records the day, not the instant', () => {
    // Two hundred timestamps to the second is a record of when someone works.
    const { snapshot } = buildSnapshot(inputs())
    expect(snapshot.builder.writtenOn).toBe('2026-08-23')
  })

  it('names the axis set the completeness flags were judged over', () => {
    const { snapshot } = buildSnapshot(inputs())
    expect(snapshot.completeness.evaluatedOver).toEqual(SCORED_AXES)
    expect(snapshot.completeness.schemaComplete).toBe(false)
  })

  it('keeps the composite, because nothing else does', () => {
    // It was stored nowhere and read back as a hardcoded null, so the composite
    // delta -- the number the product exists to produce -- was structurally
    // null on every run a comparison could ever make.
    const { snapshot } = buildSnapshot({ ...inputs(), compositeE4: 543_100 })
    expect(snapshot.compositeE4).toBe(543_100)
    expect(snapshot.completeness.compositeComparable).toBe(true)
  })

  it('says so when there was no composite to keep', () => {
    const { snapshot } = buildSnapshot({ ...inputs(), compositeE4: null })
    expect(snapshot.compositeE4).toBeNull()
    expect(snapshot.completeness.compositeComparable).toBe(false)
  })
})

describe('the formula fingerprint', () => {
  it('changes when a constant that moves the score changes', () => {
    // The version strings cannot do this job: both are literals with one
    // possible value. W_REF is what actually moves axis 2's number.
    const a = formulaFingerprint('wastedMotion', WASTED_MOTION_CONSTANTS)
    const b = formulaFingerprint('wastedMotion', { ...WASTED_MOTION_CONSTANTS, wRefE4: 40_000 })
    expect(a).not.toBe(b)
  })

  it('does not change when the constants are written in another order', () => {
    const reordered = Object.fromEntries(Object.entries(WASTED_MOTION_CONSTANTS).reverse())
    expect(formulaFingerprint('wastedMotion', reordered)).toBe(
      formulaFingerprint('wastedMotion', WASTED_MOTION_CONSTANTS),
    )
  })

  it('covers every axis that has a formula, not only the first one built', () => {
    // An axis with a measured score and a null fingerprint is one whose
    // definition can change between windows with nothing to say it did -- the
    // failure the fingerprint exists to stop, reintroduced per axis.
    for (const key of ['wastedMotion', 'selfVerification', 'artifactUptake', 'environmentMetabolism', 'recurrencePrevention']) {
      expect(AXIS_CONSTANTS[key], key).toBeDefined()
      expect(Object.keys(AXIS_CONSTANTS[key] ?? {}).length, key).toBeGreaterThan(0)
    }
  })

  it('holds only integers, so the canonical form accepts every entry', () => {
    for (const [axis, constants] of Object.entries(AXIS_CONSTANTS)) {
      for (const [name, value] of Object.entries(constants)) {
        expect(Number.isInteger(value), `${axis}.${name} = ${value}`).toBe(true)
      }
    }
  })

  it('differs between axes holding the same constants', () => {
    expect(formulaFingerprint('wastedMotion', { a: 1 })).not.toBe(
      formulaFingerprint('selfVerification', { a: 1 }),
    )
  })

  it('is built from scaled integers, because the constants are fractions', () => {
    // The first record built refused on weightInvestigationRepeat: 0.2, which
    // is exactly what the E4 scale exists for.
    for (const [k, v] of Object.entries(WASTED_MOTION_CONSTANTS)) {
      if (typeof v === 'number' && !Number.isInteger(v)) {
        throw new Error(`${k} is not an integer: ${v}`)
      }
    }
    expect(() => canonical(WASTED_MOTION_CONSTANTS)).not.toThrow()
  })
})

describe('the identities', () => {
  it('hold for a coherent record', () => {
    const { snapshot } = buildSnapshot(inputs())
    expect(snapshot.identities.map((i) => i.name)).toContain('lines-close')
    for (const i of snapshot.identities) expect(i.holds).toBe(true)
  })

  it('refuse a record whose lines do not close', () => {
    // An internally inconsistent snapshot is worse than none: it will be
    // compared against later.
    expect(() =>
      buildSnapshot(inputs({ counts: { ...counts, linesRead: 999 } } as Partial<BuildInputs>)),
    ).toThrow(IdentityViolation)
  })

  it('refuse a record whose sessions do not close against the bundle count', () => {
    expect(() =>
      buildSnapshot(inputs({ counts: { ...counts, taskBundles: 99 } } as Partial<BuildInputs>)),
    ).toThrow(IdentityViolation)
  })

  it('refuse more human-turn days than user-row days', () => {
    expect(() =>
      buildSnapshot(
        inputs({ counts: { ...counts, humanTurnDates: ['a', 'b', 'c'] } } as Partial<BuildInputs>),
      ),
    ).toThrow(IdentityViolation)
  })
})

describe('privacy', () => {
  it('carries no session id, only a MAC of one', () => {
    const { snapshot } = buildSnapshot(inputs())
    const blob = JSON.stringify(snapshot)
    expect(blob).not.toContain('"s1"')
    expect(blob).not.toContain('"s2"')
    expect(snapshot.sessions).toHaveLength(2)
    for (const s of snapshot.sessions) expect(s.id).toMatch(/^h1:/)
  })

  it('orders sessions by the MAC, not by the id', () => {
    // Ordering by the plaintext id leaks the ids' relative order into a file
    // that is meant not to carry them.
    const { snapshot } = buildSnapshot(inputs())
    const ids = snapshot.sessions.map((s) => s.id)
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('writing', () => {
  const write = (dir: string, over: Partial<BuildInputs> = {}) => {
    const built = buildSnapshot(inputs(over))
    return {
      built,
      outcome: writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar }),
    }
  }

  it('writes a body, a sidecar and a head', () => {
    const dir = freshDir()
    const { outcome } = write(dir)
    expect(outcome.kind).toBe('written')
    const files = readdirSync(dir)
    expect(files.some((f) => /^\d{6}-[0-9a-f]{12}\.json$/.test(f))).toBe(true)
    expect(files.some((f) => f.endsWith('.sig.json'))).toBe(true)
    expect(files).toContain('HEAD.json')
  })

  it('leaves nothing under a temporary name', () => {
    // A torn file only ever exists as tmp-, which nothing references.
    const dir = freshDir()
    write(dir)
    expect(readdirSync(dir).filter((f) => f.startsWith('tmp-'))).toEqual([])
  })

  it('carries no path in its outcome', () => {
    // A path holds the OS username, and run output gets pasted into issues.
    const dir = freshDir()
    const { outcome } = write(dir)
    expect(JSON.stringify(outcome)).not.toContain('agent-eval-snap-')
  })

  it('refuses rather than overwriting an existing sequence', () => {
    // A snapshot is immutable.
    const dir = freshDir()
    write(dir)
    const again = write(dir)
    expect(again.outcome.kind).toBe('refused')
    if (again.outcome.kind === 'refused') expect(again.outcome.reason).toBe('name-taken')
  })

  it('refuses while another live run holds the lock', () => {
    const dir = freshDir()
    writeFileSync(join(dir, '.lock'), `${process.pid}\n`)
    const built = buildSnapshot(inputs())
    const outcome = writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.reason).toBe('locked')
  })

  it('steals a lock from a process that is gone', () => {
    // Otherwise one crash disables snapshots permanently.
    const dir = freshDir()
    writeFileSync(join(dir, '.lock'), '999999\n')
    const built = buildSnapshot(inputs())
    const outcome = writeSnapshot(
      { snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar },
      { ...defaultSnapshotIo, pidAlive: () => false },
    )
    expect(outcome.kind).toBe('written')
  })

  it('never throws into its caller', () => {
    // The payload must still come out on a day the store cannot be written.
    const built = buildSnapshot(inputs())
    const outcome = writeSnapshot(
      { snapshotDir: freshDir(), snapshot: built.snapshot, sidecar: built.sidecar },
      { ...defaultSnapshotIo, rename: () => { throw new Error('EPERM') } },
    )
    expect(outcome.kind).toBe('refused')
  })
})

describe('reading the chain back', () => {
  it('reports genesis for an empty store', () => {
    const head = readHead(freshDir(), defaultSnapshotIo)
    expect(head.prev).toEqual({ kind: 'genesis' })
    expect(head.seq).toBe(1)
  })

  it('links to a snapshot whose hash recomputes', () => {
    const dir = freshDir()
    const built = buildSnapshot(inputs())
    writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar })
    const head = readHead(dir, defaultSnapshotIo)
    expect(head.prev).toEqual({ kind: 'linked', hash: built.snapshot.selfHash })
    expect(head.seq).toBe(2)
  })

  it('recomputes the hash rather than trusting the stored one', () => {
    // A stored hash that is trusted is a hash that can be edited to match an
    // edited body.
    const dir = freshDir()
    const built = buildSnapshot(inputs())
    writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar })
    const file = readdirSync(dir).find((f) => /^\d{6}-/.test(f)) as string
    const body = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
    // Edit a figure and rewrite the stored hash to match the edit's own hash --
    // the forgery someone would actually attempt.
    ;(body['scan'] as Record<string, unknown>)['linesRead'] = 999_999
    const { selfHash: _drop, ...rest } = body
    writeFileSync(join(dir, file), canonical({ ...rest, selfHash: bodyHash(rest) }), 'utf8')
    const head = readHead(dir, defaultSnapshotIo)
    // The hash matches its own body, so this is not detected here -- it is
    // detected by the child's prev.hash, which is the property the chain has.
    expect(head.prev).toEqual({ kind: 'linked', hash: bodyHash(rest) })
    expect(head.prev).not.toEqual({ kind: 'linked', hash: built.snapshot.selfHash })
  })

  it('reports a break rather than a fresh chain when a body is corrupt', () => {
    // Genesis and a lost history mean opposite things and must not spell alike.
    const dir = freshDir()
    const built = buildSnapshot(inputs())
    writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar })
    const file = readdirSync(dir).find((f) => /^\d{6}-/.test(f)) as string
    writeFileSync(join(dir, file), '{ not json', 'utf8')
    const head = readHead(dir, defaultSnapshotIo)
    expect(head.prev).toMatchObject({ kind: 'broken', why: 'file-unreadable' })
  })

  it('reports a hash mismatch when a body was edited without rehashing', () => {
    const dir = freshDir()
    const built = buildSnapshot(inputs())
    writeSnapshot({ snapshotDir: dir, snapshot: built.snapshot, sidecar: built.sidecar })
    const file = readdirSync(dir).find((f) => /^\d{6}-/.test(f)) as string
    const body = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
    ;(body['scan'] as Record<string, unknown>)['linesRead'] = 12
    writeFileSync(join(dir, file), canonical(body), 'utf8')
    const head = readHead(dir, defaultSnapshotIo)
    expect(head.prev).toMatchObject({ kind: 'broken', why: 'hash-mismatch' })
  })

  it('lists snapshots in sequence order', () => {
    const dir = freshDir()
    writeSnapshot({
      snapshotDir: dir,
      ...(() => {
        const b = buildSnapshot(inputs())
        return { snapshot: b.snapshot, sidecar: b.sidecar }
      })(),
    })
    expect(listSnapshots(dir, defaultSnapshotIo).map((s) => s.seq)).toEqual([1])
  })
})

describe('the hash covers what it should', () => {
  it('changes when the previous link changes', () => {
    // prev is inside the hashed body, so a chain hash cannot be edited without
    // changing the child's own hash. There is no separate concatenation step to
    // get wrong.
    const a = buildSnapshot(inputs()).snapshot.selfHash
    const b = buildSnapshot(
      inputs({ chain: { seq: 1, prev: { kind: 'linked', hash: sha256(`sha256:${'a'.repeat(64)}`) } } }),
    ).snapshot.selfHash
    expect(a).not.toBe(b)
  })

  it('changes when the key changes', () => {
    const other = Buffer.alloc(KEY_BYTES, 9)
    const a = buildSnapshot(inputs()).snapshot.selfHash
    const b = buildSnapshot(inputs({ key: { epoch: 1, fingerprint: fingerprintOf(other) } })).snapshot.selfHash
    expect(a).not.toBe(b)
  })

  it('is stable for the same inputs', () => {
    expect(buildSnapshot(inputs()).snapshot.selfHash).toBe(buildSnapshot(inputs()).snapshot.selfHash)
  })
})
