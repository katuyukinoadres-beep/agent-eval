/**
 * One byte sequence per value, so two runs over identical data produce one hash.
 *
 * `JSON.stringify` does not give this. It emits object keys in insertion order,
 * so the same record built by two code paths hashes differently; and it emits
 * `1e+21` for large numbers and `-0` for negative zero, so a value has two
 * spellings. Either would break a chain that exists to say "this has not
 * changed", by reporting a change that did not happen.
 *
 * Numbers are safe integers and nothing else. Floats are the part of JSON that
 * differs across runtimes, and a chain whose hash depends on the printer is not
 * a chain. Anything fractional is scaled by `e4` before it gets here, and the
 * serialiser is the runtime half of that rule — the type says `E4` and this
 * throws if something else arrives.
 */

import { createHash } from 'node:crypto'
import { SnapshotError, sha256, type Sha256 } from './types.js'

/**
 * Characters below 0x20 have no literal form, and these four have shorter
 * escapes than `\u00XX`. Everything else at or above 0x20 is emitted as itself,
 * including every non-ASCII code point: escaping those would make the byte
 * sequence depend on a choice nothing else here makes.
 */
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const FIRST_PRINTABLE = 0x20

/**
 * True when the string holds anything that cannot be emitted literally.
 *
 * A scan over code units rather than a regex, on purpose. The regex that stood
 * here looked right and was not: the backslash escaped the closing bracket, so
 * the first character class held a quote, a bracket, a pipe and an opening
 * bracket, and matched no backslash at all. A string containing one took the
 * fast path and was emitted unescaped -- invalid JSON, and a hash for a value
 * that never existed.
 *
 * It was found by evaluating the line out of the source and testing it case by
 * case, not by reading it. Character classes are exactly where reading fails.
 */
function needsEscape(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < FIRST_PRINTABLE || c === QUOTE || c === BACKSLASH) return true
  }
  return false
}

export function canonicalString(s: string): string {
  if (!needsEscape(s)) return `"${s}"`
  let out = '"'
  for (const ch of s) {
    const known = ESCAPES[ch]
    if (known !== undefined) {
      out += known
    } else if (ch.charCodeAt(0) < FIRST_PRINTABLE) {
      out += `${String.fromCharCode(92)}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return `${out}"`
}

export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw new SnapshotError(`non-finite number in a snapshot: ${n}`)
  if (!Number.isInteger(n)) {
    throw new SnapshotError(
      `non-integer in a snapshot: ${n}. Scale it with e4() and name the field with an E4 suffix.`,
    )
  }
  if (!Number.isSafeInteger(n)) throw new SnapshotError(`integer past the safe range: ${n}`)
  // Object.is separates -0 from 0. `-0` and `0` are one value with two
  // spellings, and a hash must not depend on which one a caller produced.
  return Object.is(n, -0) ? '0' : String(n)
}

/**
 * Canonical JSON.
 *
 * `undefined` and an absent key are the same thing and neither is emitted, so a
 * record that sets a field to `undefined` hashes like one that omits it. A
 * function or a symbol is a programming error rather than data, and throws.
 */
export function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return canonicalNumber(value)
  if (typeof value === 'string') return canonicalString(value)
  if (typeof value === 'bigint') throw new SnapshotError('bigint in a snapshot')
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SnapshotError(`${typeof value} in a snapshot`)
  }

  if (Array.isArray(value)) {
    // Given order. Every array in the record has a stated total order, decided
    // where it is built: unordered iteration is how two runs over identical
    // data produce two hashes.
    return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Sorted by UTF-16 code unit, which is what String.prototype.localeCompare
    // is not: locale-aware ordering differs by machine.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${keys.map((k) => `${canonicalString(k)}:${canonical(obj[k])}`).join(',')}}`
  }

  throw new SnapshotError(`unserialisable value in a snapshot: ${typeof value}`)
}

/**
 * Domains, so a hash computed here can never equal one this codebase computes
 * for something else.
 *
 * Project ids, error digests and input keys are all sha256 over
 * attacker-influenceable text. Without a prefix, someone who can shape one
 * input space could manufacture a value that validates in another.
 */
export const SNAPSHOT_DOMAIN = 'agent-eval/snapshot/1\n'
export const SIDECAR_DOMAIN = 'agent-eval/sidecar/1\n'

export function digestOf(domain: string, value: unknown): Sha256 {
  const h = createHash('sha256')
  h.update(domain, 'utf8')
  h.update(canonical(value), 'utf8')
  return sha256(`sha256:${h.digest('hex')}`)
}

/** The hash of a snapshot body. `selfHash` is not part of what it covers. */
export const bodyHash = (body: unknown): Sha256 => digestOf(SNAPSHOT_DOMAIN, body)

export const sidecarHash = (sidecar: unknown): Sha256 => digestOf(SIDECAR_DOMAIN, sidecar)
