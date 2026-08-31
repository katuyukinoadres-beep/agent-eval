import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan } from '@/collect/scan.js'
import { walkProjects } from '@/collect/walk.js'
import { MIN_DENOMINATOR } from '@/score/minimum.js'
import { BASE_PAYLOAD } from '@/payload/base.js'

/**
 * Cutting the corpus by the version that wrote it.
 *
 * The tool always knew this and threw it away after counting rows. A version
 * boundary is the one change in a log that is definitely not the user's own
 * doing, which makes it the honest first place to look when an agent "feels
 * worse lately".
 *
 * The fixture is built so that a slicer which ignored the version — pooling
 * everything and reporting the same figure twice — fails. Two versions with
 * deliberately different failure rates, and one below the floor.
 */

let root = ''

const row = (version: string, day: string, i: number, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    type: 'user',
    uuid: `${version}-${i}`,
    sessionId: 's1',
    version,
    timestamp: `${day}T0${i % 9}:00:00.000Z`,
    message: { role: 'user', content: 'x' },
    ...extra,
  })}\n`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-version-'))
  const project = join(root, 'projects', 'C--Users-x-proj')
  mkdirSync(project, { recursive: true })
  const lines: string[] = []
  // Two versions, different days, different row counts.
  for (let i = 0; i < 40; i += 1) lines.push(row('9.0.1', '2026-08-01', i))
  for (let i = 0; i < 25; i += 1) lines.push(row('9.0.2', '2026-08-05', i))
  writeFileSync(join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), lines.join(''))
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const counts = () => scan(walkProjects(join(root, 'projects')), undefined, null, 0)

describe('the corpus cut by version', () => {
  it('separates the versions instead of pooling them', () => {
    // The load-bearing assertion. A slicer that ignored `version` would produce
    // one bucket, or two buckets holding the same number.
    const s = counts().versionSlices
    expect(Object.keys(s).sort()).toEqual(['9.0.1', '9.0.2'])
    expect(s['9.0.1']?.rows).toBe(40)
    expect(s['9.0.2']?.rows).toBe(25)
  })

  it('agrees with the histogram it used to be', () => {
    // The rows figure is the same number `toolVersions` has always reported, so
    // a regression in the new path shows up as a disagreement with the old one.
    const c = counts()
    for (const [v, n] of Object.entries(c.toolVersions)) {
      expect(c.versionSlices[v]?.rows, v).toBe(n)
    }
  })

  it('records when each version was in use', () => {
    const s = counts().versionSlices
    expect(s['9.0.1']?.firstDay).toBe('2026-08-01')
    expect(s['9.0.1']?.lastDay).toBe('2026-08-01')
    expect(s['9.0.2']?.firstDay).toBe('2026-08-05')
    // The positive control for the day range: the two versions must not share
    // one, which is what a slicer keyed on the wrong thing would produce.
    expect(s['9.0.1']?.firstDay).not.toBe(s['9.0.2']?.firstDay)
  })

  it('accounts for every dated row exactly once', () => {
    const c = counts()
    const total = Object.values(c.versionSlices).reduce((a, v) => a + v.rows, 0)
    expect(total).toBe(65)
  })
})

describe('the floor on a per-version rate', () => {
  it('withholds the rate below the floor and renders it above', () => {
    // Both directions, from the reference payload. The development machine's
    // oldest version has four tool calls and two failures: rendering 0.5000
    // beside 0.0201 invites a conclusion the evidence cannot carry, and a test
    // that only checked the rendered case would never notice.
    const slices = BASE_PAYLOAD.scanManifest.versionSlices
    const withheld = slices.filter((v) => v.failuresPerToolUseE4 === null)
    const rendered = slices.filter((v) => v.failuresPerToolUseE4 !== null)
    expect(withheld.length).toBeGreaterThan(0)
    expect(rendered.length).toBeGreaterThan(0)
    for (const v of withheld) expect(v.toolUse, v.version).toBeLessThan(MIN_DENOMINATOR)
    for (const v of rendered) expect(v.toolUse, v.version).toBeGreaterThanOrEqual(MIN_DENOMINATOR)
  })

  it('keeps the raw terms even when the rate is withheld', () => {
    // Withholding a rate is not the same as reporting nothing. The numerator and
    // denominator stay, so a reader who wants to pool versions can.
    for (const v of BASE_PAYLOAD.scanManifest.versionSlices) {
      expect(typeof v.failures, v.version).toBe('number')
      expect(typeof v.toolUse, v.version).toBe('number')
    }
  })

  it('uses the same floor as the axes, not one invented here', () => {
    expect(MIN_DENOMINATOR).toBe(200)
  })
})
