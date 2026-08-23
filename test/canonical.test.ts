import { describe, expect, it } from 'vitest'
import {
  SIDECAR_DOMAIN,
  SNAPSHOT_DOMAIN,
  bodyHash,
  canonical,
  canonicalNumber,
  canonicalString,
  sidecarHash,
} from '@/snapshot/canonical.js'
import { SnapshotError } from '@/snapshot/types.js'

/**
 * A chain exists to say "this has not changed". Anything that gives one value
 * two byte sequences makes it say the opposite, about a change that never
 * happened.
 *
 * The escaping half of this was written twice. The first version tested for
 * characters needing escapes with a regex whose backslash escaped a closing
 * bracket instead of matching itself, so a string containing a backslash took
 * the fast path and came out unescaped: invalid JSON, hashed. It was found by
 * evaluating the line out of the source and running it case by case. The tests
 * below do the same thing, which is why they check output bytes rather than
 * that a function was called.
 */

const BACKSLASH = String.fromCharCode(92)
const NUL = String.fromCharCode(0)
const NEWLINE = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

describe('strings', () => {
  it('leaves ordinary text alone', () => {
    expect(canonicalString('abc')).toBe('"abc"')
  })

  it('escapes a backslash, which the first version silently did not', () => {
    // The whole reason the regex is gone. `a\b` emitted raw is not JSON, and
    // it hashes to a value for a string that was never written.
    expect(canonicalString(`a${BACKSLASH}b`)).toBe(`"a${BACKSLASH}${BACKSLASH}b"`)
  })

  it('escapes a quote', () => {
    expect(canonicalString('a"b')).toBe(`"a${BACKSLASH}"b"`)
  })

  it('escapes the control characters that have short forms', () => {
    expect(canonicalString(`a${NEWLINE}b`)).toBe(`"a${BACKSLASH}nb"`)
    expect(canonicalString(`a${TAB}b`)).toBe(`"a${BACKSLASH}tb"`)
  })

  it('escapes the rest as a single-backslash unicode escape', () => {
    // One backslash, not two. Two is a backslash followed by a `u`, which is a
    // different string.
    expect(canonicalString(`a${NUL}b`)).toBe(`"a${BACKSLASH}u0000b"`)
    expect(canonicalString(String.fromCharCode(0x1f))).toBe(`"${BACKSLASH}u001fb"`.replace('b', ''))
  })

  it('emits non-ASCII literally', () => {
    // Escaping these would make the bytes depend on a choice nothing else here
    // makes, and both spellings would be valid JSON for one value.
    expect(canonicalString('あい')).toBe('"あい"')
  })

  it('round-trips through JSON.parse for every case above', () => {
    // The output is not merely different from the input; it has to be readable.
    for (const s of ['abc', `a${BACKSLASH}b`, 'a"b', `a${NEWLINE}b`, `a${NUL}b`, 'あい']) {
      expect(JSON.parse(canonicalString(s))).toBe(s)
    }
  })
})

describe('numbers', () => {
  it('takes safe integers', () => {
    expect(canonicalNumber(0)).toBe('0')
    expect(canonicalNumber(-17)).toBe('-17')
    expect(canonicalNumber(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
  })

  it('gives negative zero one spelling', () => {
    // JSON.stringify(-0) is "0" but Object.is(-0, 0) is false, and a rounding
    // step can produce either. One value, one byte sequence.
    expect(canonicalNumber(-0)).toBe('0')
    expect(canonicalNumber(0)).toBe(canonicalNumber(-0))
  })

  it('refuses a fraction, and says what to do instead', () => {
    // Float formatting is the part of JSON that differs across runtimes, and a
    // chain whose hash depends on the printer is not a chain.
    expect(() => canonicalNumber(1.5)).toThrow(/e4/)
  })

  it('refuses non-finite and unsafe values', () => {
    expect(() => canonicalNumber(Number.NaN)).toThrow(SnapshotError)
    expect(() => canonicalNumber(Number.POSITIVE_INFINITY)).toThrow(SnapshotError)
    expect(() => canonicalNumber(2 ** 53)).toThrow(SnapshotError)
  })
})

describe('objects and arrays', () => {
  it('sorts keys, so two code paths building one record agree', () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }))
  })

  it('sorts by code unit, not by locale', () => {
    // Locale-aware ordering differs by machine, which is the same failure as
    // insertion order with more steps.
    expect(canonical({ Z: 1, a: 2 })).toBe('{"Z":1,"a":2}')
  })

  it('keeps array order, because every array here has a stated one', () => {
    expect(canonical([3, 1, 2])).toBe('[3,1,2]')
  })

  it('treats an undefined value and an absent key as the same thing', () => {
    expect(canonical({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }))
  })

  it('emits no whitespace', () => {
    expect(canonical({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}')
  })

  it('refuses what is code rather than data', () => {
    expect(() => canonical({ f: () => 1 })).toThrow(SnapshotError)
    expect(() => canonical(1n)).toThrow(SnapshotError)
  })

  it('produces something JSON.parse accepts, for a nested record', () => {
    const v = { z: [1, 2], a: { q: `x${BACKSLASH}"y`, n: -0 }, t: true, u: null }
    expect(JSON.parse(canonical(v))).toEqual({ z: [1, 2], a: { q: `x${BACKSLASH}"y`, n: 0 }, t: true, u: null })
  })
})

describe('hashing', () => {
  it('is stable for equal values written differently', () => {
    expect(bodyHash({ a: 1, b: 2 })).toBe(bodyHash({ b: 2, a: 1 }))
  })

  it('changes when anything in the value changes', () => {
    expect(bodyHash({ a: 1 })).not.toBe(bodyHash({ a: 2 }))
  })

  it('separates domains, so one hash can never stand for another kind of thing', () => {
    // Project ids, error digests and input keys are all sha256 over text
    // someone can shape. Without a prefix, a value manufactured in one space
    // could validate in another.
    expect(bodyHash({ a: 1 })).not.toBe(sidecarHash({ a: 1 }))
    expect(SNAPSHOT_DOMAIN).not.toBe(SIDECAR_DOMAIN)
  })

  it('is a branded sha256', () => {
    expect(bodyHash({})).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
