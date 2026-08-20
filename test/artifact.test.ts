import { describe, expect, it } from 'vitest'
import { readWrite, recordWrite, type MutPathTally } from '@/collect/artifact.js'

/**
 * P6's collection half.
 *
 * `toolUseResult` was banned outright until this existed. The instinct was
 * right — the object holds the file and the terminal — but the shape was wrong,
 * and a ban on the parent is what sends a later stage hunting for line counts
 * somewhere worse. Every read now goes through this module so there is one
 * place to check.
 */

describe('reading where a write landed', () => {
  it('takes the line count from an edit patch', () => {
    // `newLines` is a field the log already computed, per hunk. Nothing here
    // opens `lines`, which is the diff text itself.
    const w = readWrite({
      filePath: '/a.ts',
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 21, lines: ['+x'] },
        { oldStart: 40, oldLines: 1, newStart: 59, newLines: 4, lines: ['+y'] },
      ],
    })
    expect(w).toEqual({ path: '/a.ts', newLines: 25, newLinesKnown: true })
  })

  it('takes it from the file record on a create', () => {
    const w = readWrite({ file: { filePath: '/b.ts', numLines: 12, content: 'secret' } })
    expect(w).toEqual({ path: '/b.ts', newLines: 12, newLinesKnown: true })
  })

  it('reports a path with no size as unknown, not as zero', () => {
    // 131 of 356 paths here are in this state. Zero would be indistinguishable
    // from an empty file, and v1's weight floors at 0.5 either way — so the
    // distinction has to live outside the number.
    const w = readWrite({ filePath: '/c.ts' })
    expect(w).toEqual({ path: '/c.ts', newLines: 0, newLinesKnown: false })
  })

  it('returns nothing for a result that is not a write', () => {
    expect(readWrite({ stdout: 'ls output', stderr: '' })).toBeNull()
    expect(readWrite(null)).toBeNull()
    expect(readWrite('a string')).toBeNull()
    expect(readWrite({ filePath: '' })).toBeNull()
  })

  it('survives a patch whose hunks are malformed', () => {
    const w = readWrite({ filePath: '/d.ts', structuredPatch: [null, { newLines: 'many' }, 3] })
    expect(w).toEqual({ path: '/d.ts', newLines: 0, newLinesKnown: false })
  })
})

describe('accumulating writes to one path', () => {
  const tally = (): Map<string, MutPathTally> => new Map()

  it('sums lines across writes and counts them', () => {
    const t = tally()
    recordWrite(t, { path: '/a', newLines: 10, newLinesKnown: true }, '2026-08-19T01:00:00Z', 1)
    recordWrite(t, { path: '/a', newLines: 5, newLinesKnown: true }, '2026-08-19T02:00:00Z', 2)
    expect(t.get('/a')).toMatchObject({ newLines: 15, writes: 2 })
  })

  it('keeps the latest write, not the last one seen', () => {
    // The censoring rule turns on the last write. An earlier timestamp
    // overwriting a later one would make an artifact look settled while it was
    // still being changed — and rows do not always arrive in time order.
    const t = tally()
    recordWrite(t, { path: '/a', newLines: 1, newLinesKnown: true }, '2026-08-19T05:00:00Z', 5)
    recordWrite(t, { path: '/a', newLines: 1, newLinesKnown: true }, '2026-08-19T01:00:00Z', 9)
    expect(t.get('/a')?.lastWrite).toBe('2026-08-19T05:00:00Z')
    expect(t.get('/a')?.bundle).toBe(5)
  })

  it('remembers that a size was known once, even if a later write had none', () => {
    const t = tally()
    recordWrite(t, { path: '/a', newLines: 10, newLinesKnown: true }, '2026-08-19T01:00:00Z', 1)
    recordWrite(t, { path: '/a', newLines: 0, newLinesKnown: false }, '2026-08-19T02:00:00Z', 1)
    expect(t.get('/a')?.newLinesKnown).toBe(true)
  })

  it('keeps paths apart', () => {
    const t = tally()
    recordWrite(t, { path: '/a', newLines: 1, newLinesKnown: true }, '2026-08-19T01:00:00Z', 1)
    recordWrite(t, { path: '/b', newLines: 2, newLinesKnown: true }, '2026-08-19T01:00:00Z', 1)
    expect(t.size).toBe(2)
  })
})

describe('what it refuses to look at', () => {
  it('ignores the content fields even when they are right there', () => {
    // The result of a real edit carries originalFile, oldString and newString
    // alongside the patch. None of them reaches the returned record.
    const w = readWrite({
      filePath: '/a.ts',
      originalFile: 'THE WHOLE FILE',
      oldString: 'before',
      newString: 'after',
      userModified: false,
      structuredPatch: [{ newLines: 3, lines: ['+secret line'] }],
    })
    expect(JSON.stringify(w)).not.toContain('secret')
    expect(JSON.stringify(w)).not.toContain('WHOLE FILE')
    expect(w).toEqual({ path: '/a.ts', newLines: 3, newLinesKnown: true })
  })
})
