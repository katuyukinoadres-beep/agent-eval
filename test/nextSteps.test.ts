import { describe, expect, it } from 'vitest'
import { nextSteps, type NextStepsInput } from '@/cli.js'

/**
 * The `next` block: the only place this tool tells the reader what to do.
 *
 * Everywhere else it refuses, on purpose — the spec's rule is that a symptom
 * has several mechanisms and naming one would invent the finding. That rule is
 * right, and it leaves a reader holding numbers with no move to make. This
 * block is the exception that does not break it, so what it may say is worth
 * pinning: inventory facts only, never a cause, never derived from a score.
 *
 * Tested against the function rather than by spawning the CLI, because the CLI
 * reads the developer's own transcripts: the assertions would depend on whose
 * machine ran them, and each spawn took eight seconds to scan 83,000 lines.
 */

const base: NextStepsInput = { storeOpened: true, skills: null, mcp: null, versions: [] }
const block = (input: Partial<NextStepsInput>): string => nextSteps({ ...base, ...input }).join('\n')

describe('the history warning', () => {
  it('appears when no store was opened, and not when one was', () => {
    // Both directions. This is the only item that gets worse while the reader
    // waits: raw logs are pruned, so a window that was not stored cannot be
    // recovered, and the first comparison needs two of them.
    expect(block({ storeOpened: false })).toContain('no history yet')
    expect(block({ storeOpened: true })).not.toContain('no history yet')
  })

  it('names the flag that fixes it', () => {
    expect(block({ storeOpened: false })).toContain('--store')
  })
})

describe('the asset lines', () => {
  it('count the idle ones rather than leaving subtraction to the reader', () => {
    expect(block({ skills: { numerator: 3, denominator: 28 } })).toContain('25 of 28 skills have never fired')
    expect(block({ mcp: { numerator: 4, denominator: 10 } })).toContain('6 of 10 MCP servers')
  })

  it('say nothing when everything fired', () => {
    // The positive control for the pair above: a line that always printed would
    // pass those and be wrong here.
    const all = block({ skills: { numerator: 28, denominator: 28 }, mcp: { numerator: 10, denominator: 10 } })
    expect(all).not.toContain('never fired')
    expect(all).not.toContain('never been called')
  })

  it('say read before removing, never delete', () => {
    // An unfired skill is not proven useless. This tool cannot tell a dead one
    // from one whose moment has not come, and must not imply that it can.
    const out = block({ skills: { numerator: 1, denominator: 9 } })
    expect(out).toContain('read them before removing')
    expect(out.toLowerCase()).not.toContain('delete')
  })
})

describe('the version comparison', () => {
  const v = (version: string, rate: number | null) => ({ version, failuresPerToolUseE4: rate })

  it('needs two rated versions before it says anything', () => {
    expect(block({ versions: [v('1.0.0', 200)] })).not.toContain('more often')
    // An unrated slice is not a second opinion — it is a slice with too few
    // calls to carry a rate at all.
    expect(block({ versions: [v('1.0.0', 200), v('1.0.1', null)] })).not.toContain('more often')
    expect(block({ versions: [v('1.0.0', 200), v('1.0.1', 400)] })).toContain('more often')
  })

  it('stays quiet when the spread is noise', () => {
    // A hundredth of a failure per call between versions doing the same work is
    // rounding. Naming a worst at that distance manufactures a finding.
    expect(block({ versions: [v('1.0.0', 200), v('1.0.1', 250)] })).not.toContain('more often')
    expect(block({ versions: [v('1.0.0', 200), v('1.0.1', 300)] })).toContain('more often')
  })

  it('states the confounder in the same breath', () => {
    // A version boundary usually spans a change in the work as well. A reader
    // told only the number will act on it.
    const out = block({ versions: [v('1.0.0', 200), v('1.0.1', 900)] })
    expect(out).toContain('your work changed over that span too')
  })
})

describe('what the block may never contain', () => {
  const everything = block({
    storeOpened: false,
    skills: { numerator: 3, denominator: 28 },
    mcp: { numerator: 4, denominator: 10 },
    versions: [
      { version: '1.0.0', failuresPerToolUseE4: 200 },
      { version: '1.0.1', failuresPerToolUseE4: 900 },
    ],
  })

  it('is not empty, so the assertions below mean something', () => {
    expect(everything.length).toBeGreaterThan(200)
  })

  it('names no cause', () => {
    for (const causal of ['because', 'caused', 'due to', 'せい', '原因']) {
      expect(everything, causal).not.toContain(causal)
    }
  })

  it('derives nothing from a score', () => {
    // Scores need scale and carry omitted terms. An instruction built on one
    // would inherit both without saying so.
    for (const scored of ['composite', 'wastedMotion', 'selfVerification', 'artifactUptake', 'tier']) {
      expect(everything, scored).not.toContain(scored)
    }
  })
})

describe('when there is nothing to do', () => {
  it('prints no block at all, rather than a reassuring line', () => {
    expect(nextSteps({ storeOpened: true, skills: { numerator: 5, denominator: 5 }, mcp: null, versions: [] })).toEqual([])
  })
})
