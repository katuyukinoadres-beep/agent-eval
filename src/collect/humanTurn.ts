/**
 * P1 — deciding which user rows are a person speaking.
 *
 * The definition is the v1 axes document's, and it is not the one this code
 * used first. The earlier implementation counted `origin.kind === 'human'` and
 * nothing else, which reads 250 turns over 5 days on this machine against P1's
 * 413 over 9 — understating turns by 1.65x and days by 1.8x.
 *
 * v1 says why, in as many words: `origin.kind` was absent from 134 of 144 text
 * messages when it was measured, so it may be used as a supporting signal and
 * must never be read as "no key means not human". Coverage here is 3.2%.
 *
 * The day count matters beyond the metric. It is the window's `activeDays`, and
 * the environment gate withholds a total below five. The origin-only reading put
 * this machine at exactly 5 — one day from being unscoreable — while the real
 * figure has four days of margin.
 *
 * Message text is read here and never leaves. Only counts do.
 */

/**
 * Markers that make a user row a channel rather than a person.
 *
 * Checked against the first 300 characters, per v1: a later occurrence is a
 * person quoting one, and dropping the row for that would silence people who
 * talk about their tooling.
 */
export const CHANNEL_MARKERS = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<system-reminder>',
] as const

/** A skill being injected into the conversation, not a person typing. */
export const SKILL_INJECTION_PREFIX = 'Base directory for this skill:'

export const INTERRUPT_MARKER = '[Request interrupted by user]'

export const MARKER_SCAN_CHARS = 300
export const PREFIX_SCAN_CHARS = 200

export type NotHumanReason =
  | 'tool-result'
  | 'channel-marker'
  | 'skill-injection'
  | 'interrupted'
  | 'subagent'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The text of a user row, flattened. Read locally, never emitted. */
export function userText(row: Record<string, unknown>): string {
  const message = row['message']
  if (!isObj(message)) return ''
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (isObj(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      out += block['text']
    }
  }
  return out
}

export function hasToolResult(row: Record<string, unknown>): boolean {
  const message = row['message']
  if (!isObj(message)) return false
  const content = message['content']
  return Array.isArray(content) && content.some((b) => isObj(b) && b['type'] === 'tool_result')
}

/**
 * Why this row is not a person speaking, or null if it is.
 *
 * Returns the reason rather than a boolean so the excluded counts can be
 * reported. 3,959 of 4,379 user rows here are tool results; a filter that
 * removed 90% of its input without saying so would be indistinguishable from one
 * that was broken.
 *
 * `isSubagent` comes from the file's position rather than from `isSidechain`.
 * v1 phrases the condition as `isSidechain != true`, and the field agrees with
 * the path on both measured machines — but it reads false on every main-file row
 * including ones that are sidechains, so the path is the version that cannot go
 * quietly wrong.
 */
export function notHumanBecause(
  row: Record<string, unknown>,
  isSubagent: boolean,
): NotHumanReason | null {
  if (isSubagent) return 'subagent'
  if (hasToolResult(row)) return 'tool-result'
  const text = userText(row)
  const head = text.slice(0, MARKER_SCAN_CHARS)
  if (CHANNEL_MARKERS.some((m) => head.includes(m))) return 'channel-marker'
  if (text.slice(0, PREFIX_SCAN_CHARS).startsWith(SKILL_INJECTION_PREFIX)) return 'skill-injection'
  // Counted separately and excluded, per v1: an interruption is a person acting,
  // but it is not a turn with content to attribute anything to.
  if (head.includes(INTERRUPT_MARKER)) return 'interrupted'
  return null
}

export const isHumanTurn = (row: Record<string, unknown>, isSubagent: boolean): boolean =>
  notHumanBecause(row, isSubagent) === null
