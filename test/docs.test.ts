import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MIN_ACTIVE_DAYS, PARSE_FAILURE_GATE } from '@/score/gate.js'
import { MIN_OUTCOME_AXES, TIERS } from '@/score/composite.js'
import { VERSION } from '@/version.js'

/**
 * The manual is a claim about the code, and every claim in this repository has
 * to be checkable by something other than the person who wrote it.
 *
 * This file exists because the privacy document said the tool ran one git
 * command when it ran two, and nothing noticed until a test looked. A number
 * quoted in prose drifts the moment the constant beside it changes, and it
 * drifts silently: the reader has no way to tell a stale figure from a current
 * one.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]): string => readFileSync(join(repo, ...p), 'utf8')

const README = read('README.md')
const INSTALL = read('docs', 'INSTALL.md')
const GUIDE = read('docs', 'GUIDE.md')

describe('the documents a first-time reader is given', () => {
  it('are all shipped in the package', () => {
    const files = JSON.parse(read('package.json')).files as string[]
    for (const f of ['README.md', 'LICENSE', 'docs/PRIVACY.md', 'docs/INSTALL.md', 'docs/GUIDE.md']) {
      expect(files, f).toContain(f)
      expect(existsSync(join(repo, f)), f).toBe(true)
    }
  })

  it('are tracked by git, not merely present on disk', () => {
    // `.gitignore` was a single `*` for the whole of the first build. Tracked
    // files kept working, so nothing looked broken, while every new file was
    // invisible to `git status` unless someone remembered `git add -f`. LICENSE
    // was missed that way: `npm pack` reads the disk and found it, so the
    // tarball was correct and a clone had no licence at all.
    //
    // Presence on disk is what the test above checks, and it is exactly the
    // check that cannot see this.
    let listed: string
    try {
      listed = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })
    } catch {
      return // not a checkout; nothing to assert
    }
    const tracked = new Set(listed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    expect(tracked.size).toBeGreaterThan(50)
    for (const f of ['README.md', 'LICENSE', 'docs/PRIVACY.md', 'docs/INSTALL.md', 'docs/GUIDE.md']) {
      expect([...tracked].includes(f), `${f} is on disk but not tracked`).toBe(true)
    }
    // The positive control: the store must NOT be tracked, and this same
    // listing is what would show it if it were.
    expect([...tracked].filter((f) => f.startsWith('snapshots/'))).toEqual([])
  })

  it('carry no claim that stopped being true', () => {
    // Each of these described the repository accurately once. The README said
    // "Phase 0 着手前 / 仕様書待ち" and listed three spec files as unshared
    // while all three sat in docs/spec/, and the CLI's help ended with "No
    // scores yet" while printing four of them.
    const stale = ['PHASE0_PLAN', 'No scores yet', 'Phase 0 着手前', '仕様書待ち', '現在ブロックされているもの']
    for (const claim of stale) {
      expect(README, claim).not.toContain(claim)
      expect(read('src', 'cli.ts'), claim).not.toContain(claim)
    }
  })

  it('link only to files that exist', () => {
    // The positive control is the second half: a link that cannot resolve has
    // to be caught, or this passes on a document with no links left in it.
    const links = (body: string, from: string): string[] =>
      [...body.matchAll(/\]\(([^)#:]+\.md)\)/g)].map((m) => resolve(repo, from, m[1] as string))

    const found = [
      ...links(README, '.'),
      ...links(INSTALL, 'docs'),
      ...links(GUIDE, 'docs'),
      ...links(read('docs', 'PRIVACY.md'), 'docs'),
    ]
    expect(found.length).toBeGreaterThan(4)
    expect(found.filter((f) => !existsSync(f))).toEqual([])
    expect(existsSync(resolve(repo, 'docs', 'NOT_A_REAL_DOC.md'))).toBe(false)
  })
})

describe('the numbers the manual quotes', () => {
  it('are the thresholds the code actually uses', () => {
    // Quoted as "5%" and "5 日". If either constant moves, the prose is wrong
    // and this is the only thing that would say so.
    expect(PARSE_FAILURE_GATE).toBe(0.05)
    expect(GUIDE).toContain('**5%** を超えると環境ごと採点対象外')
    expect(INSTALL).toContain(`稼働日が **${MIN_ACTIVE_DAYS} 日**に届いていない`)
  })

  it('are the tier boundaries the code actually uses', () => {
    for (const { min, tier } of TIERS) {
      if (min === -Infinity) continue
      expect(GUIDE, tier).toContain(`| **${tier}** | ${min} 以上 |`)
    }
    expect(GUIDE).toContain(`| **D** | ${40} 未満 |`)
  })

  it('describe a window the code actually applies', () => {
    // `windowDays` has no CLI flag, so the manual states 10 as a fact rather
    // than a default. If a flag is added, both sentences become wrong.
    const run = read('src', 'run.ts')
    expect(run).toContain('windowDays ?? 10')
    expect(README).toContain('直近 10 稼働日')
    expect(GUIDE).toContain('直近 **10 稼働日**')
    expect(MIN_OUTCOME_AXES).toBe(3)
  })

  it('quote a version that matches the package', () => {
    expect(JSON.parse(read('package.json')).version).toBe(VERSION)
    expect(INSTALL).toContain(`agent-eval-${VERSION}.tgz`)
  })
})

describe('what the manual promises about behaviour', () => {
  it('is true of the flags the CLI accepts', () => {
    const cli = read('src', 'cli.ts')
    for (const flag of ['--summary', '--store', '--state-dir', '--repo', '--external-log', '--at']) {
      expect(cli, flag).toContain(`'${flag}'`)
      expect(`${README}${INSTALL}${GUIDE}${read('docs', 'PRIVACY.md')}`, flag).toContain(flag)
    }
  })

  it('is true of the refusal reasons it tells the reader to expect', () => {
    // A troubleshooting table naming a reason the code cannot emit sends the
    // reader looking for a message that will never appear.
    const src = ['gate.ts', 'composite.ts', 'comparison.ts'].map((f) => read('src', 'score', f)).join('')
    for (const reason of ['too-few-active-days', 'parse-failure-rate', 'count-basis-changed']) {
      expect(src, reason).toContain(`'${reason}'`)
      expect(`${INSTALL}${GUIDE}`, reason).toContain(reason)
    }
  })

  it('does not promise an npm install that would fail today', () => {
    // The package is unpublished and the bare name is taken by someone else.
    // "npm i -g agent-eval" in a manual is a broken first step.
    expect(INSTALL).not.toMatch(/npm i(nstall)? -g agent-eval\s*$/m)
    expect(INSTALL).toContain('npm レジストリからはまだ入れられません')
  })
})
