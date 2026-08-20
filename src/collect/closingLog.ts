/**
 * The external log — a CSV the environment keeps outside the transcripts.
 *
 * It is the numerator of the record rate: of the days that left evidence of
 * work, the share that also reached a log somebody maintains. On this machine
 * that log outlives the raw transcripts by months, which is exactly why the
 * denominator is a union rather than a max — three of its days survive nowhere
 * else, and `max(git, jsonl)` put the numerator above the denominator at 107.1%.
 *
 * Its location is configuration, not discovery. There is no convention to guess
 * at, and a guess that missed would report `exists: false` — indistinguishable
 * from an environment that keeps no log at all.
 *
 * Neither the path nor any cell but the date leaves this module. The rows carry
 * session ids, client-facing application names and cost figures.
 */

import { readFileSync } from 'node:fs'

/** The column read, unless the caller names another. Every other column is ignored. */
export const DEFAULT_DATE_COLUMN = 'date'

const DATE_CELL = /^(\d{4}-\d{2}-\d{2})/

export type ClosingLogAbsence =
  | 'not-configured'
  | 'unreadable'
  | 'no-header'
  | 'column-missing'

export interface ClosingLog {
  readonly exists: boolean
  /** Why it is absent, when it is. `null` when it was read. */
  readonly absence: ClosingLogAbsence | null
  /** Data rows, header excluded. */
  readonly rows: number
  /** Distinct dates, sorted. */
  readonly dates: readonly string[]
  /** Rows whose date cell did not parse. Counted, never silently dropped. */
  readonly rowsUnparsed: number
}

const ABSENT = (absence: ClosingLogAbsence): ClosingLog => ({
  exists: false,
  absence,
  rows: 0,
  dates: [],
  rowsUnparsed: 0,
})

/**
 * Splits one CSV record.
 *
 * Hand-written rather than pulled in, because the only requirement is that a
 * quoted comma does not split a field — these files carry JSON in some columns,
 * and a naive split would shift every column after it and read a date out of the
 * wrong one.
 */
export function splitRow(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      out.push(field)
      field = ''
    } else {
      field += c
    }
  }
  out.push(field)
  return out
}

type Reader = (path: string) => string

export function readClosingLog(
  path: string | null,
  column: string = DEFAULT_DATE_COLUMN,
  read: Reader = (p) => readFileSync(p, 'utf8'),
): ClosingLog {
  if (path === null || path === '') return ABSENT('not-configured')

  let raw: string
  try {
    raw = read(path)
  } catch {
    return ABSENT('unreadable')
  }

  const lines = raw.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
  const header = lines[0]
  if (header === undefined) return ABSENT('no-header')

  const columns = splitRow(header).map((c) => c.trim())
  const at = columns.indexOf(column)
  if (at === -1) return ABSENT('column-missing')

  const dates = new Set<string>()
  let unparsed = 0
  for (const line of lines.slice(1)) {
    const cell = splitRow(line)[at]
    const m = cell === undefined ? null : DATE_CELL.exec(cell.trim())
    // A row whose date will not parse is still a row. Dropping it from `rows`
    // as well as from `dates` would lower the numerator and the row count
    // together, which is the arithmetic that hides a broken column index.
    if (m === null || m[1] === undefined) unparsed += 1
    else dates.add(m[1])
  }

  return {
    exists: true,
    absence: null,
    rows: lines.length - 1,
    dates: [...dates].sort(),
    rowsUnparsed: unparsed,
  }
}
