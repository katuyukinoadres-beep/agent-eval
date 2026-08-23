import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GITIGNORE_BODY,
  StateDirError,
  assertGuarded,
  defaultIo,
  ensureStateDir,
  keyFileFor,
  refuseIfTracked,
  stateDirFor,
  sweepStaging,
  type StateDirIo,
} from '@/snapshot/stateDir.js'

/**
 * The directory holds MACs of session ids, project names and command names, and
 * it is never pruned. Everything here is about it not existing in a state where
 * something else could pick it up.
 */

const roots: string[] = []
const freshHome = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'agent-eval-state-'))
  roots.push(r)
  return r
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** An IO that records the order operations happened in. */
const recordingIo = (log: string[], over: Partial<StateDirIo> = {}): StateDirIo => ({
  ...defaultIo,
  mkdir: (p) => {
    log.push(`mkdir ${p}`)
    defaultIo.mkdir(p)
  },
  writeFile: (p, b, m) => {
    log.push(`write ${p}`)
    defaultIo.writeFile(p, b, m)
  },
  rename: (a, b) => {
    log.push(`rename -> ${b}`)
    defaultIo.rename(a, b)
  },
  tracked: () => false,
  ...over,
})

describe('the directory cannot appear unguarded', () => {
  it('creates it with the guard already inside', () => {
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    expect(r.created).toBe(true)
    expect(readFileSync(join(r.stateDir, '.gitignore'), 'utf8')).toBe(GITIGNORE_BODY)
    expect(existsSync(r.snapshotDir)).toBe(true)
  })

  it('writes the guard before the directory has its real name', () => {
    // "mkdir then guard" leaves an unguarded directory if anything happens in
    // between. The rename is what makes it visible, and this pins the order:
    // the guard is written to the staging path, and only then does the rename
    // happen.
    const log: string[] = []
    const home = freshHome()
    const r = ensureStateDir(home, null, recordingIo(log))
    const guardWrite = log.findIndex((l) => l.includes('.gitignore'))
    const rename = log.findIndex((l) => l.startsWith('rename'))
    expect(guardWrite).toBeGreaterThanOrEqual(0)
    expect(rename).toBeGreaterThan(guardWrite)
    // And the path it was written to is not the final one.
    expect(log[guardWrite]).not.toContain(r.stateDir + '\\.gitignore')
  })

  it('rewrites a guard that has gone missing', () => {
    // The failure this protects against is an editor, a backup tool or a `git
    // clean` removing a dotfile months later, which nothing announces.
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    rmSync(join(r.stateDir, '.gitignore'))
    const again = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    expect(again.guardRewritten).toBe(true)
    expect(readFileSync(join(r.stateDir, '.gitignore'), 'utf8')).toBe(GITIGNORE_BODY)
  })

  it('rewrites a guard that no longer ignores everything', () => {
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    writeFileSync(join(r.stateDir, '.gitignore'), '# notes\nsnapshots/\n')
    expect(assertGuarded(r.stateDir)).toBe(true)
    expect(readFileSync(join(r.stateDir, '.gitignore'), 'utf8')).toBe(GITIGNORE_BODY)
  })

  it('leaves a good guard alone', () => {
    // The positive control for the two above: rewriting must be reachable and
    // not-rewriting must be too, or `guardRewritten` proves nothing.
    const home = freshHome()
    ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    const again = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    expect(again.guardRewritten).toBe(false)
    expect(again.created).toBe(false)
  })

  it('accepts a guard with other lines as long as one is exactly *', () => {
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    writeFileSync(join(r.stateDir, '.gitignore'), '# agent-eval state\n*\n')
    expect(assertGuarded(r.stateDir)).toBe(false)
  })
})

describe('losing a race', () => {
  it('drops its own staging rather than clobbering the winner', () => {
    const home = freshHome()
    const target = stateDirFor(home)
    let staged = ''
    const io: StateDirIo = {
      ...defaultIo,
      tracked: () => false,
      mkdir: (p) => {
        if (p.includes('.new-')) staged = p
        defaultIo.mkdir(p)
      },
      rename: () => {
        // Another run got there first, with its own guard already inside.
        defaultIo.mkdir(target)
        defaultIo.writeFile(join(target, '.gitignore'), GITIGNORE_BODY)
        throw new Error('EEXIST')
      },
    }
    const r = ensureStateDir(home, null, io)
    expect(r.created).toBe(false)
    expect(existsSync(staged)).toBe(false)
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toBe(GITIGNORE_BODY)
  })
})

describe('staging left by a dead run', () => {
  it('is swept', () => {
    const home = freshHome()
    mkdirSync(join(home, '.agent-eval.new-999999-abc'), { recursive: true })
    const swept = sweepStaging(home, { ...defaultIo, alive: () => false })
    expect(swept).toBe(1)
    expect(existsSync(join(home, '.agent-eval.new-999999-abc'))).toBe(false)
  })

  it('is left alone while its process still lives', () => {
    // A concurrent run's staging must not be swept out from under it. This is
    // the positive control for the sweep: it has to be able to not-sweep.
    const home = freshHome()
    mkdirSync(join(home, '.agent-eval.new-123-abc'), { recursive: true })
    const swept = sweepStaging(home, { ...defaultIo, alive: () => true })
    expect(swept).toBe(0)
    expect(existsSync(join(home, '.agent-eval.new-123-abc'))).toBe(true)
  })

  it('ignores directories that are not staging', () => {
    const home = freshHome()
    mkdirSync(join(home, 'Documents'), { recursive: true })
    expect(sweepStaging(home, { ...defaultIo, alive: () => false })).toBe(0)
    expect(existsSync(join(home, 'Documents'))).toBe(true)
  })
})

describe('refusing to run against a tracked store', () => {
  it('refuses when git says the store is tracked', () => {
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    expect(() => refuseIfTracked(r.stateDir, { ...defaultIo, tracked: () => true })).toThrow(StateDirError)
  })

  it('does not refuse merely for sitting inside a repository', () => {
    // Someone who version-controls their home directory has ~/.git. Refusing on
    // that would refuse on every run forever, and cost them the one thing this
    // module exists to preserve. Being inside a repository is not the risk;
    // being committed is.
    const home = freshHome()
    mkdirSync(join(home, '.git'), { recursive: true })
    expect(() => ensureStateDir(home, null, { ...defaultIo, tracked: () => false })).not.toThrow()
  })

  it('names a way out', () => {
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    try {
      refuseIfTracked(r.stateDir, { ...defaultIo, tracked: () => true })
      throw new Error('should have refused')
    } catch (e) {
      expect(String(e)).toContain('--state-dir')
    }
  })

  it('names it without naming the path', () => {
    // This message reaches the summary line and, through a refusal, a snapshot
    // field that is never pruned. The path is under the home directory, so it
    // carries the OS username -- and the user already knows where their own
    // state directory is. The advice is the part they need.
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    try {
      refuseIfTracked(r.stateDir, { ...defaultIo, tracked: () => true })
      throw new Error('should have refused')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).not.toContain(r.stateDir)
      expect(message).not.toContain(home)
      // Still says what to do, so dropping the path did not drop the advice.
      expect(message).toContain('--state-dir')
      expect(message).toContain('tracked by git')
    }
  })
})

describe('the key sits outside the store', () => {
  it('so a copy of the store unmasks nothing in it', () => {
    // Containment, not prefix. See the next test for why that distinction is
    // not pedantry here.
    const home = freshHome()
    const r = ensureStateDir(home, null, { ...defaultIo, tracked: () => false })
    const key = keyFileFor(home)
    expect(key.startsWith(r.stateDir + sep)).toBe(false)
    expect(existsSync(join(r.stateDir, '.agent-eval-key'))).toBe(false)
  })

  it('but its name is a prefix of the store path, so no check may use prefixes', () => {
    // `~/.agent-eval-key` literally starts with `~/.agent-eval`. Anything that
    // asks "is this path inside the store?" with startsWith answers yes for the
    // key — and a backup routine using that test to exclude the store would
    // sweep the key in with it, or a cleanup using it would delete the key
    // while leaving the snapshots the key is the only way to compare.
    //
    // This assertion is here to fail loudly if the names are ever changed to
    // make it stop being true, since the guard it justifies would then look
    // unnecessary.
    const home = freshHome()
    expect(keyFileFor(home).startsWith(stateDirFor(home))).toBe(true)
    expect(keyFileFor(home).startsWith(stateDirFor(home) + sep)).toBe(false)
  })
})

describe('an explicit state directory', () => {
  it('is used instead of the one under home', () => {
    const home = freshHome()
    const elsewhere = join(freshHome(), 'somewhere-else')
    const r = ensureStateDir(home, elsewhere, { ...defaultIo, tracked: () => false })
    expect(r.stateDir).toBe(elsewhere)
    expect(existsSync(join(elsewhere, '.gitignore'))).toBe(true)
  })
})
