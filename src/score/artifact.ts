/**
 * P6, scoring half — which written files count as settled artifacts.
 *
 * v1 hardened this definition after it was attacked hardest, and two of the
 * changes are worth restating because they run against intuition.
 *
 * "Never edited again" was dropped as a condition. Of 1,498 edited paths when it
 * was measured, only 135 (9.0%) were re-edited across two or more sessions —
 * so 91% were write-once, and requiring no further edits made the files someone
 * kept maintaining disappear from the denominator. Depth of re-editing belongs
 * in the numerator, not in whether the artifact exists.
 *
 * Weight comes from lines written, never from the file's size on disk. 180 of
 * the 355 edited paths here sit outside the working tree. Existence is checked;
 * no byte is read.
 */

import { existsSync } from 'node:fs'
import type { PathTally } from '../collect/artifact.js'

/** Writes inside the last three days are still in flight. Right-censoring, per v1. */
export const CENSOR_DAYS = 3

/** Weight floor and ceiling, from v1's clip(). */
export const WEIGHT_FLOOR = 0.5
export const WEIGHT_CEILING = 3.0

/** The line count at which weight is exactly 1.0. */
export const WEIGHT_PIVOT = 50

/** Uptake when nothing later referred to the file. Not zero: it was still written. */
export const UPTAKE_UNREFERENCED = 0.4
export const UPTAKE_REFERENCED = 1.0

/** Cluster members past the first are dropped; bundles are capped at this many. */
export const MAX_PER_BUNDLE = 3

export type NotSettledReason = 'written-too-recently' | 'no-longer-exists'

export interface Artifact {
  readonly path: string
  readonly weight: number
  readonly uptake: number
  readonly newLines: number
  readonly newLinesKnown: boolean
  readonly bundle: number | null
}

export interface ArtifactSet {
  /** Settled artifacts after clustering and the per-bundle cap. */
  readonly artifacts: readonly Artifact[]
  /** Summed weight — the denominator axes 1, 4 and 8 share. */
  readonly totalWeight: number
  /** Paths written in the window, before any condition was applied. */
  readonly consideredPaths: number
  /** Why the rest are not settled. Counted, so a filter that ate most says so. */
  readonly notSettled: Readonly<Record<NotSettledReason, number>>
  /** Dropped by clustering, and dropped by the per-bundle cap. */
  readonly clustered: number
  readonly clipped: number
  /** Artifacts whose weight was floored for want of a line count, not for size. */
  readonly weightFlooredUnknown: number
}

const DAY_MS = 86_400_000

/** The instant before which a write is settled. */
export function censorBefore(windowEnd: string, days: number = CENSOR_DAYS): string {
  const end = Date.parse(windowEnd)
  if (Number.isNaN(end)) return windowEnd
  return new Date(end - days * DAY_MS).toISOString()
}

/**
 * v1's weight, without the uptake factor.
 *
 * `log10(0)` is -Infinity, which clips to the floor. That is the right value and
 * the wrong reason: an unmeasured file and an empty one land on the same number.
 * `weightFlooredUnknown` carries the difference.
 */
export function sizeWeight(newLines: number): number {
  if (newLines <= 0) return WEIGHT_FLOOR
  const raw = 1 + Math.log10(newLines / WEIGHT_PIVOT)
  return Math.min(WEIGHT_CEILING, Math.max(WEIGHT_FLOOR, raw))
}

const extensionOf = (path: string): string => {
  const base = path.split(/[\\/]/).pop() ?? ''
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

const parentOf = (path: string): string => {
  const norm = path.split('\\').join('/')
  const at = norm.lastIndexOf('/')
  return at === -1 ? '' : norm.slice(0, at).toLowerCase()
}

/** Sizes within a factor of two, per v1. Two unknown sizes are alike. */
const alike = (a: number, b: number): boolean => {
  if (a <= 0 && b <= 0) return true
  if (a <= 0 || b <= 0) return false
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return hi <= lo * 2
}

export interface SettleInputs {
  readonly paths: Readonly<Record<string, PathTally>>
  /** Latest timestamp in the window; censoring counts back from here. */
  readonly windowEnd: string
  /** Latest mention of a path anywhere, for uptake condition (a). */
  readonly lastMention: (path: string) => string | null
  /** Injected so a test needs no files on disk. */
  readonly exists?: (path: string) => boolean
}

/**
 * Applies P6.
 *
 * Only uptake condition (a) is implemented. (b) needs a previous window, which a
 * first run does not have, and (c) — a successful execution taking the path as
 * an argument — is narrower than (a) and would only add cases. So a path
 * satisfying (b) or (c) alone is weighted 0.4 where v1 would give it 1.0, which
 * makes this reading of the artifact score too low rather than too high.
 */
export function settleArtifacts(inputs: SettleInputs): ArtifactSet {
  const exists = inputs.exists ?? existsSync
  const cutoff = censorBefore(inputs.windowEnd)

  const notSettled: Record<NotSettledReason, number> = {
    'written-too-recently': 0,
    'no-longer-exists': 0,
  }

  const entries = Object.entries(inputs.paths)
  const settled: Artifact[] = []

  for (const [path, tally] of entries) {
    if (tally.lastWrite === '' || tally.lastWrite >= cutoff) {
      notSettled['written-too-recently'] += 1
      continue
    }
    if (!exists(path)) {
      notSettled['no-longer-exists'] += 1
      continue
    }
    const mention = inputs.lastMention(path)
    const uptake =
      mention !== null && mention > tally.lastWrite ? UPTAKE_REFERENCED : UPTAKE_UNREFERENCED
    settled.push({
      path,
      weight: sizeWeight(tally.newLines) * uptake,
      uptake,
      newLines: tally.newLines,
      newLinesKnown: tally.newLinesKnown,
      bundle: tally.bundle,
    })
  }

  // Clustering, per bundle. Same parent directory, same extension, sizes within
  // a factor of two — one file. Writing the same thing to eight sibling paths is
  // one piece of work, and counting it eight times is the cheapest way to move
  // this denominator.
  const byBundle = new Map<number | null, Artifact[]>()
  for (const a of settled) {
    const list = byBundle.get(a.bundle)
    if (list === undefined) byBundle.set(a.bundle, [a])
    else list.push(a)
  }

  const kept: Artifact[] = []
  let clustered = 0
  let clipped = 0

  for (const [, list] of byBundle) {
    // Heaviest first, so the representative of a cluster is its largest member
    // rather than whichever was written first.
    const ordered = [...list].sort((a, b) => b.weight - a.weight)
    const representatives: Artifact[] = []
    for (const a of ordered) {
      const match = representatives.find(
        (r) =>
          parentOf(r.path) === parentOf(a.path) &&
          extensionOf(r.path) === extensionOf(a.path) &&
          alike(r.newLines, a.newLines),
      )
      if (match === undefined) representatives.push(a)
      else clustered += 1
    }
    if (representatives.length > MAX_PER_BUNDLE) {
      clipped += representatives.length - MAX_PER_BUNDLE
    }
    kept.push(...representatives.slice(0, MAX_PER_BUNDLE))
  }

  return {
    artifacts: kept,
    totalWeight: kept.reduce((sum, a) => sum + a.weight, 0),
    consideredPaths: entries.length,
    notSettled,
    clustered,
    clipped,
    weightFlooredUnknown: kept.filter((a) => !a.newLinesKnown).length,
  }
}
