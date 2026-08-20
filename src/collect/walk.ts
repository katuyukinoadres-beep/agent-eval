/**
 * Enumerates the transcript files, and nothing else.
 *
 * No file is opened here. That is the point rather than an optimisation: this
 * module decides which files are subagent transcripts, and the only honest way
 * to decide it is by where a file sits. `isSidechain` is false on every row of
 * every main transcript on both measured machines, so a classifier reading it
 * returns "no subagents" while a quarter to a third of the lines are sitting in
 * the subtree it just declared empty. A module that cannot read a file cannot be
 * tempted to ask it.
 *
 * Parsing, and therefore the manifest, belongs to the next stage. Splitting them
 * is not tidiness either: counting lines requires opening every file, and the
 * next stage's whole guarantee is that it opens each file exactly once.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * A glob that was walked, and how many files it actually matched.
 *
 * Reported from the walk rather than from a constant, because a glob that
 * matches nothing has to be visible. The reference implementation declares its
 * roots in one place and walks in another, so its manifest reports the right
 * strings no matter what the walker did — and the levelling is easy to get
 * wrong: `projects/*` + `/*.jsonl` finds 11 files on this machine while
 * `projects/*` + `/*` + `/*.jsonl` finds 0.
 */
export interface WalkedRoot {
  readonly glob: string
  readonly matchCount: number
}

export type FileKind = 'main' | 'sub'

export interface FileEntry {
  readonly path: string
  /** Decided by position in the tree. Never by anything inside the file. */
  readonly kind: FileKind
  /** Directory name under projects/. Hashed before it can reach a payload. */
  readonly project: string
  /**
   * The session this file belongs to. For a subagent transcript that is the
   * parent session, recovered from the directory it lives under, which is the
   * only place the relationship is recorded once you stop trusting isSidechain.
   */
  readonly sessionId: string
  readonly bytes: number
}

export interface ProjectInventory {
  readonly project: string
  readonly mainFiles: number
  readonly subFiles: number
  readonly bytes: number
}

export interface Inventory {
  readonly rootsWalked: readonly WalkedRoot[]
  readonly files: readonly FileEntry[]
  readonly projects: readonly ProjectInventory[]
}

export const MAIN_GLOB = 'projects/*/*.jsonl'
export const SUB_GLOB = 'projects/*/*/subagents/**/*.jsonl'

const isJsonl = (name: string): boolean => name.endsWith('.jsonl')
const stripExt = (name: string): string => name.slice(0, -'.jsonl'.length)

function dirsIn(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function filesIn(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Every .jsonl under a directory, at any depth. */
function jsonlBelow(dir: string, out: string[] = []): string[] {
  for (const name of filesIn(dir)) if (isJsonl(name)) out.push(join(dir, name))
  for (const sub of dirsIn(dir)) jsonlBelow(join(dir, sub), out)
  return out
}

/**
 * Walk a `~/.claude/projects` directory.
 *
 * `projectsRoot` is passed in rather than resolved from the home directory so
 * tests can point it at a temporary tree. Fixtures are generated, never
 * committed — the repository ignores *.jsonl precisely so a real transcript
 * cannot be checked in by accident, and a fixture built from one would carry
 * conversation text into git.
 */
export function walkProjects(projectsRoot: string): Inventory {
  const files: FileEntry[] = []
  const projects: ProjectInventory[] = []
  let mainMatches = 0
  let subMatches = 0

  for (const project of dirsIn(projectsRoot).sort()) {
    const projectDir = join(projectsRoot, project)
    let mainFiles = 0
    let subFiles = 0
    let bytes = 0

    // main: projects/<project>/<session>.jsonl
    for (const name of filesIn(projectDir).sort()) {
      if (!isJsonl(name)) continue
      const path = join(projectDir, name)
      const size = sizeOf(path)
      files.push({ path, kind: 'main', project, sessionId: stripExt(name), bytes: size })
      mainFiles += 1
      bytes += size
      mainMatches += 1
    }

    // sub: projects/<project>/<session>/subagents/**/*.jsonl
    for (const sessionId of dirsIn(projectDir).sort()) {
      const subagents = join(projectDir, sessionId, 'subagents')
      for (const path of jsonlBelow(subagents).sort()) {
        const size = sizeOf(path)
        // sessionId is the directory the subagents tree hangs off, so a
        // subagent transcript keeps the parent it belongs to.
        files.push({ path, kind: 'sub', project, sessionId, bytes: size })
        subFiles += 1
        bytes += size
        subMatches += 1
      }
    }

    projects.push({ project, mainFiles, subFiles, bytes })
  }

  return {
    rootsWalked: [
      { glob: MAIN_GLOB, matchCount: mainMatches },
      { glob: SUB_GLOB, matchCount: subMatches },
    ],
    files,
    projects,
  }
}

/** True when the path sits under a `subagents` directory. The whole classifier. */
export function isSubagentPath(path: string): boolean {
  return path.split(/[\\/]/).includes('subagents')
}

/** Project directory names, for hashing into ids before anything is submitted. */
export function projectNames(inv: Inventory): readonly string[] {
  return inv.projects.map((p) => p.project)
}

export function fileName(entry: FileEntry): string {
  return basename(entry.path)
}
