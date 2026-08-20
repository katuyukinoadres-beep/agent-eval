import { describe, expect, it } from 'vitest'
import {
  MIN_ACTIVE_DAYS,
  PARSE_FAILURE_GATE,
  gate,
  walkedSubagents,
  type GateInputs,
} from '@/score/gate.js'
import { MIN_CLUSTERS, MIN_DENOMINATOR, MIN_NUMERATOR, meetsMinimum } from '@/score/minimum.js'

/**
 * Both thresholds here come from the axes spec. Neither was chosen, and that is
 * the whole point of asserting their values: a gate decides whether a machine
 * gets a total at all, so a number picked for convenience would quietly exclude
 * real environments or admit unreadable ones.
 */

const ok: GateInputs = {
  linesRead: 30_000,
  linesParseFailed: 0,
  rootsWalked: [
    { glob: 'projects/*/*.jsonl', matchCount: 11 },
    { glob: 'projects/*/*/subagents/**/*.jsonl', matchCount: 238 },
  ],
  activeDays: 5,
}

describe('the thresholds are the spec\'s', () => {
  it('does not round them off', () => {
    expect(PARSE_FAILURE_GATE).toBe(0.05)
    expect(MIN_ACTIVE_DAYS).toBe(5)
    expect(MIN_CLUSTERS).toBe(20)
    expect(MIN_DENOMINATOR).toBe(200)
    expect(MIN_NUMERATOR).toBe(5)
  })
})

describe('the environment gate', () => {
  it('passes this machine', () => {
    // Measured: 30,664 lines, 0 unparsed, both globs walked, 5 human-turn days.
    expect(gate(ok)).toMatchObject({ availability: 'available', totalAllowed: true })
  })

  it('refuses a log it mostly could not read', () => {
    const v = gate({ ...ok, linesParseFailed: 1_600 })
    expect(v.availability).toBe('parse_failed')
    expect(v.reasons).toContain('parse-failure-rate')
  })

  it('stays silent at exactly the threshold', () => {
    // 5% is not over 5%. A check written with >= fires on every environment
    // sitting on the line.
    expect(gate({ ...ok, linesParseFailed: 1_500 }).availability).toBe('available')
  })

  it('refuses a scan that never looked under subagents', () => {
    // The incident this project started from: a non-recursive glob that never
    // opened the subagent tree and reported a clean total anyway.
    const v = gate({ ...ok, rootsWalked: [{ glob: 'projects/*/*.jsonl', matchCount: 11 }] })
    expect(v.availability).toBe('parse_failed')
    expect(v.reasons).toContain('subagents-not-walked')
  })

  it('accepts a subagent glob that matched nothing', () => {
    // Presence, not match count. A machine that ran no subagents is a different
    // fact from a scan that never looked, and W-2 reports the former.
    const v = gate({
      ...ok,
      rootsWalked: [
        { glob: 'projects/*/*.jsonl', matchCount: 11 },
        { glob: 'projects/*/*/subagents/**/*.jsonl', matchCount: 0 },
      ],
    })
    expect(v.availability).toBe('available')
  })

  it('withholds a total under five active days without calling it unreadable', () => {
    const v = gate({ ...ok, activeDays: 4 })
    expect(v.availability).toBe('not_applicable')
    expect(v.totalAllowed).toBe(false)
    expect(v.reasons).toEqual(['too-few-active-days'])
  })

  it('passes at exactly five, which is what this machine measures', () => {
    // One day either way decides whether the environment is scored at all, and
    // activeDays is a function of origin coverage — 3.2% here.
    expect(gate({ ...ok, activeDays: 5 }).totalAllowed).toBe(true)
  })

  it('reports every condition that fired, not the first', () => {
    const v = gate({ ...ok, linesParseFailed: 5_000, rootsWalked: [] })
    expect(v.reasons).toEqual(['parse-failure-rate', 'subagents-not-walked'])
  })

  it('lets parse_failed outrank not_applicable', () => {
    // If the log could not be read, the day count taken from it is not evidence
    // of a small environment either.
    const v = gate({ ...ok, linesParseFailed: 5_000, activeDays: 1 })
    expect(v.availability).toBe('parse_failed')
  })

  it('does not divide by zero on an empty log', () => {
    // NaN compares false against every threshold, so the gate would pass.
    const v = gate({ ...ok, linesRead: 0, linesParseFailed: 0 })
    expect(v.reasons).not.toContain('parse-failure-rate')
  })

  it('recognises a subagent glob whatever the separator', () => {
    expect(walkedSubagents([{ glob: 'projects/*/*/subagents/**/*.jsonl', matchCount: 0 }])).toBe(true)
    expect(walkedSubagents([{ glob: 'projects/*/*.jsonl', matchCount: 9 }])).toBe(false)
    expect(walkedSubagents([])).toBe(false)
  })
})

describe('the minimum denominator', () => {
  const enough = { clusters: 20, denominator: 200, numerator: 5 }

  it('accepts exactly the minimum on all three', () => {
    expect(meetsMinimum(enough).meetsMinimum).toBe(true)
  })

  it('is an AND, so any one shortfall withholds the rate', () => {
    expect(meetsMinimum({ ...enough, clusters: 19 }).meetsMinimum).toBe(false)
    expect(meetsMinimum({ ...enough, denominator: 199 }).meetsMinimum).toBe(false)
    expect(meetsMinimum({ ...enough, numerator: 4 }).meetsMinimum).toBe(false)
  })

  it('names every shortfall, so a near miss reads differently from a rout', () => {
    expect(meetsMinimum({ clusters: 11, denominator: 200, numerator: 5 }).reasons).toEqual(['too-few-clusters'])
    expect(meetsMinimum({ clusters: 1, denominator: 1, numerator: 1 }).reasons).toEqual([
      'too-few-clusters',
      'denominator-below-minimum',
      'numerator-below-minimum',
    ])
  })

  it('withholds every first-wave axis on this machine', () => {
    // 11 sessions against a minimum of 20. No rate can be carried regardless of
    // what it would have been, which is why base ships with no scores.
    expect(meetsMinimum({ clusters: 11, denominator: 8_202, numerator: 314 })).toEqual({
      meetsMinimum: false,
      reasons: ['too-few-clusters'],
    })
  })
})
