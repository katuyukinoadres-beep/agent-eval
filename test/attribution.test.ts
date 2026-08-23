import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTIONS,
  ATTRIBUTION_PRIMARY,
  EVALUATION_ORDER,
  IN_AXIS2_DENOMINATOR,
  IN_AXIS2_NUMERATOR,
  SPEC_DENIAL_KINDS,
  SUPPLIES_SIGNATURE,
  attribute,
  closure,
  emptyTally,
  isExternalTool,
  type AttributionInput,
} from '@/collect/attribution.js'

/**
 * The table exists because one event was reaching two axes with opposite signs:
 * a call a permission rule refused was charged to the agent as wasted motion
 * and credited to the environment as a guardrail working.
 *
 * Measured here, the correction is 407 failures down to 187 in axis 2's
 * numerator. The tests below pin the parts of that where getting it wrong
 * produces a plausible number rather than an error.
 */

const at = (over: Partial<AttributionInput> = {}): AttributionInput => ({
  denialKind: null,
  text: '',
  tool: 'Bash',
  errorClass: 'other:0000',
  ...over,
})

describe('the evaluation order', () => {
  it('decides a denial before it reads the body', () => {
    // The case that makes the order load-bearing. This failure would classify
    // as E7 on its text alone, and E7 feeds axis 3. Reading the body first
    // would move a refused call into a different axis entirely.
    expect(
      attribute(at({ denialKind: 'permission-rule', errorClass: 'edit_stale_read' })),
    ).toBe('E2')
    expect(attribute(at({ errorClass: 'edit_stale_read' }))).toBe('E7')
  })

  it('decides a denial before it looks at the tool', () => {
    // Same shape one step later: E4 would take this call out of every axis,
    // which is a different claim from "a guardrail stopped it".
    expect(attribute(at({ denialKind: 'user-rejected', tool: 'WebFetch' }))).toBe('E3')
    expect(attribute(at({ tool: 'WebFetch' }))).toBe('E4')
  })

  it('is the order the spec fixed', () => {
    expect(EVALUATION_ORDER).toEqual(['E1', 'E2', 'E2b', 'E3', 'E4', 'E7', 'E6', 'E5', 'E8_E9'])
  })
})

describe('denials', () => {
  it('splits a permission rule by whether a hook wrote the text', () => {
    const hook = at({ denialKind: 'permission-rule', text: 'PreToolUse:Bash refused' })
    expect(attribute(hook)).toBe('E1')
    expect(attribute(at({ denialKind: 'permission-rule', text: 'refused' }))).toBe('E2')
  })

  it('sends a kind the spec does not name to E2b rather than to the residue', () => {
    // 95 of 407 failures here are these, and none at all on the machine the
    // spec was written against. Left in the residue they would be charged to
    // the agent, so an environment running under auto mode would score worse
    // than one that is not, for refusals neither of them chose.
    expect(attribute(at({ denialKind: 'automode-blocked' }))).toBe('E2b')
    expect(attribute(at({ denialKind: 'automode-unavailable' }))).toBe('E2b')
    expect(attribute(at({ denialKind: 'something-invented-next-release' }))).toBe('E2b')
  })

  it('keeps every kind of denial out of axis 2', () => {
    for (const kind of ['permission-rule', 'user-rejected', 'automode-blocked', 'whatever']) {
      const id = attribute(at({ denialKind: kind }))
      expect(IN_AXIS2_NUMERATOR[id]).toBe(false)
    }
  })

  it('names the two kinds the spec covers, and does not pretend they are all', () => {
    expect(SPEC_DENIAL_KINDS).toEqual(['permission-rule', 'user-rejected'])
    expect(SPEC_DENIAL_KINDS).not.toContain('automode-blocked')
  })
})

describe('the structured field against the body pattern it replaces', () => {
  it('catches a denial the body pattern misses', () => {
    // The reason the field replaced the pattern. `(Pre|Post)ToolUse:` matched 0
    // of 407 failures here and 12 of 62 denials on the other machine, because
    // it was fitted to text one environment happens to emit.
    const missed = at({ denialKind: 'permission-rule', text: 'Claude requested permissions' })
    expect(attribute(missed)).toBe('E2')
    expect(IN_AXIS2_NUMERATOR[attribute(missed)]).toBe(false)
  })

  it('still catches the ones the body pattern did', () => {
    // Positive control for the claim above: the pattern is a subset, not a
    // different set. If this failed, the replacement would be losing events the
    // old code caught, and the numerator would move the flattering way.
    const caught = at({ denialKind: 'permission-rule', text: 'PreToolUse:Bash' })
    expect(attribute(caught)).toBe('E1')
    expect(IN_AXIS2_NUMERATOR[attribute(caught)]).toBe(false)
  })
})

describe('external tools', () => {
  it('leaves the network out of every axis', () => {
    expect(attribute(at({ tool: 'WebFetch' }))).toBe('E4')
    expect(attribute(at({ tool: 'WebSearch' }))).toBe('E4')
    expect(attribute(at({ tool: 'mcp__playwright__browser_click' }))).toBe('E4')
    expect(IN_AXIS2_NUMERATOR.E4).toBe(false)
    expect(IN_AXIS2_DENOMINATOR.E4).toBe(false)
    expect(SUPPLIES_SIGNATURE.E4).toBe(false)
  })

  it('does not treat a tool whose name merely contains mcp as external', () => {
    expect(isExternalTool('mcp__x')).toBe(true)
    expect(isExternalTool('my_mcp__helper')).toBe(false)
    expect(isExternalTool('Bash')).toBe(false)
  })

  it('attributes by class when the tool could not be joined', () => {
    // A tool_use_id that did not join leaves the tool unknown. Guessing
    // external would silently drop the failure out of every axis.
    expect(attribute(at({ tool: null, errorClass: 'timeout' }))).toBe('E6')
  })
})

describe('the axis-3 hand-off', () => {
  it('takes a stale read out of the numerator but leaves it in the denominator', () => {
    // The only row where the two differ. A stale read is real work that
    // happened; it is evidence of a verification that did not.
    expect(attribute(at({ errorClass: 'edit_stale_read' }))).toBe('E7')
    expect(attribute(at({ errorClass: 'edit_string_not_found' }))).toBe('E7')
    expect(IN_AXIS2_NUMERATOR.E7).toBe(false)
    expect(IN_AXIS2_DENOMINATOR.E7).toBe(true)
  })
})

describe('what reaches axis 2', () => {
  it('takes timeouts, missing dependencies and the residue', () => {
    expect(attribute(at({ errorClass: 'timeout' }))).toBe('E6')
    expect(attribute(at({ errorClass: 'cmd_not_found' }))).toBe('E5')
    expect(attribute(at({ errorClass: 'no_such_file' }))).toBe('E5')
    expect(attribute(at({ errorClass: 'traceback:ValueError' }))).toBe('E8_E9')
    expect(attribute(at({ errorClass: 'syntax_error' }))).toBe('E8_E9')
    expect(attribute(at({ errorClass: 'permission_denied' }))).toBe('E8_E9')
    for (const id of ['E5', 'E6', 'E8_E9'] as const) expect(IN_AXIS2_NUMERATOR[id]).toBe(true)
  })

  it('scores a body that merely says permission when no denial was recorded', () => {
    // Deliberate. Without the structured field there is nothing to say this was
    // a guardrail rather than the agent failing, and inventing the distinction
    // from text is what the field replaced.
    expect(attribute(at({ errorClass: 'permission_denied', denialKind: null }))).toBe('E8_E9')
  })
})

describe('the tables', () => {
  it('cover every attribution', () => {
    for (const id of ATTRIBUTIONS) {
      expect(IN_AXIS2_NUMERATOR[id]).toBeTypeOf('boolean')
      expect(IN_AXIS2_DENOMINATOR[id]).toBeTypeOf('boolean')
      expect(SUPPLIES_SIGNATURE[id]).toBeTypeOf('boolean')
      expect(ATTRIBUTION_PRIMARY[id]).toBeTruthy()
    }
    expect(Object.keys(emptyTally()).sort()).toEqual([...ATTRIBUTIONS].sort())
  })

  it('never lets an excluded attribution supply a signature', () => {
    // A signature set is what axis 6 intersects across windows. Feeding it a
    // refused call would make a guardrail firing twice look like the same
    // failure recurring.
    for (const id of ATTRIBUTIONS) {
      if (!IN_AXIS2_NUMERATOR[id]) expect(SUPPLIES_SIGNATURE[id]).toBe(false)
    }
  })

  it('keeps the signature set distinct from the numerator table', () => {
    // They agree today and are written out separately on purpose. Aliasing them
    // would mean a later change to one silently changed the other.
    expect(SUPPLIES_SIGNATURE).not.toBe(IN_AXIS2_NUMERATOR)
  })
})

describe('the closure check', () => {
  it('balances when the partition accounts for every failure seen', () => {
    const t = emptyTally()
    t.E2 = 28
    t.E2b = 95
    t.E3 = 5
    t.E4 = 48
    t.E7 = 44
    t.E6 = 5
    t.E5 = 73
    t.E8_E9 = 109
    const c = closure(t, 407)
    expect(c.numerator).toBe(187)
    expect(c.excluded).toBe(220)
    expect(c.balanced).toBe(true)
  })

  it('reports false when an event went missing', () => {
    // The positive control. `balanced` computed from the tally alone would be
    // true for every input, including a partition that lost half its events --
    // a check that cannot fail is worse than no check, because it reports
    // success. `observed` has to come from outside the tally for this to fail.
    const t = emptyTally()
    t.E5 = 100
    expect(closure(t, 100).balanced).toBe(true)
    expect(closure(t, 101).balanced).toBe(false)
    expect(closure(t, 99).balanced).toBe(false)
  })

  it('counts an empty scan as balanced at zero', () => {
    expect(closure(emptyTally(), 0)).toMatchObject({ balanced: true, numerator: 0, excluded: 0 })
  })
})
