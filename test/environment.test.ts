import { describe, expect, it } from 'vitest'
import {
  INTERPRETERS,
  SKILL_GLOBS,
  classifyPermission,
  countHooks,
  countMcpServers,
  countSkills,
  mcpSourcePaths,
  tallyPermissions,
  type ScopeDocument,
} from '@/collect/environment.js'

/**
 * Three of the counts here read zero on the machine this was written on:
 * `unrestrictedExec`, the `skills/*\/SKILL.md` glob, and MCP servers found in
 * `settings.json`. Every one of those zeros is also what a broken collector
 * produces, so each has a case below that makes it non-zero.
 */

describe('classifying a permission entry', () => {
  it('names arbitrary execution as such', () => {
    // The positive control for a count that is 0 on this machine. Without it,
    // "no unrestricted patterns" is equally satisfied by a classifier that
    // never returns the class at all.
    expect(classifyPermission('Bash(python:*)')).toBe('unrestrictedExec')
    expect(classifyPermission('Bash(*)')).toBe('unrestrictedExec')
    expect(classifyPermission('Bash(sh:*)')).toBe('unrestrictedExec')
    expect(classifyPermission('Bash(node *)')).toBe('unrestrictedExec')
  })

  it('separates an interpreter pinned to a script from a bare interpreter', () => {
    // Measured on this machine: 18 entries of this shape. Scoring them the same
    // as `Bash(python:*)` would report an open door where a named script sits.
    expect(classifyPermission('Bash(python scripts/redact.py:*)')).toBe('scriptPathFixed')
    expect(classifyPermission('Bash(node scripts/db-query.mjs:*)')).toBe('scriptPathFixed')
    expect(classifyPermission('Bash(node ../anki-new/scripts/emit-service-key.mjs:*)')).toBe('scriptPathFixed')
  })

  it('names a wildcard bounded to one CLI', () => {
    expect(classifyPermission('Bash(git push*)')).toBe('cliWildcard')
    expect(classifyPermission('Bash(wc:*)')).toBe('cliWildcard')
    expect(classifyPermission('Bash(npx vercel*)')).toBe('cliWildcard')
  })

  it('leaves an exact command in no risk class', () => {
    // The three classes are risk classes over `allow`, not a partition of it.
    // Nine entries on this machine carry no wildcard at all.
    expect(classifyPermission('Bash(git status)')).toBe('exact')
    expect(classifyPermission('WebSearch')).toBe('exact')
  })

  it('does not treat a tool name as a command line', () => {
    expect(classifyPermission('Edit')).toBe('exact')
    expect(classifyPermission('mcp__notion__search')).toBe('exact')
  })

  it('lists the interpreters it knows, since the list is the one judgement here', () => {
    // Everything else in this module is read off the file. This list is not,
    // so it is asserted rather than left implicit.
    expect([...INTERPRETERS]).toContain('python')
    expect([...INTERPRETERS]).toContain('node')
    expect([...INTERPRETERS]).toContain('bash')
    expect([...INTERPRETERS]).not.toContain('git')
  })
})

describe('tallying permissions across scopes', () => {
  const doc = (scope: string, allow: string[], deny: string[] = [], ask: string[] = []): ScopeDocument => ({
    scope,
    doc: { permissions: { allow, deny, ask } },
  })

  it('sums the scopes rather than taking the highest-precedence one', () => {
    // Claude Code applies every scope's list, so the effective surface is the
    // union. Measured here: 16 + 0 + 51 = 67 allow entries. Reporting only the
    // user scope would say 16.
    const t = tallyPermissions([
      doc('user', ['Bash(git status)'], ['Bash(rm -rf:*)']),
      doc('local', ['Bash(git push*)', 'Bash(node scripts/x.mjs:*)']),
    ])
    expect(t.allow).toBe(3)
    expect(t.deny).toBe(1)
    expect(t.scopesWithEntries).toEqual(['user', 'local'])
  })

  it('classifies allow entries and leaves deny out of the risk classes', () => {
    // A wildcard under deny is the opposite of a risk. Counting it would make a
    // machine look more open the more carefully it was locked down.
    const t = tallyPermissions([doc('local', ['Bash(git push*)'], ['Bash(python:*)'])])
    expect(t.unrestrictedExec).toBe(0)
    expect(t.cliWildcard).toBe(1)
    expect(t.deny).toBe(1)
  })

  it('finds an unrestricted entry when one is there', () => {
    const t = tallyPermissions([doc('local', ['Bash(python:*)', 'Bash(git push*)'])])
    expect(t.unrestrictedExec).toBe(1)
  })

  it('reports zero without error on a machine that configures nothing', () => {
    expect(tallyPermissions([{ scope: 'user', doc: {} }])).toMatchObject({ allow: 0, scopesWithEntries: [] })
  })
})

describe('counting skills', () => {
  const globber = (hits: Record<string, string[]>) => (pattern: string): readonly string[] => hits[pattern] ?? []

  it('counts both layouts, because the spec names only the one that is empty here', () => {
    // `skills/*/SKILL.md` matches 0 files on this machine; the 27 skills are
    // flat `skills/*.md`. A denominator of zero passes V-4, sits under W-6's
    // floor of 100, and yields 0/0 — a hole, not an error.
    const c = countSkills('/x', globber({ 'skills/*/SKILL.md': [], 'skills/*.md': ['a.md', 'b.md'] }))
    expect(c.total).toBe(2)
    expect(c.byGlob['skills/*/SKILL.md']).toBe(0)
    expect(c.byGlob['skills/*.md']).toBe(2)
  })

  it('finds the nested layout when that is the one in use', () => {
    // The positive control for the glob that reads zero here.
    const c = countSkills('/x', globber({ 'skills/*/SKILL.md': ['a/SKILL.md'], 'skills/*.md': [] }))
    expect(c.total).toBe(1)
  })

  it('does not count a skill twice when both layouts would match it', () => {
    const c = countSkills('/x', globber({ 'skills/*/SKILL.md': ['a/SKILL.md'], 'skills/*.md': ['a/SKILL.md'] }))
    expect(c.total).toBe(1)
  })

  it('keeps a zero glob in the breakdown instead of omitting it', () => {
    const c = countSkills('/x', globber({}))
    expect(Object.keys(c.byGlob).sort()).toEqual([...SKILL_GLOBS].sort())
  })
})

describe('counting hooks', () => {
  it('counts hook entries, not matcher blocks', () => {
    // Measured here: 3 events, 4 matcher blocks, 5 hooks. A tally of matchers
    // would say 4 and a tally of events would say 3.
    const c = countHooks([
      {
        scope: 'project',
        doc: {
          hooks: {
            SessionStart: [{ hooks: [{ command: 'a' }] }],
            PreToolUse: [{ hooks: [{ command: 'b' }] }, { hooks: [{ command: 'c' }] }],
            Stop: [{ hooks: [{ command: 'd' }, { command: 'e' }] }],
          },
        },
      },
    ])
    expect(c.total).toBe(5)
    expect(c.events).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
  })

  it('does not list an event whose matcher block is empty', () => {
    const c = countHooks([{ scope: 'user', doc: { hooks: { Stop: [{ hooks: [] }] } } }])
    expect(c.total).toBe(0)
    expect(c.events).toEqual([])
  })

  it('carries event names only, never a command or a path', () => {
    const c = countHooks([
      { scope: 'user', doc: { hooks: { Stop: [{ hooks: [{ command: 'python C:/secret/path.py' }] }] } } },
    ])
    expect(JSON.stringify(c)).not.toContain('secret')
  })
})

describe('counting MCP servers', () => {
  const read = (files: Record<string, string>) => (p: string): string => {
    const v = files[p]
    if (v === undefined) throw new Error('ENOENT')
    return v
  }

  it('looks where the definitions actually are, not only in settings', () => {
    // Measured: all four settings scopes report zero, and the one definition is
    // the top-level mcpServers of ~/.claude.json. A collector built from the
    // settings sweep alone gives mcpUsed a denominator of zero.
    const c = countMcpServers(
      ['/w/.mcp.json', '/h/.claude.json', '/h/.claude/settings.json'],
      read({
        '/h/.claude.json': JSON.stringify({ mcpServers: { playwright: {} } }),
        '/h/.claude/settings.json': JSON.stringify({ model: 'opus' }),
      }),
    )
    expect(c.servers).toBe(1)
    expect(c.sourcesRead).toBe(2)
  })

  it('counts claude.ai connectors, which no config file defines', () => {
    // Found by makeMetric refusing to build the result: mcpUsed came out 3/1 on
    // this machine, numerator over denominator, because three servers had been
    // called and only one was in a config file. The other nine are claude.ai
    // connectors, listed under claudeAiMcpEverConnected and nowhere else.
    //
    // The key says *ever* connected, so the denominator is "servers this
    // machine has had available", not "connected right now". denominatorMeaning
    // has to carry that.
    const c = countMcpServers(
      ['/h/.claude.json'],
      read({
        '/h/.claude.json': JSON.stringify({
          mcpServers: { playwright: {} },
          claudeAiMcpEverConnected: ['claude.ai Notion', 'claude.ai Gmail'],
        }),
      }),
    )
    expect(c.configured).toBe(1)
    expect(c.connectors).toBe(2)
    expect(c.servers).toBe(3)
  })

  it('reads a config with no connector list without inventing one', () => {
    const c = countMcpServers(['/a.json'], read({ '/a.json': JSON.stringify({ mcpServers: { x: {} } }) }))
    expect(c).toMatchObject({ servers: 1, configured: 1, connectors: 0 })
  })

  it('unions across sources without double counting a shared name', () => {
    const c = countMcpServers(
      ['/a.json', '/b.json'],
      read({
        '/a.json': JSON.stringify({ mcpServers: { x: {}, y: {} } }),
        '/b.json': JSON.stringify({ mcpServers: { y: {}, z: {} } }),
      }),
    )
    expect(c.servers).toBe(3)
  })

  it('finds a per-project nesting', () => {
    const c = countMcpServers(
      ['/a.json'],
      read({ '/a.json': JSON.stringify({ projects: { '/p': { mcpServers: { q: {} } } } }) }),
    )
    expect(c.servers).toBe(1)
  })

  it('names .mcp.json and ~/.claude.json among its sources', () => {
    const slash = (s: string): string => s.split('\\').join('/')
    const got = mcpSourcePaths('/w', '/h').map(slash)
    expect(got).toContain('/w/.mcp.json')
    expect(got).toContain('/h/.claude.json')
  })
})

describe('an interpreter told to read its program from the argument', () => {
  /**
   * `-c` is a token, is not path-shaped, and used to fall past both interpreter
   * branches into `cliWildcard` -- the class for a command whose *arguments*
   * are open. It pins nothing at all.
   *
   * The recorded control for this classifier only ever exercised the bare
   * `Bash(python:*)` shape, which is exactly where the blind spot was not.
   */
  it('is unrestricted, whichever interpreter it is', () => {
    for (const entry of [
      'Bash(python -c:*)',
      'Bash(python3 -c:*)',
      'Bash(node -e:*)',
      'Bash(bash -c:*)',
      'Bash(sh -c:*)',
      'Bash(perl -e:*)',
      'Bash(pwsh -Command:*)',
    ]) {
      expect(classifyPermission(entry), entry).toBe('unrestrictedExec')
    }
  })

  it('still separates a pinned script from an open interpreter', () => {
    // The distinction the class exists to draw, and it must survive the fix.
    expect(classifyPermission('Bash(python:*)')).toBe('unrestrictedExec')
    expect(classifyPermission('Bash(python scripts/redact.py:*)')).toBe('scriptPathFixed')
  })
})
