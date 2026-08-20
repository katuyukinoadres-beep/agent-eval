import { describe, expect, it } from 'vitest'
import {
  CHANNEL_MARKERS,
  INTERRUPT_MARKER,
  MARKER_SCAN_CHARS,
  SKILL_INJECTION_PREFIX,
  isHumanTurn,
  notHumanBecause,
  userText,
} from '@/collect/humanTurn.js'

/**
 * P1, from the v1 axes document.
 *
 * The implementation this replaced counted `origin.kind === 'human'` and
 * nothing else: 250 turns over 5 days on this machine against P1's 413 over 9.
 * The day count is the window's `activeDays`, and the gate withholds a total
 * below five — so the shortcut had this environment one day from unscoreable
 * while the real figure has four days of margin.
 */

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user',
  message: { content: [{ type: 'text', text: 'ここを直して' }] },
  ...over,
})

const withText = (text: string): Record<string, unknown> =>
  row({ message: { content: [{ type: 'text', text }] } })

describe('a person speaking', () => {
  it('counts a plain user row', () => {
    expect(isHumanTurn(row(), false)).toBe(true)
  })

  it('counts one carrying no origin at all', () => {
    // 96.8% of user rows on this machine. Reading a missing key as "not human"
    // is what cost 1.65x, and v1 names the mistake explicitly.
    expect(notHumanBecause(row(), false)).toBeNull()
  })

  it('counts one whose origin says human, without requiring it', () => {
    expect(isHumanTurn(row({ origin: { kind: 'human' } }), false)).toBe(true)
  })

  it('counts a row with no message body', () => {
    // A denial row carries toolDenialKind and no text. It is still a person.
    expect(isHumanTurn({ type: 'user', toolDenialKind: 'user-rejected' }, false)).toBe(true)
  })
})

describe('what is not a person', () => {
  it('excludes a tool result, which is most user rows', () => {
    const r = row({ message: { content: [{ type: 'tool_result', is_error: false }] } })
    expect(notHumanBecause(r, false)).toBe('tool-result')
  })

  it('excludes a subagent row by where the file sits', () => {
    // v1 phrases this as `isSidechain != true`. The field agrees with the path
    // on both measured machines, but it reads false on every main-file row
    // including sidechains, so the path is the version that cannot go quietly
    // wrong. 6,070 subagent rows carry true; 0 main rows do.
    expect(notHumanBecause(row(), true)).toBe('subagent')
  })

  it('excludes every channel marker the spec names', () => {
    for (const marker of CHANNEL_MARKERS) {
      expect(notHumanBecause(withText(`${marker} ...`), false), marker).toBe('channel-marker')
    }
  })

  it('excludes a skill injection', () => {
    expect(notHumanBecause(withText(`${SKILL_INJECTION_PREFIX} /x/y`), false)).toBe('skill-injection')
  })

  it('excludes an interruption, and names it separately', () => {
    // v1 counts these apart rather than folding them into the tool-result pile:
    // an interruption is a person acting, but not a turn with content.
    expect(notHumanBecause(withText(INTERRUPT_MARKER), false)).toBe('interrupted')
  })
})

describe('the marker window is bounded on purpose', () => {
  it('ignores a marker past the first 300 characters', () => {
    // Someone writing about their tooling quotes these. Scanning the whole body
    // would silence exactly the people who talk about the thing being measured.
    const text = `${'あ'.repeat(MARKER_SCAN_CHARS + 50)}<system-reminder>`
    expect(notHumanBecause(withText(text), false)).toBeNull()
  })

  it('catches one at the very end of the window', () => {
    // The positive control for the assertion above: the boundary has to be
    // reachable from both sides or the first test proves only that long text
    // passes.
    const marker = '<system-reminder>'
    const text = `${'あ'.repeat(MARKER_SCAN_CHARS - marker.length)}${marker}`
    expect(notHumanBecause(withText(text), false)).toBe('channel-marker')
  })

  it('requires the skill prefix at the start, not anywhere', () => {
    expect(notHumanBecause(withText(`話は変わるけど ${SKILL_INJECTION_PREFIX}`), false)).toBeNull()
  })
})

describe('reading the text', () => {
  it('joins text blocks and ignores the rest', () => {
    const r = row({
      message: { content: [{ type: 'text', text: 'あ' }, { type: 'image' }, { type: 'text', text: 'い' }] },
    })
    expect(userText(r)).toBe('あい')
  })

  it('accepts a plain string body', () => {
    expect(userText({ message: { content: 'そのまま' } })).toBe('そのまま')
  })

  it('returns empty rather than throwing on a shape it does not know', () => {
    expect(userText({})).toBe('')
    expect(userText({ message: null })).toBe('')
    expect(userText({ message: { content: 42 } })).toBe('')
  })
})
