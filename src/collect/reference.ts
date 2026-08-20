/**
 * Where a path was mentioned after it was written.
 *
 * This feeds condition (a) of P6's uptake: a written file that something later
 * refers to was used, and one nothing ever mentions again may just have been
 * produced. v1 weights the second at 0.4 rather than dropping it, because
 * "written and never referenced" is a real outcome and not necessarily a
 * worthless one.
 *
 * Matching is done by extracting path-shaped tokens from each row and looking
 * them up afterwards, rather than searching every row for every known path.
 * The second is 30,000 rows against 356 paths, and the tokens are bounded by
 * what the log actually mentions.
 *
 * Tokens are normalised, never stored as written, and never emitted. What
 * leaves this module is one timestamp per path.
 */

/**
 * Path-shaped runs of text.
 *
 * Three shapes: a Windows absolute path, a POSIX absolute path, and a bare
 * filename with an extension. The third is what catches `scripts/foo.mjs`
 * mentioned in prose, which is how people refer to files they just asked for.
 */
const PATH_TOKEN = /[A-Za-z]:[\\/][^\s"'`,;()[\]]+|\/[^\s"'`,;()[\]]{2,}|[\w.-]+\.[A-Za-z0-9]{1,6}/g

/**
 * Lowercased, forward-slashed.
 *
 * Case because Windows paths arrive in both, separators because the same file
 * appears as `c:\a\b.ts` in one row and `c:/a/b.ts` in the next. Without this
 * a file counts as referenced only when the two spellings happen to agree.
 */
export const normalisePath = (s: string): string => s.split('\\').join('/').toLowerCase()

/** The trailing segment, which is how a file is usually named in prose. */
export const basename = (s: string): string => {
  const norm = normalisePath(s)
  const at = norm.lastIndexOf('/')
  return at === -1 ? norm : norm.slice(at + 1)
}

export interface ReferenceIndex {
  /** Records every path-shaped token in `text` as mentioned at `timestamp`. */
  readonly note: (text: string, timestamp: string | null) => void
  /** The latest mention of a path or its basename, or null. */
  readonly lastMention: (path: string) => string | null
  /** Distinct tokens held. Reported so an empty index is visible as empty. */
  readonly size: () => number
}

export function referenceIndex(): ReferenceIndex {
  const latest = new Map<string, string>()

  const record = (token: string, timestamp: string): void => {
    const previous = latest.get(token)
    if (previous === undefined || timestamp > previous) latest.set(token, timestamp)
  }

  const note = (text: string, timestamp: string | null): void => {
    if (timestamp === null || text === '') return
    // Bounded: a very long row is a transcript paste, and scanning all of it
    // buys nothing a path mention in the first part does not already give.
    const body = text.length > 20_000 ? text.slice(0, 20_000) : text
    for (const match of body.matchAll(PATH_TOKEN)) {
      const raw = match[0]
      if (raw === undefined) continue
      const norm = normalisePath(raw)
      record(norm, timestamp)
      const base = basename(norm)
      if (base !== norm && base.length > 0) record(base, timestamp)
    }
  }

  const lastMention = (path: string): string | null => {
    const norm = normalisePath(path)
    const direct = latest.get(norm)
    const byName = latest.get(basename(norm))
    if (direct === undefined) return byName ?? null
    if (byName === undefined) return direct
    return direct > byName ? direct : byName
  }

  return { note, lastMention, size: () => latest.size }
}
