import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAIN_GLOB, SUB_GLOB, isSubagentPath, walkProjects } from '@/collect/walk.js'

/**
 * The tree is generated into a temp directory, never committed. The repository
 * ignores *.jsonl so a real transcript cannot be checked in by accident, and a
 * fixture cut from one would carry conversation text into git.
 *
 * Its shape mirrors the machine this was measured on: five projects, one holding
 * everything and four holding nothing. That distribution is what makes a partial
 * miss survive an aggregate check, so it is the shape worth testing against.
 */

let root = ''

/** A line whose isSidechain says the opposite of where the file sits. */
const line = (isSidechain: boolean): string =>
  `${JSON.stringify({ type: 'user', isSidechain, sessionId: 'x' })}\n`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-walk-'))
  const projects = join(root, 'projects')

  // The busy project: two main transcripts and three subagent ones.
  const busy = join(projects, 'C--Users-x-busy')
  mkdirSync(busy, { recursive: true })
  writeFileSync(join(busy, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), line(true))
  writeFileSync(join(busy, 'aaaaaaaa-0000-4000-8000-000000000002.jsonl'), line(true))

  const wf = join(busy, 'aaaaaaaa-0000-4000-8000-000000000001', 'subagents', 'workflows', 'wf_1')
  mkdirSync(wf, { recursive: true })
  writeFileSync(join(wf, 'agent-1.jsonl'), line(false))
  writeFileSync(join(wf, 'agent-2.jsonl'), line(false))
  // Nested deeper, to catch a walk that only looks one level under subagents.
  mkdirSync(join(wf, 'nested'), { recursive: true })
  writeFileSync(join(wf, 'nested', 'agent-3.jsonl'), line(false))

  // Four projects that exist but hold nothing. Four of five on the real machine.
  for (const n of ['empty-a', 'empty-b', 'empty-c', 'empty-d']) {
    mkdirSync(join(projects, `C--Users-x-${n}`), { recursive: true })
  }

  // A project whose only content is a subagent tree — no main transcript at all.
  const subOnly = join(projects, 'C--Users-x-subonly')
  const subOnlyWf = join(subOnly, 'bbbbbbbb-0000-4000-8000-000000000001', 'subagents', 'wf_2')
  mkdirSync(subOnlyWf, { recursive: true })
  writeFileSync(join(subOnlyWf, 'agent-9.jsonl'), line(false))

  // Files the walk must ignore.
  writeFileSync(join(busy, 'notes.md'), 'not a transcript\n')
  mkdirSync(join(busy, 'memory'), { recursive: true })
  writeFileSync(join(busy, 'memory', 'MEMORY.md'), 'not a transcript\n')
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const inv = () => walkProjects(join(root, 'projects'))

describe('what the walk finds', () => {
  it('finds main transcripts and subagent transcripts at any depth', () => {
    const i = inv()
    expect(i.files.filter((f) => f.kind === 'main')).toHaveLength(2)
    // Three under the busy project, one under the sub-only project. The third
    // busy one is nested an extra level down.
    expect(i.files.filter((f) => f.kind === 'sub')).toHaveLength(4)
  })

  it('ignores everything that is not a transcript', () => {
    expect(inv().files.every((f) => f.path.endsWith('.jsonl'))).toBe(true)
  })

  it('lists every project directory, including the empty ones', () => {
    // The empty ones matter: they are what a per-project check needs in order to
    // notice a partial miss, and dropping them is how the aggregate hides it.
    expect(inv().projects).toHaveLength(6)
  })
})

describe('each glob reports its own match count', () => {
  it('so a glob that matched nothing is visible', () => {
    const i = inv()
    const byGlob = Object.fromEntries(i.rootsWalked.map((r) => [r.glob, r.matchCount]))
    expect(byGlob[MAIN_GLOB]).toBe(2)
    expect(byGlob[SUB_GLOB]).toBe(4)
  })

  it('counts sum to the files found, so a count cannot drift from the walk', () => {
    const i = inv()
    const claimed = i.rootsWalked.reduce((a, r) => a + r.matchCount, 0)
    expect(claimed).toBe(i.files.length)
  })

  it('reports zero rather than omitting a root that found nothing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agent-eval-empty-'))
    try {
      mkdirSync(join(empty, 'projects'), { recursive: true })
      const i = walkProjects(join(empty, 'projects'))
      expect(i.rootsWalked.map((r) => r.matchCount)).toEqual([0, 0])
      expect(i.rootsWalked).toHaveLength(2)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('classification is by position, not by what the file claims', () => {
  it('holds even when every isSidechain says the opposite', () => {
    // The tree is built inverted on purpose: main transcripts carry
    // isSidechain: true, subagent ones carry false. On the real machine the two
    // agree, so an implementation reading the field and one reading the path
    // produce identical numbers and no aggregate test can tell them apart.
    // Here they disagree, and only the path-based answer survives.
    const i = inv()
    for (const f of i.files) {
      expect(isSubagentPath(f.path), f.path).toBe(f.kind === 'sub')
    }
    expect(i.files.filter((f) => f.kind === 'main')).toHaveLength(2)
    expect(i.files.filter((f) => f.kind === 'sub')).toHaveLength(4)
  })

  it('recognises a subagents directory anywhere in the path', () => {
    expect(isSubagentPath('a/b/subagents/c.jsonl')).toBe(true)
    expect(isSubagentPath('a\\b\\subagents\\c.jsonl')).toBe(true)
    expect(isSubagentPath('a/b/c.jsonl')).toBe(false)
    // Not a substring match: a project could legitimately be named this.
    expect(isSubagentPath('a/subagents-archive/c.jsonl')).toBe(false)
  })
})

describe('a subagent transcript keeps the session it came from', () => {
  it('recovers the parent session id from the directory it hangs under', () => {
    // Once isSidechain is out of use, the directory is the only record of which
    // session a subagent transcript belongs to.
    const subs = inv().files.filter((f) => f.kind === 'sub')
    const busy = subs.filter((f) => f.project === 'C--Users-x-busy')
    expect(busy).toHaveLength(3)
    for (const f of busy) {
      expect(f.sessionId).toBe('aaaaaaaa-0000-4000-8000-000000000001')
    }
  })

  it('gives a main transcript its own session id', () => {
    const main = inv().files.filter((f) => f.kind === 'main')
    expect(main.map((f) => f.sessionId).sort()).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000002',
    ])
  })
})

describe('the inventory a payload will be built from', () => {
  it('records main and sub counts per project', () => {
    const byName = Object.fromEntries(inv().projects.map((p) => [p.project, p]))
    expect(byName['C--Users-x-busy']).toMatchObject({ mainFiles: 2, subFiles: 3 })
    expect(byName['C--Users-x-subonly']).toMatchObject({ mainFiles: 0, subFiles: 1 })
    expect(byName['C--Users-x-empty-a']).toMatchObject({ mainFiles: 0, subFiles: 0 })
  })

  it('measures bytes without reading a line', () => {
    const i = inv()
    expect(i.files.every((f) => f.bytes > 0)).toBe(true)
    const perProject = i.projects.reduce((a, p) => a + p.bytes, 0)
    const perFile = i.files.reduce((a, f) => a + f.bytes, 0)
    expect(perProject).toBe(perFile)
  })

  it('survives a projects root that does not exist', () => {
    const i = walkProjects(join(root, 'no-such-directory'))
    expect(i.files).toEqual([])
    expect(i.projects).toEqual([])
    expect(i.rootsWalked.map((r) => r.matchCount)).toEqual([0, 0])
  })
})
