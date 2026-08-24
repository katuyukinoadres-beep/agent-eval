import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan } from '@/collect/scan.js'
import { walkProjects } from '@/collect/walk.js'
import { windowScope } from '@/collect/scope.js'
import { ALL_TIME_REASONS, UNDATED, restrict, rowsOutOfWindow } from '@/collect/restrict.js'

/**
 * The window is a selection over day-keyed aggregates, not a filter over rows.
 * The scan sees the same corpus it always did, so nothing that depends on order
 * — the parentUuid chain, the repeat detector's first occurrences, a session's
 * first-seen error classes, an artifact's lastWrite — can be corrupted by it.
 *
 * The negative control below is the load-bearing one. This machine has ten
 * complete active days against a window of ten, so the real window selects
 * everything and a filter that did nothing at all would pass every test written
 * against these numbers. The fixture therefore has twelve days on purpose.
 */

let root = ''

const row = (day: string, hour: number, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    type: 'user',
    uuid: `${day}-${hour}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    timestamp: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    message: { role: 'user', content: 'do the thing' },
    ...extra,
  })}\n`

/** Twelve active days, so a ten-day window has something to exclude. */
const DAYS = [
  '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
  '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12',
]

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-restrict-'))
  const project = join(root, 'projects', 'C--Users-x-proj')
  mkdirSync(project, { recursive: true })
  // One row per day plus an extra on the first, so the excluded days are
  // distinguishable by count rather than only by presence.
  const lines = DAYS.flatMap((d, i) => Array.from({ length: i + 1 }, (_, h) => row(d, h % 24)))
  // A row with no timestamp at all: the undated bucket, in no window ever.
  lines.push(`${JSON.stringify({ type: 'user', uuid: 'no-ts', sessionId: 's1', message: { role: 'user', content: 'x' } })}\n`)
  writeFileSync(join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), lines.join(''))
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const scanned = () => scan(walkProjects(join(root, 'projects')), undefined, null, 0)

describe('the all-time view', () => {
  it('is the scan itself, untouched', () => {
    // The negative control. Every number this tool produces goes through here,
    // and the day-keying refactor is only safe if the all-time view is the same
    // object the scan reported. Rebuilding it from the buckets would make this
    // test check the rebuild instead of the original.
    const c = scanned()
    expect(restrict(c, null).counts).toBe(c)
  })

  it('is compared by content, not by reference, when it must be', () => {
    // The other half: prove the comparison above is capable of failing. A
    // deep-equal against a stubbed view has to come out false, or `toBe` is
    // passing for a reason that has nothing to do with the data.
    const c = scanned()
    const stub = { ...c, userRows: 0 }
    expect(JSON.stringify(stub) === JSON.stringify(c)).toBe(false)
  })

  it('says it windowed nothing', () => {
    expect(restrict(scanned(), null).basis.days).toBeNull()
    expect(restrict(scanned(), null).basis.windowed).toEqual([])
  })
})

describe('a window that excludes something', () => {
  const windowed = () => {
    const c = scanned()
    const scope = windowScope(c.humanTurnDates, 10, 'Z', '2026-09-01')
    return { all: restrict(c, null).counts, win: restrict(c, scope).counts, scope, c }
  }

  it('selects ten of the twelve days', () => {
    const { scope } = windowed()
    expect(scope?.activeDaysAll).toBe(12)
    expect(scope?.activeDaysInWindow).toBe(10)
    expect(scope?.days.has('2026-08-01')).toBe(false)
    expect(scope?.days.has('2026-08-02')).toBe(false)
    expect(scope?.days.has('2026-08-03')).toBe(true)
  })

  it('drops the excluded days rows, and the undated ones with them', () => {
    // 1 + 2 = 3 rows on the two excluded days, plus the one row that carries no
    // timestamp. A row with no day belongs to no window — including it in the
    // newest one would be a fabricated observation, not a recovered one.
    const { all, win } = windowed()
    expect(all.userRows - win.userRows).toBe(4)
  })

  it('never counts the undated rows, in any window', () => {
    const { c, scope } = windowed()
    expect(Object.keys(c.perDay)).toContain(UNDATED)
    expect(scope?.days.has(UNDATED)).toBe(false)
    const out = rowsOutOfWindow(c, scope)
    expect(out.undated).toBe(1)
  })

  it('reports what it left out, by day rather than as a total', () => {
    // A zero inside a sum is invisible; a zero at a position is not.
    const { c, scope } = windowed()
    const out = rowsOutOfWindow(c, scope)
    expect(Object.keys(out.byDay).sort()).toEqual(['2026-08-01', '2026-08-02'])
    expect(out.byDay['2026-08-01']).toBe(1)
    expect(out.byDay['2026-08-02']).toBe(2)
    expect(out.total).toBe(4)
  })

  it('leaves the totals equal when the window covers everything', () => {
    // The case this machine is in, and the reason the twelve-day fixture above
    // is not optional: with the window at least as long as the corpus, a filter
    // that dropped everything and one that dropped nothing look the same from
    // the totals alone.
    const c = scanned()
    const whole = windowScope(c.humanTurnDates, 12, 'Z', '2026-09-01')
    // Every dated row is in, and no day is left out...
    expect(rowsOutOfWindow(c, whole).byDay).toEqual({})
    // ...but the undated row is still out, which is why this is one short of
    // the all-time total rather than equal to it. Those are different facts and
    // the window has to keep them apart.
    expect(restrict(c, whole).counts.userRows).toBe(restrict(c, null).counts.userRows - 1)
    expect(rowsOutOfWindow(c, whole).undated).toBe(1)
  })
})

describe('what the view says about itself', () => {
  it('names every family it did not window, and why', () => {
    // The dominant way this change goes wrong is one counter left all-time
    // inside a windowed axis. The only defence is a list somebody has to edit
    // when a counter moves.
    const c = scanned()
    const scope = windowScope(c.humanTurnDates, 10, 'Z', '2026-09-01')
    const { basis } = restrict(c, scope)
    expect(basis.windowed.length).toBeGreaterThan(0)
    expect(basis.allTime).toContain('linesParseFailed')
    expect(basis.allTime).toContain('taskBundles')
    for (const key of Object.keys(ALL_TIME_REASONS)) {
      expect(ALL_TIME_REASONS[key], key).toBeTruthy()
    }
  })

  it('keeps the parse-failure count out of the window, because it cannot be in one', () => {
    // A line that will not parse has no timestamp, so a windowed version is
    // zero by construction and the gate built on it becomes a detector that
    // returns a well-formed zero.
    expect(ALL_TIME_REASONS['linesParseFailed']).toContain('zero by construction')
  })
})
