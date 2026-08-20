import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FORBIDDEN_KEYS, READ_KEYS, scan } from '@/collect/scan.js'
import { walkProjects } from '@/collect/walk.js'

/**
 * A hand-built corpus with known answers.
 *
 * Every row here is shaped after something measured on a real machine, and the
 * three fields the reducer must not consult are present and set to say the
 * opposite of the truth. A reducer that consults any of them gets a different
 * number, which is the only way to tell the two implementations apart — on a
 * real machine the field and the position agree.
 */

let root = ''
const projects = (): string => join(root, 'projects')

const j = (o: unknown): string => `${JSON.stringify(o)}\n`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-scan-'))
  const p = join(projects(), 'C--Users-x-one')
  mkdirSync(p, { recursive: true })

  const main =
    // 3 tool_results: 2 carry the key, 1 of those is an error.
    j({
      type: 'assistant', version: '2.1.233', sessionId: 's1', timestamp: '2026-08-19T01:00:00Z',
      isSidechain: true, preventedContinuation: true,
      message: {
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 },
        content: [
          { type: 'tool_result', is_error: true },
          { type: 'tool_result', is_error: false },
          { type: 'tool_result' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/b.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }) +
    // Two user rows: one carries origin.kind human, one carries no origin at all
    // (96.6% of user rows on the real machine are in the second state).
    j({ type: 'user', version: '2.1.233', sessionId: 's1', timestamp: '2026-08-19T02:00:00Z', origin: { kind: 'human' } }) +
    j({ type: 'user', version: '2.1.112', sessionId: 's1', timestamp: '2026-08-20T02:00:00Z' }) +
    // Denials: one refused by a person, one by a rule.
    j({ type: 'user', toolDenialKind: 'user-rejected', version: '2.1.233' }) +
    j({ type: 'user', toolDenialKind: 'permission-rule', version: '2.1.233' }) +
    // Hook summaries: preventedContinuation false on both, hookErrors non-empty
    // on one. Reading the boolean gives 0; reading hookErrors gives 1.
    j({ type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false, hookErrors: ['refused'] }) +
    j({ type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false, hookErrors: [] }) +
    j({ type: 'assistant', attributionSkill: 'closing', attributionMcpServer: 'playwright', version: '2.1.233' }) +
    j({ type: 'assistant', attributionSkill: 'closing', attributionMcpServer: 'notion', version: '2.1.233' }) +
    j({ type: 'assistant', attributionSkill: 'commit-yama', version: '2.1.233' }) +
    'not json at all\n' +
    '\n'
  writeFileSync(join(p, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), main)

  const wf = join(p, 'aaaaaaaa-0000-4000-8000-000000000001', 'subagents', 'wf_1')
  mkdirSync(wf, { recursive: true })
  writeFileSync(
    join(wf, 'agent-1.jsonl'),
    j({ type: 'assistant', isSidechain: false, version: '2.1.233', message: { content: [{ type: 'tool_result', is_error: true }] } }) +
      j({ type: 'user', version: '2.1.233' }),
  )
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const counts = () => scan(walkProjects(projects()))

describe('the reducer reads each file once', () => {
  it('opens every file exactly once', () => {
    // A second pass is where two passes disagree — the measurement that started
    // this project was 27,751 against 0 over the same machine on the same day.
    // Totals look right either way, so the open count is what is asserted.
    const opens = new Map<string, number>()
    const inv = walkProjects(projects())
    scan(inv, (path) => {
      opens.set(path, (opens.get(path) ?? 0) + 1)
      return ''
    })
    expect([...opens.values()]).toEqual(inv.files.map(() => 1))
    expect(opens.size).toBe(inv.files.length)
  })

  it('survives a file it cannot read rather than aborting the scan', () => {
    const inv = walkProjects(projects())
    const c = scan(inv, (p) => {
      if (p.endsWith('agent-1.jsonl')) throw new Error('EACCES')
      return ''
    })
    expect(c.linesRead).toBe(0)
  })
})

describe('the lines account for themselves', () => {
  it('main and sub lines sum to linesRead', () => {
    const c = counts()
    expect(c.mainLines + c.subLines).toBe(c.linesRead)
  })

  it('counts a line it could not parse instead of skipping it', () => {
    // A parse failure that vanishes is a parser returning a quiet zero.
    expect(counts().linesParseFailed).toBe(1)
  })

  it('does not count blank lines as read', () => {
    const c = counts()
    expect(c.mainLines).toBe(11)
    expect(c.subLines).toBe(2)
  })
})

describe('the counts behind the eleven metrics', () => {
  it('separates the two tool-error denominators', () => {
    const c = counts()
    // 4 results across both files; 3 carry the key; 2 are errors.
    expect(c.toolResultTotal).toBe(4)
    expect(c.toolResultWithIsErrorKey).toBe(3)
    expect(c.toolResultIsErrorTrue).toBe(2)
  })

  it('separates skill rows from distinct skills', () => {
    const c = counts()
    // Taking rows for kinds is a whole order of magnitude on the real machine:
    // 319 rows against 3 distinct skills.
    expect(c.attributionSkillRows).toBe(3)
    expect(c.attributionSkillDistinct).toBe(2)
  })

  it('counts human turns by P1, not by whether origin happens to be there', () => {
    const c = counts()
    // Four of the five user rows are people: the one carrying origin, the one
    // carrying none, and the two denials. The fifth sits under subagents.
    //
    // Counting `origin.kind === 'human'` instead gives 1. On the real machine
    // that difference is 250 against 413 — 1.65x — because the key is absent
    // from 96.8% of user rows. v1 states outright that a missing key must not
    // be read as "not human", and this assertion is what stops the shortcut
    // coming back.
    expect(c.humanTurns).toBe(4)
    expect(c.originHumanRows).toBe(1)
    expect(c.originBearingUserRows).toBe(1)
    expect(c.userRows).toBe(5)
  })

  it('says why it excluded the rows it excluded', () => {
    // A filter that removes most of its input and reports only the survivors is
    // indistinguishable from a broken one. 3,959 of 4,379 user rows on the real
    // machine are tool results.
    expect(counts().notHumanCounts['subagent']).toBe(1)
  })

  it('separates a person refusing from a rule refusing', () => {
    const c = counts()
    expect(c.denialRows).toBe(2)
    expect(c.denialUserRejected).toBe(1)
  })

  it('counts edited files and the ones touched more than once', () => {
    const c = counts()
    // /a.ts twice, /b.ts once. Bash is not an edit.
    expect(c.editedFilesDistinct).toBe(2)
    expect(c.editedFilesRepeated).toBe(1)
  })

  it('keeps the four token counts apart', () => {
    expect(counts().tokens).toEqual({ input: 10, output: 20, cacheRead: 300, cacheCreation: 4 })
  })

  it('tallies tool versions per line, and only where a line carries one', () => {
    const c = counts()
    // Per line, not per environment: this corpus spans two versions and the real
    // machine spans twelve, so a per-environment verdict lets newer rows cover
    // for what older ones never carried.
    //
    // Nine rather than ten: the two stop_hook_summary rows carry no version at
    // all, which is how they arrive. A tally that assumed every row has one
    // would have to invent a value for them.
    expect(c.toolVersions).toEqual({ '2.1.112': 1, '2.1.233': 9 })
    const tallied = Object.values(c.toolVersions).reduce((a, b) => a + b, 0)
    expect(tallied).toBeLessThan(c.linesRead)
  })
})

describe('hook pushback comes from hookErrors, not the boolean', () => {
  it('finds the refusal the boolean denies', () => {
    const c = counts()
    // Both summary rows say preventedContinuation: false. One of them carries a
    // non-empty hookErrors. Reading the boolean gives zero; the event is real.
    expect(c.stopHookSummaryRows).toBe(2)
    expect(c.hookErrorsNonEmpty).toBe(1)
  })
})

describe('the forbidden fields', () => {
  it('are not in the allowlist', () => {
    const allowed = new Set<string>(READ_KEYS)
    expect(FORBIDDEN_KEYS.filter((k) => allowed.has(k))).toEqual([])
  })

  it('names all three', () => {
    expect([...FORBIDDEN_KEYS].sort()).toEqual([
      'isSidechain',
      'preventedContinuation',
      'toolUseResult',
    ])
  })

  it('do not change a single count when their values are inverted', () => {
    // The corpus sets isSidechain true on main rows and false on subagent ones,
    // and preventedContinuation true on a row where no hook refused anything.
    // Every number above is what it is regardless.
    const c = counts()
    expect(c.mainLines).toBe(11)
    expect(c.subLines).toBe(2)
    expect(c.hookErrorsNonEmpty).toBe(1)
  })
})

describe('what the scan carries forward', () => {
  it('collects session ids and dates for the window', () => {
    const c = counts()
    expect(c.sessionIds).toEqual(['s1'])
    expect(c.dates).toEqual(['2026-08-19', '2026-08-20'])
  })

  it('reports bytes from the inventory rather than from what it read', () => {
    expect(counts().bytesRead).toBeGreaterThan(0)
  })
})
