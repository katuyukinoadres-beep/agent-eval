import { describe, expect, it } from 'vitest'
import { bundleTracker, isEnvironmentNoise } from '@/collect/bundle.js'

/**
 * P5 and P3.
 *
 * The orphan count is the assertion that matters. Every non-null `parentUuid`
 * on this machine — 13,413 of them — refers to a row earlier in the same file,
 * measured independently before any of this was written. So an orphan means the
 * tracker is wrong, not that the data is odd, and two versions of it were caught
 * that way: one that gave metadata rows bundles (5,202 orphans) and one that
 * dropped P3 noise out of the chain (7).
 */

const counter = (): (() => number) => {
  let n = 0
  return () => {
    n += 1
    return n
  }
}

describe('a bundle runs from one human turn to the next', () => {
  it('opens a bundle per human turn and gives the rows between to it', () => {
    const t = bundleTracker(counter())
    const a = t.assign('u1', null, true)
    const b = t.assign('u2', 'u1', false)
    const c = t.assign('u3', 'u2', false)
    const d = t.assign('u4', 'u3', true)
    expect([a?.id, b?.id, c?.id]).toEqual([1, 1, 1])
    expect(d?.id).toBe(2)
    expect(t.opened()).toBe(2)
    // The kind travels with the id: only the row that opened a bundle can set
    // the day the bundle belongs to.
    expect([a?.kind, b?.kind, c?.kind, d?.kind]).toEqual([
      'human',
      'inherited',
      'inherited',
      'human',
    ])
  })

  it('follows the chain, not the order rows arrive in', () => {
    // 563 of 13,421 rows here have a parent that is not the row before them,
    // and one session branches 304 times in 3,350 rows. Reading order as the
    // chain puts every one of those in the wrong bundle.
    const t = bundleTracker(counter())
    t.assign('u1', null, true) // bundle 1
    t.assign('u2', 'u1', false) // 1
    t.assign('u3', null, true) // bundle 2
    const branched = t.assign('u4', 'u2', false) // back to 1, not 2
    expect(branched?.id).toBe(1)
  })

  it('reports no orphan when every parent was seen', () => {
    const t = bundleTracker(counter())
    t.assign('u1', null, true)
    t.assign('u2', 'u1', false)
    expect(t.orphans()).toBe(0)
  })
})

describe('rows that are not in the tree', () => {
  it('get no bundle at all', () => {
    // 5,182 of 18,641 main rows here: last-prompt, ai-title, queue-operation,
    // pr-link, mode, file-history-snapshot. The first version gave them bundles
    // and reported 5,202 orphans against a measured zero.
    const t = bundleTracker(counter())
    expect(t.assign(null, null, false)).toBeNull()
    expect(t.opened()).toBe(0)
    expect(t.orphans()).toBe(0)
  })

  it('do not become a parent anything can inherit from', () => {
    const t = bundleTracker(counter())
    t.assign(null, null, false)
    t.assign('u1', null, true)
    expect(t.assign('u2', 'u1', false)?.id).toBe(1)
  })
})

describe('roots and orphans are different facts', () => {
  it('counts a null parent as a root, not an orphan', () => {
    // 13 rows here carry a null parent. They begin a chain; they are not
    // evidence that the tracker lost one.
    const t = bundleTracker(counter())
    t.assign('u1', null, false)
    expect(t.roots()).toBe(1)
    expect(t.orphans()).toBe(0)
  })

  it('counts a named but unseen parent as an orphan', () => {
    // The positive control: orphans must be reachable, or asserting zero on
    // real data proves only that the counter is never incremented.
    const t = bundleTracker(counter())
    const assigned = t.assign('u2', 'missing', false)
    expect(t.orphans()).toBe(1)
    expect(assigned?.id).toBe(1)
    // The kind is what decides the day a bundle belongs to, so an orphan has to
    // be distinguishable from a row that inherited one.
    expect(assigned?.kind).toBe('orphan')
  })

  it('starts its own bundle rather than joining whichever was current', () => {
    // Attaching a branch to the wrong request moves a denominator with no count
    // changing to show it.
    const t = bundleTracker(counter())
    t.assign('u1', null, true)
    expect(t.assign('u9', 'missing', false)).not.toBe(1)
  })
})

describe('P3 — environment noise', () => {
  it('names the three shapes the spec lists', () => {
    expect(isEnvironmentNoise({ isApiErrorMessage: true })).toBe(true)
    expect(isEnvironmentNoise({ type: 'system', subtype: 'api_error' })).toBe(true)
    expect(isEnvironmentNoise({ message: { model: '<synthetic>' } })).toBe(true)
  })

  it('leaves an ordinary row alone', () => {
    expect(isEnvironmentNoise({ type: 'user', message: { model: 'claude-opus-5' } })).toBe(false)
    expect(isEnvironmentNoise({ isApiErrorMessage: false })).toBe(false)
    // A system row that is not an api_error is not noise.
    expect(isEnvironmentNoise({ type: 'system', subtype: 'stop_hook_summary' })).toBe(false)
  })

  it('survives a row whose message is not an object', () => {
    expect(isEnvironmentNoise({ message: null })).toBe(false)
    expect(isEnvironmentNoise({})).toBe(false)
  })
})
