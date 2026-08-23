/**
 * The leaves a snapshot is built from.
 *
 * A snapshot is the one thing this tool writes that cannot be recomputed: the
 * raw logs are pruned by `cleanupPeriodDays`, so a value recorded wrongly today
 * is wrong for as long as the file survives, and a value not recorded is gone.
 * Everything here is validated at construction rather than described in a
 * comment — a comment does not stop `'not-a-hash' as Sha256` from compiling.
 */

declare const brand: unique symbol

/** First 128 bits of an HMAC-SHA-256, prefixed. Compared for equality, never inverted. */
export type Hmac128 = string & { readonly [brand]: 'Hmac128' }
export type Sha256 = string & { readonly [brand]: 'Sha256' }
export type Day = string & { readonly [brand]: 'Day' }
export type SemVer = string & { readonly [brand]: 'SemVer' }

/**
 * A number scaled by 10,000 and rounded to an integer.
 *
 * Only ever on a field whose name ends `E4`, so the scale travels with the
 * value. A scale factor documented only in a type comment is how a minimum
 * denominator of 200 comes to be compared against 2,000,000.
 */
export type E4 = number & { readonly [brand]: 'E4' }

export class SnapshotError extends Error {}

const HMAC128 = /^h1:[0-9a-f]{32}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const SEMVER = /^\d+\.\d+\.\d+$/

export const hmac128 = (s: string): Hmac128 => {
  if (!HMAC128.test(s)) throw new SnapshotError(`not an h1 mac: ${JSON.stringify(s)}`)
  return s as Hmac128
}

export const sha256 = (s: string): Sha256 => {
  if (!SHA256.test(s)) throw new SnapshotError(`not a sha256: ${JSON.stringify(s)}`)
  return s as Sha256
}

/**
 * A calendar day, not an instant.
 *
 * A chain of two hundred timestamps is a record of when someone works, to the
 * second. The day is enough to order snapshots and to say how far apart two
 * windows are.
 */
export const day = (s: string): Day => {
  if (!DAY.test(s)) throw new SnapshotError(`not a YYYY-MM-DD day: ${JSON.stringify(s)}`)
  return s as Day
}

export const semver = (s: string): SemVer => {
  if (!SEMVER.test(s)) throw new SnapshotError(`not a semver: ${JSON.stringify(s)}`)
  return s as SemVer
}

/**
 * Scales by 10,000 and rounds to a safe integer.
 *
 * `+ 0` normalises negative zero, which `Math.round(-0.00004 * 1e4)` produces
 * and which serialises as `-0` — a second spelling of a value the canonical
 * form must have exactly one of.
 *
 * The safe-integer check bites above 2^53 / 1e4, which is about 9.007e11. The
 * design note that produced this module justified it with `bytesRead`, which
 * reaches 1e9 here — but 1e9 scaled by 1e4 is 1e13, and 2^53 is 9.007e15, so
 * that value is nowhere near the limit and the arithmetic was wrong.
 *
 * The check stays, for a smaller reason honestly stated: every field that
 * legitimately takes this scale is a ratio or a 0-100 score, so anything
 * arriving here above 9e11 is a raw count that reached the wrong constructor.
 * `int` is what a count wants. An imprecise integer is still an integer, so
 * nothing downstream would notice the difference.
 */
export const e4 = (x: number): E4 => {
  if (!Number.isFinite(x)) throw new SnapshotError(`non-finite value: ${x}`)
  const n = Math.round(x * 10_000) + 0
  if (!Number.isSafeInteger(n)) throw new SnapshotError(`E4 out of safe integer range: ${x}`)
  return n as E4
}

/** A plain count. Integers only, never scaled. */
export const int = (x: number): number => {
  if (!Number.isSafeInteger(x)) throw new SnapshotError(`not a safe integer: ${x}`)
  return x
}

/** The day part of an ISO 8601 instant, or null if it does not carry one. */
export const dayOf = (iso: string): Day | null => {
  const head = iso.slice(0, 10)
  return DAY.test(head) ? (head as Day) : null
}
