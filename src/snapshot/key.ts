/**
 * The master key, and the epoch that labels it.
 *
 * The documents pull in two directions here and both pulls are real.
 *
 * A key that changes per run destroys the product. Axis 6's cross-window
 * recurrence is a set intersection over MACs: re-key and the intersection is
 * empty, recurrence reads as zero, and the environment scores a perfect
 * never-repeats-a-mistake. That is the spec's own named attack, reached by
 * accident, and it fails in the flattering direction.
 *
 * A key that never changes is a permanent secret whose compromise makes every
 * stored MAC enumerable over a small preimage space.
 *
 * The resolution is not a rotation schedule. Rotation would need the
 * plaintexts, and the plaintexts are discarded by construction, so a new key
 * cannot carry old sets forward — every pre-rotation window becomes permanently
 * incomparable with every post-rotation one. Nobody will pay that. The key is
 * write-once for the life of the store, its compromise is retroactive and
 * total, and the two things that actually bound the damage are that it lives
 * outside the store and that the sets it protects age out.
 *
 * The epoch and fingerprint stay for the disaster case — key file lost — where
 * they turn a silent empty intersection into a stated gap.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprintOf, newKeyMaterial, parseKey } from './mac.js'
import { keyFileFor } from './stateDir.js'
import type { Sha256 } from './types.js'

export const EPOCH_FILE_NAME = 'key.epoch'

/** POSIX only. On win32 Node's mode sets the read-only bit and is not a confidentiality control. */
export const KEY_FILE_MODE = 0o600

export interface KeyIo {
  readonly exists: (path: string) => boolean
  readonly readFile: (path: string) => string
  readonly writeFile: (path: string, body: string, mode?: number) => void
  readonly platform: () => string
}

export const defaultKeyIo: KeyIo = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, body, mode) =>
    writeFileSync(p, body, mode === undefined ? 'utf8' : { encoding: 'utf8', mode }),
  platform: () => process.platform,
}

export interface KeyRef {
  readonly epoch: number
  readonly fingerprint: Sha256
}

export interface LoadedKey {
  readonly master: Buffer
  readonly ref: KeyRef
  /** True when this run generated the key rather than reading one. */
  readonly generated: boolean
  /**
   * True when the file could not be given owner-only permissions.
   *
   * Recorded rather than asserted away. On win32 any process running as this
   * user can read the key, and that residual belongs in the open where someone
   * can weigh it.
   */
  readonly modeEnforced: boolean
}

const readEpoch = (path: string, io: KeyIo): number => {
  if (!io.exists(path)) return 0
  const n = Number.parseInt(io.readFile(path).trim(), 10)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/**
 * Loads the key, generating one on first use.
 *
 * Generation bumps the epoch, so a key file that was lost and recreated is
 * distinguishable from the original — but only by the fingerprint. The epoch on
 * its own is a label that resets to 1 if the counter is lost alongside the key,
 * which is exactly the case where two different keys would otherwise share it.
 */
export function loadKey(home: string, stateDir: string, io: KeyIo = defaultKeyIo): LoadedKey {
  const keyPath = keyFileFor(home)
  const epochPath = join(stateDir, EPOCH_FILE_NAME)

  if (io.exists(keyPath)) {
    const master = parseKey(io.readFile(keyPath))
    const epoch = Math.max(1, readEpoch(epochPath, io))
    return {
      master,
      ref: { epoch, fingerprint: fingerprintOf(master) },
      generated: false,
      modeEnforced: io.platform() !== 'win32',
    }
  }

  const material = newKeyMaterial()
  io.writeFile(keyPath, material, KEY_FILE_MODE)
  const epoch = readEpoch(epochPath, io) + 1
  io.writeFile(epochPath, `${epoch}\n`)
  const master = parseKey(material)
  return {
    master,
    ref: { epoch, fingerprint: fingerprintOf(master) },
    generated: true,
    modeEnforced: io.platform() !== 'win32',
  }
}

export type IntersectRefusal = 'key-epoch-change' | 'key-identity-conflict'

/**
 * Whether two snapshots' MAC sets may be compared, and if not, why.
 *
 * A consumer that intersected across keys would get an empty set, and an empty
 * intersection is indistinguishable from a broken hasher and from an
 * environment that repeated no mistakes. Refusing by name converts that silent
 * zero into a stated gap.
 *
 * `key-identity-conflict` is the worse of the two: the epochs agree, so nothing
 * looks wrong, and the fingerprints do not.
 */
export function mayIntersect(a: KeyRef, b: KeyRef): IntersectRefusal | null {
  if (a.fingerprint === b.fingerprint) return null
  return a.epoch === b.epoch ? 'key-identity-conflict' : 'key-epoch-change'
}
