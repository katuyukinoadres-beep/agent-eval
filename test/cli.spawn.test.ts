import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The only tests that run the thing users actually get.
 *
 * Every other test imports a module. The shipped artifact is `dist/cli.js`
 * invoked by a shell through the `bin` entry, and nothing exercised that — so
 * the suite was green for a long time while the binary did nothing at all.
 *
 * The entry guard used to be `import.meta.url.endsWith(argv[1])`, comparing a
 * percent-encoded `file://` URL against a raw path. A home directory named
 * `C:\Users\First Last` gave `with%20space` on one side and a space on the
 * other, so the body never ran: zero bytes of output and exit 0. The same miss
 * happens through a symlink, which is what `npm i -g` creates on POSIX.
 *
 * Silence with a success code is the worst failure a CLI can have. There is
 * nothing to search for and nothing to paste into an issue.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const built = join(repo, 'dist', 'cli.js')

let sandbox = ''

beforeAll(() => {
  // The point of this file is the built artifact, so build it if it is absent
  // rather than skipping and reporting a pass.
  if (!existsSync(built)) execSync('npm run build', { cwd: repo, stdio: 'ignore' })
  sandbox = mkdtempSync(join(tmpdir(), 'agent-eval-cli-'))
}, 120_000)

afterAll(() => {
  if (sandbox !== '') rmSync(sandbox, { recursive: true, force: true })
})

const runFrom = (entry: string): { out: string; code: number } => {
  try {
    const out = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' })
    return { out: out.trim(), code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; status?: number }
    return { out: (err.stdout ?? '').trim(), code: err.status ?? -1 }
  }
}

describe('the binary a user actually runs', () => {
  it('prints its version from an ordinary path', () => {
    const r = runFrom(built)
    expect(r.out).toMatch(/^\d+\.\d+\.\d+$/)
    expect(r.code).toBe(0)
  })

  it('prints it from a path containing a space', () => {
    // `C:\Users\First Last` is an ordinary Windows home directory. Under the
    // old guard this produced no output and exit 0.
    const spaced = join(sandbox, 'with space')
    mkdirSync(spaced, { recursive: true })
    cpSync(join(repo, 'dist'), join(spaced, 'dist'), { recursive: true })
    const r = runFrom(join(spaced, 'dist', 'cli.js'))
    expect(r.out).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('prints it when reached through a symlink', () => {
    // The shape `npm i -g` produces on POSIX: the bin entry is a link and the
    // real file lives elsewhere, so `import.meta.url` resolves to the target
    // while `argv[1]` stays the link. Under the old guard they never matched.
    //
    // Creating a symlink on Windows needs Developer Mode or elevation, so this
    // reports why it could not run rather than passing quietly.
    const link = join(sandbox, 'agent-eval-link.js')
    try {
      symlinkSync(built, link, 'file')
    } catch (e) {
      const code = (e as { code?: string }).code
      expect(['EPERM', 'EACCES'], `unexpected symlink failure: ${String(code)}`).toContain(code)
      return
    }
    const r = runFrom(link)
    expect(r.out).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('says something on every exit path, and never exits 0 in silence', () => {
    // The property that was violated. An empty stdout with status 0 is
    // indistinguishable from success, and it is what a broken entry guard
    // produces.
    for (const args of [['--version'], ['--help'], ['emit', '--fixture', 'base']]) {
      const out = execFileSync(process.execPath, [built, ...args], { encoding: 'utf8' })
      expect(out.trim().length, args.join(' ')).toBeGreaterThan(0)
    }
  })

  it('reports an unknown argument on stderr with a non-zero code', () => {
    // The other direction: a failure has to be loud. If this passed while the
    // tests above failed, the guard would be inverted rather than fixed.
    let code = 0
    let stderr = ''
    try {
      execFileSync(process.execPath, [built, 'nonsense'], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { status?: number; stderr?: string }
      code = err.status ?? -1
      stderr = err.stderr ?? ''
    }
    expect(code).not.toBe(0)
    expect(stderr).toContain('unknown argument')
  })
})
