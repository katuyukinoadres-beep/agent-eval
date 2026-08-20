import { describe, expect, it } from 'vitest'
import {
  DIGEST_CHARS,
  ERROR_CLASSES,
  classifyError,
  digest,
  errorFamily,
  repeatRate,
} from '@/collect/errorClass.js'
import { targetOf } from '@/collect/scan.js'

/**
 * The patterns here were fitted by reading what fell through, not by reasoning
 * about what errors look like.
 *
 * The first attempt left 63.1% of 317 real failures in `other`, and opening that
 * bucket showed the miss: this environment's commonest failure is a permission
 * refusal, phrased "Permission for this action was denied" and "Permission to
 * use Bash with command" — neither of which matches `permission denied`. With
 * that fixed, `other` is 32.5% and permission refusals are 27.8%, the largest
 * named class.
 *
 * The lesson generalises past the regex. A classifier reporting a large `other`
 * bucket looks like a hard dataset and is usually an unread one.
 */

describe('the classes v1 names', () => {
  it('recognises the permission refusals this machine actually produces', () => {
    // 88 of 317. The wording, verbatim from the log.
    expect(classifyError('Permission for this action was denied by the Claude Code auth')).toBe('permission_denied')
    expect(classifyError('Permission to use Bash with command cd /x')).toBe('permission_denied')
    expect(classifyError('EACCES: permission denied, open /x')).toBe('permission_denied')
  })

  it('recognises an edit against a file read too long ago', () => {
    expect(classifyError('File has been modified since read, either by the user or by a linter')).toBe('edit_stale_read')
    expect(classifyError('File has not been read yet. Read it again.')).toBe('edit_stale_read')
  })

  it('recognises a replacement that matched nothing', () => {
    expect(classifyError('String to replace not found in file.')).toBe('edit_string_not_found')
  })

  it('recognises a missing command by exit code as well as by wording', () => {
    expect(classifyError('Exit code 127\nfoo: command not found')).toBe('cmd_not_found')
    expect(classifyError("'foo' is not recognized as an internal or external command")).toBe('cmd_not_found')
  })

  it('recognises the rest', () => {
    expect(classifyError('Ripgrep search timed out after 10s')).toBe('timeout')
    expect(classifyError('ENOENT: no such file or directory')).toBe('no_such_file')
    expect(classifyError("error TS2345: Argument of type 'x'")).toBe('syntax_error')
  })

  it('names the exception a traceback ended on', () => {
    // traceback:ValueError and traceback:KeyError are different failures that
    // both mention a file.
    const text = 'Traceback (most recent call last)\n  File "x.py", line 1\nValueError: bad input'
    expect(classifyError(text)).toBe('traceback:ValueError')
  })

  it('keeps a traceback whose exception line is unreadable as a traceback', () => {
    // Checked before the flat rules: a script that times out prints both a
    // traceback and the word timeout, and classing it as a timeout loses which
    // script failed — the part that repeats.
    expect(classifyError('Traceback (most recent call last)\n<truncated> timed out')).toBe('traceback:unknown')
  })

  it('falls back to a digest, and the same message digests alike', () => {
    const a = classifyError('Exit code 1 something unfamiliar')
    expect(a.startsWith('other:')).toBe(true)
    expect(classifyError('Exit code 1 something unfamiliar')).toBe(a)
    expect(classifyError('Exit code 1 something else entirely')).not.toBe(a)
  })

  it('digests only the leading text, so a long tail does not split a class', () => {
    const head = 'x'.repeat(DIGEST_CHARS)
    expect(digest(`${head}AAAA`)).toBe(digest(`${head}BBBB`))
  })

  it('lists its named classes', () => {
    expect([...ERROR_CLASSES]).toContain('permission_denied')
    expect(errorFamily('traceback:ValueError')).toBe('traceback')
    expect(errorFamily('permission_denied')).toBe('permission_denied')
  })
})

describe('the repeat rate', () => {
  it('is zero when every failure was different', () => {
    const r = repeatRate([
      ['Bash', 'timeout', 'a'],
      ['Edit', 'edit_stale_read', 'b'],
    ])
    expect(r.rIn).toBe(0)
    expect(r.distinctSignatures).toBe(2)
  })

  it('rises as failures repeat', () => {
    const r = repeatRate([
      ['Bash', 'timeout', 'a'],
      ['Bash', 'timeout', 'a'],
      ['Bash', 'timeout', 'a'],
      ['Edit', 'edit_stale_read', 'b'],
    ])
    expect(r.distinctSignatures).toBe(2)
    expect(r.rIn).toBeCloseTo(0.5)
  })

  it('reports zero for an environment that failed at nothing', () => {
    // Not 1. No failures is no repeats to measure, and 1 would read as "every
    // failure was a repeat" — the loudest possible value for the quietest log.
    expect(repeatRate([]).rIn).toBe(0)
  })

  it('separates two tools failing the same way', () => {
    const r = repeatRate([
      ['Bash', 'no_such_file', 'a'],
      ['Read', 'no_such_file', 'a'],
    ])
    expect(r.distinctSignatures).toBe(2)
  })

  it('separates the same tool and class against different targets', () => {
    // The term an earlier version left constant. With the tool name hashed into
    // it instead of the target, a signature was really (tool, class) and two
    // failures against different files could not be told apart.
    const r = repeatRate([
      ['Bash', 'no_such_file', 'aaa'],
      ['Bash', 'no_such_file', 'bbb'],
    ])
    expect(r.distinctSignatures).toBe(2)
  })

  it('groups traceback variants under one family for reporting', () => {
    const r = repeatRate([
      ['Bash', 'traceback:ValueError', 'a'],
      ['Bash', 'traceback:KeyError', 'a'],
    ])
    expect(r.byFamily['traceback']).toBe(2)
    expect(r.distinctSignatures).toBe(2)
  })
})

describe('what a failing call was aimed at', () => {
  it('is the extension for a file operation', () => {
    expect(targetOf('Edit', { file_path: 'c:/x/y/a.TS' })).toBe('ts')
    expect(targetOf('Read', { file_path: '/x/a.py' })).toBe('py')
  })

  it('is the command name for a shell call, without its directory', () => {
    // So `scripts/x.py` and `./x.py` are the same target.
    expect(targetOf('Bash', { command: 'scripts/redact.py --in a' })).toBe('redact.py')
    expect(targetOf('Bash', { command: './redact.py' })).toBe('redact.py')
    expect(targetOf('Bash', { command: 'git status' })).toBe('git')
  })

  it('splits on a backslash as well as a slash', () => {
    // The character class was mangled to `[\/]` in an earlier edit, which drops
    // backslash silently: every Windows path then became one long token.
    expect(targetOf('Bash', { command: 'scripts\\redact.py' })).toBe('redact.py')
    expect(targetOf('Edit', { file_path: 'c:\\x\\a.md' })).toBe('md')
  })

  it('returns empty rather than guessing', () => {
    expect(targetOf('Edit', { file_path: 'Makefile' })).toBe('')
    expect(targetOf('Bash', {})).toBe('')
    expect(targetOf('Edit', null)).toBe('')
  })
})
