import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan } from '@/collect/scan.js'
import { walkProjects } from '@/collect/walk.js'
import { signerFor, KEY_BYTES } from '@/snapshot/mac.js'

/**
 * The two things a snapshot cannot be reconstructed without.
 *
 * The bootstrap resamples sessions and recomputes a ratio from the members it
 * drew, so it needs each session's numerator and denominator apart. An
 * aggregate cannot be resampled -- there is one of it. And cross-window
 * recurrence is a set intersection over signatures, which needs the members,
 * not the count.
 *
 * Both come from raw logs that are pruned. A window that ships without them has
 * lost them, and no later version of this tool can recover them.
 */

let root = ''
const projects = (): string => join(root, 'projects')
const j = (o: unknown): string => `${JSON.stringify(o)}\n`
const KEY = Buffer.alloc(KEY_BYTES, 7)

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-persession-'))
  const p = join(projects(), 'C--Users-x-one')
  mkdirSync(p, { recursive: true })

  // Session A: one human turn, one failing Bash call, one repeated Edit.
  writeFileSync(
    join(p, 'aaaaaaaa-0000-4000-8000-00000000000a.jsonl'),
    j({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-08-19T01:00:00Z' }) +
      j({
        type: 'assistant', uuid: 'u2', parentUuid: 'u1', timestamp: '2026-08-19T01:01:00Z',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a.ts' } },
            { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/a.ts' } },
          ],
        },
      }) +
      j({
        type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: '2026-08-19T01:02:00Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: no such file or directory' }] },
      }),
  )

  // Session B: one human turn, one failure of a different class.
  writeFileSync(
    join(p, 'bbbbbbbb-0000-4000-8000-00000000000b.jsonl'),
    j({ type: 'user', uuid: 'v1', parentUuid: null, timestamp: '2026-08-20T01:00:00Z' }) +
      j({
        type: 'assistant', uuid: 'v2', parentUuid: 'v1', timestamp: '2026-08-20T01:01:00Z',
        message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'python x.py' } }] },
      }) +
      j({
        type: 'user', uuid: 'v3', parentUuid: 'v2', timestamp: '2026-08-20T01:02:00Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 's1', is_error: true, content: 'Ripgrep search timed out' }] },
      }),
  )

  // A subagent transcript under session A. Its rows must land in A's cluster.
  const wf = join(p, 'aaaaaaaa-0000-4000-8000-00000000000a', 'subagents', 'wf')
  mkdirSync(wf, { recursive: true })
  writeFileSync(
    join(wf, 'agent.jsonl'),
    j({
      type: 'assistant', timestamp: '2026-08-19T01:03:00Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'Permission denied' }] },
    }),
  )
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const counts = (signed = false) =>
  scan(walkProjects(projects()), undefined, signed ? signerFor(KEY) : null, 0)

describe('per-session tallies', () => {
  it('splits the numerator by session', () => {
    const c = counts()
    const a = c.perSession['aaaaaaaa-0000-4000-8000-00000000000a']
    const b = c.perSession['bbbbbbbb-0000-4000-8000-00000000000b']
    expect(a?.failures).toBe(2) // one in the main file, one under subagents
    expect(b?.failures).toBe(1)
    expect(a?.writeRepeats).toBe(1)
    expect(b?.writeRepeats).toBe(0)
  })

  it('folds a subagent transcript into its parent, not its own cluster', () => {
    // The unit the bootstrap resamples. A subagent counted separately inflates
    // the cluster count, and the cluster count decides whether a rate gets an
    // interval at all.
    const c = counts()
    expect(Object.keys(c.perSession)).toHaveLength(2)
    expect(c.perSession['aaaaaaaa-0000-4000-8000-00000000000a']?.lines).toBeGreaterThan(3)
  })

  it('accounts for every bundle and every failure', () => {
    // The per-session split must close against the aggregate, or one of them is
    // measuring something else.
    const c = counts()
    const sessions = Object.values(c.perSession)
    expect(sessions.reduce((n, s) => n + s.bundles, 0)).toBe(c.taskBundles)
    expect(sessions.reduce((n, s) => n + s.failures, 0)).toBe(c.wasted.failures)
    expect(sessions.reduce((n, s) => n + s.writeRepeats, 0)).toBe(c.wasted.writeRepeats)
    expect(sessions.reduce((n, s) => n + s.lines, 0)).toBe(c.linesRead)
  })

  it('gives a bootstrap something to resample', () => {
    // A ratio estimator over a resample needs a numerator and a denominator per
    // drawn member. This is the shape of that draw.
    const c = counts()
    for (const s of Object.values(c.perSession)) {
      expect(typeof s.failures).toBe('number')
      expect(typeof s.bundles).toBe('number')
    }
    expect(Object.keys(c.perSession).length).toBeGreaterThan(1)
  })
})

describe('signatures', () => {
  it('are empty and say so when no signer was supplied', () => {
    // An unsigned run and an environment that failed at nothing produce the
    // same empty array. The flag is what tells them apart.
    const c = counts(false)
    expect(c.signatures).toEqual([])
    expect(c.signaturesSigned).toBe(false)
  })

  it('are MACs when one was', () => {
    const c = counts(true)
    expect(c.signaturesSigned).toBe(true)
    expect(c.signatures).toHaveLength(3)
    for (const m of c.signatures) expect(m).toMatch(/^h1:[0-9a-f]{32}$/)
  })

  it('carry nothing of the tool, the error text or the target', () => {
    const blob = JSON.stringify(counts(true).signatures)
    for (const leak of ['Bash', 'ENOENT', 'timed out', 'python', 'git', 'x.py']) {
      expect(blob, leak).not.toContain(leak)
    }
  })

  it('are stable across runs, so two windows can be intersected', () => {
    // The whole point. If these differed run to run, cross-window recurrence
    // would read zero and the environment would score a perfect never-repeats.
    expect(counts(true).signatures).toEqual(counts(true).signatures)
  })

  it('separate two failures that differ only in their class', () => {
    const c = counts(true)
    expect(new Set(c.signatures).size).toBe(3)
  })

  it('leave the aggregates working either way', () => {
    // repeatRate is computed from the plaintext tuples inside scan, so it does
    // not depend on a signer being present.
    expect(counts(false).errorRepeats.errors).toBe(3)
    expect(counts(true).errorRepeats.errors).toBe(3)
    expect(counts(false).errorRepeats.rIn).toBe(counts(true).errorRepeats.rIn)
  })
})

describe('what the reducer refuses to hand out', () => {
  it('returns no plaintext signature tuple at all', () => {
    // The tuple holds a tool name, an error class and a target -- a command's
    // first token, often a private script. It stays in the frame it was built
    // in; only MACs and counts come out.
    const c = counts(true)
    expect(c).not.toHaveProperty('signatureTuples')
    const blob = JSON.stringify({ signatures: c.signatures, errorRepeats: c.errorRepeats })
    expect(blob).not.toContain('no such file')
    expect(blob).not.toContain('Permission denied')
  })
})
