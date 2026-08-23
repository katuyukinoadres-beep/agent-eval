import { describe, expect, it } from 'vitest'
import { basename, normalisePath, referenceIndex } from '@/collect/reference.js'

/**
 * Whether a written file was referred to again, and by a different request.
 *
 * The index used to get this wrong in both directions at once. It kept one
 * mention per token, latest wins, and a write records its own path as a
 * mention in its own bundle -- so a file written, genuinely re-used, then
 * edited again had its last mention overwritten by that final write and scored
 * as never re-used. Meanwhile a bare filename credited every path ending in
 * it, so one `index.ts` in prose marked every `index.ts` on the machine.
 */

const at = (n: number) => `2026-08-2${n}T00:00:00.000Z`

describe('normalising', () => {
  it('folds case and separators, because the same file arrives spelled both ways', () => {
    expect(normalisePath('C:\\A\\B.ts')).toBe('c:/a/b.ts')
    expect(basename('C:\\A\\B.ts')).toBe('b.ts')
    expect(basename('b.ts')).toBe('b.ts')
  })
})

describe('a mention in a different request', () => {
  it('still counts after the file was written again', () => {
    // Written in bundle 1, genuinely re-read in 13, edited again in 14. Under
    // latest-wins the last mention is that final write, in the writing bundle,
    // so the file scored as abandoned however carefully it was maintained.
    const ix = referenceIndex()
    ix.note('/x/keep.ts', at(1), 1)
    ix.note('/x/keep.ts', at(3), 13)
    ix.note('/x/keep.ts', at(4), 14)
    expect(ix.lastMentionIn('/x/keep.ts')?.bundle).toBe(14)
    expect(ix.mentionedElsewhereAfter('/x/keep.ts', 14, at(1))).toBe(true)
  })

  it('does not count a read-back inside the writing request', () => {
    // The other direction. Without this the cheapest way to score is reading
    // your own output back, which axis 3 already counts as verification.
    const ix = referenceIndex()
    ix.note('/x/solo.ts', at(1), 7)
    ix.note('/x/solo.ts', at(2), 7)
    expect(ix.mentionedElsewhereAfter('/x/solo.ts', 7, at(1))).toBe(false)
  })

  it('does not count a mention that came before the write', () => {
    const ix = referenceIndex()
    ix.note('/x/early.ts', at(1), 3)
    expect(ix.mentionedElsewhereAfter('/x/early.ts', 9, at(5))).toBe(false)
    expect(ix.mentionedElsewhereAfter('/x/early.ts', 9, at(0))).toBe(true)
  })

  it('does not count a mention with no bundle', () => {
    const ix = referenceIndex()
    ix.note('/x/loose.ts', at(2), null)
    expect(ix.mentionedElsewhereAfter('/x/loose.ts', 4, at(1))).toBe(false)
  })
})

describe('the bare-filename fallback', () => {
  it('credits a file named without its directory', () => {
    // Why it exists: naming a file without its path is how people refer to
    // files they just asked for.
    const ix = referenceIndex()
    ix.note('/src/only-one.ts', at(1), 1)
    ix.note('have a look at only-one.ts', at(2), 5)
    expect(ix.mentionedElsewhereAfter('/src/only-one.ts', 1, at(1))).toBe(true)
    expect(ix.ambiguousBasenames()).toBe(0)
  })

  it('refuses it once two paths share the name', () => {
    // One `index.ts` in prose used to mark every `index.ts` on the machine as
    // re-used. A name is only evidence when it can mean one file.
    const ix = referenceIndex()
    ix.note('/src/a/index.ts', at(1), 1)
    ix.note('/src/b/index.ts', at(1), 2)
    ix.note('see index.ts', at(3), 9)
    expect(ix.ambiguousBasenames()).toBe(1)
    expect(ix.mentionedElsewhereAfter('/src/a/index.ts', 1, at(1))).toBe(false)
    expect(ix.mentionedElsewhereAfter('/src/b/index.ts', 2, at(1))).toBe(false)
  })

  it('still credits the full path when the basename is ambiguous', () => {
    // Dropping the fallback must not drop the direct match with it.
    const ix = referenceIndex()
    ix.note('/src/a/index.ts', at(1), 1)
    ix.note('/src/b/index.ts', at(1), 2)
    ix.note('/src/a/index.ts', at(4), 9)
    expect(ix.mentionedElsewhereAfter('/src/a/index.ts', 1, at(1))).toBe(true)
    expect(ix.mentionedElsewhereAfter('/src/b/index.ts', 2, at(1))).toBe(false)
  })
})

describe('what the index holds', () => {
  it('reports an empty index as empty', () => {
    expect(referenceIndex().size()).toBe(0)
  })

  it('ignores a row with no timestamp', () => {
    const ix = referenceIndex()
    ix.note('/x/a.ts', null, 1)
    expect(ix.size()).toBe(0)
  })
})
