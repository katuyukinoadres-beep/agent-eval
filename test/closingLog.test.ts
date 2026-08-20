import { describe, expect, it } from 'vitest'
import { readClosingLog, splitRow } from '@/collect/closingLog.js'

/**
 * The external log is the record rate's numerator. It is also the only input
 * here that a person maintains by hand, so its shape varies and its absence is
 * ordinary. What must never happen is that a misread column looks like a machine
 * that keeps no log.
 */

const read = (text: string) => (): string => text

const HEADER = 'date,spans_months,app,session_id,started_at,duration_minutes'

describe('reading a log that is there', () => {
  it('counts rows and distinct dates separately', () => {
    // 42 rows over 15 days on this machine. A field that conflated them would be
    // out by 2.8x and read plausibly either way.
    const log = readClosingLog(
      '/x.csv',
      'date',
      read(`${HEADER}\n2026-08-19,false,a,s1,x,10\n2026-08-19,false,b,s2,x,20\n2026-08-20,false,a,s3,x,5\n`),
    )
    expect(log.exists).toBe(true)
    expect(log.rows).toBe(3)
    expect(log.dates).toEqual(['2026-08-19', '2026-08-20'])
  })

  it('reads the named column, not the first one', () => {
    const log = readClosingLog('/x.csv', 'when', read('app,when\nfoo,2026-08-19\n'))
    expect(log.dates).toEqual(['2026-08-19'])
  })

  it('accepts a full timestamp in the date cell', () => {
    const log = readClosingLog('/x.csv', 'date', read('date\n2026-08-19T10:00:00+09:00\n'))
    expect(log.dates).toEqual(['2026-08-19'])
  })

  it('survives CRLF, which is how the file arrives on this platform', () => {
    const log = readClosingLog('/x.csv', 'date', read('date,app\r\n2026-08-19,a\r\n'))
    expect(log.dates).toEqual(['2026-08-19'])
  })
})

describe('a row whose date will not parse', () => {
  it('is counted, and stays in the row total', () => {
    // Dropping it from `rows` as well as from `dates` lowers numerator and
    // denominator together, which is the arithmetic that hides a wrong column
    // index: every ratio still looks reasonable.
    const log = readClosingLog('/x.csv', 'date', read('date\n2026-08-19\n—\nn/a\n'))
    expect(log.rows).toBe(3)
    expect(log.dates).toEqual(['2026-08-19'])
    expect(log.rowsUnparsed).toBe(2)
  })
})

describe('absence says which absence it is', () => {
  it('distinguishes never-configured from unreadable', () => {
    expect(readClosingLog(null).absence).toBe('not-configured')
    expect(readClosingLog('/gone.csv', 'date', () => { throw new Error('ENOENT') }).absence).toBe('unreadable')
  })

  it('distinguishes a missing column from a missing file', () => {
    // The dangerous one. A renamed column produces zero dates, and a record rate
    // of 0/N is a number a receiver would accept without comment.
    const log = readClosingLog('/x.csv', 'date', read('day,app\n2026-08-19,a\n'))
    expect(log.exists).toBe(false)
    expect(log.absence).toBe('column-missing')
    expect(log.dates).toEqual([])
  })

  it('reports an empty file as having no header rather than as zero rows', () => {
    expect(readClosingLog('/x.csv', 'date', read('')).absence).toBe('no-header')
  })
})

describe('the row splitter', () => {
  it('does not split inside quotes', () => {
    // These files carry JSON in some columns. A naive split shifts every column
    // after it, and the date then comes out of whichever column landed there.
    expect(splitRow('2026-08-19,"{""a"":1,""b"":2}",x')).toEqual(['2026-08-19', '{"a":1,"b":2}', 'x'])
  })

  it('keeps empty fields, so column positions do not shift', () => {
    expect(splitRow('a,,c')).toEqual(['a', '', 'c'])
    expect(splitRow(',,')).toEqual(['', '', ''])
  })

  it('reads the right column when an earlier one holds a comma', () => {
    const log = readClosingLog('/x.csv', 'date', read('note,date\n"a,b",2026-08-19\n'))
    expect(log.dates).toEqual(['2026-08-19'])
  })
})
