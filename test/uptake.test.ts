import { describe, expect, it } from 'vitest'
import {
  MIN_BUNDLES,
  UPTAKE_OMISSION_LEANINGS,
  WEIGHT_NOT_OVERWRITTEN,
  WEIGHT_REUSE,
  uptake,
  type UptakeInputs,
} from '@/score/uptake.js'
import type { Artifact } from '@/score/artifact.js'

/**
 * Axis 4 exists because every other axis watches procedure, and someone
 * producing rubbish by a tidy procedure scores full marks on all of them. A
 * request that ended in silence with nothing built used to be simply missing,
 * so failing cost nothing.
 *
 * The rule that carries most of the weight is that a re-reference only counts
 * from a *different* bundle. Reading back one's own output inside the same
 * request is verification, and letting it count here would make re-reading the
 * cheapest way to raise the score.
 */

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  path: '/x/a.ts',
  weight: 1,
  uptake: 1,
  newLines: 100,
  newLinesKnown: true,
  bundle: 1,
  ...over,
})

const base: UptakeInputs = {
  artifacts: [artifact()],
  totalWeight: 1,
  bundles: 20,
  lastMentionIn: () => null,
  manuallyOverwritten: () => false,
  firstWindow: true,
}

const at = (over: Partial<UptakeInputs>): UptakeInputs => ({ ...base, ...over })

describe('re-reference', () => {
  it('counts a mention from another bundle', () => {
    const r = uptake(at({ lastMentionIn: () => ({ at: '2026-08-20T00:00:00Z', bundle: 2 }) }))
    expect(r.reuse).toBe(1)
    expect(r.reusedArtifacts).toBe(1)
  })

  it('does not count a read-back inside the same bundle', () => {
    // The attack this closes: reading your own output back to score. Axis 3
    // counts that as verification, and counting it twice would reward it.
    const r = uptake(at({ lastMentionIn: () => ({ at: '2026-08-20T00:00:00Z', bundle: 1 }) }))
    expect(r.reuse).toBe(0)
    expect(r.reusedArtifacts).toBe(0)
  })

  it('does not count a mention with no bundle', () => {
    const r = uptake(at({ lastMentionIn: () => ({ at: '2026-08-20T00:00:00Z', bundle: null }) }))
    expect(r.reuse).toBe(0)
  })

  it('weighs artifacts rather than counting them', () => {
    // A thin file mentioned once is not worth a large one mentioned once, and
    // the weight is what stops mass-producing small files from working.
    const r = uptake(
      at({
        artifacts: [artifact({ path: '/a', weight: 3 }), artifact({ path: '/b', weight: 1 })],
        totalWeight: 4,
        lastMentionIn: (p) => (p === '/a' ? { at: '2026-08-20T00:00:00Z', bundle: 9 } : null),
      }),
    )
    expect(r.reuse).toBeCloseTo(0.75)
  })
})

describe('manual overwrite', () => {
  it('counts an artifact a person edited', () => {
    const r = uptake(at({ manuallyOverwritten: () => true }))
    expect(r.overwritten).toBe(1)
    expect(r.overwrittenArtifacts).toBe(1)
  })

  it('lowers the score when it rises', () => {
    const clean = uptake(at({ lastMentionIn: () => ({ at: 'x', bundle: 2 }) }))
    const edited = uptake(
      at({ lastMentionIn: () => ({ at: 'x', bundle: 2 }), manuallyOverwritten: () => true }),
    )
    expect(edited.score).toBeLessThan(clean.score as number)
  })
})

describe('when there is nothing to judge', () => {
  it('has no score without artifacts', () => {
    const r = uptake(at({ artifacts: [], totalWeight: 0 }))
    expect(r.score).toBeNull()
    expect(r.unavailable).toBe('no-artifacts')
  })

  it('has no score below ten bundles', () => {
    const r = uptake(at({ bundles: MIN_BUNDLES - 1 }))
    expect(r.score).toBeNull()
    expect(r.unavailable).toBe('too-few-bundles')
  })

  it('has one at exactly ten', () => {
    expect(uptake(at({ bundles: MIN_BUNDLES })).score).not.toBeNull()
  })
})

describe('the dropped term', () => {
  it('names abandonment and says it reads high', () => {
    // v1 defines an abandoned bundle by three conditions: no successful write,
    // a closing turn that is not an acknowledgement, and a next bundle that is
    // not a continuation. Only the first is mechanical, and implementing it
    // alone would call every question-and-answer bundle abandoned -- 70 of 427
    // on this machine made no tool call at all. That is not a conservative
    // approximation, it is a wrong one.
    const r = uptake(base)
    expect(r.omitted).toContain('axis4-abandonment')
    expect(UPTAKE_OMISSION_LEANINGS['axis4-abandonment']).toBe('high')
  })

  it('names next-window survival on a first window, and says it reads low', () => {
    // It is one of four ways a re-reference can be satisfied, so leaving it out
    // removes a way to reach the numerator.
    expect(uptake(base).omitted).toContain('axis4-next-window-survival')
    expect(UPTAKE_OMISSION_LEANINGS['axis4-next-window-survival']).toBe('low')
    expect(uptake(at({ firstWindow: false })).omitted).not.toContain('axis4-next-window-survival')
  })

  it('renormalises the surviving coefficients to one', () => {
    // Nothing credited and nothing docked: the survivors are scaled until they
    // sum to 1 again. With everything reused and nothing overwritten the score
    // is 100, which it could not reach if the dropped term still occupied its
    // share.
    const r = uptake(at({ lastMentionIn: () => ({ at: 'x', bundle: 2 }) }))
    expect(r.score).toBeCloseTo(100)
    expect(WEIGHT_REUSE + WEIGHT_NOT_OVERWRITTEN).toBeCloseTo(0.7)
  })
})

describe('the score', () => {
  it('is zero when nothing was reused and everything was overwritten', () => {
    const r = uptake(at({ manuallyOverwritten: () => true }))
    expect(r.score).toBeCloseTo(0)
  })

  it('stays inside 0 and 100', () => {
    for (const reused of [true, false]) {
      for (const edited of [true, false]) {
        const r = uptake(
          at({
            lastMentionIn: () => (reused ? { at: 'x', bundle: 2 } : null),
            manuallyOverwritten: () => edited,
          }),
        )
        expect(r.score).toBeGreaterThanOrEqual(0)
        expect(r.score).toBeLessThanOrEqual(100)
      }
    }
  })
})
