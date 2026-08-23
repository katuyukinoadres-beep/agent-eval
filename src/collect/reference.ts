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
 * Two things here were wrong in opposite directions, and both are worth
 * keeping in front of the code.
 *
 * The index used to keep one mention per token, latest wins. A write records
 * its own path as a mention in its own bundle, so a file written in one
 * request, genuinely re-read in a later one, then edited again had its last
 * mention overwritten by that final write -- same bundle, therefore not
 * re-used. A file someone kept maintaining scored exactly as if it had been
 * abandoned. Mentions are kept per bundle now.
 *
 * And a mention of a bare filename used to credit every path ending in it. One
 * `index.ts` in prose marked every `index.ts` on the machine as re-used. The
 * basename index is still here, because naming a file without its directory is
 * how people refer to files they just asked for, but it is trusted only when
 * exactly one full path has ever been seen under that name.
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

export interface Mention {
  readonly at: string
  /**
   * The task bundle the mention happened in.
   *
   * Axis 4 counts a re-reference only when it happens in a *different* bundle
   * from the write. Reading back a file inside the same request is verification
   * -- axis 3 already counts it -- and letting it count here would make
   * re-reading one's own output the cheapest way to raise the score.
   */
  readonly bundle: number | null
}

/** A stand-in key for "no bundle", which is a real value a mention can carry. */
const NO_BUNDLE = -1
const keyOf = (bundle: number | null): number => bundle ?? NO_BUNDLE

export interface ReferenceIndex {
  /** Records every path-shaped token in `text` as mentioned at `timestamp`. */
  readonly note: (text: string, timestamp: string | null, bundle: number | null) => void
  /** The latest mention of a path, or null. Whether it was referred to at all. */
  readonly lastMention: (path: string) => string | null
  /** The latest mention overall, with the bundle it happened in. */
  readonly lastMentionIn: (path: string) => Mention | null
  /**
   * Whether some bundle other than `bundle` mentioned this path after `after`.
   *
   * The question axis 4 actually asks. Taking the latest mention and comparing
   * its bundle answers a different one, and answers it wrong for every file
   * that was written again after being re-used.
   */
  readonly mentionedElsewhereAfter: (path: string, bundle: number | null, after: string) => boolean
  /** Distinct tokens held. Reported so an empty index is visible as empty. */
  readonly size: () => number
  /**
   * Basenames seen under more than one full path.
   *
   * Reported because it sizes what the basename fallback is worth here, and a
   * fallback nobody can size is a fallback nobody can argue with.
   */
  readonly ambiguousBasenames: () => number
}

export function referenceIndex(): ReferenceIndex {
  /** token -> bundle -> the latest timestamp it was mentioned in that bundle. */
  const byToken = new Map<string, Map<number, string>>()
  /** basename -> the distinct full paths seen under it. */
  const fullPathsOf = new Map<string, Set<string>>()

  const record = (token: string, timestamp: string, bundle: number | null): void => {
    let bundles = byToken.get(token)
    if (bundles === undefined) {
      bundles = new Map<number, string>()
      byToken.set(token, bundles)
    }
    const k = keyOf(bundle)
    const previous = bundles.get(k)
    if (previous === undefined || timestamp > previous) bundles.set(k, timestamp)
  }

  const note = (text: string, timestamp: string | null, bundle: number | null): void => {
    if (timestamp === null || text === '') return
    // Bounded: a very long row is a transcript paste, and scanning all of it
    // buys nothing a path mention in the first part does not already give.
    const body = text.length > 20_000 ? text.slice(0, 20_000) : text
    for (const match of body.matchAll(PATH_TOKEN)) {
      const raw = match[0]
      if (raw === undefined) continue
      const norm = normalisePath(raw)
      record(norm, timestamp, bundle)
      const base = basename(norm)
      if (base !== norm && base.length > 0) {
        record(base, timestamp, bundle)
        let owners = fullPathsOf.get(base)
        if (owners === undefined) {
          owners = new Set<string>()
          fullPathsOf.set(base, owners)
        }
        owners.add(norm)
      }
    }
  }

  /**
   * The tokens a path may be looked up under.
   *
   * Its own normalised form always. Its basename only when nothing else has
   * ever been seen under that name: one `index.ts` mentioned in prose is not
   * evidence about a different `index.ts`.
   */
  const tokensFor = (path: string): readonly string[] => {
    const norm = normalisePath(path)
    const base = basename(norm)
    if (base === norm) return [norm]
    const owners = fullPathsOf.get(base)
    return owners === undefined || owners.size <= 1 ? [norm, base] : [norm]
  }

  const lastMentionIn = (path: string): Mention | null => {
    let best: Mention | null = null
    for (const token of tokensFor(path)) {
      const bundles = byToken.get(token)
      if (bundles === undefined) continue
      for (const [k, at] of bundles) {
        if (best === null || at > best.at) best = { at, bundle: k === NO_BUNDLE ? null : k }
      }
    }
    return best
  }

  const mentionedElsewhereAfter = (path: string, bundle: number | null, after: string): boolean => {
    const mine = keyOf(bundle)
    for (const token of tokensFor(path)) {
      const bundles = byToken.get(token)
      if (bundles === undefined) continue
      for (const [k, at] of bundles) {
        // A mention with no bundle cannot be shown to belong to a different
        // request, so it does not count as one.
        if (k === NO_BUNDLE || k === mine) continue
        if (at > after) return true
      }
    }
    return false
  }

  const lastMention = (path: string): string | null => lastMentionIn(path)?.at ?? null

  return {
    note,
    lastMention,
    lastMentionIn,
    mentionedElsewhereAfter,
    size: () => byToken.size,
    ambiguousBasenames: () => {
      let n = 0
      for (const owners of fullPathsOf.values()) if (owners.size > 1) n += 1
      return n
    },
  }
}
