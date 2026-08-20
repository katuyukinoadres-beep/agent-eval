import { describe, expect, it } from 'vitest'
import { BASE_PAYLOAD } from '@/payload/base.js'
import { validate } from '@/validate/index.js'
import { FLAGS_NOT_IMPLEMENTED, FLAG_IDS, type FlagId } from '@/validate/rules.js'

/**
 * Warnings accept the payload and mark it. Refusing these would lose a
 * submission over a reading that is merely suspect, so `ok` stays true and the
 * receiver decides what to leave out of which statistic.
 *
 * The second half of this file is the part that matters. Every threshold here
 * is an inequality, and a check written with the wrong one fires on values it
 * should pass — which looks like a working detector right up until it cries
 * wolf often enough to be ignored. The boundary cases pin each comparison at
 * the exact value where it must stay silent.
 */

type Mutable = Record<string, unknown>

function altered(mutate: (p: Mutable) => void): Mutable {
  const copy = JSON.parse(JSON.stringify(BASE_PAYLOAD)) as Mutable
  mutate(copy)
  return copy
}

const obj = (p: Mutable, key: string): Mutable => p[key] as Mutable
const flagsOf = (p: unknown): FlagId[] => validate(p).flags.map((f) => f.flag)

/** A warned payload is still accepted; that is the whole distinction from a violation. */
function expectFlagged(payload: unknown, id: FlagId): void {
  const v = validate(payload)
  expect(v.violations, 'a warning fixture must not also be refused').toEqual([])
  expect(v.ok).toBe(true)
  expect(v.status).toBe(200)
  expect(v.flags.map((f) => f.flag)).toContain(id)
}

describe('base carries the one flag its own numbers earn', () => {
  it('is accepted', () => {
    expect(validate(BASE_PAYLOAD).ok).toBe(true)
  })

  it('is flagged W-1, because 195/5814 really is 3.4%', () => {
    // Not a defect in the fixture. This machine's origin coverage is 3.4%, and a
    // base that hid that would be describing a cleaner machine than exists.
    expect(flagsOf(BASE_PAYLOAD)).toContain('W-1')
  })

  it('earns no other flag', () => {
    expect(flagsOf(BASE_PAYLOAD)).toEqual(['W-1'])
  })
})

describe('W-2 — a sub-line share at an edge it cannot legitimately reach', () => {
  it('flags zero under scope all', () => {
    expectFlagged(altered((p) => { obj(p, 'scanManifest')['subLineRatio'] = 0 }), 'W-2')
  })

  it('flags one under scope all — the glob levelled one directory too deep', () => {
    // A rule watching only for zero stays silent here: matching no main files
    // at all pins the ratio at 1, and the three-level glob does exactly that
    // (0 matches against 11 on this machine).
    expectFlagged(altered((p) => { obj(p, 'scanManifest')['subLineRatio'] = 1 }), 'W-2')
  })

  it('flags a single project even when the aggregate looks healthy', () => {
    // The failure this rule exists for is a partial miss. Four of five projects
    // missed while one holds every line leaves an aggregate of 0.42 — a number
    // nothing would look at twice.
    const p = altered((x) => {
      const proj = (obj(x, 'environment')['projects'] as Mutable[])[0]
      if (proj) proj['subLineRatio'] = 0
    })
    const flagged = validate(p).flags.filter((f) => f.flag === 'W-2')
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.path).toBe('environment.projects[0].subLineRatio')
  })
})

describe('the other warnings', () => {
  it('W-3 flags more than five tool versions', () => {
    expectFlagged(
      altered((p) => { obj(p, 'scanManifest')['toolVersionDistinct'] = 12 }),
      'W-3',
    )
  })

  it('W-5 flags parse failures over 1%', () => {
    expectFlagged(
      altered((p) => { obj(p, 'scanManifest')['linesParseFailed'] = 2_000 }),
      'W-5',
    )
  })

  it('W-6 flags a boolean-derived zero over a large denominator', () => {
    // Indistinguishable from a field that never fires — which is what
    // preventedContinuation turned out to be, across two machines.
    expectFlagged(
      altered((p) => { obj(obj(p, 'metrics'), 'toolError')['numerator'] = 0 }),
      'W-6',
    )
  })

  it('W-7 flags a zero denominator, which nothing else catches', () => {
    // 0/0, not 3/0 — a glob that matches no files reports nothing fired out of
    // nothing defined, and both parts go to zero together. That shape slips
    // past everything else: V-4 sees both parts present, V-5 finds 0 > 0 false,
    // and W-6 only looks above a hundred. The spec's own glob for skillFired
    // (`.claude/skills/*/SKILL.md`) matches 0 files on this machine against 27
    // flat ones, so this is a reading that will really arrive.
    expectFlagged(
      altered((p) => {
        const s = obj(obj(p, 'metrics'), 'skillFired')
        s['numerator'] = 0
        s['denominator'] = 0
      }),
      'W-7',
    )
  })

  it('a zero denominator with a live numerator is refused, not flagged', () => {
    // 3/0 is a numerator exceeding its denominator, and V-5 is right to refuse
    // it. Only the 0/0 form is the silent hole.
    const v = validate(altered((p) => { obj(obj(p, 'metrics'), 'skillFired')['denominator'] = 0 }))
    expect(v.ok).toBe(false)
    expect(v.violations.map((x) => x.rule)).toContain('V-5')
  })
})

// ── the boundaries ────────────────────────────────────────────────────────────
// Each of these sits exactly on a threshold and must produce nothing. A check
// written with >= where it wanted > passes every test above and fails only here.

describe('boundary — the value where each check must stay silent', () => {
  it('1. origin coverage of exactly 0.1 does not flag W-1', () => {
    const p = altered((x) => {
      const c = obj(obj(x, 'scanManifest'), 'originFieldCoverage')
      c['numerator'] = 100
      c['denominator'] = 1_000
    })
    expect(flagsOf(p)).not.toContain('W-1')
  })

  it('2. exactly five tool versions does not flag W-3', () => {
    expect(
      flagsOf(altered((p) => { obj(p, 'scanManifest')['toolVersionDistinct'] = 5 })),
    ).not.toContain('W-3')
  })

  it('3. a parse failure rate of exactly 1% does not flag W-5', () => {
    // linesRead is 129,132; 1,291.32 would be the exact 1%, so use a payload
    // where the arithmetic is clean rather than one that rounds into the flag.
    const p = altered((x) => {
      const m = obj(x, 'scanManifest')
      m['linesRead'] = 100_000
      m['mainLines'] = 72_064
      m['subLines'] = 27_936
      m['linesParseFailed'] = 1_000
      m['toolVersions'] = { '2.1.234': 100_000 }
      m['toolVersionDistinct'] = 1
      for (const axis of Object.values(obj(x, 'axes') as Record<string, Mutable>)) {
        axis['lineStates'] = { available: 0, not_applicable: 100_000, parse_failed: 0 }
      }
    })
    expect(validate(p).violations).toEqual([])
    expect(flagsOf(p)).not.toContain('W-5')
  })

  it('4. a boolean-derived zero over exactly 100 does not flag W-6', () => {
    const p = altered((x) => {
      const t = obj(obj(x, 'metrics'), 'toolError')
      t['numerator'] = 0
      t['denominator'] = 100
    })
    expect(flagsOf(p)).not.toContain('W-6')
  })

  it('5. a rate of exactly 15/15 is not refused by V-5', () => {
    const p = altered((x) => {
      const r = obj(obj(obj(x, 'scanManifest'), 'externalLog'), 'recordRate')
      r['numerator'] = 15
      r['denominator'] = 15
    })
    expect(validate(p).violations.map((v) => v.rule)).not.toContain('V-5')
  })

  it('6. scope "main" with a zero sub-line share does not flag W-2', () => {
    // A legitimate main-only scan. A check that ignores scope and only watches
    // the ratio fires on every one of them.
    const p = altered((x) => {
      const m = obj(x, 'scanManifest')
      m['scope'] = 'main'
      m['subLineRatio'] = 0
      m['subLines'] = 0
      m['subFiles'] = 0
      m['linesRead'] = 101_196
      m['filesRead'] = 1_094
      m['toolVersions'] = { '2.1.234': 101_196 }
      m['toolVersionDistinct'] = 1
      for (const axis of Object.values(obj(x, 'axes') as Record<string, Mutable>)) {
        axis['lineStates'] = { available: 0, not_applicable: 101_196, parse_failed: 0 }
      }
    })
    expect(validate(p).violations).toEqual([])
    expect(flagsOf(p)).not.toContain('W-2')
  })

  it('7. a project holding no lines does not flag W-2', () => {
    // 0/0 is an absence, not an edge. Four projects on this machine are in
    // exactly that state, and flagging them would bury the one real signal.
    const p = altered((x) => {
      const proj = (obj(x, 'environment')['projects'] as Mutable[])[2]
      if (proj) {
        proj['lines'] = 0
        proj['subLineRatio'] = 0
      }
    })
    expect(flagsOf(p)).not.toContain('W-2')
  })
})

describe('the flag set is honest about what it does not check', () => {
  it('states that W-4 is unimplemented rather than implying coverage', () => {
    // Its threshold is undefined in the spec, and n=2 cannot set one — the same
    // reasoning that removed the submission-unit threshold.
    expect([...FLAGS_NOT_IMPLEMENTED]).toEqual(['W-4'])
    expect([...FLAG_IDS] as string[]).not.toContain('W-4')
  })
})
