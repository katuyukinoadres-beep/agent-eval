/**
 * P5 — task bundles, and P3 — environment noise.
 *
 * A bundle runs from one human turn to the next, following the `parentUuid`
 * chain. It is the denominator of axis 2 and part of axis 4's, and v1 changed it
 * there for a reason worth restating: with total tool calls as the denominator,
 * the cheapest way to raise the score was to fire hundreds of calls that could
 * not fail. Bundles are the unit a person actually asked for.
 *
 * Following the chain rather than file order is not pedantry. Measured here,
 * 563 of 13,421 rows (4.19%) have a parent that is not the row before them, and
 * one session branches 304 times in 3,350 rows. Reading file order as the chain
 * would put those rows in the wrong bundle.
 *
 * What makes a single pass sufficient is that every non-null `parentUuid`
 * (13,413 of them) refers to a row earlier in the same file — 100%, measured. So
 * a uuid-to-bundle map filled as rows go by is enough; no second pass, and no
 * holding a session in memory.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * P3 — rows excluded from every axis, numerator and denominator alike.
 *
 * A bad connection is not low quality work. Rare here (15 rows in 18,569) and
 * excluded anyway, because the axes it would distort are error rates, where a
 * handful of rows moves a small numerator.
 */
export function isEnvironmentNoise(row: Record<string, unknown>): boolean {
  if (row['isApiErrorMessage'] === true) return true
  if (row['type'] === 'system' && row['subtype'] === 'api_error') return true
  const message = row['message']
  if (isObj(message) && message['model'] === '<synthetic>') return true
  return false
}

export interface BundleTracker {
  /**
   * Places a row in a bundle and returns the id, or null if the row is not part
   * of the conversation tree.
   *
   * A row without a `uuid` is not in the tree. 5,182 of 18,641 main rows here
   * are in that state — `last-prompt`, `ai-title`, `queue-operation`, `pr-link`,
   * `mode`, `file-history-snapshot` and kin. The first version assigned them
   * bundles anyway and reported 5,202 orphans, which is how the mistake showed:
   * a measurement taken beforehand had put unresolvable parents at zero.
   *
   * A human turn opens a bundle. Anything else inherits its parent's, and a row
   * whose parent was never seen opens its own rather than joining whichever
   * bundle happened to be current — silently attaching a branch to the wrong
   * request moves a denominator with no count changing to show it.
   */
  readonly assign: (
    uuid: string | null,
    parentUuid: string | null,
    isHumanTurn: boolean,
  ) => number | null
  /** Bundles opened by a human turn. */
  readonly opened: () => number
  /** Chain roots that were not human turns. 13 rows carry a null parent here. */
  readonly roots: () => number
  /**
   * Bundles started because a parent was named and never seen.
   *
   * Expected to be zero: every one of the 13,413 non-null parents on this
   * machine refers to a row earlier in the same file. A non-zero value means
   * either the file is ordered differently than measured or the tracker is being
   * fed rows it should not see.
   */
  readonly orphans: () => number
}

/**
 * A tracker for one file.
 *
 * Per file, because a main transcript is one session and `uuid` values are only
 * guaranteed unique within it. Ids are drawn from a counter the caller owns, so
 * bundles from different files never collide.
 */
export function bundleTracker(nextId: () => number): BundleTracker {
  const ofUuid = new Map<string, number>()
  let opened = 0
  let roots = 0
  let orphans = 0

  const assign = (
    uuid: string | null,
    parentUuid: string | null,
    isHumanTurn: boolean,
  ): number | null => {
    // Not in the tree. Metadata rows have no uuid and no place in a bundle.
    if (uuid === null) return null

    let id: number
    if (isHumanTurn) {
      id = nextId()
      opened += 1
    } else if (parentUuid === null) {
      id = nextId()
      roots += 1
    } else {
      const inherited = ofUuid.get(parentUuid)
      if (inherited === undefined) {
        id = nextId()
        orphans += 1
      } else {
        id = inherited
      }
    }
    ofUuid.set(uuid, id)
    return id
  }

  return { assign, opened: () => opened, roots: () => roots, orphans: () => orphans }
}
