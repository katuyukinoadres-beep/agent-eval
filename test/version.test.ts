import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from '@/version.js'

/**
 * Two version numbers that can drift are two version numbers that will.
 *
 * `VERSION` is stamped into `--version`, the summary header, the payload's
 * `toolVersion` and every snapshot written to disk. Snapshots are hash-chained
 * and not rewritable, so bumping `package.json` alone would leave every stored
 * measurement permanently claiming the old build made it — and for a tool whose
 * value is comparing one window against another, a version field that lies
 * makes it impossible to tell which code produced which number.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string
  bin: Record<string, string>
  files: string[]
  license: string
  private?: boolean
}

describe('the version this build stamps', () => {
  it('is the version the package publishes', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('is a real version rather than a placeholder', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(VERSION).not.toBe('0.0.0')
  })
})

describe('what the package would publish', () => {
  it('is publishable at all', () => {
    // `private: true` makes `npm publish` refuse outright, which is the correct
    // setting for a repository nobody may install and the wrong one for this.
    expect(pkg.private).toBeUndefined()
  })

  it('states a licence', () => {
    // Without one, a public repository grants the right to read and nothing
    // else, and npm publishes it as UNLICENSED.
    expect(pkg.license).toBeTruthy()
  })

  it('ships the built binary and not the internal documents', () => {
    // Without `files`, `npm pack` takes everything the gitignore does not
    // exclude — which here is 1.6 MB of development narrative naming private
    // agents, an internal database and a client, against a 46-file runtime.
    expect(pkg.files).toContain('dist')
    expect(pkg.files.some((f) => f.startsWith('docs/DECISION_LOG'))).toBe(false)
    expect(pkg.files.some((f) => f.startsWith('docs/PHASE0_PLAN'))).toBe(false)
    expect(pkg.files.some((f) => f.startsWith('docs/spec'))).toBe(false)
  })

  it('points its binary at something the build produces', () => {
    expect(pkg.bin['agent-eval']).toBe('./dist/cli.js')
  })
})
