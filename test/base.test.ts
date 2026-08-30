import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASE_PAYLOAD } from '@/payload/base.js'
import { FIXTURE_NAMES, emit, isFixtureName } from '@/payload/emit.js'
import { AXIS_KEYS } from '@/payload/types.js'

/**
 * base is the fixture every validation case is derived from, so the invariants
 * the validator will check have to hold here first.
 *
 * The spec's own §2 sample does not satisfy them — mainLines + subLines falls
 * 741 short of its stated linesRead, and its stated subLineRatio of 0.267 is
 * 0.2163 recomputed from its own numbers. These assertions are what keeps this
 * fixture from inheriting that, and they run against the values rather than
 * against the comment claiming the values are fine.
 */

const m = BASE_PAYLOAD.scanManifest

describe('the manifest accounts for every line it claims to have read', () => {
  it('main and sub lines sum to linesRead', () => {
    // V-9. A scan that loses a third of the lines to a non-recursive glob still
    // reports plausible per-side counts; only the total gives it away.
    expect(m.mainLines + m.subLines).toBe(m.linesRead)
  })

  it('files sum the same way', () => {
    expect(m.mainFiles + m.subFiles).toBe(m.filesRead)
  })

  it('subLineRatio follows from the line counts', () => {
    expect(m.subLineRatio).toBeCloseTo(m.subLines / m.linesRead, 4)
  })

  it('is not the spec sample, which does not close', () => {
    // Guards against someone "correcting" this fixture back to the spec's
    // numbers. 101,196 + 27,936 = 129,132, not 129,873.
    expect(m.linesRead).not.toBe(129_873)
    expect(m.subLineRatio).not.toBe(0.267)
  })

  it('the version tally covers every line', () => {
    const counted = Object.values(m.toolVersions).reduce((a, b) => a + b, 0)
    expect(counted).toBe(m.linesRead)
    expect(m.toolVersionDistinct).toBe(Object.keys(m.toolVersions).length)
  })

  it('every walked glob reports its own match count', () => {
    // A glob that matched nothing has to be visible. Reporting the roots from a
    // constant instead of from the walk is how a silently empty one hides.
    const matched = m.rootsWalked.reduce((a, r) => a + r.matchCount, 0)
    expect(matched).toBe(m.filesRead)
    expect(m.rootsWalked.every((r) => r.glob.length > 0)).toBe(true)
  })
})

describe('rates cannot exceed one', () => {
  it('originFieldCoverage', () => {
    expect(m.originFieldCoverage.numerator).toBeLessThanOrEqual(m.originFieldCoverage.denominator)
  })

  it('recordRate — the one that reached 107.1% here', () => {
    const r = m.externalLog.recordRate
    expect(r.numerator).toBeLessThanOrEqual(r.denominator)
  })

  it('recordRateCalendar, which V-5 must also cover', () => {
    const r = m.externalLog.recordRateCalendar
    expect(r.numerator).toBeLessThanOrEqual(r.denominator)
  })

  it('every metric that has a denominator', () => {
    for (const [name, v] of Object.entries(BASE_PAYLOAD.metrics)) {
      if (typeof v === 'object' && 'denominator' in v) {
        expect(v.numerator, name).toBeLessThanOrEqual(v.denominator)
        expect(v.denominator, name).toBeGreaterThan(0)
      }
    }
  })
})

describe('axes', () => {
  it('carries every axis the spec names', () => {
    expect(Object.keys(BASE_PAYLOAD.axes).sort()).toEqual([...AXIS_KEYS].sort())
  })

  it('line states close against linesRead for each axis', () => {
    // V-10. Every line got a verdict; a tally that does not close is a parser
    // that dropped rows without reporting it.
    for (const [name, axis] of Object.entries(BASE_PAYLOAD.axes)) {
      const s = axis.lineStates
      expect(s.available + s.not_applicable + s.parse_failed, name).toBe(m.linesRead)
    }
  })

  it('carries no score anywhere, which is what this machine produces', () => {
    // 11 session clusters against a minimum denominator of 20. A base fixture
    // showing scores would describe a machine that does not exist.
    for (const axis of Object.values(BASE_PAYLOAD.axes)) {
      expect(axis.score).toBeNull()
    }
  })

  it('shows the two axes that are never scored and always available', () => {
    // Everything else is not_applicable. These two are not, and the fixture has
    // to show it: a reference payload that illustrates a state the code can no
    // longer produce teaches the reader the wrong shape.
    const alwaysShown = ['coverageGate', 'safetyCheck'] as const
    for (const key of alwaysShown) {
      expect(BASE_PAYLOAD.axes[key].availability, key).toBe('available')
      expect(BASE_PAYLOAD.axes[key].unavailableReasons, key).toEqual([])
    }
    // The positive control: everything outside that pair is still unavailable,
    // so this is not passing because the fixture went uniformly available.
    for (const [key, axis] of Object.entries(BASE_PAYLOAD.axes)) {
      if ((alwaysShown as readonly string[]).includes(key)) continue
      expect(axis.availability, key).toBe('not_applicable')
    }
  })
})

describe('environment', () => {
  it('lists every project it counts — partial submissions are refused', () => {
    expect(BASE_PAYLOAD.environment.projects).toHaveLength(BASE_PAYLOAD.environment.projectCount)
  })

  it('topProjectByteShare follows from the project bytes', () => {
    const bytes = BASE_PAYLOAD.environment.projects.map((p) => p.bytes)
    const top = Math.max(...bytes) / bytes.reduce((a, b) => a + b, 0)
    expect(BASE_PAYLOAD.environment.topProjectByteShare).toBeCloseTo(top, 3)
  })

  it('identifies projects by hash only, never by path', () => {
    // The spec's §5 example carries a cwd with separators swapped, which ships
    // the home directory and OS username. There is no field here it could go in.
    for (const p of BASE_PAYLOAD.environment.projects) {
      expect(p.id).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(JSON.stringify(p)).not.toMatch(/[A-Za-z]:[\\/]|\/home\/|\/Users\//)
    }
  })
})

describe('emit', () => {
  it('round-trips base through JSON', () => {
    expect(JSON.parse(emit('base'))).toEqual(JSON.parse(JSON.stringify(BASE_PAYLOAD)))
  })

  it('names its fixtures', () => {
    expect(FIXTURE_NAMES).toContain('base')
    expect(isFixtureName('base')).toBe(true)
    expect(isFixtureName('scan-of-my-actual-machine')).toBe(false)
  })

  it('does not import from the collector', () => {
    // Structural, not advisory. If emit could reach the scanner, the cheapest
    // way to make a fixture becomes "scan this machine and edit a field", and
    // the conversation text and paths in that scan get committed as test data.
    const src = readFileSync(fileURLToPath(new URL('../src/payload/emit.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/from\s+['"](?:\.\.\/collect|@\/collect)/)
  })
})

describe('cli emit', () => {
  it('prints the base fixture', async () => {
    const { run } = await import('@/cli.js')
    const { code, out } = run(['emit', '--fixture', 'base'])
    expect(code).toBe(0)
    expect(JSON.parse(out).schemaVersion).toBe('1.0')
  })

  it('refuses an unknown fixture rather than defaulting to base', () => {
    // Silently returning the reference payload for a typo is how a fixture gets
    // mistaken for a real reading.
    return import('@/cli.js').then(({ run }) => {
      expect(run(['emit', '--fixture', 'bse']).code).toBe(2)
      expect(run(['emit']).code).toBe(2)
    })
  })
})
