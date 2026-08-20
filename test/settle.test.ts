import { describe, expect, it } from 'vitest'
import {
  CENSOR_DAYS,
  MAX_PER_BUNDLE,
  UPTAKE_REFERENCED,
  UPTAKE_UNREFERENCED,
  WEIGHT_CEILING,
  WEIGHT_FLOOR,
  censorBefore,
  settleArtifacts,
  sizeWeight,
  type SettleInputs,
} from '@/score/artifact.js'
import { basename, normalisePath, referenceIndex } from '@/collect/reference.js'
import type { PathTally } from '@/collect/artifact.js'

/**
 * P6's two hardest choices, both of which run against intuition, and both of
 * which v1 arrived at by measurement.
 *
 * "Never edited again" is not a condition. Of 1,498 edited paths when it was
 * measured, 135 were re-edited across sessions — so requiring no further edits
 * made the files someone kept maintaining vanish from the denominator, an
 * inverse relationship between care and credit.
 *
 * Weight comes from lines written, never from size on disk. 180 of 355 paths
 * here sit outside the working tree; existence is checked and no byte is read.
 */

const tally = (over: Partial<PathTally> = {}): PathTally => ({
  lastWrite: '2026-08-01T00:00:00Z',
  newLines: 50,
  newLinesKnown: true,
  writes: 1,
  bundle: 1,
  ...over,
})

const settle = (paths: Record<string, PathTally>, over: Partial<SettleInputs> = {}) =>
  settleArtifacts({
    paths,
    windowEnd: '2026-08-20T00:00:00Z',
    lastMention: () => null,
    exists: () => true,
    ...over,
  })

describe('what counts as settled', () => {
  it('accepts a write from before the censoring window', () => {
    expect(settle({ '/a.ts': tally() }).artifacts).toHaveLength(1)
  })

  it('holds back a write from the last three days', () => {
    // Still in flight. 91 of 359 paths here are in this state, which is most of
    // a working day's output.
    const r = settle({ '/a.ts': tally({ lastWrite: '2026-08-19T00:00:00Z' }) })
    expect(r.artifacts).toHaveLength(0)
    expect(r.notSettled['written-too-recently']).toBe(1)
  })

  it('holds back a file that is gone', () => {
    const r = settle({ '/a.ts': tally() }, { exists: () => false })
    expect(r.notSettled['no-longer-exists']).toBe(1)
  })

  it('does not require the file to have been left alone since', () => {
    // The condition v1 removed. Requiring no further edits drops the files
    // someone kept maintaining, which is backwards.
    const r = settle({ '/a.ts': tally({ writes: 40 }) })
    expect(r.artifacts).toHaveLength(1)
  })

  it('counts what it considered, so a filter that ate most says so', () => {
    const r = settle({
      '/a.ts': tally(),
      '/b.ts': tally({ lastWrite: '2026-08-19T00:00:00Z' }),
    })
    expect(r.consideredPaths).toBe(2)
  })
})

describe('uptake', () => {
  it('is full when something referred to the file afterwards', () => {
    const r = settle({ '/a.ts': tally() }, { lastMention: () => '2026-08-02T00:00:00Z' })
    expect(r.artifacts[0]?.uptake).toBe(UPTAKE_REFERENCED)
  })

  it('is partial when the only mention predates the write', () => {
    // Being named before it existed is not uptake.
    const r = settle({ '/a.ts': tally() }, { lastMention: () => '2026-07-01T00:00:00Z' })
    expect(r.artifacts[0]?.uptake).toBe(UPTAKE_UNREFERENCED)
  })

  it('is partial rather than zero when nothing mentions it', () => {
    // Written and never referenced is a real outcome, not a worthless one.
    expect(settle({ '/a.ts': tally() }).artifacts[0]?.uptake).toBe(0.4)
  })
})

describe('weight', () => {
  it('is exactly one at the pivot', () => {
    expect(sizeWeight(50)).toBeCloseTo(1)
  })

  it('clips at both ends', () => {
    expect(sizeWeight(1)).toBe(WEIGHT_FLOOR)
    expect(sizeWeight(10_000_000)).toBe(WEIGHT_CEILING)
  })

  it('floors an unmeasured file, and says that is why', () => {
    // log10(0) is -Infinity, which clips to the floor. The right value for the
    // wrong reason: an unmeasured file and an empty one land on the same number.
    const r = settle({ '/a.ts': tally({ newLines: 0, newLinesKnown: false }) })
    expect(r.artifacts[0]?.weight).toBeCloseTo(WEIGHT_FLOOR * UPTAKE_UNREFERENCED)
    expect(r.weightFlooredUnknown).toBe(1)
  })

  it('does not count a measured empty file as unmeasured', () => {
    const r = settle({ '/a.ts': tally({ newLines: 0, newLinesKnown: true }) })
    expect(r.weightFlooredUnknown).toBe(0)
  })
})

describe('clustering inside a bundle', () => {
  it('folds sibling files of the same kind and size into one', () => {
    // Writing the same thing to eight sibling paths is one piece of work, and
    // counting it eight times is the cheapest way to move this denominator.
    const r = settle({
      '/x/a.ts': tally({ newLines: 100 }),
      '/x/b.ts': tally({ newLines: 120 }),
      '/x/c.ts': tally({ newLines: 110 }),
    })
    expect(r.artifacts).toHaveLength(1)
    expect(r.clustered).toBe(2)
  })

  it('keeps files whose sizes differ by more than a factor of two', () => {
    const r = settle({
      '/x/a.ts': tally({ newLines: 100 }),
      '/x/b.ts': tally({ newLines: 500 }),
    })
    expect(r.artifacts).toHaveLength(2)
  })

  it('keeps different extensions and different directories apart', () => {
    const r = settle({
      '/x/a.ts': tally({ newLines: 100 }),
      '/x/a.md': tally({ newLines: 100 }),
      '/y/a.ts': tally({ newLines: 100 }),
    })
    expect(r.artifacts).toHaveLength(3)
  })

  it('does not cluster across bundles', () => {
    const r = settle({
      '/x/a.ts': tally({ newLines: 100, bundle: 1 }),
      '/x/b.ts': tally({ newLines: 100, bundle: 2 }),
    })
    expect(r.artifacts).toHaveLength(2)
  })

  it('caps a bundle and reports what it dropped', () => {
    const paths: Record<string, PathTally> = {}
    for (let i = 0; i < 6; i += 1) {
      paths[`/x/f${i}.ts`] = tally({ newLines: 10 * 3 ** i })
    }
    const r = settle(paths)
    expect(r.artifacts).toHaveLength(MAX_PER_BUNDLE)
    expect(r.clipped).toBe(3)
  })

  it('keeps the heaviest member as the representative', () => {
    const r = settle({
      '/x/small.ts': tally({ newLines: 100 }),
      '/x/big.ts': tally({ newLines: 150 }),
    })
    expect(r.artifacts[0]?.path).toBe('/x/big.ts')
  })
})

describe('censoring arithmetic', () => {
  it('counts back the stated number of days', () => {
    expect(censorBefore('2026-08-20T00:00:00Z')).toBe('2026-08-17T00:00:00.000Z')
    expect(CENSOR_DAYS).toBe(3)
  })

  it('crosses a month boundary', () => {
    expect(censorBefore('2026-08-02T00:00:00Z')).toBe('2026-07-30T00:00:00.000Z')
  })
})

describe('the reference index', () => {
  it('finds a path mentioned in prose after it was written', () => {
    const r = referenceIndex()
    r.note('あとで scripts/redact.py を直して', '2026-08-02T00:00:00Z')
    expect(r.lastMention('c:/Users/x/scripts/redact.py')).toBe('2026-08-02T00:00:00Z')
  })

  it('matches across separator and case', () => {
    // The same file arrives as `c:\a\B.ts` in one row and `c:/a/b.ts` in the
    // next. Without normalising, a file counts as referenced only when the two
    // spellings happen to agree.
    const r = referenceIndex()
    r.note('C:\\Users\\X\\A.TS', '2026-08-02T00:00:00Z')
    expect(r.lastMention('c:/users/x/a.ts')).not.toBeNull()
  })

  it('keeps the latest mention, not the first', () => {
    const r = referenceIndex()
    r.note('/x/a.ts', '2026-08-02T00:00:00Z')
    r.note('/x/a.ts', '2026-08-05T00:00:00Z')
    r.note('/x/a.ts', '2026-08-03T00:00:00Z')
    expect(r.lastMention('/x/a.ts')).toBe('2026-08-05T00:00:00Z')
  })

  it('returns null for a path nobody mentioned', () => {
    const r = referenceIndex()
    r.note('something else entirely', '2026-08-02T00:00:00Z')
    expect(r.lastMention('/x/a.ts')).toBeNull()
  })

  it('normalises and splits paths the way the matcher expects', () => {
    expect(normalisePath('C:\\A\\B.TS')).toBe('c:/a/b.ts')
    expect(basename('c:/a/b.ts')).toBe('b.ts')
    expect(basename('b.ts')).toBe('b.ts')
  })
})
