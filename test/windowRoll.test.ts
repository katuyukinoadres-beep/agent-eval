import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultOptions, run } from '@/run.js'

/**
 * The loop this product exists for: scan, store, let the window move, scan
 * again, and get a delta that reflects what actually changed.
 *
 * Nothing tested it. `comparison.test.ts` exercises `compare()` on constructed
 * views and `snapshot.test.ts` exercises the writer, but no test had ever
 * driven `run()` twice with a store across two measurement times. On the
 * development machine the comparison has only ever produced `+0`, because both
 * runs happened on the same day and the window did not move — a result that is
 * correct and proves nothing about the path.
 *
 * The corpus below changes on purpose. The first half fails one call in three;
 * the second fails one in twenty. Measured at day 12 the window sees the bad
 * half, measured at day 30 it sees the good half, and the delta has to move in
 * the direction of the injected change. A comparison that reported +0 here
 * would be reporting the shape of the code rather than the shape of the data.
 */

let home = ''

const SESSIONS_PER_DAY = 3
const BUNDLES_PER_SESSION = 8

/** One request and its tool call, failing or not. */
const exchange = (day: string, session: string, n: number, fails: boolean): string[] => {
  const hour = String((n % 12) + 8).padStart(2, '0')
  const min = String((n * 7) % 60).padStart(2, '0')
  const user = `u-${session}-${n}`
  const asst = `a-${session}-${n}`
  const call = `t-${session}-${n}`
  return [
    JSON.stringify({
      type: 'user',
      uuid: user,
      sessionId: session,
      cwd: '/w',
      version: '2.1.235',
      timestamp: `${day}T${hour}:${min}:00.000Z`,
      message: { role: 'user', content: 'do the thing' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: asst,
      parentUuid: user,
      sessionId: session,
      cwd: '/w',
      version: '2.1.235',
      timestamp: `${day}T${hour}:${min}:03.000Z`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: 'ls' } }] },
    }),
    JSON.stringify({
      type: 'user',
      uuid: `r-${session}-${n}`,
      parentUuid: asst,
      sessionId: session,
      cwd: '/w',
      version: '2.1.235',
      timestamp: `${day}T${hour}:${min}:07.000Z`,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call,
            is_error: fails,
            content: fails ? 'bash: nope: command not found' : 'ok',
          },
        ],
      },
      toolUseResult: { is_error: fails },
    }),
  ]
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-eval-roll-'))
  const project = join(home, '.claude', 'projects', 'C--w')
  mkdirSync(project, { recursive: true })

  for (let d = 1; d <= 30; d += 1) {
    const day = `2026-08-${String(d).padStart(2, '0')}`
    // The injected change. Day 15 is the boundary: before it one call in three
    // fails, after it one in twenty.
    const period = d <= 15 ? 3 : 20
    for (let s = 0; s < SESSIONS_PER_DAY; s += 1) {
      const session = `s-${d}-${s}`
      const lines: string[] = []
      for (let n = 0; n < BUNDLES_PER_SESSION; n += 1) {
        lines.push(...exchange(day, session, n, n % period === 0))
      }
      writeFileSync(join(project, `${session}.jsonl`), `${lines.join('\n')}\n`)
    }
  }
})

afterAll(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
})

const scanAt = (measuredAt: string, stateDir: string) =>
  run(defaultOptions({ home, cwd: home, measuredAt, useStore: true, stateDir }))

describe('a window that actually moves', () => {
  it('records the first window and has nothing to compare it to', () => {
    const stateDir = join(home, 'state-first')
    const first = scanAt('2026-08-12T23:00:00Z', stateDir)
    expect(first.snapshot?.kind).not.toBe('refused')
    expect(first.comparison?.refused).toBe('no-previous-window')
  })

  it('produces a delta once the window has rolled', () => {
    const stateDir = join(home, 'state-roll')
    const before = scanAt('2026-08-12T23:00:00Z', stateDir)
    const after = scanAt('2026-08-30T23:00:00Z', stateDir)

    // The windows must actually differ, or the rest of this proves nothing.
    expect(before.payload.scanManifest.window.windowEnd).not.toBe(
      after.payload.scanManifest.window.windowEnd,
    )

    const comparison = after.comparison
    expect(comparison, 'no comparison was produced at all').not.toBeNull()
    // A refusal here is a finding, not a pass. Name it rather than skipping.
    expect(comparison?.refused, `comparison refused: ${String(comparison?.refused)}`).toBeNull()

    const motion = comparison?.perAxis.find((a) => a.axis === 'wastedMotion')
    expect(motion, 'wastedMotion was not among the compared axes').toBeDefined()
    // The corpus got better across the boundary, and wastedMotion scores higher
    // when less motion is wasted. A zero delta would mean the window selection
    // never reached the axis.
    expect(motion?.delta).not.toBe(0)
    expect(motion?.delta ?? 0).toBeGreaterThan(0)
  })

  it('does not call the delta a change while it has no interval', () => {
    // The property that keeps this honest. A number moved; that is not yet
    // evidence it moved for a reason, and the tool must not say it is.
    const stateDir = join(home, 'state-sig')
    scanAt('2026-08-12T23:00:00Z', stateDir)
    const after = scanAt('2026-08-30T23:00:00Z', stateDir)
    for (const axis of after.comparison?.perAxis ?? []) {
      expect(axis.significant, `${axis.axis} was called significant`).toBe(false)
      expect(axis.gap, `${axis.axis} had no reason for withholding`).not.toBeNull()
    }
  })

  it('selects two windows that share no day', () => {
    // Disjointness is the one condition axis 6's cross-window layer needs and
    // the only one this project could find that requires no correction factor.
    // Overlapping windows would double-count the days in the overlap, and the
    // resulting figure would look like evidence.
    const stateDir = join(home, 'state-disjoint')
    const before = scanAt('2026-08-12T23:00:00Z', stateDir)
    const after = scanAt('2026-08-30T23:00:00Z', stateDir)
    const w1 = before.payload.scanManifest.window
    const w2 = after.payload.scanManifest.window
    expect(w1.windowEnd).not.toBeNull()
    expect(w2.windowStart).not.toBeNull()
    // The later window opens after the earlier one closes.
    expect(String(w2.windowStart) > String(w1.windowEnd)).toBe(true)
  })

  it('withholds the composite delta when there is no composite to subtract', () => {
    // Seven axes compare here and the composite still comes out null, because
    // this corpus scores too few of the axes the composite is defined over.
    // Reporting `0` for that would be a measurement of nothing; the delta has
    // to be absent, and it is worth pinning because a null that becomes a zero
    // reads as "no change".
    const stateDir = join(home, 'state-composite')
    scanAt('2026-08-12T23:00:00Z', stateDir)
    const after = scanAt('2026-08-30T23:00:00Z', stateDir)
    expect(after.payload.composite.score).toBeNull()
    expect(after.comparison?.delta).toBeNull()
    // ...while the per-axis deltas are present, which is what makes the null
    // above a decision rather than an empty comparison.
    expect((after.comparison?.perAxis ?? []).length).toBeGreaterThan(4)
  })
})
