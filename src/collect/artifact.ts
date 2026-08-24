/**
 * P6, collection half — where a write landed and how large it was.
 *
 * Every read of `toolUseResult` in this codebase goes through here, so there is
 * one place to check against the fields that carry content. The object holds
 * `originalFile`, `newString`, `oldString`, `content`, `stdout` and `stderr` —
 * the file and the terminal — alongside the three harmless ones this needs.
 *
 * 180 of the 355 edited paths on this machine sit outside the working tree.
 * Their contents are somebody's business and not this tool's, which is why v1
 * weights an artifact by lines written rather than by its size on disk, and why
 * the existence check later reads no bytes.
 *
 * The parent object was banned outright before this existed. That was the right
 * instinct with the wrong shape: a ban on the parent is what sends a later stage
 * hunting for line counts somewhere worse.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface WriteRecord {
  readonly path: string
  /**
   * Lines in the new version of what was written.
   *
   * From `structuredPatch[].newLines` for an edit and `file.numLines` for a
   * create. Both are integers the log already computed; neither requires
   * looking at a line of the file.
   */
  readonly newLines: number
  /**
   * Whether a line count was available at all.
   *
   * 130 of 355 paths here have none — the result carries a path and no size.
   * v1's weight floors at 0.5 when the count is zero, which makes "small" and
   * "unmeasured" the same number. Carrying the distinction lets a receiver see
   * how many weights were floored for lack of data rather than for size.
   */
  readonly newLinesKnown: boolean
}

/**
 * The path and size of a write, or null if this result is not one.
 *
 * Reads exactly three fields. Nothing else in the object is touched, and a test
 * asserts this file mentions none of the content-bearing ones.
 */
export function readWrite(toolUseResult: unknown): WriteRecord | null {
  if (!isObj(toolUseResult)) return null

  const direct = toolUseResult['filePath']
  const file = toolUseResult['file']
  const nested = isObj(file) ? file['filePath'] : undefined
  const path = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : null
  if (path === null || path === '') return null

  const patch = toolUseResult['structuredPatch']
  if (Array.isArray(patch) && patch.length > 0) {
    let total = 0
    let known = false
    for (const hunk of patch) {
      if (!isObj(hunk)) continue
      const n = hunk['newLines']
      if (typeof n === 'number' && Number.isFinite(n)) {
        total += n
        known = true
      }
    }
    return { path, newLines: total, newLinesKnown: known }
  }

  if (isObj(file)) {
    const n = file['numLines']
    if (typeof n === 'number' && Number.isFinite(n)) {
      return { path, newLines: n, newLinesKnown: true }
    }
  }

  // A path with no size. Reported as unknown rather than as zero: a zero would
  // be indistinguishable from an empty file, and 130 paths here are in this
  // state.
  return { path, newLines: 0, newLinesKnown: false }
}

/** What the scanner accumulates per edited path. */
export interface PathTally {
  /** Latest write timestamp seen, ISO 8601. */
  readonly lastWrite: string
  /**
   * The first write's timestamp, so both anchors can be measured.
   *
   * A window has to pick one, and the choice is not obvious. Anchoring on the
   * last write means the artifact set is not a partition of the writes: a file
   * written on day 3 and rewritten on day 12 appears in the day-12 window and
   * not the day-3 one, and across two disjoint windows it can appear in both or
   * — if its last write falls in a gap — in neither. Anchoring on the first
   * systematically drops long-lived files that keep being revisited, which are
   * the ones uptake exists to reward.
   *
   * The spec's 「窓内に確定した成果物」 favours the last write, so that is what
   * is used; this is carried so the divergence is a number rather than an
   * argument.
   */
  readonly firstWrite: string
  /** Cumulative newLines across writes in the window. */
  readonly newLines: number
  /** True if any write to this path reported a line count. */
  readonly newLinesKnown: boolean
  readonly writes: number
  /** The bundle of the most recent write, for P6's clustering. */
  readonly bundle: number | null
}

export interface MutPathTally {
  lastWrite: string
  firstWrite: string
  newLines: number
  newLinesKnown: boolean
  writes: number
  bundle: number | null
}

export function recordWrite(
  tally: Map<string, MutPathTally>,
  write: WriteRecord,
  timestamp: string | null,
  bundle: number | null,
): void {
  const existing = tally.get(write.path)
  if (existing === undefined) {
    tally.set(write.path, {
      lastWrite: timestamp ?? '',
      firstWrite: timestamp ?? '',
      newLines: write.newLines,
      newLinesKnown: write.newLinesKnown,
      writes: 1,
      bundle,
    })
    return
  }
  existing.writes += 1
  // Earliest wins, and an empty string loses to any real timestamp.
  if (timestamp !== null && (existing.firstWrite === '' || timestamp < existing.firstWrite)) {
    existing.firstWrite = timestamp
  }
  existing.newLines += write.newLines
  existing.newLinesKnown = existing.newLinesKnown || write.newLinesKnown
  // Latest wins. The right-censoring rule turns on the last write, so an
  // earlier timestamp overwriting a later one would make an artifact look
  // settled while it was still being changed.
  if (timestamp !== null && timestamp > existing.lastWrite) {
    existing.lastWrite = timestamp
    existing.bundle = bundle
  }
}
