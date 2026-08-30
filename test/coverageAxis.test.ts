import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyPermission } from '@/collect/environment.js'
import { settingsPaths } from '@/collect/settings.js'
import { defaultOptions, run } from '@/run.js'

/**
 * The two axes the spec never scores and always shows.
 *
 * Before this, both inherited the scored axes' cluster minimum, so a single run
 * reported `gate passed` and a composite of 58.28 while the two axes whose job
 * is to describe the corpus said `not_applicable / too-few-clusters`. A coverage
 * gate that disappears exactly when coverage is thin is the shape of failure
 * this project exists to detect, and it was in the shipped payload.
 */

/**
 * Run against a synthetic corpus rather than the reference fixture.
 *
 * The fixture is a hand-written illustration of the schema; asserting against
 * it would prove only that someone edited the fixture. These two axes are about
 * what the reader actually gets, so the assertions have to come out of the code
 * path that produces it.
 *
 * The corpus is deliberately tiny — three active days, far below every minimum.
 * That is the condition under which the bug appeared: the axes that describe
 * coverage vanished precisely because coverage was thin.
 */
let home = ''
let payload: ReturnType<typeof run>['payload']

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-eval-coverage-'))
  const project = join(home, '.claude', 'projects', 'C--Users-x-proj')
  mkdirSync(project, { recursive: true })
  const rows: string[] = []
  for (const [i, day] of ['2026-08-01', '2026-08-02', '2026-08-03'].entries()) {
    rows.push(
      `${JSON.stringify({ type: 'user', uuid: `u${i}`, sessionId: 's1', timestamp: `${day}T01:00:00.000Z`, message: { role: 'user', content: 'go' } })}
`,
    )
  }
  writeFileSync(join(project, 'aaaaaaaa-0000-4000-8000-00000000000a.jsonl'), rows.join(''))
  // A subagent transcript, in the subtree a non-recursive walk does not enter.
  // Without one of these in the fixture, `subLineRatio` is legitimately zero and
  // a walk that never recursed would look identical to one that did.
  const sub = join(project, 'aaaaaaaa-0000-4000-8000-00000000000a', 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(
    join(sub, 'bbbbbbbb-0000-4000-8000-00000000000b.jsonl'),
    `${JSON.stringify({ type: 'user', uuid: 'sub0', sessionId: 's2', timestamp: '2026-08-02T02:00:00.000Z', message: { role: 'user', content: 'sub' } })}
`,
  )
  payload = run(defaultOptions({ home, cwd: home })).payload
})

afterAll(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
})

describe('the axes that are never scored and always shown', () => {
  for (const key of ['coverageGate', 'safetyCheck']) {
    it(`${key} is available and says it is unscored by design`, () => {
      const a = (payload.axes as Record<string, any>)[key]
      expect(a, key).toBeDefined()
      expect(a?.availability, key).toBe('available')
      expect(a?.score, key).toBeNull()
      // A null score with an empty reason list would be indistinguishable from
      // a bug. The detail carries the third meaning the schema has no word for.
      expect(a?.detail?.['notScoredByDesign'], key).toBe(1)
    })

    it(`${key} never carries the scored axes' cluster reason`, () => {
      // The specific regression. `too-few-clusters` is a statement about a
      // denominator these axes do not have.
      expect((payload.axes as Record<string, any>)[key]?.unavailableReasons).not.toContain('too-few-clusters')
      expect((payload.axes as Record<string, any>)[key]?.unavailableReasons).toEqual([])
    })

    it(`${key} accounts for every line it read`, () => {
      const ls = (payload.axes as Record<string, any>)[key]?.lineStates ?? {}
      const sum = (ls['available'] ?? 0) + (ls['not_applicable'] ?? 0) + (ls['parse_failed'] ?? 0)
      expect(sum, key).toBe(payload.scanManifest.linesRead)
    })
  }

  it('separates the axis that read rows from the axis that read configuration', () => {
    // The positive control for the line-state split. coverageGate's evidence IS
    // the rows, so counting zero of them available was the axis reporting it had
    // seen nothing in a corpus it had read end to end. safetyCheck reads
    // configuration files and touches no row, so the opposite is correct.
    // Asserting both directions is what makes either assertion mean anything.
    expect((payload.axes as Record<string, any>)['coverageGate']?.lineStates['available']).toBeGreaterThan(0)
    expect((payload.axes as Record<string, any>)['safetyCheck']?.lineStates['available']).toBe(0)
  })

  it('reports the sub-line share, which is the only number a missed subtree moves', () => {
    // A non-recursive walk produces a payload that parses, validates, and reads
    // as healthy. This is the single field that betrays it, so the fixture
    // carries a subagent transcript on purpose: without one, zero is the correct
    // answer and the assertion could not tell a recursive walk from a broken one.
    const detail = (payload.axes as Record<string, any>)['coverageGate']?.detail
    expect(detail?.['subLineRatioE4']).toBeGreaterThan(0)
    // And the walk really did reach it — the file count includes the subtree.
    expect(detail?.['filesRead']).toBe(2)
  })
})

describe('permission classification', () => {
  it('treats a bare Bash grant as arbitrary execution', () => {
    // Invisible on the development machine: its only bare entries are Edit and
    // Write. The bug would first appear on someone else's machine, in the
    // reassuring direction — the widest grant reported as the narrowest class.
    expect(classifyPermission('Bash')).toBe('unrestrictedExec')
    expect(classifyPermission('Bash(*)')).toBe('unrestrictedExec')
  })

  it('does not widen bare tool names that cannot execute code', () => {
    // The other direction, and the reason the fix above is a set and not a
    // blanket rule. Edit and Write granted bare are wide, but calling them
    // arbitrary execution inflates the one number a reader acts on.
    expect(classifyPermission('Edit')).toBe('exact')
    expect(classifyPermission('Write')).toBe('exact')
    expect(classifyPermission('WebSearch')).toBe('exact')
  })

  it('still tells the bounded shapes apart', () => {
    // The positive control for the classifier as a whole: if everything had
    // collapsed into one class, the two tests above would still pass.
    expect(classifyPermission('Bash(git status:*)')).toBe('cliWildcard')
    expect(classifyPermission('Bash(python scripts/redact.py:*)')).toBe('scriptPathFixed')
    expect(classifyPermission('Bash(python:*)')).toBe('unrestrictedExec')
    expect(classifyPermission('Bash(python -c:*)')).toBe('unrestrictedExec')
  })
})

describe('settings scopes', () => {
  it('reads the user-local overrides as well as the user file', () => {
    // Missing this read 16 allow entries while 32 more sat in the file beside
    // it. Nothing failed — the totals were self-consistent and the scope list
    // truthfully named what it had read.
    const paths = settingsPaths('/cwd', '/home', 'linux').map((p) => p.path.replaceAll(String.fromCharCode(92), '/'))
    expect(paths).toContain('/home/.claude/settings.json')
    expect(paths).toContain('/home/.claude/settings.local.json')
    expect(paths).toContain('/cwd/.claude/settings.local.json')
    // The positive control: the list is capable of not containing something.
    expect(paths).not.toContain('/home/.claude/settings.other.json')
  })
})
