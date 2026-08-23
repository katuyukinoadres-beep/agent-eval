import { describe, expect, it } from 'vitest'
import { meetsMinimum } from '@/score/minimum.js'
import { UPTAKE_REFERENCED } from '@/score/artifact.js'
import { assemble, type AssembleInputs } from '@/payload/assemble.js'
import { validate } from '@/validate/index.js'
import { assembleWindow } from '@/collect/window.js'
import { AXIS_KEYS } from '@/payload/types.js'

/**
 * The assembler is the first place the tool produces a number about a real
 * machine, and the first place it can lie about one.
 *
 * The lie it already told: the first version wrote `Math.max(1, denominator)`
 * to get past makeMetric's refusal of a zero denominator, and the run that found
 * it reported `skillFired: 3/1` — three skills fired out of one defined, in a
 * directory holding none. A floor of 1 does not avoid an absence; it renames it
 * as the smallest possible presence and multiplies the rate by whatever the
 * numerator happens to be.
 */

const window = assembleWindow({
  jsonlDates: ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'],
  userRowDates: ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'],
  humanTurnDates: ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'],
  gitDates: [],
  externalDates: [],
  externalExists: false,
  externalRows: 0,
  cleanupPeriodDays: null,
  cleanupFoundAt: null,
  windowDays: 10,
})

const counts = {
  linesRead: 1_000, linesParseFailed: 0, bytesRead: 5_000, mainLines: 600, subLines: 400,
  toolResultTotal: 300, toolResultWithIsErrorKey: 200, toolResultIsErrorTrue: 10,
  attributionSkillRows: 40, attributionSkillDistinct: 3, mcpServerDistinct: 3,
  userRows: 500, originBearingUserRows: 20, humanTurns: 15,
  denialRows: 8, denialUserRejected: 2, denialKinds: {},
  editedFilesDistinct: 30, editedFilesRepeated: 9,
  stopHookSummaryRows: 12, hookErrorsNonEmpty: 1,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
  toolVersions: { '2.1.233': 1_000 },
  sessionIds: ['a', 'b'],
  // Per-axis clusters are counted from here, not from sessionIds: a cluster is
  // a session with a non-zero denominator for that axis, and the axes do not
  // share one.
  perSession: {
    a: { intervals: 60, bundles: 25, failures: 6, writeRepeats: 2, investigationRepeats: 6, timedOut: 0, largeOutput: 0, errors: 6, lines: 600 },
    b: { intervals: 40, bundles: 15, failures: 4, writeRepeats: 2, investigationRepeats: 4, timedOut: 0, largeOutput: 0, errors: 4, lines: 400 },
  },
  dates: ['2026-08-16'],
  userRowDates: ['2026-08-16'],
  humanTurnDates: ['2026-08-16'],
  perProject: { p1: { lines: 1_000, subLines: 400, humanRows: 15 } },
  notHumanCounts: {},
  taskBundles: 40,
  rootBundles: 0,
  orphanBundles: 0,
  environmentNoiseRows: 0,
  editedPaths: {},
  lastMention: () => null, lastMentionIn: () => null,
  referenceTokens: 0,
  toolActivityRows: 200,
  errorRepeats: { errors: 10, distinctSignatures: 5, rIn: 0.5, byFamily: { timeout: 10 } },
  metabolism: {
    skillsListed: ['a', 'b'], listingChars: 100, listingTruncated: false,
    skillFirings: { a: 9 }, hookFirings: {}, mcpFirings: {},
    effectiveInputPerCall: [30_000, 30_000],
  },
  manualEdits: {
    editedNames: [], staleRecoveredPaths: [], userModifiedPresent: 0, userModifiedTrue: 0,
  },
  verification: {
    intervals: 30, verifiedIntervals: 10, todoWriteUsed: true,
    selfRepaired: 2, humanRescued: 1, unresolved: 1, repairedNotCounted: 0,
  },
  wasted: {
    failures: 10,
    hookOriginated: 0,
    errorsObserved: 10,
    attribution: { E1: 0, E2: 0, E2b: 0, E3: 0, E4: 0, E7: 0, E6: 0, E5: 0, E8_E9: 10 },
    closure: { observed: 10, attributed: 10, numerator: 10, excluded: 0, balanced: true },
    writeRepeats: 4,
    investigationRepeats: 10,
    timedOut: 0,
    largeOutput: 0,
    callsPerBundle: { b1: 5, b2: 7 },
  },
}

const inputs: AssembleInputs = {
  inventory: {
    files: [
      { path: 'a.jsonl', project: 'p1', kind: 'main', sessionId: 's', bytes: 3_000 },
      { path: 'b.jsonl', project: 'p1', kind: 'sub', sessionId: 's', bytes: 2_000 },
    ],
    projects: [
      { project: 'p1', mainFiles: 1, subFiles: 1, bytes: 5_000 },
      { project: 'p2', mainFiles: 0, subFiles: 0, bytes: 0 },
    ],
    rootsWalked: [
      { glob: 'projects/*/*.jsonl', matchCount: 1 },
      { glob: 'projects/*/*/subagents/**/*.jsonl', matchCount: 1 },
    ],
  },
  counts,
  artifacts: {
    artifacts: [], totalWeight: 0, consideredPaths: 0,
    notSettled: { 'written-too-recently': 0, 'no-longer-exists': 0 },
    clustered: 0, clipped: 0, weightFlooredUnknown: 0,
  },
  window,
  permissions: { allow: 67, deny: 3, ask: 0, unrestrictedExec: 0, cliWildcard: 27, scriptPathFixed: 24, scopesWithEntries: ['user'] },
  skills: { total: 27, byGlob: { 'skills/*.md': 27 } },
  hooks: { total: 5, events: ['Stop'] },
  mcp: { servers: 10, configured: 1, connectors: 9, sourcesRead: 2 },
  os: 'win32',
  shell: 'unknown',
  agentTools: ['claude-code'],
  measuredAt: '2026-08-20T12:00:00+09:00',
  submissionId: '00000000-0000-4000-8000-000000000001',
  hashProject: (n: string) => `${'0'.repeat(63)}${n === 'p1' ? '1' : '2'}`,
} as unknown as AssembleInputs

const over = (o: Partial<AssembleInputs>): AssembleInputs => ({ ...inputs, ...o })

/** The axes that carry a formula today. The rest are still not-implemented. */
const BUILT_AXES = new Set<string>([
  'wastedMotion',
  'environmentMetabolism',
  'artifactUptake',
  'selfVerification',
  'recurrencePrevention',
])

describe('the payload it builds passes its own rules', () => {
  it('validates, in the shape it ships in', () => {
    // Round-tripped through JSON, because a payload that only validates as a
    // live object has not been checked as one that arrived over a wire.
    const { payload } = assemble(inputs)
    const v = validate(JSON.parse(JSON.stringify(payload)))
    expect(v.violations).toEqual([])
    expect(v.ok).toBe(true)
  })
})

describe('a denominator of zero is an absence, not a one', () => {
  it('reports skillFired as null when nothing defines a skill', () => {
    // The measured failure: run from a directory with no skills, the numerator
    // was 3 and the floored denominator 1.
    const { payload } = assemble(over({ skills: { total: 0, byGlob: {} } }))
    expect(payload.metrics.skillFired).toBeNull()
  })

  it('does the same for every other rate whose denominator can be zero', () => {
    const { payload } = assemble(over({
      skills: { total: 0, byGlob: {} },
      mcp: { servers: 0, configured: 0, connectors: 0, sourcesRead: 0 },
      counts: {
        ...counts,
        toolResultTotal: 0, toolResultWithIsErrorKey: 0,
        denialRows: 0, editedFilesDistinct: 0, stopHookSummaryRows: 0,
      },
    } as unknown as Partial<AssembleInputs>))
    const m = payload.metrics
    expect([m.toolError, m.toolErrorAlt, m.skillFired, m.mcpUsed, m.denialUserRejected, m.editPaths, m.hookPushback])
      .toEqual([null, null, null, null, null, null, null])
  })

  it('still validates with every rate absent', () => {
    const { payload } = assemble(over({
      skills: { total: 0, byGlob: {} },
      mcp: { servers: 0, configured: 0, connectors: 0, sourcesRead: 0 },
      counts: { ...counts, toolResultTotal: 0, toolResultWithIsErrorKey: 0, denialRows: 0, editedFilesDistinct: 0, stopHookSummaryRows: 0 },
    } as unknown as Partial<AssembleInputs>))
    expect(validate(JSON.parse(JSON.stringify(payload))).ok).toBe(true)
  })

  it('carries the rate when the denominator is real', () => {
    // The positive control for the four assertions above: null must be
    // reachable and non-null must be too, or the field proves nothing.
    const { payload } = assemble(inputs)
    expect(payload.metrics.skillFired).toMatchObject({ numerator: 3, denominator: 27 })
    expect(payload.metrics.mcpUsed).toMatchObject({ numerator: 3, denominator: 10 })
  })
})

describe('no axis carries a score', () => {
  it('leaves every score null except the axes that are built', () => {
    const { payload } = assemble(inputs)
    for (const key of AXIS_KEYS) {
      if (BUILT_AXES.has(key)) continue
      expect(payload.axes[key].score, key).toBeNull()
      expect(payload.axes[key].metric, key).toBeNull()
    }
  })

  it('scores axis 2 on its own condition, not on the cluster minimum', () => {
    // v1 makes axis 2 unavailable below 50 filtered tool calls. The cluster
    // minimum is a different question — whether a change between windows may be
    // called an improvement — and conflating them reported a machine with 8,502
    // tool calls as having nothing to measure.
    const { payload } = assemble(inputs)
    const axis = payload.axes.wastedMotion
    expect(axis.availability).toBe('available')
    expect(axis.score).not.toBeNull()
    // Still below the minimum at 2 clusters, so no comparison and no interval.
    expect(axis.belowMinDenominator).toBe(true)
    expect(axis.confidenceInterval).toBeNull()
  })

  it('carries the parts the score came from, under names that are not a rate', () => {
    // Wasted moves per bundle exceeds 1 by design. Naming the pair
    // numerator/denominator would trip V-5, and exempting it would put a hole
    // in the rule the 107.1% walked through.
    const detail = assemble(inputs).payload.axes.wastedMotion.detail
    expect(detail).not.toBeNull()
    expect(Object.keys(detail ?? {})).toContain('wastedPerBundle')
    expect(Object.keys(detail ?? {})).not.toContain('numerator')
    expect(Object.keys(detail ?? {})).not.toContain('denominator')
  })

  it('says why an unbuilt axis has nothing, and separates the two reasons', () => {
    // `too-few-clusters` is measured. `definition-pending` is not about this
    // environment at all — it is about a formula the repository does not have.
    const { payload } = assemble(inputs)
    expect(payload.axes.firstPassLanding.unavailableReasons).toContain('too-few-clusters')
    expect(payload.axes.firstPassLanding.unavailableReasons).toContain('definition-pending')
    // Axis 4 is built now, and says its own reason: no artifacts in this
    // fixture rather than a small environment.
    expect(payload.axes.artifactUptake.unavailableReasons).toEqual(['insufficient-assets'])
    expect(payload.axes.coverageGate.unavailableReasons).toEqual(['too-few-clusters'])
  })

  it('claims no shortfall it did not measure', () => {
    // An earlier version passed a denominator of 0 to the minimum check and
    // reported `denominator-below-minimum` on all eleven axes, against a
    // denominator no axis had computed.
    const { payload } = assemble(inputs)
    for (const key of AXIS_KEYS) {
      expect(payload.axes[key].unavailableReasons, key).not.toContain('denominator-below-minimum')
      expect(payload.axes[key].unavailableReasons, key).not.toContain('numerator-below-minimum')
    }
  })

  it('marks every axis when the environment gate withheld the total', () => {
    const gated = assemble(over({
      counts: { ...counts, linesParseFailed: 900 },
    } as unknown as Partial<AssembleInputs>))
    expect(gated.gate.availability).toBe('parse_failed')
    expect(gated.payload.axes.coverageGate.unavailableReasons).toContain('environment-gated')
  })
})

describe('projects', () => {
  it('keeps a project that holds nothing', () => {
    // Four of five on this machine. Dropping them is how a partial miss hides
    // behind a healthy aggregate, and V-6 refuses a short list anyway.
    const { payload } = assemble(inputs)
    expect(payload.environment.projectCount).toBe(2)
    expect(payload.environment.projects[1]).toMatchObject({ lines: 0, subLineRatio: 0 })
  })

  it('sends a hash and never the directory name', () => {
    const { payload } = assemble(inputs)
    expect(JSON.stringify(payload.environment.projects)).not.toContain('p1')
    expect(payload.environment.projects[0]?.id.startsWith('sha256:')).toBe(true)
  })
})

describe('the minimum denominator', () => {
  /**
   * Twenty-five sessions, so the cluster term passes and the other two are the
   * only things that can decide the verdict.
   *
   * This is the shape the old code could not express. It passed
   * `Math.max(measured, MIN)` into a test for `< MIN`, so the denominator and
   * numerator conditions held whatever the measurement was, and the verdict was
   * the cluster count wearing three names. On a machine with enough sessions
   * that meant a delta could be called an improvement off twelve artifacts.
   */
  const manySessions = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `s${i}`,
      {
        intervals: 40,
        bundles: 20,
        failures: 4,
        writeRepeats: 1,
        investigationRepeats: 2,
        timedOut: 0,
        largeOutput: 0,
        errors: 4,
        lines: 100,
      },
    ]),
  )

  const artifactsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `f${i}.ts`,
      weight: 1,
      uptake: UPTAKE_REFERENCED,
      newLines: 60,
      newLinesKnown: true,
      bundle: (i % 25) + 1,
    }))

  const withSessions = (artifactCount: number) =>
    assemble({
      ...inputs,
      counts: {
        ...inputs.counts,
        sessionIds: Object.keys(manySessions),
        perSession: manySessions,
        // Every artifact referred to again from a different bundle, so the
        // numerator condition is satisfied and the denominator is the only
        // thing left that can decide the verdict.
        lastMentionIn: () => ({ bundle: 9_999, at: '2026-08-20T12:00:00.000Z' }),
      },
      artifacts: {
        ...inputs.artifacts,
        artifacts: artifactsOf(artifactCount),
        totalWeight: artifactCount,
        consideredPaths: artifactCount,
      },
    }).payload

  it('fails on a small denominator even when there are clusters enough', () => {
    // Axis 4's denominator is artifacts. Twelve is the number from the report
    // that prompted this: plenty of sessions, far too few artifacts.
    expect(withSessions(12).axes.artifactUptake.belowMinDenominator).toBe(true)
  })

  it('passes when the denominator is genuinely large', () => {
    // The other half of the control. Without a case that comes out false, the
    // test above would also pass against a check hardcoded to true -- which is
    // exactly what the clamped version was.
    expect(withSessions(300).axes.artifactUptake.belowMinDenominator).toBe(false)
  })

  it('names both conditions rather than folding them into the cluster count', () => {
    // `denominator-below-minimum` and `numerator-below-minimum` were
    // unreachable strings: nothing could produce either, because both were
    // tested against a value clamped to the threshold first.
    expect(meetsMinimum({ clusters: 25, denominator: 12, numerator: 3 }).reasons).toEqual([
      'denominator-below-minimum',
      'numerator-below-minimum',
    ])
    expect(meetsMinimum({ clusters: 25, denominator: 300, numerator: 40 }).reasons).toEqual([])
  })
})
