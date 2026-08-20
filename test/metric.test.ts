import { describe, expect, it } from 'vitest'
import {
  DENOMINATOR_MEANINGS,
  FORBIDDEN_SOURCE_FIELDS,
  MetricError,
  SOURCE_FIELDS,
  makeCount,
  makeMetric,
} from '@/payload/metric.js'
import { VERSION } from '@/version.js'
import { run } from '@/cli.js'

/**
 * These pin the constraints the repository has already paid for. Each assertion
 * below corresponds to a measured incident, not to a hypothetical.
 */

describe('makeMetric refuses figures that cannot be compared', () => {
  const ok = {
    numerator: 243,
    denominator: 5254,
    denominatorMeaning: DENOMINATOR_MEANINGS[0],
    sourceField: SOURCE_FIELDS[0],
  } as const

  it('accepts a well-formed rate', () => {
    expect(makeMetric(ok)).toEqual(ok)
  })

  it('refuses a numerator above its denominator', () => {
    // recordRate arrived at 15/14 = 107.1% on this machine because the
    // denominator was max(git days, jsonl days) and the numerator counted days
    // present in neither. V-5 catches it on receipt; this stops it being built.
    expect(() => makeMetric({ ...ok, numerator: 15, denominator: 14 })).toThrow(MetricError)
  })

  it('refuses a zero denominator', () => {
    // skillFired's denominator per spec §3.1 is `.claude/skills/*/SKILL.md`,
    // which matches 0 files here — the skills are flat `.claude/skills/*.md`,
    // 27 of them. Zero passes V-4, and W-6 only fires above 100, so this would
    // ship as a silent hole.
    expect(() => makeMetric({ ...ok, numerator: 0, denominator: 0 })).toThrow(/zero denominator/)
  })

  it('refuses negatives and non-finite values', () => {
    expect(() => makeMetric({ ...ok, numerator: -1 })).toThrow(MetricError)
    expect(() => makeMetric({ ...ok, denominator: Number.NaN })).toThrow(MetricError)
  })
})

describe('makeCount', () => {
  it('accepts a count that states why it has no denominator', () => {
    const c = {
      value: 319,
      noDenominatorReason: 'reference-value',
      sourceField: 'attributionSkill',
    } as const
    expect(makeCount(c)).toEqual(c)
  })

  it('refuses a negative count', () => {
    expect(() =>
      makeCount({ value: -1, noDenominatorReason: 'reference-value', sourceField: 'attributionSkill' }),
    ).toThrow(MetricError)
  })
})

describe('the forbidden fields stay out of the allowlist', () => {
  // Each of these looks like the obvious source for something the product
  // measures, and each returns a constant zero rather than an error:
  //   isSidechain               false on every main-transcript row
  //   toolUseResult.interrupted 9,995 occurrences across two machines, 0 true
  //   preventedContinuation     all false even on rows where a hook did push back
  it('has no overlap between SOURCE_FIELDS and FORBIDDEN_SOURCE_FIELDS', () => {
    const allowed = new Set<string>(SOURCE_FIELDS)
    const overlap = FORBIDDEN_SOURCE_FIELDS.filter((f) => allowed.has(f))
    expect(overlap).toEqual([])
  })

  it('names all three', () => {
    expect([...FORBIDDEN_SOURCE_FIELDS].sort()).toEqual([
      'isSidechain',
      'preventedContinuation',
      'toolUseResult.interrupted',
    ])
  })
})

describe('cli', () => {
  it('reports its version', () => {
    expect(run(['--version'])).toEqual({ code: 0, out: VERSION })
  })

  it('says what it does and that analysis stays local', () => {
    const { code, out } = run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('stays on the machine')
  })

  it('rejects an unknown argument rather than guessing', () => {
    expect(run(['--score-everything']).code).toBe(2)
  })
})
