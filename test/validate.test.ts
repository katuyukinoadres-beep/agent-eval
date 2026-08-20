import { describe, expect, it } from 'vitest'
import { BASE_PAYLOAD } from '@/payload/base.js'
import { validate } from '@/validate/index.js'
import { NOT_IMPLEMENTED_HERE, RULE_IDS, type RuleId } from '@/validate/rules.js'

/**
 * One fixture per rule, each a copy of base with a single field broken.
 *
 * Deriving them from base rather than writing them whole means a fixture cannot
 * accidentally trip a second rule and pass for the wrong reason — the diff from
 * a payload known to be clean is one field.
 *
 * The mutations are not invented. Each is the shape of something that actually
 * happened or that the spec names as the reason the rule exists.
 */

type Mutable = Record<string, unknown>

/** A deep, writable copy of base. */
function broken(mutate: (p: Mutable) => void): Mutable {
  const copy = JSON.parse(JSON.stringify(BASE_PAYLOAD)) as Mutable
  mutate(copy)
  return copy
}

const obj = (p: Mutable, key: string): Mutable => p[key] as Mutable

/** Asserts the payload is refused, and refused for the stated reason. */
function expectRefused(payload: unknown, rule: RuleId): void {
  const v = validate(payload)
  expect(v.ok, `expected ${rule} to refuse this payload`).toBe(false)
  expect(v.status).toBe(422)
  expect(v.violations.map((x) => x.rule)).toContain(rule)
}

describe('base is accepted', () => {
  it('passes every rule', () => {
    const v = validate(BASE_PAYLOAD)
    expect(v.violations, 'base must be clean or every fixture below is meaningless').toEqual([])
    expect(v.ok).toBe(true)
    expect(v.status).toBe(200)
  })

  it('survives the JSON round trip it will arrive through', () => {
    expect(validate(JSON.parse(JSON.stringify(BASE_PAYLOAD))).ok).toBe(true)
  })
})

describe('V-1 — no manifest', () => {
  it('refuses a payload with no scan range stated', () => {
    expectRefused(broken((p) => delete p['scanManifest']), 'V-1')
  })

  it('refuses things that are not payloads at all', () => {
    for (const junk of [null, 42, 'a payload', [], undefined]) expectRefused(junk, 'V-1')
  })
})

describe('V-2 — an incomplete manifest', () => {
  it('refuses a manifest missing subLineRatio', () => {
    // The field that detects the non-recursive glob. Losing it loses the detector.
    expectRefused(broken((p) => { delete obj(p, 'scanManifest')['subLineRatio'] }), 'V-2')
  })

  it('names every required field it misses', () => {
    const v = validate(broken((p) => {
      const m = obj(p, 'scanManifest')
      delete m['recursive']
      delete m['toolVersions']
    }))
    const paths = v.violations.filter((x) => x.rule === 'V-2').map((x) => x.path)
    expect(paths).toContain('scanManifest.recursive')
    expect(paths).toContain('scanManifest.toolVersions')
  })
})

describe('V-3 — a rate that does not say what it divided by', () => {
  it('refuses a metric with no denominatorMeaning', () => {
    expectRefused(
      broken((p) => { delete obj(obj(p, 'metrics'), 'toolError')['denominatorMeaning'] }),
      'V-3',
    )
  })

  it('reaches the manifest rates too', () => {
    // recordRateCalendar sat outside the rule as originally written.
    expectRefused(
      broken((p) => {
        delete obj(obj(obj(p, 'scanManifest'), 'externalLog'), 'recordRateCalendar')['denominatorMeaning']
      }),
      'V-3',
    )
  })
})

describe('V-4 — a rate with nothing to recompute from', () => {
  it('refuses a bare percentage', () => {
    expectRefused(
      broken((p) => { obj(p, 'metrics')['toolError'] = { rate: 0.0463, denominatorMeaning: 'x' } }),
      'V-4',
    )
  })

  it('refuses half a fraction', () => {
    expectRefused(
      broken((p) => { delete obj(obj(p, 'metrics'), 'toolError')['denominator'] }),
      'V-4',
    )
  })
})

describe('V-5 — a numerator above its denominator', () => {
  it('refuses the 107.1% record rate that actually happened', () => {
    expectRefused(
      broken((p) => {
        const r = obj(obj(obj(p, 'scanManifest'), 'externalLog'), 'recordRate')
        r['numerator'] = 15
        r['denominator'] = 14
      }),
      'V-5',
    )
  })

  it('reaches any rate anywhere, not a list of remembered ones', () => {
    expectRefused(
      broken((p) => {
        const r = obj(obj(obj(p, 'scanManifest'), 'externalLog'), 'recordRateCalendar')
        r['numerator'] = 200
      }),
      'V-5',
    )
  })

  it('catches the string form as well', () => {
    // `"15/18"` is the other shape a rate arrives in, and both sides of it read
    // as undefined to a check that only looks for the object form.
    expectRefused(broken((p) => { obj(p, 'scanManifest')['someRate'] = '15/14' }), 'V-5')
  })
})

describe('V-6 — a partial submission', () => {
  it('refuses a project list shorter than its own count', () => {
    // Refusing partial submissions is what removes the need for a threshold on
    // which projects count.
    expectRefused(
      broken((p) => {
        const e = obj(p, 'environment')
        e['projects'] = (e['projects'] as unknown[]).slice(0, 1)
      }),
      'V-6',
    )
  })
})

describe('V-7 — an availability outside the enum', () => {
  it('refuses a fourth value', () => {
    expectRefused(
      broken((p) => { obj(obj(p, 'axes'), 'firstPassLanding')['availability'] = 'unknown' }),
      'V-7',
    )
  })

  it('refuses a boolean where the enum belongs', () => {
    expectRefused(
      broken((p) => { obj(obj(p, 'axes'), 'wastedMotion')['availability'] = false }),
      'V-7',
    )
  })
})

describe('V-9 — lines that do not account for themselves', () => {
  it('refuses the spec sample own gap of 741', () => {
    expectRefused(broken((p) => { obj(p, 'scanManifest')['linesRead'] = 129_873 }), 'V-9')
  })

  it('refuses a file count that does not close', () => {
    expectRefused(broken((p) => { obj(p, 'scanManifest')['filesRead'] = 1_500 }), 'V-9')
  })
})

describe('V-10 — an axis tally that drops rows', () => {
  it('refuses states that do not sum to linesRead', () => {
    expectRefused(
      broken((p) => {
        obj(obj(obj(p, 'axes'), 'selfVerification'), 'lineStates')['not_applicable'] = 1
      }),
      'V-10',
    )
  })
})

describe('V-11 — activeDays over sources we cannot reason about', () => {
  it('refuses max(), which returned 107.1% here', () => {
    expectRefused(
      broken((p) => { obj(obj(p, 'scanManifest'), 'window')['activeDaysMethod'] = 'max(git, jsonl)' }),
      'V-11',
    )
  })

  it('refuses a union naming a source outside the known set', () => {
    // history.jsonl stopped being written on 2026-04-17 on both measured
    // machines. Folding it in inflates the denominator, which lowers the record
    // rate and makes V-5 pass more easily — the failure points the wrong way.
    expectRefused(
      broken((p) => {
        obj(obj(p, 'scanManifest'), 'window')['activeDaysMethod'] =
          'union-of-observed(git, jsonl, historyJsonl)'
      }),
      'V-11',
    )
  })
})

describe('the rule set is honest about what it does not check', () => {
  it('every declared rule has a fixture above', () => {
    // Guards against a rule id existing with nothing exercising it.
    const covered = new Set<RuleId>([
      'V-1', 'V-2', 'V-3', 'V-4', 'V-5', 'V-6', 'V-7', 'V-9', 'V-10', 'V-11',
    ])
    expect([...RULE_IDS].filter((r) => !covered.has(r))).toEqual([])
  })

  it('states the two it does not implement, rather than implying full coverage', () => {
    expect([...NOT_IMPLEMENTED_HERE]).toEqual(['V-8', 'V-12'])
    expect([...RULE_IDS] as string[]).not.toContain('V-8')
  })
})
