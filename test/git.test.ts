import { describe, expect, it } from 'vitest'
import { GIT_ARGS, gitCommitDates } from '@/collect/git.js'

/**
 * Two things are pinned here, and only one of them is behaviour.
 *
 * The other is the argument list. This is the first place a git client enters
 * the tool, which makes it the cheapest place to start asking git for more —
 * PR counts, merge attribution, revert rates. The axes spec rejected all of
 * those: `pr-link` was 284 on one measured machine and 0 on the other, so
 * anything built on it scores which host you use. Asserting the argv means a
 * second question has to go through a test that says why the first one is the
 * only one.
 */

describe('the only question asked of git', () => {
  it('is commit dates, in a fixed format', () => {
    expect([...GIT_ARGS]).toEqual(['log', '--format=%cd', '--date=short'])
  })

  it('asks nothing else, and names no ref, path or author', () => {
    const argv = [...GIT_ARGS].join(' ')
    for (const forbidden of ['--author', '--name-only', '--stat', 'origin', 'HEAD', '%H', '%s', '%an']) {
      expect(argv, `argv must not mention ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('passes the repository through -C rather than changing directory', () => {
    const seen: Array<{ repo: string; args: readonly string[] }> = []
    gitCommitDates(['/r'], (repo, args) => {
      seen.push({ repo, args })
      return ''
    })
    expect(seen).toEqual([{ repo: '/r', args: GIT_ARGS }])
  })
})

describe('what it counts', () => {
  const run = (out: Record<string, string>) => (repo: string): string => {
    const v = out[repo]
    if (v === undefined) throw new Error('not a repository')
    return v
  }

  it('collects distinct dates across repositories', () => {
    const r = gitCommitDates(
      ['/a', '/b'],
      run({ '/a': '2026-08-19\n2026-08-19\n2026-08-20\n', '/b': '2026-08-20\n2026-04-20\n' }),
    )
    expect(r.dates).toEqual(['2026-04-20', '2026-08-19', '2026-08-20'])
    expect(r.reposAnswered).toBe(2)
  })

  it('counts a repository that failed rather than dropping it', () => {
    // Silent is the state that matters: a path that is not a repository and a
    // repository with no commits both produce no dates, and neither should
    // vanish into a total that looks complete.
    const r = gitCommitDates(['/a', '/missing'], run({ '/a': '2026-08-19\n' }))
    expect(r.reposAnswered).toBe(1)
    expect(r.reposSilent).toBe(1)
  })

  it('counts an empty repository as silent, not as answered', () => {
    const r = gitCommitDates(['/a'], run({ '/a': '' }))
    expect(r.reposAnswered).toBe(0)
    expect(r.reposSilent).toBe(1)
  })

  it('drops a line that is not a plain date instead of counting it', () => {
    // A locale or a format override turns %cd into something else. Taking the
    // first ten characters of whatever arrives would produce dates that sort
    // and count fine and mean nothing.
    const r = gitCommitDates(['/a'], run({ '/a': 'Wed Aug 19 2026\n2026-08-19\ngarbage\n' }))
    expect(r.dates).toEqual(['2026-08-19'])
  })

  it('returns nothing when asked about nothing', () => {
    const r = gitCommitDates([], () => '')
    expect(r).toEqual({ dates: [], reposAnswered: 0, reposSilent: 0 })
  })
})
