/**
 * Commit dates, and nothing else.
 *
 * This is the first place a git client enters the tool, which makes it the
 * cheapest place to start asking git for more: PR counts, merge attribution,
 * revert rates. The axes spec rejected all of those in v1 §15 — `pr-link` was
 * 284 on this machine and 0 on the other, so anything built on it measures which
 * host you use rather than how you work. The command is fixed here and a test
 * asserts the argument list, so adding a second question means changing a test
 * that says why the first one is the only one.
 *
 * Dates only. A commit's message, hash, author and file list all identify the
 * work; the date identifies only that a day had work in it.
 */

import { execFileSync } from 'node:child_process'

/** The only git invocation this tool makes. */
export const GIT_ARGS = ['log', '--format=%cd', '--date=short'] as const

/** A YYYY-MM-DD line, so a locale or format surprise is dropped rather than counted. */
const DATE_LINE = /^\d{4}-\d{2}-\d{2}$/

type Runner = (repo: string, args: readonly string[]) => string

const defaultRunner: Runner = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })

export interface GitDays {
  /** Distinct commit dates across every repository that answered. */
  readonly dates: readonly string[]
  /** Repositories that produced at least one date. */
  readonly reposAnswered: number
  /** Repositories asked but which failed or held no commits. */
  readonly reposSilent: number
}

/**
 * Collects commit dates from repositories given explicitly.
 *
 * Explicitly, because the transcript directory cannot supply them. Project
 * directories are named by replacing every separator in the working directory
 * with a hyphen, so `C--Users-x-My-Project` could decode to
 * `C:\Users\x\My-Project` or `C:\Users\x\My\Project` with nothing in the
 * name to say which. A decoder would be right most of the time, and the times it
 * was wrong would look like a repository with no commits — the silent-zero shape
 * this project exists to stop.
 *
 * When no repository is supplied, git simply does not contribute, and
 * `activeDaysMethod` says so.
 */
export function gitCommitDates(repos: readonly string[], run: Runner = defaultRunner): GitDays {
  const dates = new Set<string>()
  let answered = 0
  let silent = 0

  for (const repo of repos) {
    let out: string
    try {
      out = run(repo, GIT_ARGS)
    } catch {
      silent += 1
      continue
    }
    const found = out.split('\n').map((l) => l.trim()).filter((l) => DATE_LINE.test(l))
    if (found.length === 0) {
      silent += 1
      continue
    }
    answered += 1
    for (const d of found) dates.add(d)
  }

  return { dates: [...dates].sort(), reposAnswered: answered, reposSilent: silent }
}
