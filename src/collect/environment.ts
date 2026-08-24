/**
 * What the environment is configured to be: permissions, skills, hooks, MCP
 * servers.
 *
 * Everything here is read from configuration rather than from transcripts, and
 * everything that leaves is a count or a class name. That constraint is not
 * decorative. The permission entries on this machine include
 * `node scripts/emit-service-key.mjs:*`, `node scripts/ban-test-accounts.mjs:*`
 * and `node ../anki-new/scripts/emit-service-key.mjs:*` — script names that
 * describe what the machine is allowed to do, and a relative path naming a
 * second project. The spec sketched shipping these as strings
 * (`"effectivelyUnrestrictedPatterns": ["Bash(python:*)"]`); classifying them
 * answers the same question without carrying any of that.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * Commands that run whatever they are given.
 *
 * A closed list, and an incomplete one by nature — this is the one judgement in
 * the module that is not derived from the file being read. It errs toward
 * naming things: a command wrongly on the list overstates risk in a count,
 * while one wrongly off it reports an open door as a closed one.
 */
export const INTERPRETERS = [
  'bash', 'sh', 'zsh', 'ksh', 'fish',
  'python', 'python3', 'py',
  'node', 'deno', 'bun',
  'perl', 'ruby', 'php',
  'pwsh', 'powershell', 'cmd',
  'osascript', 'eval', 'exec',
] as const

export type PermissionClass = 'unrestrictedExec' | 'cliWildcard' | 'scriptPathFixed' | 'exact'

/** A token that looks like a file being named, rather than a flag or a subcommand. */
const looksLikePath = (t: string): boolean =>
  t.includes('/') || t.includes('\\') || /\.(mjs|cjs|js|ts|py|sh|rb|pl|ps1)$/.test(t)

const isInterpreter = (t: string): boolean =>
  (INTERPRETERS as readonly string[]).includes(t.toLowerCase())

/**
 * Classifies one allow entry.
 *
 * Only `allow`. A wildcard under `deny` is the opposite of a risk, and a
 * classifier that scored it the same way would report a machine as more open
 * the more carefully it was locked down.
 */
export function classifyPermission(entry: string): PermissionClass {
  const bash = /^Bash\((.*)\)$/.exec(entry.trim())
  // Non-Bash entries name a tool, not a command line: Edit, Write, WebSearch,
  // Skill, an MCP method. None of them executes arbitrary code.
  if (bash === null) return entry.trim().endsWith('*') ? 'cliWildcard' : 'exact'

  const inner = (bash[1] ?? '').trim()
  if (inner === '' || inner === '*') return 'unrestrictedExec'

  // `cmd:*` and `cmd arg*` are the two shapes settings files use.
  const tokens = inner.split(/[\s:]+/).filter((t) => t.length > 0)
  const head = tokens[0]
  if (head === undefined) return 'unrestrictedExec'

  const rest = tokens.slice(1)
  const named = rest.filter((t) => t !== '*')

  if (isInterpreter(head)) {
    // `Bash(python:*)` — the interpreter with nothing constraining what it runs.
    // This is the spec's own example, and the reason the class exists.
    if (named.length === 0) return 'unrestrictedExec'
    // `Bash(python -c:*)` — the interpreter reading its program from the
    // argument. It pins nothing at all, and it used to land in `cliWildcard`
    // because `-c` is a token, is not path-shaped, and fell past both branches.
    // The recorded positive control only ever exercised the bare `python:*`
    // shape, which is precisely where the blind spot was not. Same for
    // `node -e`, `bash -c`, `pwsh -Command` and `perl -e`.
    if (named.some(isInlineCodeFlag)) return 'unrestrictedExec'
    // `Bash(python scripts/redact.py:*)` — the script is pinned, the arguments
    // are not. That is a different thing from arbitrary code.
    if (named.some(looksLikePath)) return 'scriptPathFixed'
    return 'cliWildcard'
  }

  if (named.some(looksLikePath)) return 'scriptPathFixed'
  return inner.endsWith('*') ? 'cliWildcard' : 'exact'
}

/**
 * Flags that make an interpreter read its program from the command line.
 *
 * Matched case-insensitively because PowerShell writes `-Command` and shells
 * are inconsistent about it. A miss here reports an open door as a closed one.
 */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-command', '-encodedcommand', '--command', '--eval', '-ec'])

const isInlineCodeFlag = (token: string): boolean => INLINE_CODE_FLAGS.has(token.toLowerCase())

export interface PermissionTally {
  readonly allow: number
  readonly deny: number
  readonly ask: number
  readonly unrestrictedExec: number
  readonly cliWildcard: number
  readonly scriptPathFixed: number
  /** Scopes that contributed at least one entry. */
  readonly scopesWithEntries: readonly string[]
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export interface ScopeDocument {
  readonly scope: string
  readonly doc: Json
}

/**
 * Merges the permission lists across scopes and classifies the allow entries.
 *
 * A merge, not an override: Claude Code applies every scope's list, so the
 * effective surface is the union. Reporting the highest-precedence scope alone
 * would have said 16 allow entries on this machine where 67 apply.
 */
export function tallyPermissions(docs: readonly ScopeDocument[]): PermissionTally {
  let allow = 0
  let deny = 0
  let ask = 0
  let unrestrictedExec = 0
  let cliWildcard = 0
  let scriptPathFixed = 0
  const scopes: string[] = []

  for (const { scope, doc } of docs) {
    const perm = doc['permissions']
    if (!isObj(perm)) continue
    const a = strings(perm['allow'])
    const d = strings(perm['deny'])
    const k = strings(perm['ask'])
    if (a.length + d.length + k.length > 0) scopes.push(scope)
    allow += a.length
    deny += d.length
    ask += k.length
    for (const entry of a) {
      const cls = classifyPermission(entry)
      if (cls === 'unrestrictedExec') unrestrictedExec += 1
      else if (cls === 'cliWildcard') cliWildcard += 1
      else if (cls === 'scriptPathFixed') scriptPathFixed += 1
    }
  }

  return { allow, deny, ask, unrestrictedExec, cliWildcard, scriptPathFixed, scopesWithEntries: scopes }
}

// ── skills ────────────────────────────────────────────────────────────────────

/**
 * Both layouts, counted as a union.
 *
 * The spec's denominator for `skillFired` is the first of these. It matches 0
 * files on this machine, where 27 skills live flat in the second. A denominator
 * of zero passes V-4 (both parts are present), sits under W-6's floor of 100,
 * and produces a rate of 0/0 — a silent hole rather than an error. Counting both
 * and recording which one produced the number is the fix.
 */
export const SKILL_GLOBS = ['skills/*/SKILL.md', 'skills/*.md'] as const

export interface SkillCount {
  readonly total: number
  /** Per glob, so a layout that matched nothing is visible rather than absent. */
  readonly byGlob: Readonly<Record<string, number>>
}

type Globber = (pattern: string, cwd: string) => readonly string[]

/**
 * The two skill layouts, read directly rather than globbed.
 *
 * `SKILL_GLOBS` has exactly two entries and both are one level deep, so no
 * general glob engine is needed — and needing one was a distribution problem.
 * `globSync` is a recent addition to `node:fs`, newer than the Node version
 * this package declares support for, and a missing named export from a builtin
 * is a link-time SyntaxError: it happens before any code runs, so the
 * try/catch that used to wrap this could never have caught it. The whole tool
 * would have failed to start on a supported runtime.
 *
 * A pattern this does not recognise returns nothing rather than guessing, and a
 * test asserts both halves — that the two known shapes find files, and that an
 * unknown one finds none.
 */
const defaultGlobber: Globber = (pattern, cwd) => {
  const base = join(cwd, 'skills')
  let entries: Dirent[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    // No skills directory is not an error; it is an environment with no skills.
    return []
  }
  if (pattern === 'skills/*.md') {
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `skills/${e.name}`)
  }
  if (pattern === 'skills/*/SKILL.md') {
    return entries
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(base, e.name, 'SKILL.md')))
      .map((e) => `skills/${e.name}/SKILL.md`)
  }
  return []
}

/**
 * Skills defined across every directory that can hold them.
 *
 * Takes a list, because the denominator has to cover the same ground as the
 * numerator. `attributionSkill` is collected across every project on the
 * machine while this counted one `.claude` directory, so running from a
 * repository with fewer skills than the log mentions made the numerator exceed
 * the denominator -- and `makeMetric` refuses that by throwing, from a call
 * nothing catches. The tool produced nothing at all.
 *
 * A leading underscore marks a skill as disabled; the payload spec excludes
 * them, and counting them pads a denominator with things that cannot fire.
 */
export function countSkills(
  claudeDirs: readonly string[] | string,
  glob: Globber = defaultGlobber,
): SkillCount {
  const dirs = typeof claudeDirs === 'string' ? [claudeDirs] : claudeDirs
  const byGlob: Record<string, number> = {}
  const seen = new Set<string>()
  for (const pattern of SKILL_GLOBS) {
    let hits = 0
    for (const dir of dirs) {
      for (const h of glob(pattern, dir)) {
        if (isDisabledSkill(h)) continue
        hits += 1
        // Deduplicated: two layouts can match the same file, and a skill counted
        // twice inflates a denominator, which lowers a rate and looks like care.
        seen.add(`${dir}/${h}`)
      }
    }
    byGlob[pattern] = hits
  }
  return { total: seen.size, byGlob }
}

/** A leading underscore on the skill's own name marks it disabled. */
export const isDisabledSkill = (path: string): boolean => {
  const parts = path.split('/').filter((x) => x.length > 0)
  // `skills/_foo.md` and `skills/_foo/SKILL.md` -- the name is the segment
  // after `skills/`, which is the last one for a flat layout and the
  // second-to-last for a directory one.
  const name = parts[parts.length - 1] === 'SKILL.md' ? parts[parts.length - 2] : parts[parts.length - 1]
  return name !== undefined && name.startsWith('_')
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export interface HookCount {
  readonly total: number
  /** Events that have at least one hook. Names only — never a command or path. */
  readonly events: readonly string[]
}

export function countHooks(docs: readonly ScopeDocument[]): HookCount {
  let total = 0
  const events = new Set<string>()
  for (const { doc } of docs) {
    const hooks = doc['hooks']
    if (!isObj(hooks)) continue
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) continue
      let n = 0
      for (const m of matchers) {
        if (isObj(m) && Array.isArray(m['hooks'])) n += m['hooks'].length
      }
      if (n > 0) {
        events.add(event)
        total += n
      }
    }
  }
  return { total, events: [...events].sort() }
}

// ── MCP servers ───────────────────────────────────────────────────────────────

/**
 * Where server definitions actually live, measured rather than assumed.
 *
 * Not in `settings*.json`: all four scopes report zero on this machine, and the
 * one definition is the top-level `mcpServers` of `~/.claude.json`. A collector
 * built from the settings sweep alone would give `mcpUsed` a denominator of
 * zero — the 0/0 shape again.
 */
export function mcpSourcePaths(cwd: string, home: string): readonly string[] {
  return [join(cwd, '.mcp.json'), join(home, '.claude.json'), join(home, '.claude', 'settings.json')]
}

export interface McpCount {
  /** Locally configured servers plus claude.ai connectors ever connected. */
  readonly servers: number
  /** Of those, the ones defined in a config file on this machine. */
  readonly configured: number
  /**
   * Of those, claude.ai connectors.
   *
   * The key is `claudeAiMcpEverConnected`, and *ever* is load-bearing: a
   * connector used once and dropped stays in the list. The denominator is
   * therefore "servers this machine has had available", not "servers connected
   * right now", and `denominatorMeaning` has to say so.
   */
  readonly connectors: number
  readonly sourcesRead: number
}

type Reader = (path: string) => string

export function countMcpServers(
  paths: readonly string[],
  read: Reader = (p) => readFileSync(p, 'utf8'),
): McpCount {
  const configured = new Set<string>()
  const connectors = new Set<string>()
  let sourcesRead = 0
  for (const path of paths) {
    let doc: unknown
    try {
      doc = JSON.parse(read(path))
    } catch {
      continue
    }
    if (!isObj(doc)) continue
    sourcesRead += 1
    const servers = doc['mcpServers']
    if (isObj(servers)) for (const name of Object.keys(servers)) configured.add(name)
    // Some layouts nest a server map per project.
    const projects = doc['projects']
    if (isObj(projects)) {
      for (const entry of Object.values(projects)) {
        if (!isObj(entry)) continue
        const nested = entry['mcpServers']
        if (isObj(nested)) for (const name of Object.keys(nested)) configured.add(name)
      }
    }
    // claude.ai connectors leave no server definition anywhere else. Counting
    // only config files gave a denominator of 1 against a numerator of 3 on this
    // machine -- the 107% shape again, numerator and denominator taken from
    // different universes. makeMetric refuses to build it, which is how it was
    // found rather than shipped.
    for (const name of strings(doc['claudeAiMcpEverConnected'])) connectors.add(name)
  }
  const all = new Set<string>([...configured, ...connectors])
  return { servers: all.size, configured: configured.size, connectors: connectors.size, sourcesRead }
}
