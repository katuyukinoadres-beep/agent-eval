import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan } from '@/collect/scan.js'
import { walkProjects } from '@/collect/walk.js'
import { defaultOptions, run } from '@/run.js'

/**
 * The assets block, and the bug that made it unusable as a headline.
 *
 * Skills, hooks and settings live under a project directory, and the tool read
 * them from `process.cwd()`. Running from its own checkout reported
 * `skillsDefined: 0` while the project beside it had 27; running from that
 * project reported 27. The environment was identical in both runs — only the
 * shell's location differed. A number that moves for that reason is not a
 * measurement, and this one was about to become the first thing every user
 * reads.
 */

let home = ''
let projectDir = ''

const row = (cwd: string, day: string, i: number): string =>
  `${JSON.stringify({
    type: 'user',
    uuid: `u${i}`,
    sessionId: 's1',
    cwd,
    version: '2.1.235',
    timestamp: `${day}T0${i % 9}:00:00.000Z`,
    message: { role: 'user', content: 'go' },
  })}\n`

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-eval-assets-'))
  projectDir = join(home, 'a-project')
  // Two skills, in the project rather than in the home directory or the cwd the
  // test process happens to be in.
  const skills = join(projectDir, '.claude', 'skills')
  mkdirSync(skills, { recursive: true })
  writeFileSync(join(skills, 'one.md'), '---\nname: one\n---\nbody\n')
  writeFileSync(join(skills, 'two.md'), '---\nname: two\n---\nbody\n')

  const transcripts = join(home, '.claude', 'projects', 'C--a-project')
  mkdirSync(transcripts, { recursive: true })
  const lines: string[] = []
  for (let i = 0; i < 6; i += 1) lines.push(row(projectDir, `2026-08-0${i + 1}`, i))
  // The same directory with a different drive-letter case, which is what
  // Windows actually writes. Both spellings appear in this machine's own logs:
  // 55,346 rows lowercase and 15,366 uppercase, for one directory.
  lines.push(row(projectDir.replace(/^([a-z]):/i, (_m, d: string) => `${String(d).toUpperCase()}:`), '2026-08-07', 9))
  writeFileSync(join(transcripts, 'aaaaaaaa-0000-4000-8000-00000000000a.jsonl'), lines.join(''))
})

afterAll(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
})

describe('the working directories the transcripts name', () => {
  it('are collected from the rows', () => {
    const c = scan(walkProjects(join(home, '.claude', 'projects')), undefined, null, 0)
    expect(c.cwds.length).toBeGreaterThan(0)
  })

  it('fold two drive-letter spellings into one directory', () => {
    // The positive control is the fixture itself: it contains both spellings on
    // purpose, so a scanner that keyed on the raw string would report two.
    const c = scan(walkProjects(join(home, '.claude', 'projects')), undefined, null, 0)
    expect(c.cwds.length).toBe(1)
    // And it keeps a real spelling rather than a lowercased reconstruction.
    expect(c.cwds[0]).toBe(projectDir)
  })
})

describe('what stays inside the process', () => {
  it('never lets a working directory reach the payload', () => {
    // `cwd` is the only filesystem path this scanner is allowed to read, and it
    // is read to locate config files rather than to report anything. A path
    // carries the OS username and the project's name, and this payload is meant
    // to be pasteable.
    const payload = run(defaultOptions({ home, cwd: projectDir })).payload
    const text = JSON.stringify(payload)
    // Compared in its JSON-escaped form. On Windows the raw path holds
    // backslashes that `JSON.stringify` doubles, so searching for the raw
    // string finds nothing in any JSON at all -- the first version of this
    // test passed against a payload that did leak, and the positive control
    // below is the only reason that was noticed.
    const escaped = JSON.stringify(projectDir).slice(1, -1)
    expect(text).not.toContain(escaped)
    expect(JSON.stringify({ leak: projectDir })).toContain(escaped)
    // And the counts it was read for did come through.
    expect(payload.environment.skillsDefined).toBe(2)
  })
})

describe('the asset counts', () => {
  it('do not move with the directory the process is run from', () => {
    // The regression, stated as the property rather than as a number: three
    // different working directories, none of them the project, must all report
    // the project's two skills.
    const elsewhere = mkdtempSync(join(tmpdir(), 'agent-eval-elsewhere-'))
    try {
      const counts = [projectDir, home, elsewhere].map(
        (cwd) => run(defaultOptions({ home, cwd })).payload.environment.skillsDefined,
      )
      expect(new Set(counts).size, `skillsDefined differed by cwd: ${counts.join(', ')}`).toBe(1)
      expect(counts[0]).toBe(2)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('find skills the process cwd cannot see', () => {
    // The other half. If the fixture's skills happened to be reachable from the
    // cwd, the test above would pass without the fix.
    const elsewhere = mkdtempSync(join(tmpdir(), 'agent-eval-blank-'))
    try {
      // No transcripts at all: nothing names the project, so nothing finds it.
      const blank = mkdtempSync(join(tmpdir(), 'agent-eval-nohome-'))
      const withoutLogs = run(defaultOptions({ home: blank, cwd: elsewhere })).payload.environment.skillsDefined
      const withLogs = run(defaultOptions({ home, cwd: elsewhere })).payload.environment.skillsDefined
      expect(withoutLogs).toBe(0)
      expect(withLogs).toBe(2)
      rmSync(blank, { recursive: true, force: true })
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})
