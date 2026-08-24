import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KEY_BYTES,
  MAC_DOMAINS,
  fingerprintOf,
  mac,
  newKeyMaterial,
  parseKey,
  signerFor,
} from '@/snapshot/mac.js'
import { defaultKeyIo, loadKey, mayIntersect, type KeyIo } from '@/snapshot/key.js'
import { ensureStateDir, defaultIo, keyFileFor } from '@/snapshot/stateDir.js'
import { SnapshotError, e4, day, hmac128, int, semver, sha256 } from '@/snapshot/types.js'

/**
 * Everything here exists because of one failure mode: a MAC set that cannot be
 * intersected with the previous window's produces an empty intersection, an
 * empty intersection reads as "no failure recurred", and that is a perfect
 * score. It is the spec's own named attack, reachable by accident, and it fails
 * in the flattering direction.
 */

const roots: string[] = []
const freshHome = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'agent-eval-key-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const SEP = String.fromCharCode(0)
const KEY_A = Buffer.alloc(KEY_BYTES, 1)
const KEY_B = Buffer.alloc(KEY_BYTES, 2)

describe('the MAC', () => {
  it('is stable for one key, domain and value', () => {
    expect(mac(KEY_A, 'path', '/x/a.ts')).toBe(mac(KEY_A, 'path', '/x/a.ts'))
  })

  it('separates domains, so a value in two roles does not collide into one', () => {
    expect(mac(KEY_A, 'path', 'same')).not.toBe(mac(KEY_A, 'command', 'same'))
  })

  it('separates keys', () => {
    expect(mac(KEY_A, 'path', 'x')).not.toBe(mac(KEY_B, 'path', 'x'))
  })

  it('carries nothing of the value', () => {
    const m = mac(KEY_A, 'command', 'node scripts/deploy.mjs')
    expect(m).not.toContain('deploy')
    expect(m).not.toContain('scripts')
    expect(m).not.toContain('node')
  })

  it('is 128 bits behind a prefix that says what it is', () => {
    expect(mac(KEY_A, 'path', 'x')).toMatch(/^h1:[0-9a-f]{32}$/)
  })

  it('covers every domain the snapshot needs', () => {
    for (const d of MAC_DOMAINS) expect(mac(KEY_A, d, 'x')).toMatch(/^h1:/)
  })

  it('gives a signer that never sees the key', () => {
    // The reducer is handed this and keeps only the result, so the plaintext
    // tuple never crosses the function boundary and the key never enters it.
    const sign = signerFor(KEY_A)
    expect(sign('sig/e', ['Bash', 'timeout', 'git'].join(SEP))).toBe(mac(KEY_A, 'sig/e', ['Bash', 'timeout', 'git'].join(SEP)))
  })
})

describe('key material', () => {
  it('is 32 bytes of hex', () => {
    const m = newKeyMaterial()
    expect(m.trim()).toHaveLength(KEY_BYTES * 2)
    expect(parseKey(m)).toHaveLength(KEY_BYTES)
  })

  it('refuses a short key rather than producing weaker MACs', () => {
    // A short key still produces MACs, and they still compare equal to each
    // other, so nothing downstream would notice a store protected by sixteen
    // bits.
    expect(() => parseKey('abcd\n')).toThrow()
    expect(() => parseKey('')).toThrow()
    expect(() => parseKey('X'.repeat(64))).toThrow()
  })

  it('is fingerprinted without being recoverable from the fingerprint', () => {
    const fp = fingerprintOf(KEY_A)
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(fp).not.toContain(KEY_A.toString('hex').slice(0, 8))
  })

  it('fingerprints differently for different keys', () => {
    expect(fingerprintOf(KEY_A)).not.toBe(fingerprintOf(KEY_B))
  })
})

describe('loading the key', () => {
  const io = (home: string, platform = 'linux'): KeyIo => ({ ...defaultKeyIo, platform: () => platform })

  it('generates one on first use and starts the epoch at 1', () => {
    const home = freshHome()
    const { stateDir } = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    const k = loadKey(home, stateDir, io(home))
    expect(k.generated).toBe(true)
    expect(k.ref.epoch).toBe(1)
  })

  it('reads the same key back, with the same fingerprint', () => {
    const home = freshHome()
    const { stateDir } = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    const first = loadKey(home, stateDir, io(home))
    const second = loadKey(home, stateDir, io(home))
    expect(second.generated).toBe(false)
    expect(second.ref.fingerprint).toBe(first.ref.fingerprint)
    expect(second.ref.epoch).toBe(first.ref.epoch)
  })

  it('records that owner-only mode could not be enforced on win32', () => {
    // Stated rather than asserted away: on win32 Node's mode sets the read-only
    // bit, so any process running as this user can read the key.
    const home = freshHome()
    const { stateDir } = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    expect(loadKey(home, stateDir, io(home, 'win32')).modeEnforced).toBe(false)
    expect(loadKey(home, stateDir, io(home, 'linux')).modeEnforced).toBe(true)
  })

  it('bumps the epoch when a lost key is regenerated', () => {
    const home = freshHome()
    const { stateDir } = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    const first = loadKey(home, stateDir, io(home))
    rmSync(keyFileFor(home))
    const second = loadKey(home, stateDir, io(home))
    expect(second.generated).toBe(true)
    expect(second.ref.epoch).toBe(first.ref.epoch + 1)
    expect(second.ref.fingerprint).not.toBe(first.ref.fingerprint)
  })

  it('refuses a corrupt key file rather than hashing under something else', () => {
    const home = freshHome()
    const { stateDir } = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    loadKey(home, stateDir, io(home))
    writeFileSync(keyFileFor(home), 'not a key\n')
    expect(() => loadKey(home, stateDir, io(home))).toThrow()
  })
})

describe('refusing to intersect across keys', () => {
  it('allows it when the fingerprints agree', () => {
    const fp = fingerprintOf(KEY_A)
    expect(mayIntersect({ epoch: 1, fingerprint: fp }, { epoch: 2, fingerprint: fp })).toBeNull()
  })

  it('names an epoch change rather than returning an empty set', () => {
    // An empty intersection is what a broken hasher produces, and what an
    // environment that repeated no mistakes produces. Naming the refusal turns
    // a silent zero into a stated gap.
    expect(
      mayIntersect(
        { epoch: 1, fingerprint: fingerprintOf(KEY_A) },
        { epoch: 2, fingerprint: fingerprintOf(KEY_B) },
      ),
    ).toBe('key-epoch-change')
  })

  it('names the worse case, where the labels agree and the keys do not', () => {
    // Delete the key and its epoch counter while the snapshots survive, and a
    // fresh key gets epoch 1 again. Keying the refusal on the epoch alone would
    // pass this straight through.
    expect(
      mayIntersect(
        { epoch: 1, fingerprint: fingerprintOf(KEY_A) },
        { epoch: 1, fingerprint: fingerprintOf(KEY_B) },
      ),
    ).toBe('key-identity-conflict')
  })
})

describe('the branded leaves', () => {
  it('refuse what does not match, rather than describing the shape in a comment', () => {
    expect(() => hmac128('not-a-mac')).toThrow(SnapshotError)
    expect(() => sha256('sha256:short')).toThrow(SnapshotError)
    expect(() => day('2026-8-1')).toThrow(SnapshotError)
    expect(() => semver('1.0')).toThrow(SnapshotError)
  })

  it('accept what does', () => {
    // The positive control: every refusal above needs a matching acceptance or
    // it only proves the constructor throws.
    expect(hmac128(`h1:${'a'.repeat(32)}`)).toBeTruthy()
    expect(sha256(`sha256:${'a'.repeat(64)}`)).toBeTruthy()
    expect(day('2026-08-23')).toBe('2026-08-23')
    expect(semver('0.0.0')).toBe('0.0.0')
  })

  it('normalise negative zero, which is a second spelling of a value', () => {
    expect(Object.is(e4(-0.00004), 0)).toBe(true)
  })

  it('refuse a scaled value past the safe integer range', () => {
    // The limit is 2^53 / 1e4, about 9.007e11. The design note justified this
    // guard with bytesRead at 1e9, but 1e9 scaled is 1e13 against a 2^53 of
    // 9.007e15 -- the arithmetic was wrong and this test is what showed it.
    //
    // What the guard is actually worth: every field that legitimately takes
    // this scale is a ratio or a 0-100 score, so a value this large is a raw
    // count that reached the wrong constructor.
    expect(() => e4(1e12)).toThrow(SnapshotError)
    expect(e4(1e9)).toBe(1e13)
    expect(e4(1.2345)).toBe(12_345)
  })

  it('refuse a count that is not a whole number', () => {
    expect(() => int(1.5)).toThrow(SnapshotError)
    expect(int(42)).toBe(42)
  })
})
