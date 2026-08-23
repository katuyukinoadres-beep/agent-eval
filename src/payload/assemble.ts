/**
 * Builds a payload from what was collected.
 *
 * This is the first place the pieces meet, and the first place the tool produces
 * a number about a real machine rather than about a fixture. Two consequences
 * are deliberate.
 *
 * Every axis comes out `not_applicable`. That is not a shortcut — this machine
 * has 11 session clusters against a minimum of 20, so no first-wave axis can
 * carry a rate no matter what the rate would have been. What each axis does
 * carry is why, in `unavailableReasons`, so "your environment is small" is
 * distinguishable from "this axis is not implemented yet".
 *
 * And no score is produced anywhere. The rate-to-score formula lives in the v1
 * axes document, which is not in this repository. Inventing one would put a
 * number on a screen that nobody could defend, which is the failure this whole
 * project was built in response to.
 */

import { makeCount, makeMetric } from './metric.js'
import type { CountBasis } from './metric.js'
import type { Metric } from './metric.js'
import {
  AXIS_KEYS,
  iso8601,
  projectId,
  uuid,
  type Axes,
  type Axis,
  type Environment,
  type Payload,
  type ProjectSummary,
  type ScanManifest,
  type UnavailableReason,
} from './types.js'
import type { Inventory } from '../collect/walk.js'
import type { ScanCounts } from '../collect/scan.js'
import type { AssembledWindow } from '../collect/window.js'
import type { McpCount, PermissionTally, SkillCount, HookCount } from '../collect/environment.js'
import { gate, type GateVerdict } from '../score/gate.js'
import { MIN_DENOMINATOR, MIN_NUMERATOR, meetsMinimum } from '../score/minimum.js'
import { wastedMotion, OMITTED_TERM_LEANINGS, type OmittedTermName } from '../score/wastedMotion.js'
import { composite, type AxisInput, type OmittedTerm, type SuppressedReason } from '../score/composite.js'
import { METABOLISM_OMISSION_LEANINGS, metabolism } from '../score/metabolism.js'
import { UPTAKE_OMISSION_LEANINGS, uptake } from '../score/uptake.js'
import { VERIFICATION_OMISSION_LEANINGS, verification } from '../score/verification.js'
import type { ArtifactSet } from '../score/artifact.js'
import { basename, normalisePath } from '../collect/reference.js'
import { MIN_FILTERED_CALLS } from '../score/wastedMotion.js'

    // This submission's counts, stated as they are rather than as the spec's
// default. Three of the four differ, and each difference is a gap in this
// implementation that the field now makes visible instead of hiding:
//
//   period  allTime, not window. `windowDays` is carried in the payload and
//           never applied as a filter; the scan reads every transcript that
//           survived pruning. Claiming `window` would be the exact defect
//           this field was added to stop.
//   unit    row, not toolUseId. Denials are tallied per row, and rows and
//           ids disagreed by one on the machine that was measured.
//   excludes  empty. `Tool permission stream closed` appears 11 times here
//           and is not removed, so denial counts include failures where no
//           decision was reached.
export const COUNT_BASIS: CountBasis = {
  scope: 'all',
  period: 'allTime',
  unit: 'row',
  excludes: [],
}

export interface AssembleInputs {
  readonly inventory: Inventory
  readonly counts: ScanCounts
  /** The settled artifact set. Axis 4's denominator. */
  readonly artifacts: ArtifactSet
  readonly window: AssembledWindow
  readonly permissions: PermissionTally
  readonly skills: SkillCount
  readonly hooks: HookCount
  readonly mcp: McpCount
  readonly os: string
  readonly shell: string
  readonly agentTools: readonly string[]
  /** Supplied rather than read from the clock, so a run is reproducible. */
  readonly measuredAt: string
  readonly submissionId: string
  /** Hashes project directory names. Injected so the test does not need a real digest. */
  readonly hashProject: (name: string) => string
}

export interface Assembled {
  readonly payload: Payload
  readonly gate: GateVerdict
}

/** Rounded to four places, the precision the manifest sample uses. */
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/**
 * A rate, or null when this environment has no denominator for it.
 *
 * makeMetric refuses a zero denominator, and rightly: 0/0 passes V-4, sits under
 * W-6's floor of 100, and reads as a measured zero. An absence is reported as an
 * absence instead.
 */
function rateOrNull(
  numerator: number,
  denominator: number,
  denominatorMeaning: Parameters<typeof makeMetric>[0]['denominatorMeaning'],
  sourceField: Parameters<typeof makeMetric>[0]['sourceField'],
): Metric | null {
  if (denominator <= 0) return null
  return makeMetric({ numerator, denominator, denominatorMeaning, sourceField })
}

/**
 * Why each axis has no rate.
 *
 * Two kinds of reason, kept apart. `too-few-clusters` is measured against a
 * threshold the spec gives. `definition-pending` means the axis needs something
 * that is not settled — `taskBundles`, `SA` and `P1` are defined only in the v1
 * axes document, and the error-signature classification (E1..E14) it depends on
 * is not built.
 */
function axisReasons(clusters: number, gated: boolean): Readonly<Record<string, readonly UnavailableReason[]>> {
  // Only the cluster term. The denominator and numerator terms of the minimum
  // are real conditions, but no axis has computed a denominator yet, and
  // reporting a shortfall against a figure that was never measured invents a
  // finding. `definition-pending` is what is true about those axes.
  const short = meetsMinimum({ clusters, denominator: MIN_DENOMINATOR, numerator: MIN_NUMERATOR })
  const sample: readonly UnavailableReason[] = gated
    ? ['environment-gated', ...short.reasons]
    : short.reasons

  const pending: readonly UnavailableReason[] = [...sample, 'definition-pending']
  return {
    // Needs deepPaths and the induced-re-edit paths, which come from the
    // error-signature classification.
    firstPassLanding: pending,
    wastedMotion: pending,
    selfVerification: [...pending, 'first-window'],
    // SA and taskBundles are defined only in the v1 document.
    artifactUptake: pending,
    environmentMetabolism: pending,
    // Layer A needs the error signatures; layer B needs an external hook log,
    // which this environment does not keep.
    recurrencePrevention: [...pending, 'no-external-log'],
    pendingDecisions: pending,
    userRejected: pending,
    askUserQuestionCustomRate: pending,
    coverageGate: sample,
    safetyCheck: sample,
  }
}

/** The same, for the three rates that also carry `booleanDerived`. */
function booleanRate(
  numerator: number,
  denominator: number,
  denominatorMeaning: Parameters<typeof makeMetric>[0]['denominatorMeaning'],
  sourceField: Parameters<typeof makeMetric>[0]['sourceField'],
): (Metric & { readonly booleanDerived: true }) | null {
  const m = rateOrNull(numerator, denominator, denominatorMeaning, sourceField)
  return m === null ? null : { ...m, booleanDerived: true }
}

export function assemble(inputs: AssembleInputs): Assembled {
  const { inventory, counts, window, permissions, skills, hooks, mcp } = inputs

  const linesRead = counts.linesRead
  const verdict = gate({
    linesRead,
    linesParseFailed: counts.linesParseFailed,
    rootsWalked: inventory.rootsWalked,
    activeDays: window.window.activeDays,
  })

  // Clusters are sessions, which is what the spec's bootstrap resamples over.
  const clusters = counts.sessionIds.length
  const reasons = axisReasons(clusters, !verdict.totalAllowed)

  // Axis 2 is available on its own condition -- filtered tool_use of at least
  // 50, per v1 -- not on the cluster minimum. The cluster minimum gates whether
  // a change between windows may be called an improvement, which is a different
  // question from whether the rate exists. Conflating them reported a machine
  // with 8,502 tool calls as having nothing to measure.
  const motion = wastedMotion(counts.wasted, counts.errorRepeats.rIn, counts.taskBundles)
  const toolCalls = counts.toolResultTotal
  const axis2Available = toolCalls >= MIN_FILTERED_CALLS && motion.score !== null

  const axisFor = (key: string): Axis => ({
    availability: 'not_applicable',
    // Every line got a verdict, and they sum to linesRead. A tally that does not
    // close is a parser that dropped rows without saying so.
    lineStates: { available: 0, not_applicable: linesRead, parse_failed: 0 },
    metric: null,
    score: null,
    confidenceInterval: null,
    belowMinDenominator: true,
    unavailableReasons: reasons[key] ?? ['definition-pending'],
    detail: null,
    omittedTerms: [],
  })

  const minimum = meetsMinimum({
    clusters,
    denominator: motion.bundles,
    numerator: Math.floor(motion.numerator),
  })

  const wastedAxis: Axis = {
    availability: axis2Available ? 'available' : 'not_applicable',
    // Rows carrying a tool_use or tool_result are the axis's evidence; the rest
    // had nothing for it to judge. The three states still sum to linesRead.
    lineStates: {
      available: axis2Available ? counts.toolActivityRows : 0,
      not_applicable: axis2Available ? linesRead - counts.toolActivityRows : linesRead,
      parse_failed: 0,
    },
    metric: null,
    // Rounded. A fifteen-digit float in a payload is noise, and two decimals
    // is finer than anything this score can actually resolve.
    score: axis2Available && motion.score !== null ? Math.round(motion.score * 100) / 100 : null,
    // No interval. v1 fixes it to a session-cluster bootstrap at B=4,000, and
    // 11 clusters is under the minimum of 20, so any interval computed here
    // would be one nobody should read.
    confidenceInterval: null,
    belowMinDenominator: !minimum.meetsMinimum,
    unavailableReasons: axis2Available ? [] : [...(reasons['wastedMotion'] ?? [])],
    // Named, caused and directed. Three of these are positive numerator terms,
    // so leaving them out makes the score read high; winsorisation is the one
    // that reads low. A receiver seeing 57.1 with no leaning would take it for
    // a plain measurement.
    omittedTerms: motion.omitted.map(
      (term): OmittedTerm => ({
        term,
        cause: 'not-implemented',
        leans: OMITTED_TERM_LEANINGS[term as OmittedTermName],
      }),
    ),
    detail: {
      wastedTotal: Math.round(motion.numerator * 100) / 100,
      bundleCount: motion.bundles,
      wastedPerBundle: Math.round(motion.w * 10_000) / 10_000,
      repeatRate: Math.round(motion.rIn * 10_000) / 10_000,
      failures: counts.wasted.failures,
      writeRepeats: counts.wasted.writeRepeats,
      investigationRepeats: counts.wasted.investigationRepeats,
      hookOriginatedExcluded: counts.wasted.hookOriginated,
    },
  }

  // Axis 5. Its own availability condition is having a tax to measure at all;
  // the asset multiplier is skipped when nothing is owned rather than set to
  // its worst value.
  const met = metabolism({
    effectiveInputPerCall: counts.metabolism.effectiveInputPerCall,
    skillsListed: counts.metabolism.skillsListed,
    skillFirings: counts.metabolism.skillFirings,
    hookFirings: counts.metabolism.hookFirings,
    mcpFirings: counts.metabolism.mcpFirings,
    mcpServersDefined: mcp.servers,
    listingTruncated: counts.metabolism.listingTruncated,
  })

  const metabolismAxis: Axis = {
    availability: met.score === null ? 'not_applicable' : 'available',
    lineStates: {
      available: met.score === null ? 0 : counts.toolActivityRows,
      not_applicable: met.score === null ? linesRead : linesRead - counts.toolActivityRows,
      parse_failed: 0,
    },
    metric: null,
    score: met.score === null ? null : Math.round(met.score * 100) / 100,
    confidenceInterval: null,
    belowMinDenominator: !meetsMinimum({
      clusters,
      denominator: Math.max(met.assets, MIN_DENOMINATOR),
      numerator: Math.max(met.firedAssets, MIN_NUMERATOR),
    }).meetsMinimum,
    unavailableReasons: met.score === null ? ['definition-pending'] : [],
    omittedTerms: met.omitted.map(
      (term): OmittedTerm => ({ term, cause: 'not-implemented', leans: METABOLISM_OMISSION_LEANINGS[term] }),
    ),
    detail: {
      contextTaxPerCall: met.fc ?? 0,
      trapezoidE2: Math.round((met.trapezoidScore ?? 0) * 100),
      assets: met.assets,
      firedAssets: met.firedAssets,
      utilisationE4: Math.round((met.u ?? 0) * 10_000),
      // A tax past the ceiling pins the trapezoid to its floor, and an axis on
      // its floor cannot respond to anything the environment does.
      saturated: met.saturated ? 1 : 0,
    },
  }

  // Axis 4. Its (b) term is dropped and the rest renormalised: an abandoned
  // bundle needs a semantic judgement, and the mechanical half alone would call
  // every question-and-answer bundle abandoned.
  const editedNames = new Set(counts.manualEdits.editedNames)
  const stale = new Set(counts.manualEdits.staleRecoveredPaths.map(normalisePath))
  const up = uptake({
    artifacts: inputs.artifacts.artifacts,
    totalWeight: inputs.artifacts.totalWeight,
    bundles: counts.taskBundles,
    lastMentionIn: counts.lastMentionIn,
    manuallyOverwritten: (p) => stale.has(p) || editedNames.has(basename(p)),
    firstWindow: true,
  })

  const uptakeAxis: Axis = {
    availability: up.score === null ? 'not_applicable' : 'available',
    lineStates: {
      available: up.score === null ? 0 : counts.toolActivityRows,
      not_applicable: up.score === null ? linesRead : linesRead - counts.toolActivityRows,
      parse_failed: 0,
    },
    metric: null,
    score: up.score === null ? null : Math.round(up.score * 100) / 100,
    confidenceInterval: null,
    belowMinDenominator: !meetsMinimum({
      clusters,
      denominator: Math.max(up.artifacts, MIN_DENOMINATOR),
      numerator: Math.max(up.reusedArtifacts, MIN_NUMERATOR),
    }).meetsMinimum,
    unavailableReasons:
      up.unavailable === null
        ? []
        : up.unavailable === 'no-artifacts'
          ? ['insufficient-assets']
          : ['definition-pending'],
    omittedTerms: up.omitted.map(
      (term): OmittedTerm => ({ term, cause: 'not-implemented', leans: UPTAKE_OMISSION_LEANINGS[term] }),
    ),
    detail: {
      artifacts: up.artifacts,
      reusedArtifacts: up.reusedArtifacts,
      overwrittenArtifacts: up.overwrittenArtifacts,
      reuseE4: Math.round((up.reuse ?? 0) * 10_000),
      overwrittenE4: Math.round((up.overwritten ?? 0) * 10_000),
      bundles: up.bundles,
    },
  }

  // Axis 3. Condition (ii) needs a past window's command set, so a first window
  // drops it -- which makes verification easier to earn and reads high.
  const ver = verification({
    intervals: counts.verification.intervals,
    verifiedIntervals: counts.verification.verifiedIntervals,
    selfRepaired: counts.verification.selfRepaired,
    humanRescued: counts.verification.humanRescued,
    unresolved: counts.verification.unresolved,
    todoWriteUsed: counts.verification.todoWriteUsed,
    firstWindow: true,
  })

  const verificationAxis: Axis = {
    availability: ver.score === null ? 'not_applicable' : 'available',
    lineStates: {
      available: ver.score === null ? 0 : counts.toolActivityRows,
      not_applicable: ver.score === null ? linesRead : linesRead - counts.toolActivityRows,
      parse_failed: 0,
    },
    metric: null,
    score: ver.score === null ? null : Math.round(ver.score * 100) / 100,
    confidenceInterval: null,
    belowMinDenominator: !meetsMinimum({
      clusters,
      denominator: Math.max(ver.intervals, MIN_DENOMINATOR),
      numerator: Math.max(counts.verification.verifiedIntervals, MIN_NUMERATOR),
    }).meetsMinimum,
    unavailableReasons: ver.unavailable === null ? [] : ['insufficient-edit-intervals'],
    omittedTerms: ver.omitted.map(
      (term): OmittedTerm => ({
        term,
        cause: term === 'axis3-command-history' ? 'below-minimum' : 'not-implemented',
        leans: VERIFICATION_OMISSION_LEANINGS[term],
      }),
    ),
    detail: {
      intervals: ver.intervals,
      verifiedIntervals: counts.verification.verifiedIntervals,
      verifiedE4: Math.round((ver.v ?? 0) * 10_000),
      failures: ver.failures,
      selfRepaired: counts.verification.selfRepaired,
      humanRescued: counts.verification.humanRescued,
      unresolved: counts.verification.unresolved,
      todoWriteUsed: counts.verification.todoWriteUsed ? 1 : 0,
    },
  }

  const axes = Object.fromEntries(
    AXIS_KEYS.map((k) => [
      k,
      k === 'wastedMotion'
        ? wastedAxis
        : k === 'environmentMetabolism'
          ? metabolismAxis
          : k === 'artifactUptake'
            ? uptakeAxis
            : k === 'selfVerification'
              ? verificationAxis
              : axisFor(k),
    ]),
  ) as Axes

  const projects: ProjectSummary[] = inventory.projects.map((p) => {
    // A project with no files never reaches the reducer, so it has no tally.
    // Four of five projects here are in that state, and they must still appear:
    // dropping them is how a partial miss hides behind a healthy aggregate.
    const tally = counts.perProject[p.project] ?? { lines: 0, subLines: 0, humanRows: 0 }
    return {
      id: projectId(`sha256:${inputs.hashProject(p.project)}`),
      files: p.mainFiles + p.subFiles,
      lines: tally.lines,
      bytes: p.bytes,
      humanRows: tally.humanRows,
      subLineRatio: tally.lines > 0 ? round4(tally.subLines / tally.lines) : 0,
    }
  })

  const totalBytes = projects.reduce((a, p) => a + p.bytes, 0)
  const topBytes = projects.reduce((a, p) => Math.max(a, p.bytes), 0)

  const environment: Environment = {
    os: inputs.os,
    shell: inputs.shell,
    agentTools: inputs.agentTools,
    projectCount: projects.length,
    projects,
    topProjectByteShare: totalBytes > 0 ? round4(topBytes / totalBytes) : 0,
    skillsDefined: skills.total,
    hooksDefined: hooks.total,
  }

  const manifest: ScanManifest = {
    parserVersion: '1',
    scope: 'all',
    rootsWalked: inventory.rootsWalked,
    recursive: true,
    filesRead: inventory.files.length,
    linesRead,
    linesParseFailed: counts.linesParseFailed,
    bytesRead: counts.bytesRead,
    mainFiles: inventory.files.filter((f) => f.kind === 'main').length,
    mainLines: counts.mainLines,
    subFiles: inventory.files.filter((f) => f.kind === 'sub').length,
    subLines: counts.subLines,
    subLineRatio: linesRead > 0 ? round4(counts.subLines / linesRead) : 0,
    toolVersions: counts.toolVersions,
    toolVersionDistinct: Object.keys(counts.toolVersions).length,
    originFieldCoverage: makeMetric({
      numerator: counts.originBearingUserRows,
      // V-2 makes this field required, so it cannot be null. A machine with no
      // user rows at all has nothing to submit anyway, and the gate catches it.
      denominator: Math.max(1, counts.userRows),
      denominatorMeaning: 'origin フィールドが付いている user 行の割合。低いほど human 判定が過小になる',
      sourceField: 'origin.kind',
    }),
    countBasis: COUNT_BASIS,
    window: window.window,
    externalLog: {
      exists: window.externalRows > 0,
      rows: window.externalRows,
      recordedDays: window.recordedDays,
      activeDays: window.evidenceDays,
      activeDaysMethod: window.evidenceDaysMethod,
      recordRate: window.recordRate,
      recordRateCalendar: window.recordRateCalendar,
    },
    measuredAt: iso8601(inputs.measuredAt),
  }

  // The gate is the authority on its own three conditions; the composite takes
  // the verdict rather than re-deriving it.
  const gateReason: SuppressedReason | null = verdict.reasons[0] ?? null

  const axisInputs: readonly AxisInput[] = AXIS_KEYS.map((k) => ({
    key: k,
    available: axes[k].availability === 'available',
    score: axes[k].score,
    omittedTerms: axes[k].omittedTerms,
  }))

  const compositeBlock = composite({ axes: axisInputs, gateReason })

  const payload: Payload = {
    schemaVersion: '1.0',
    runTimestamp: iso8601(inputs.measuredAt),
    submissionId: uuid(inputs.submissionId),
    scanManifest: manifest,
    metrics: {
      toolError: booleanRate(
        counts.toolResultIsErrorTrue,
        counts.toolResultTotal,
        'window 内の tool_result ブロック総数（キーの有無を問わない）',
        'message.content[].tool_result.is_error',
      ),
      toolErrorAlt: booleanRate(
        counts.toolResultIsErrorTrue,
        counts.toolResultWithIsErrorKey,
        '🚨 事故#2 の当事者。**両方送る**。どちらが正かは受け取り側が決める',
        'message.content[].tool_result',
      ),
      skillFired: rateOrNull(
        counts.attributionSkillDistinct,
        skills.total,
        '書いたスキルのうち実際に発火した種類数。🚨 **行数ではない**',
        'attributionSkill',
      ),
      skillRows: makeCount({
        value: counts.attributionSkillRows,
        noDenominatorReason: 'reference-value',
        sourceField: 'attributionSkill',
      }),
      mcpUsed: rateOrNull(
        counts.mcpServerDistinct,
        mcp.servers,
        '繋いだサーバーのうち実際に呼ばれた数',
        'attributionMcpServer',
      ),
      humanTurns: makeCount({
        value: counts.humanTurns,
        noDenominatorReason: 'reference-value',
        sourceField: 'origin.kind',
      }),
      denialUserRejected: booleanRate(
        counts.denialUserRejected,
        counts.denialRows,
        '権限拒否のうち人間が止めた割合',
        'toolDenialKind',
      ),
      permissions: {
        allow: makeCount({ value: permissions.allow, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
        deny: makeCount({ value: permissions.deny, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
        ask: makeCount({ value: permissions.ask, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
        unrestrictedExec: makeCount({ value: permissions.unrestrictedExec, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
        cliWildcard: makeCount({ value: permissions.cliWildcard, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
        scriptPathFixed: makeCount({ value: permissions.scriptPathFixed, noDenominatorReason: 'tuple-not-a-rate', sourceField: 'permissions' }),
      },
      editPaths: rateOrNull(
        counts.editedFilesRepeated,
        counts.editedFilesDistinct,
        '🚨 手戻りではなくファイル集中度。打ち消し判定は別途',
        'message.content[].tool_use.input.file_path',
      ),
      tokens: {
        input: makeCount({ value: counts.tokens.input, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
        output: makeCount({ value: counts.tokens.output, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
        cacheRead: makeCount({ value: counts.tokens.cacheRead, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
        cacheCreation: makeCount({ value: counts.tokens.cacheCreation, noDenominatorReason: 'raw-token-counts', sourceField: 'message.usage' }),
      },
      hookPushback: booleanRate(
        counts.hookErrorsNonEmpty,
        counts.stopHookSummaryRows,
        'ガードレールが実際に応答を差し戻した割合。🚨 `preventedContinuation` は使わない（2環境とも全 false）',
        'hookErrors',
      ),
    },
    axes,
    composite: compositeBlock,
    environment,
  }

  return { payload, gate: verdict }
}

export { rateOrNull }
