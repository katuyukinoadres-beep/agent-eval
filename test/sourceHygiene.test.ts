import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * No source file may contain a raw control byte.
 *
 * Five separate times in one day, a string written into this codebase was not
 * the string that was meant: a NUL where a separator was intended, an
 * apostrophe that closed a literal early, a newline inside a regex, and twice a
 * character range written as the characters themselves. Four of the five
 * compiled. One of them -- a character class whose backslash escaped the
 * closing bracket -- passed type checking, passed every existing test, and
 * silently emitted unescaped backslashes into what was going to be hashed.
 *
 * They are invisible in review, they make grep call the file binary, and any
 * tool that normalises whitespace changes behaviour without touching a line
 * anyone can see.
 *
 * A rule that is only a habit gets broken on the day attention is elsewhere,
 * which is exactly the day it matters. This is the check that makes the habit
 * unnecessary. Separators that genuinely need a control character build it with
 * `String.fromCharCode`, under a name.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOTS = [join(HERE, '..', 'src'), join(HERE, '..', 'test')]

/** Tab, newline and carriage return are the ones a text file legitimately has. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d])

function* typescriptFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* typescriptFiles(path)
    else if (name.endsWith('.ts')) yield path
  }
}

interface Finding {
  readonly file: string
  readonly line: number
  readonly byte: number
}

function scan(): { readonly findings: Finding[]; readonly filesScanned: number } {
  const findings: Finding[] = []
  let filesScanned = 0
  for (const root of ROOTS) {
    for (const path of typescriptFiles(root)) {
      filesScanned += 1
      const bytes = readFileSync(path)
      let line = 1
      for (const b of bytes) {
        if (b === 0x0a) line += 1
        if (b < 0x20 && !ALLOWED.has(b)) {
          findings.push({ file: path.slice(path.lastIndexOf('agent-eval')), line, byte: b })
        }
      }
    }
  }
  return { findings, filesScanned }
}

describe('source hygiene', () => {
  it('has no raw control bytes anywhere in src or test', () => {
    const { findings, filesScanned } = scan()
    // The range is stated, so a zero here is comparable and reproducible rather
    // than a number with no denominator behind it.
    expect(filesScanned).toBeGreaterThan(20)
    expect(
      findings.map((f) => `${f.file}:${f.line} byte 0x${f.byte.toString(16).padStart(2, '0')}`),
    ).toEqual([])
  })

  it('can see one when there is one', () => {
    // The positive control. A scan reporting nothing and a scan that never
    // looked produce the same empty array, and this file exists because four
    // separate mistakes had already got past everything else.
    const withNul = Buffer.from(`const x = 'a${String.fromCharCode(0)}b'`, 'utf8')
    const found = [...withNul].filter((b) => b < 0x20 && !ALLOWED.has(b))
    expect(found).toEqual([0])
  })

  it('does not flag the bytes a text file legitimately has', () => {
    const ordinary = Buffer.from('line one\r\n\tindented\n', 'utf8')
    expect([...ordinary].filter((b) => b < 0x20 && !ALLOWED.has(b))).toEqual([])
  })
})
