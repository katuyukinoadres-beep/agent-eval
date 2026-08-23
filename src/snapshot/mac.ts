/**
 * Machine-local MACs for the values a snapshot has to compare across windows
 * without storing.
 *
 * Two hashing regimes live in this codebase and they want opposite things.
 * `hashProject` in `../run.ts` is unsalted on purpose, so the same project on
 * two machines hashes alike and cross-environment comparison is possible at
 * all. These MACs are keyed on purpose, so nothing here can be enumerated by
 * someone holding the file. Both are deliberate, and either one "fixed" to
 * match the other breaks something real — which is why the reason sits at each
 * site rather than in one place that only one of them will be read next to.
 *
 * What forced the change: the scanner's existing 8-hex digests are defended in
 * their own comments on the ground that the values `never leave this process`.
 * That defence is true today and stops being true the moment a snapshot is
 * written. An 8-hex unsalted digest over file extensions and command names is
 * a space small enough to enumerate.
 */

import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { hmac128, sha256, type Hmac128, type Sha256 } from './types.js'

/**
 * What a MAC is over.
 *
 * Separate subkeys per domain so that holding one domain's material tells you
 * nothing about another's, and so a value that appears in two roles does not
 * collide into one.
 */
export const MAC_DOMAINS = [
  'session',
  'sub-session',
  'project',
  'path',
  'command',
  'sig/e',
  'sig/p',
  'sig/h',
] as const

export type Domain = (typeof MAC_DOMAINS)[number]

/** Bytes of key material. 256 bits, which is the block the HKDF and HMAC both want. */
export const KEY_BYTES = 32

/** Hex characters of MAC kept. 128 bits is far past what equality over 1e5 members needs. */
const MAC_HEX = 32

const subkey = (master: Buffer, domain: Domain): Buffer =>
  Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `agent-eval/mac/1/${domain}`, KEY_BYTES))

/**
 * HMAC-SHA-256 under a per-domain subkey, truncated to 128 bits.
 *
 * HMAC rather than a salted SHA-256 because HMAC is specified to resist
 * length-extension; the values here are attacker-influenced in principle
 * (a command line, a file extension) and the cost of the stronger construction
 * is nil.
 */
export function mac(master: Buffer, domain: Domain, value: string): Hmac128 {
  const digest = createHmac('sha256', subkey(master, domain)).update(value, 'utf8').digest('hex')
  return hmac128(`h1:${digest.slice(0, MAC_HEX)}`)
}

/**
 * A signer bound to one key, so the key itself does not travel into the
 * collector.
 *
 * The reducer never holds the master key and never returns a plaintext tuple:
 * it is handed this function, calls it, and keeps the result. That is the whole
 * reason it is injected rather than imported.
 */
export type Signer = (domain: Domain, value: string) => Hmac128

export const signerFor = (master: Buffer): Signer => (domain, value) => mac(master, domain, value)

/**
 * The identity a consumer checks before intersecting two sets of MACs.
 *
 * Not the epoch. Delete the key file and the epoch counter together while the
 * snapshots survive, and a fresh key starts at epoch 1 again — two different
 * keys wearing one label. Sets keyed on the label would then intersect to
 * nothing, and an empty intersection reads as "no failure recurred", which is
 * the flattering direction and indistinguishable from a broken hasher.
 */
export const fingerprintOf = (master: Buffer): Sha256 => {
  const h = createHmac('sha256', Buffer.alloc(0))
  h.update('agent-eval/key-fp/1\n', 'utf8')
  h.update(master)
  return sha256(`sha256:${h.digest('hex')}`)
}

/** Fresh key material. Hex, newline-terminated, for a file that a human may look at. */
export const newKeyMaterial = (): string => `${randomBytes(KEY_BYTES).toString('hex')}\n`

/**
 * Parses key material, refusing anything that is not exactly one full key.
 *
 * A short key would still produce MACs, and they would still compare equal to
 * each other, so nothing downstream would notice that the store was protected
 * by sixteen bits.
 */
export function parseKey(text: string): Buffer {
  const hex = text.trim()
  if (!/^[0-9a-f]+$/.test(hex) || hex.length !== KEY_BYTES * 2) {
    throw new Error(`key material must be ${KEY_BYTES * 2} lowercase hex characters, got ${hex.length}`)
  }
  return Buffer.from(hex, 'hex')
}
