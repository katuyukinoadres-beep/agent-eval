import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SCOPES,
  enterpriseSettingsPath,
  findCleanupPeriod,
  settingsPaths,
  type ScopePath,
} from '@/collect/settings.js'

/**
 * The reason this module reports which scopes it read, and not only what it
 * found, is that reading one file and finding nothing looks exactly like reading
 * four and finding nothing. The spec's first draft read `~/.claude.json` alone;
 * both measured machines return nothing there, and on one of them the real value
 * was in `~/.claude/settings.json` the whole time.
 */

const paths = (...scopes: string[]): ScopePath[] =>
  scopes.map((s) => ({ scope: s as ScopePath['scope'], path: `/fake/${s}.json` }))

/** A reader over an in-memory filesystem; anything not named throws, as ENOENT does. */
const reader = (files: Record<string, string>) => (p: string): string => {
  const v = files[p]
  if (v === undefined) throw new Error(`ENOENT: ${p}`)
  return v
}

describe('the sweep reports its own range', () => {
  it('finds nothing on a machine that defines nothing — and says it looked', () => {
    // This machine, measured: the key is absent from all four scopes, and three
    // of the four files do not exist at all.
    const r = findCleanupPeriod(
      paths('enterprise', 'local', 'project', 'user'),
      reader({ '/fake/user.json': JSON.stringify({ model: 'opus', hooks: {} }) }),
    )
    expect(r.days).toBeNull()
    expect(r.foundAt).toBeNull()
    expect(r.scopesRead).toEqual(['user'])
  })

  it('finds the value when a scope holds it', () => {
    // The positive control. Without it, the assertion above is equally satisfied
    // by a reader that never opens anything.
    const r = findCleanupPeriod(
      paths('enterprise', 'local', 'project', 'user'),
      reader({ '/fake/user.json': JSON.stringify({ cleanupPeriodDays: 14 }) }),
    )
    expect(r.days).toBe(14)
    expect(r.foundAt).toBe('user')
  })

  it('does not answer to a near-miss key name', () => {
    const r = findCleanupPeriod(
      paths('user'),
      reader({ '/fake/user.json': JSON.stringify({ cleanup_period_days: 14 }) }),
    )
    expect(r.days).toBeNull()
  })

  it('ignores a non-numeric value rather than passing it through', () => {
    const r = findCleanupPeriod(
      paths('user'),
      reader({ '/fake/user.json': JSON.stringify({ cleanupPeriodDays: '14' }) }),
    )
    expect(r.days).toBeNull()
    expect(r.scopesRead).toEqual(['user'])
  })
})

describe('precedence', () => {
  it('takes the highest-precedence definition, not the last one seen', () => {
    const r = findCleanupPeriod(
      paths('enterprise', 'local', 'project', 'user'),
      reader({
        '/fake/local.json': JSON.stringify({ cleanupPeriodDays: 7 }),
        '/fake/user.json': JSON.stringify({ cleanupPeriodDays: 30 }),
      }),
    )
    expect(r.days).toBe(7)
    expect(r.foundAt).toBe('local')
  })

  it('keeps opening lower scopes after a hit, so the range stays honest', () => {
    // Stopping at the first hit would report `scopesRead: ['local']` and leave
    // the reader unable to tell a one-file sweep from a four-file one.
    const r = findCleanupPeriod(
      paths('local', 'user'),
      reader({
        '/fake/local.json': JSON.stringify({ cleanupPeriodDays: 7 }),
        '/fake/user.json': JSON.stringify({ model: 'opus' }),
      }),
    )
    expect(r.scopesRead).toEqual(['local', 'user'])
  })

  it('lists enterprise first, because managed policy overrides the rest', () => {
    expect([...SETTINGS_SCOPES]).toEqual(['enterprise', 'local', 'project', 'user'])
  })
})

describe('a file that is there but unusable', () => {
  it('is reported, not counted as absent', () => {
    // Absent and corrupt are different facts about the machine. Folding them
    // together is how a parse failure becomes a clean reading.
    const r = findCleanupPeriod(paths('user'), reader({ '/fake/user.json': '{ not json' }))
    expect(r.scopesUnreadable).toEqual(['user'])
    expect(r.scopesRead).toEqual([])
  })

  it('treats a JSON array as unusable rather than indexing into it', () => {
    const r = findCleanupPeriod(paths('user'), reader({ '/fake/user.json': '[1,2,3]' }))
    expect(r.scopesUnreadable).toEqual(['user'])
  })
})

describe('paths', () => {
  it('puts managed settings where each platform keeps them', () => {
    expect(enterpriseSettingsPath('win32')).toContain('ProgramData')
    expect(enterpriseSettingsPath('darwin')).toContain('Library')
    expect(enterpriseSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json')
  })

  it('derives project and local scopes from the working directory', () => {
    // Separators are normalised before comparison: join() emits backslashes on
    // Windows and forward slashes elsewhere, and asserting one of them makes the
    // test pass on the machine it was written on and nowhere else.
    const slash = (s: string): string => s.split('\\').join('/')
    const got = settingsPaths('/w', '/h', 'linux')
    expect(got.map((p) => p.scope)).toEqual(['enterprise', 'local', 'project', 'user'])
    expect(slash(got[1]?.path ?? '')).toBe('/w/.claude/settings.local.json')
    expect(slash(got[2]?.path ?? '')).toBe('/w/.claude/settings.json')
    expect(slash(got[3]?.path ?? '')).toBe('/h/.claude/settings.json')
  })
})
