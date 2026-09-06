import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan } from '@/collect/scan.js'
import { walkProjects } from '@/collect/walk.js'

/**
 * The AskUserQuestion counters, and the scoping bug that hid them.
 *
 * v2 §2.3 names `toolUseResult.{questions, answers}` for H1 and H3. A scan
 * restricted to rows whose text contains `AskUserQuestion` finds none of them
 * across 1,182 files, because the answer row never names the tool -- it refers
 * to the call by `tool_use_id`. The pattern was right and the scope was wrong,
 * and the positive control did not catch it because a different token was
 * matching in the same pass. Measured properly here: 16 asked, 15 answered.
 *
 * The fixture is built so a scanner with that bug fails: the answer rows do not
 * contain the string "AskUserQuestion" anywhere.
 */

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-ask-'))
  const project = join(root, 'projects', 'C--Users-x-proj')
  mkdirSync(project, { recursive: true })
  const lines: string[] = []
  const ask = (i: number): void => {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: `a${i}`,
        sessionId: 's1',
        timestamp: `2026-08-0${i}T01:00:00.000Z`,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `q${i}`, name: 'AskUserQuestion', input: {} }] },
      }),
    )
  }
  const answer = (i: number, value: string, options: string[]): void => {
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `r${i}`,
        parentUuid: `a${i}`,
        sessionId: 's1',
        timestamp: `2026-08-0${i}T01:00:09.000Z`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `q${i}`, content: 'ok' }] },
        toolUseResult: {
          questions: [{ header: 'h', question: 'q', multiSelect: false, options: options.map((label) => ({ label })) }],
          answers: { h: value },
        },
      }),
    )
  }
  ask(1); answer(1, 'Yes', ['Yes', 'No'])
  ask(2); answer(2, 'something else entirely', ['Yes', 'No'])
  ask(3) // asked and never answered
  writeFileSync(join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), `${lines.join('\n')}\n`)
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const counts = () => scan(walkProjects(join(root, 'projects')), undefined, null, 0)

describe('the decision counters', () => {
  it('finds answers on rows that never name the tool', () => {
    // The regression. Every answer row in this fixture refers to its call by
    // id alone, so a scanner keyed on the tool name reports zero here.
    const d = counts().decisions
    expect(d.answered).toBe(2)
    expect(d.answers).toBe(2)
  })

  it('counts a question with no answer as pending', () => {
    const d = counts().decisions
    expect(d.asked).toBe(3)
    expect(d.asked - d.answered).toBe(1)
  })

  it('tells an off-menu answer from one that matched an option', () => {
    // Both directions: one answer is a listed option, one is not. A detector
    // that called everything off-menu, or nothing, passes only one of these.
    expect(counts().decisions.offMenu).toBe(1)
  })
})
