/**
 * The effective `cleanupPeriodDays`, and which scope it came from.
 *
 * The spec's first draft read this from `~/.claude.json`. Both measured
 * machines return nothing there: on the other one the real value (14) lives in
 * `~/.claude/settings.json`, and on this one the key is absent from all four
 * scopes. Reading one file and reporting `null` would have looked identical to
 * reading four and finding nothing, which is why the scope is reported too.
 *
 * What is reported is the scope NAME, never the path. A project-scope path is
 * the working directory, which carries the home directory, the OS user name and
 * often a client or project name — the same reason `projects[].name` is a hash
 * in the payload.
 */

import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * Ordered by precedence, highest first. Enterprise settings are managed policy
 * and win outright; below that the more local a file is, the more specific it
 * is taken to be.
 */
export const SETTINGS_SCOPES = ['enterprise', 'local', 'project', 'user'] as const

export type SettingsScope = (typeof SETTINGS_SCOPES)[number]

/** Where managed policy lives, which is the one path that varies by platform. */
export function enterpriseSettingsPath(os: string = platform()): string {
  if (os === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

export interface ScopePath {
  readonly scope: SettingsScope
  readonly path: string
}

/** The four files, in precedence order. `cwd` supplies the two project-local ones. */
export function settingsPaths(cwd: string, home: string = homedir(), os: string = platform()): readonly ScopePath[] {
  return [
    { scope: 'enterprise', path: enterpriseSettingsPath(os) },
    { scope: 'local', path: join(cwd, '.claude', 'settings.local.json') },
    { scope: 'project', path: join(cwd, '.claude', 'settings.json') },
    { scope: 'user', path: join(home, '.claude', 'settings.json') },
  ]
}

export interface CleanupPeriod {
  readonly days: number | null
  readonly foundAt: SettingsScope | null
  /**
   * Scopes that exist and parsed, whether or not they held the key.
   *
   * Without this, "the key is absent" and "every file failed to open" produce
   * the same `null`. The first is a fact about the machine; the second is a
   * fact about the reader.
   */
  readonly scopesRead: readonly SettingsScope[]
  /** Scopes present but unparseable. Reported rather than swallowed. */
  readonly scopesUnreadable: readonly SettingsScope[]
}

type Reader = (path: string) => string

/**
 * Reads the four scopes in precedence order and returns the first definition.
 *
 * `read` is injectable so a test can supply a scope that does hold the key.
 * Reporting an absence without ever having seen the detector find a presence is
 * how a broken reader passes for a clean machine.
 */
export function findCleanupPeriod(
  paths: readonly ScopePath[],
  read: Reader = (p) => readFileSync(p, 'utf8'),
): CleanupPeriod {
  const scopesRead: SettingsScope[] = []
  const scopesUnreadable: SettingsScope[] = []
  let days: number | null = null
  let foundAt: SettingsScope | null = null

  for (const { scope, path } of paths) {
    let raw: string
    try {
      raw = read(path)
    } catch {
      // Absent is the common case and not an error: three of the four scopes do
      // not exist on a typical machine.
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      scopesUnreadable.push(scope)
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      scopesUnreadable.push(scope)
      continue
    }
    scopesRead.push(scope)
    // Precedence: the first scope that defines it wins, and later ones are still
    // opened so scopesRead reflects the whole sweep rather than stopping short.
    if (foundAt === null) {
      const v = (parsed as Record<string, unknown>)['cleanupPeriodDays']
      if (typeof v === 'number' && Number.isFinite(v)) {
        days = v
        foundAt = scope
      }
    }
  }

  return { days, foundAt, scopesRead, scopesUnreadable }
}
