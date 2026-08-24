import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The claims in `docs/PRIVACY.md`, enforced.
 *
 * A privacy document nothing checks is a document that rots: the code moves,
 * the promise stays, and the gap is invisible until somebody is harmed by it.
 * Every assertion here corresponds to a sentence a reader is being asked to
 * believe.
 *
 * Each one is paired with a positive control, because "found no network call"
 * and "the search was broken" produce the same output.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

const filesUnder = (dir: string, ext: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) filesUnder(full, ext, out)
    else if (entry.endsWith(ext)) out.push(full)
  }
  return out
}

describe('the tool does not talk to the network', () => {
  const sources = filesUnder(join(repo, 'src'), '.ts')

  it('scans a real number of files, so a clean result means something', () => {
    // The range, stated. An empty result over an empty file list is not
    // evidence, and a count nobody writes down cannot be compared later.
    expect(sources.length).toBeGreaterThan(20)
  })

  it('imports no networking builtin anywhere in src/', () => {
    const offenders = sources.filter((f) => {
      const text = readFileSync(f, 'utf8')
      return /from\s+'node:(https?|net|tls|dgram|http2)'/.test(text)
    })
    expect(offenders.map((f) => f.slice(repo.length + 1))).toEqual([])
  })

  it('calls no fetch and names no URL', () => {
    const offenders = sources.filter((f) => {
      const text = readFileSync(f, 'utf8')
      // A URL inside a comment is prose; one in code is a destination.
      const code = text
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
        .join('\n')
      return /\bfetch\s*\(|https?:\/\/|XMLHttpRequest|WebSocket/.test(code)
    })
    expect(offenders.map((f) => f.slice(repo.length + 1))).toEqual([])
  })

  it('can see a networking import when there is one', () => {
    // The positive control. Without it, a regex that matches nothing at all
    // passes every assertion above.
    const planted = "import { request } from 'node:https'\nconst u = 'https://example.invalid'\nfetch(u)\n"
    expect(/from\s+'node:(https?|net|tls|dgram|http2)'/.test(planted)).toBe(true)
    expect(/\bfetch\s*\(|https?:\/\//.test(planted)).toBe(true)
  })

  it('declares no runtime dependency', () => {
    // Zero is what makes the claim checkable at all: a dependency could open a
    // socket without a line of this repository saying so.
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})

describe('the only command the tool runs', () => {
  it('is one git invocation, and it asks for dates', () => {
    // `docs/PRIVACY.md` §2.3 prints this command verbatim. If it changes, the
    // document is wrong and this fails rather than the reader being misled.
    const git = readFileSync(join(repo, 'src', 'collect', 'git.ts'), 'utf8')
    expect(git).toContain("['log', '--format=%cd', '--date=short']")
  })

  it('runs a subprocess from exactly two places, both of them git', () => {
    // The document named one command until this test was written. That is what
    // a promise nothing checks looks like after a few months: `stateDir.ts`
    // also shells out to git, to refuse running against a store somebody has
    // committed.
    const spawners = filesUnder(join(repo, 'src'), '.ts')
      .filter((f) => readFileSync(f, 'utf8').includes("from 'node:child_process'"))
      .map((f) => f.slice(repo.length + 1).split('\\').join('/'))
      .sort()
    expect(spawners).toEqual(['src/collect/git.ts', 'src/snapshot/stateDir.ts'])
  })

  it('names both of those commands in the privacy document', () => {
    const doc = readFileSync(join(repo, 'docs', 'PRIVACY.md'), 'utf8')
    expect(doc).toContain('log --format=%cd --date=short')
    expect(doc).toContain('ls-files --error-unmatch')
  })
})

describe('the privacy document is about this code', () => {
  const doc = readFileSync(join(repo, 'docs', 'PRIVACY.md'), 'utf8')

  it('names the state directory the code actually writes', () => {
    const stateDir = readFileSync(join(repo, 'src', 'snapshot', 'stateDir.ts'), 'utf8')
    expect(stateDir).toContain("STATE_DIR_NAME = '.agent-eval'")
    expect(doc).toContain('~/.agent-eval')
    expect(stateDir).toContain("KEY_FILE_NAME = '.agent-eval-key'")
    expect(doc).toContain('~/.agent-eval-key')
  })

  it('says the store is only written with --store', () => {
    // The condition is `options.useStore`, and the document promises it.
    const run = readFileSync(join(repo, 'src', 'run.ts'), 'utf8')
    expect(run).toContain('if (options.useStore)')
    expect(doc).toContain('`--store` を渡さない限り、何も書きません')
  })
})
