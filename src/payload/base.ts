/**
 * The reference payload every validation fixture is derived from.
 *
 * Hand-written and internally coherent. It is deliberately NOT a copy of the
 * sample in submission_payload_spec_v1 §2, because that sample does not add up:
 * its `mainLines` 101,196 and `subLines` 27,936 total 129,132 against a stated
 * `linesRead` of 129,873, a gap of 741, and its stated `subLineRatio` of 0.267
 * is 0.2163 when computed from its own numbers. Building the fixtures for the
 * scan-range detector on top of a scan-range discrepancy would mean every later
 * stage rests on "base is valid" while base is not.
 *
 * So the component counts are kept and the derived values are made to follow
 * from them. Every invariant the validator will check holds here by
 * construction, and base.test.ts checks that rather than trusting this comment.
 *
 * The axes are all `not_applicable` on purpose. That is what this machine
 * actually produces: 11 session clusters against a minimum denominator of 20.
 * A base fixture showing scores would describe a machine that does not exist.
 */

import { makeCount, makeMetric } from './metric.js'
import type { Payload } from './types.js'
import { AXIS_KEYS, iso8601, projectId, uuid } from './types.js'
import type { Axes, Axis } from './types.js'

const MAIN_LINES = 101_196
const SUB_LINES = 27_936
const LINES_READ = MAIN_LINES + SUB_LINES // 129,132 — derived, not asserted

const MAIN_FILES = 1_094
const SUB_FILES = 368

/** Rounded to four places; base.test.ts recomputes it from the line counts. */
const SUB_LINE_RATIO = Math.round((SUB_LINES / LINES_READ) * 10_000) / 10_000

/** Summed to LINES_READ so the version tally accounts for every line read. */
const TOOL_VERSIONS = {
  '2.1.234': 100_000,
  '2.1.233': 25_000,
  '2.1.112': 4_132,
} as const

/**
 * Every line got a verdict for every axis, so the three states sum to
 * linesRead. The validator checks this per axis; a tally that does not close is
 * a parser that dropped rows without saying so.
 */
const ALL_NOT_APPLICABLE: Axis = {
  availability: 'not_applicable',
  lineStates: { available: 0, not_applicable: LINES_READ, parse_failed: 0 },
  // No rate: with 11 session clusters against a minimum denominator of 20 there
  // is nothing to divide. null rather than 0/0, which would read as a measured
  // zero instead of an absence.
  metric: null,
  score: null,
  confidenceInterval: null,
  belowMinDenominator: true,
  // 11 clusters against a minimum of 20. Stated rather than left implicit,
  // because an axis that says only `not_applicable` cannot distinguish "this
  // environment is small" from "this axis was never implemented".
  unavailableReasons: ['too-few-clusters'],
  detail: null,
}

const axes = Object.fromEntries(AXIS_KEYS.map((k) => [k, ALL_NOT_APPLICABLE])) as Axes

const PROJECT_BYTES = [855_638_016, 2_400_000, 1_000_000] as const
const TOTAL_BYTES = PROJECT_BYTES.reduce((a, b) => a + b, 0)

export const BASE_PAYLOAD = {
  schemaVersion: '1.0',
  runTimestamp: iso8601('2026-08-20T09:00:00+09:00'),
  submissionId: uuid('3f2a6c18-9b7d-4e51-a0c3-7d5e2f8b41a9'),

  scanManifest: {
    parserVersion: '1',
    scope: 'all',
    rootsWalked: [
      // Emitted by the walker with its own match count, not copied from a
      // constant. A glob that silently matches nothing is the failure this
      // whole project started from, and a constant cannot show it.
      { glob: '~/.claude/projects/*/*.jsonl', matchCount: MAIN_FILES },
      { glob: '~/.claude/projects/*/*/subagents/**/*.jsonl', matchCount: SUB_FILES },
    ],
    recursive: true,
    filesRead: MAIN_FILES + SUB_FILES,
    linesRead: LINES_READ,
    linesParseFailed: 0,
    bytesRead: 663_311_155,
    mainFiles: MAIN_FILES,
    mainLines: MAIN_LINES,
    subFiles: SUB_FILES,
    subLines: SUB_LINES,
    subLineRatio: SUB_LINE_RATIO,
    toolVersions: TOOL_VERSIONS,
    toolVersionDistinct: Object.keys(TOOL_VERSIONS).length,
    originFieldCoverage: makeMetric({
      numerator: 195,
      denominator: 5_814,
      denominatorMeaning:
        'origin フィールドが付いている user 行の割合。低いほど human 判定が過小になる',
      sourceField: 'origin.kind',
    }),
    window: {
      unit: 'activeDays',
      windowDays: 10,
      // This machine has no cleanupPeriodDays key in any of the four settings
      // scopes, so the window length is measured rather than configured. The
      // previous pairing here — source `setting` beside a null period — claimed
      // a setting had been found and then declined to say what it was.
      windowSource: 'observed',
      cleanupPeriodDays: null,
      calendarSpanDays: 22,
      // 17, not 18. Days carrying a human turn, per the spec's §5 sample. The
      // 18 that used to sit here is the evidence-day count, which belongs to
      // externalLog below and is the record rate's denominator.
      activeDays: 17,
      activeDaysMethod: 'human-turn-days',
      // Between 17 and 18: a user spoke on every day that carried a user row in
      // the sample this fixture keeps the components of. On the machine as it
      // stands today the two are 5 and 9, because origin coverage is 3.11%.
      userRowDays: 18,
      contiguousDays: 11,
      gapCount: 2,
    },
    externalLog: {
      exists: true,
      rows: 42,
      recordedDays: 15,
      activeDays: 18,
      activeDaysMethod: 'union-of-observed(git, jsonl, externalLog)',
      recordRate: makeMetric({
        numerator: 15,
        denominator: 18,
        denominatorMeaning: '作業した証拠のある日のうち、外部ログに入っている割合',
        sourceField: 'externalLog.dates',
      }),
      recordRateCalendar: makeMetric({
        numerator: 15,
        denominator: 125,
        denominatorMeaning: '暦日のうち記録がある日の割合（作業頻度を答える別指標）',
        sourceField: 'jsonl.timestamps',
      }),
    },
    measuredAt: iso8601('2026-08-20T09:00:00+09:00'),
  },

  metrics: {
    toolError: {
      ...makeMetric({
        numerator: 243,
        denominator: 5_254,
        denominatorMeaning: 'window 内の tool_result ブロック総数（キーの有無を問わない）',
        sourceField: 'message.content[].tool_result.is_error',
      }),
      booleanDerived: true,
    },
    toolErrorAlt: {
      ...makeMetric({
        numerator: 243,
        denominator: 2_600,
        denominatorMeaning:
          '🚨 事故#2 の当事者。**両方送る**。どちらが正かは受け取り側が決める',
        sourceField: 'message.content[].tool_result',
      }),
      booleanDerived: true,
    },
    skillFired: makeMetric({
      numerator: 3,
      denominator: 27,
      denominatorMeaning: '書いたスキルのうち実際に発火した種類数。🚨 **行数ではない**',
      sourceField: 'attributionSkill',
    }),
    skillRows: makeCount({
      value: 319,
      noDenominatorReason: 'reference-value',
      sourceField: 'attributionSkill',
    }),
    mcpUsed: makeMetric({
      numerator: 3,
      denominator: 11,
      denominatorMeaning: '繋いだサーバーのうち実際に呼ばれた数',
      sourceField: 'attributionMcpServer',
    }),
    humanTurns: makeCount({
      value: 162,
      noDenominatorReason: 'reference-value',
      sourceField: 'origin.kind',
    }),
    denialUserRejected: {
      ...makeMetric({
        numerator: 4,
        denominator: 72,
        denominatorMeaning: '権限拒否のうち人間が止めた割合',
        sourceField: 'toolDenialKind',
      }),
      booleanDerived: true,
    },
    permissions: {
      allow: makeCount({ value: 99, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
      deny: makeCount({ value: 3, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
      ask: makeCount({ value: 0, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
      unrestrictedExec: makeCount({ value: 0, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
      cliWildcard: makeCount({ value: 14, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
      scriptPathFixed: makeCount({ value: 24, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
    },
    editPaths: makeMetric({
      numerator: 91,
      denominator: 215,
      denominatorMeaning: '🚨 手戻りではなくファイル集中度。打ち消し判定は別途',
      sourceField: 'message.content[].tool_use.input.file_path',
    }),
    tokens: {
      input: makeCount({ value: 229_040, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
      output: makeCount({ value: 7_927_909, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
      cacheRead: makeCount({ value: 2_332_548_903, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
      cacheCreation: makeCount({ value: 44_664_197, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
    },
    hookPushback: {
      ...makeMetric({
        numerator: 10,
        denominator: 356,
        denominatorMeaning:
          'ガードレールが実際に応答を差し戻した割合。🚨 `preventedContinuation` は使わない（2環境とも全 false）',
        sourceField: 'hookErrors',
      }),
      booleanDerived: true,
    },
  },

  axes,

  environment: {
    os: 'Windows 11',
    shell: 'PowerShell + Git Bash',
    agentTools: ['claude-code'],
    projectCount: PROJECT_BYTES.length,
    projects: [
      {
        id: projectId('sha256:1f0c9a2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8'),
        files: 1_081,
        lines: 120_400,
        bytes: PROJECT_BYTES[0],
        humanRows: 158,
        subLineRatio: 0.27,
      },
      {
        id: projectId('sha256:2a1b0c9d8e7f60514233a4b5c6d7e8f90a1b2c3d4e5f6071829304a5b6c7d8e9'),
        files: 250,
        lines: 6_400,
        bytes: PROJECT_BYTES[1],
        humanRows: 3,
        subLineRatio: 0.11,
      },
      {
        id: projectId('sha256:3b2c1d0e9f8a70615243b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901'),
        files: 131,
        lines: 2_332,
        bytes: PROJECT_BYTES[2],
        humanRows: 1,
        subLineRatio: 0.04,
      },
    ],
    topProjectByteShare: Math.round((PROJECT_BYTES[0] / TOTAL_BYTES) * 1_000) / 1_000,
    skillsDefined: 27,
    hooksDefined: 7,
  },
} satisfies Payload

export const BASE_PAYLOAD_JSON = (): string => JSON.stringify(BASE_PAYLOAD, null, 2)
