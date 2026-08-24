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
import type { CountBasis, CountPeriod } from './metric.js'
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
  type LineStates,

  type BasisMismatch,} from './types.js'
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
import { RECURRENCE_OMISSION_LEANINGS, recurrence } from '../score/recurrence.js'
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
  /**
   * The corpus-wide view. What the gate, the observed span and the axes use.
   *
   * The axes still divide by all-time denominators — bundles, intervals, the
   * artifact set — so their numerators have to come from the same place. A
   * windowed numerator over a corpus-wide denominator is a rate nobody can name.
   */
  readonly counts: ScanCounts
  /**
   * The same scan restricted to the window, for the counts that are day-keyed.
   *
   * Only the row-level counters are windowed so far, so only the metrics whose
   * numerator *and* denominator are both row counters take this view. Each one
   * that does carries a `basis` saying so, because the manifest's `countBasis`
   * describes the majority and a count that departs from it has to say where it
   * departed.
   */
  readonly windowedCounts: ScanCounts
  /** Rows with no parsable timestamp. In no window, always reported. */
  readonly undatedRows: number
  /** What the window left out, by day. A zero at a position, not inside a sum. */
  readonly rowsOutOfWindow: {
    readonly total: number
    readonly undated: number
    readonly byDay: Readonly<Record<string, number>>
  }
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
  /**
   * The previous window's repeated-signature set, or null.
   *
   * Null on a first window, when no store is open, and when the key changed --
   * the MACs mean nothing across a key change, and intersecting them would
   * produce an empty set that reads as a perfect score.
   */
  readonly previousRepeated: readonly string[] | null
}

/**
 * v1's `r_cross`: the share of this window's repeated signatures that the last
 * window also repeated.
 *
 * Null rather than zero whenever there is nothing to divide by or nothing to
 * compare against. An empty intersection over an empty set is 0/0, and
 * reporting it as 0 reads as "no failure recurred" -- the flattering direction,
 * arrived at by accident.
 */
export function crossWindowRate(
  now: readonly string[],
  previous: readonly string[] | null,
): number | null {
  if (previous === null || now.length === 0) return null
  const before = new Set(previous)
  let carried = 0
  for (const mac of now) if (before.has(mac)) carried += 1
  return carried / now.length
}

/**
 * The counts whose declared meaning promises a window the basis does not give.
 *
 * A function rather than a literal so both outcomes can be tested. Two metrics
 * carry the meaning string `window 内の tool_result ブロック総数（…）`, and that
 * string is a closed-union member a receiver matches on to decide whether two
 * environments measured the same thing — so it cannot be paraphrased when the
 * build counts over the whole corpus. Saying so is the only honest option left.
 */
export function basisMismatchesFor(period: CountPeriod): readonly BasisMismatch[] {
  if (period === 'window') return []
  const reason = 'the denominator meaning says within-window; this build counts over the whole corpus'
  return [
    { path: 'metrics.toolError', declared: 'window', actual: period, reason },
    { path: 'metrics.toolErrorAlt', declared: 'window', actual: period, reason },
  ]
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
  // A numerator above its denominator is a real inconsistency and `makeMetric`
  // is right to refuse it -- but it refused by throwing, from a call nothing
  // between here and the CLI catches, so the whole tool produced nothing. It
  // was reachable: `skillFired` counted its numerator across every project and
  // its denominator in one directory, so running from a repository with few
  // skills killed the run with `numerator 5 exceeds denominator 2`.
  //
  // The scope mismatch is fixed at the source. This is the second line: an
  // inconsistency the payload cannot represent becomes an absence, which it
  // can, rather than nothing at all.
  if (numerator > denominator) return null
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
  // Only the cluster term, and only for the axes this map serves.
  //
  // The denominator and numerator terms are real conditions, but the axes
  // reached from here have not computed a denominator, and reporting a
  // shortfall against a figure that was never measured invents a finding --
  // eleven of them were reported that way once. `definition-pending` is what is
  // true about these axes. The four axes that do compute a denominator take
  // their verdict from their own measured values instead, above.
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
/** Stamps a metric with the window basis. Null passes through untouched. */
const withBasis = <T extends Metric>(m: T | null, basis: CountBasis): T | null =>
  m === null ? null : { ...m, basis }

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
  const { inventory, counts, windowedCounts, window, permissions, skills, hooks, mcp } = inputs

  /**
   * The basis the row-level metrics were taken on.
   *
   * Attached to those metrics rather than raised to the manifest, because the
   * manifest's `countBasis` still describes everything else. One word covering
   * two periods is the under-specified number this whole module exists to
   * refuse.
   */
  const WINDOW_BASIS: CountBasis = { ...COUNT_BASIS, period: 'window' }
  const windowed = <T extends Metric>(m: T | null): T | null => withBasis(m, WINDOW_BASIS)

  const linesRead = counts.linesRead
  const verdict = gate({
    linesRead,
    linesParseFailed: counts.linesParseFailed,
    rootsWalked: inventory.rootsWalked,
    activeDays: window.window.activeDays,
  })

  // Clusters are sessions, which is what the spec's bootstrap resamples over --
  // but a cluster is a session with a non-zero denominator *for that axis*, and
  // the axes do not share a denominator. Counting every session that produced a
  // line over-counts clusters on every axis at once, in the direction that lets
  // a minimum pass.
  const sessions = Object.values(counts.perSession)
  const clustersWith = (has: (t: (typeof sessions)[number]) => boolean): number =>
    sessions.filter(has).length
  /** Sessions at all. The fallback where no per-session denominator exists. */
  const clusters = counts.sessionIds.length
  const clustersByBundle = clustersWith((t) => t.bundles > 0)
  const clustersByInterval = clustersWith((t) => t.intervals > 0)
  const clustersByError = clustersWith((t) => t.errors > 0)
  const reasons = axisReasons(clusters, !verdict.totalAllowed)

  // Axis 2 is available on its own condition -- filtered tool_use of at least
  // 50, per v1 -- not on the cluster minimum. The cluster minimum gates whether
  // a change between windows may be called an improvement, which is a different
  // question from whether the rate exists. Conflating them reported a machine
  // with 8,502 tool calls as having nothing to measure.
  // All three of axis 2's inputs are day-keyed now, so all three come from the
  // window. Two of three would be the same mistake as none: the terms have to
  // leave together or W measures the boundary.
  const motion = wastedMotion(
    windowedCounts.wasted,
    windowedCounts.errorRepeats.rIn,
    windowedCounts.taskBundles,
  )
  // Filtered tool_use, which is what v1 and v2 both name. It used to be fed
  // `toolResultTotal` -- a different block type, unfiltered, and designated a
  // reference value by the same spec that sets this threshold.
  const toolCalls = windowedCounts.toolUseFiltered
  const axis2Available = toolCalls >= MIN_FILTERED_CALLS && motion.score !== null

  const axisFor = (key: string): Axis => ({
    availability: 'not_applicable',
    basis: null,
    // Every line got a verdict, and they sum to linesRead. A tally that does not
    // close is a parser that dropped rows without saying so.
    lineStates: lineStatesFor(false),
    metric: null,
    score: null,
    confidenceInterval: null,
    belowMinDenominator: true,
    unavailableReasons: reasons[key] ?? ['definition-pending'],
    detail: null,
    omittedTerms: [],
  })

  /**
   * The three line states for an axis, which must sum to linesRead.
   *
   * `parse_failed` was hardcoded zero on every axis while the manifest reported
   * a non-zero count, because `linesRead` is incremented before the JSON parse
   * is attempted -- so unparsed rows sat inside `linesRead` and the
   * `linesRead - toolActivityRows` arithmetic swept them into `not_applicable`.
   * The tally closed, V-10 checks only the sum, and the rows were gone. The
   * per-axis rule the payload spec defines could never fire.
   */
  const lineStatesFor = (available: boolean): LineStates => ({
    available: available ? counts.toolActivityRows : 0,
    not_applicable: available
      ? linesRead - counts.toolActivityRows - counts.linesParseFailed
      : linesRead - counts.linesParseFailed,
    parse_failed: counts.linesParseFailed,
  })

  const minimum = meetsMinimum({
    clusters: clustersByBundle,
    denominator: motion.bundles,
    numerator: Math.floor(motion.numerator),
  })

  const wastedAxis: Axis = {
    availability: axis2Available ? 'available' : 'not_applicable',
    // Every one of axis 2's three inputs is windowed, so the axis is.
    basis: WINDOW_BASIS,
    // Rows carrying a tool_use or tool_result are the axis's evidence; the rest
    // had nothing for it to judge. The three states still sum to linesRead.
    lineStates: lineStatesFor(axis2Available),
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
      failures: windowedCounts.wasted.failures,
      writeRepeats: windowedCounts.wasted.writeRepeats,
      investigationRepeats: windowedCounts.wasted.investigationRepeats,
      // All five numerator terms, so the visible parts reconcile to
      // `wastedTotal`. Two of the five were collected, weighted into the sum,
      // and then left out of the detail -- on the one axis that carries a score,
      // and against this payload's own promise that the detail is what a
      // receiver recomputes from.
      timedOut: windowedCounts.wasted.timedOut,
      largeOutput: windowedCounts.wasted.largeOutput,
      hookOriginatedExcluded: windowedCounts.wasted.hookOriginated,
    },
  }

  // Axis 5. Its own availability condition is having a tax to measure at all;
  // the asset multiplier is skipped when nothing is owned rather than set to
  // its worst value.
  const met = metabolism({
    peakInputPerBundle: counts.metabolism.peakInputPerBundle,
    effectiveInputPerBundle: counts.metabolism.effectiveInputPerBundle,
    inputPerBundleWithoutCache: counts.metabolism.inputPerBundleWithoutCache,
    skillsListed: counts.metabolism.skillsListed,
    skillFirings: counts.metabolism.skillFirings,
    hookFirings: counts.metabolism.hookFirings,
    mcpFirings: counts.metabolism.mcpFirings,
    mcpServersDefined: mcp.servers,
    hooksDefined: inputs.hooks.total,
    listingTruncated: counts.metabolism.listingTruncated,
  })

  const metabolismAxis: Axis = {
    // Deduction-style with two deductions dropped, so not_applicable however
    // good the number looks. Dropping a deduction can only raise a result, and
    // the result would be the same name for a different quantity.
    availability: 'not_applicable',
    basis: null,
    lineStates: lineStatesFor(met.score !== null),
    metric: null,
    // Recorded, not scored. A later window needs the raw figures, and a
    // snapshot that omitted them would lose them for good.
    score: null,
    confidenceInterval: null,
    // Measured values, not clamped ones. Passing `Math.max(measured, MIN)` and
    // then testing `< MIN` is a condition that cannot fail: it reported every
    // denominator as sufficient however small it was, which let a delta be
    // called an improvement off twelve artifacts.
    //
    // Axis 5's denominator is assets, which are defined machine-wide rather
    // than per session, so this keeps the session count and says so.
    belowMinDenominator: !meetsMinimum({
      clusters,
      denominator: met.assets,
      numerator: met.firedAssets,
    }).meetsMinimum,
    unavailableReasons: ['definition-pending'],
    omittedTerms: met.omitted.map(
      (term): OmittedTerm => ({ term, cause: 'not-implemented', leans: METABOLISM_OMISSION_LEANINGS[term] }),
    ),
    detail: {
      // Named for what it is. v2 §3.5(b) requires both figures and forbids
      // scoring on one: cache reads are 94.7% of all tokens measured, so the
      // with-cache figure mostly measures how long a session ran.
      // The peak context a request reached, which is the figure the trapezoid
      // grades. The other two are reported beside it because the spec's two
      // lines disagree about which is meant, and the three differ by four
      // orders of magnitude.
      contextTaxPeakPerBundle: met.fc ?? 0,
      contextTaxSummedPerBundle: met.fcSummed ?? 0,
      contextTaxPerBundleWithoutCache: met.fcWithoutCache ?? 0,
      trapezoidE2: Math.round((met.trapezoidScore ?? 0) * 100),
      assets: met.assets,
      firedAssets: met.firedAssets,
      utilisationE4: Math.round((met.u ?? 0) * 10_000),
      // What the score would have been, kept where it cannot be mistaken for
      // one: outside `score`, which stays null.
      unscoredE2: Math.round((met.score ?? 0) * 100),
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
    mentionedElsewhereAfter: counts.mentionedElsewhereAfter,
    manuallyOverwritten: (p) => stale.has(p) || editedNames.has(basename(p)),
    firstWindow: true,
  })

  const uptakeAxis: Axis = {
    availability: up.score === null ? 'not_applicable' : 'available',
    basis: null,
    lineStates: lineStatesFor(up.score !== null),
    metric: null,
    score: up.score === null ? null : Math.round(up.score * 100) / 100,
    confidenceInterval: null,
    // Artifacts are keyed by bundle, and a bundle belongs to a session, so the
    // sessions that opened a bundle are the ones that could hold one.
    belowMinDenominator: !meetsMinimum({
      clusters: clustersByBundle,
      denominator: up.artifacts,
      numerator: up.reusedArtifacts,
    }).meetsMinimum,
    // Named honestly. `no-artifacts` used to report `insufficient-assets`,
    // whose text is "fewer than 3 assets defined" -- an axis-5 threshold v2
    // abolished, advising a fix that would not change the outcome. And too few
    // bundles used to report `definition-pending`, "the definition this axis
    // needs is not settled yet", when it is settled and the environment is
    // small. Conflating those two is what this module exists to prevent.
    unavailableReasons: up.unavailable === null ? [] : [up.unavailable],
    omittedTerms: up.omitted.map((term): OmittedTerm => {
      // (c) is dropped for want of data in this window, not because the build
      // never implemented it — and its direction was measured before it was
      // refused, so it is a fact rather than the table's fallback.
      if (term === 'axis4-manual-overwrite') {
        return { term, cause: 'below-minimum', leans: up.overwriteLeaning ?? UPTAKE_OMISSION_LEANINGS[term] }
      }
      return { term, cause: 'not-implemented', leans: UPTAKE_OMISSION_LEANINGS[term] }
    }),
    detail: {
      artifacts: up.artifacts,
      reusedArtifacts: up.reusedArtifacts,
      overwrittenArtifacts: up.overwrittenArtifacts,
      reuseE4: Math.round((up.reuse ?? 0) * 10_000),
      overwrittenE4: Math.round((up.overwritten ?? 0) * 10_000),
      bundles: up.bundles,
      // Sizes the bare-filename fallback. A mention of a name shared by two
      // paths is not evidence about either, and this says how much of the log
      // is in that state.
      ambiguousBasenames: counts.ambiguousBasenames,
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
    repairedNotCounted: counts.verification.repairedNotCounted,
    todoWriteUsed: counts.verification.todoWriteUsed,
    firstWindow: true,
  })

  const verificationAxis: Axis = {
    availability: ver.score === null ? 'not_applicable' : 'available',
    basis: null,
    lineStates: lineStatesFor(ver.score !== null),
    metric: null,
    score: ver.score === null ? null : Math.round(ver.score * 100) / 100,
    confidenceInterval: null,
    belowMinDenominator: !meetsMinimum({
      clusters: clustersByInterval,
      denominator: ver.intervals,
      numerator: counts.verification.verifiedIntervals,
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
      // The fourth bucket. Without it the four numbers here do not sum to
      // `failures`, and a reader checking the arithmetic finds a gap with no
      // name -- which is how a term gets assumed to be zero.
      repairedNotCounted: counts.verification.repairedNotCounted,
      todoWriteUsed: counts.verification.todoWriteUsed ? 1 : 0,
    },
  }

  // Axis 6. On a first window there is no previous signature set, so the
  // within-window repeat rate stands in and the record says which one it was --
  // two windows must never be compared across that switch.
  const rec = recurrence({
    rIn: counts.errorRepeats.rIn,
    rCross: crossWindowRate(counts.signaturesRepeated, inputs.previousRepeated),
    // Two runs over an all-time count are the same corpus twice, so every
    // repeated signature carries over and r_cross is 1.0 by construction.
    periodsDiffer: COUNT_BASIS.period !== 'allTime',
    errors: counts.errorRepeats.errors,
    firstWindow: inputs.previousRepeated === null,
    hasExternalHookLog: false,
  })

  const recurrenceAxis: Axis = {
    availability: rec.score === null ? 'not_applicable' : 'available',
    basis: null,
    lineStates: lineStatesFor(rec.score !== null),
    metric: null,
    score: rec.score === null ? null : Math.round(rec.score * 100) / 100,
    confidenceInterval: null,
    belowMinDenominator: !meetsMinimum({
      clusters: clustersByError,
      denominator: rec.errors,
      numerator: counts.errorRepeats.distinctSignatures,
    }).meetsMinimum,
    // `rec.unavailable` can only be 'no-failures'. Reporting it as
    // 'no-external-log' advised installing a log that would not change the
    // outcome, and layer B's absence is already in `omittedTerms`.
    unavailableReasons: rec.unavailable === null ? [] : [rec.unavailable],
    omittedTerms: rec.omitted.map(
      (term): OmittedTerm => ({ term, cause: 'not-implemented', leans: RECURRENCE_OMISSION_LEANINGS[term] }),
    ),
    detail: {
      errors: rec.errors,
      distinctSignatures: counts.errorRepeats.distinctSignatures,
      repeatRateE4: Math.round((rec.rate ?? 0) * 10_000),
      // 1 while this is a baseline rather than a score. The report must say so.
      baselineOnly: rec.baselineOnly ? 1 : 0,
    },
  }

  /**
   * The gate's verdict, applied to every axis.
   *
   * Each axis decided its own `availability` from its own condition, and the
   * gate's verdict reached only the composite. At 20.4% unparseable the payload
   * carried `composite: null, suppressedReason: 'parse-failure-rate'` beside
   * four axes marked `available` with scores on them -- so a receiver reading
   * `axes` instead of `composite.suppressedReason` got four scored axes off an
   * environment the tool had already rejected. v2 §3.0 says the whole
   * environment is parse_failed and no total comes out.
   */
  const gated = (axis: Axis): Axis =>
    verdict.availability === 'parse_failed'
      ? {
          ...axis,
          availability: 'parse_failed',
          score: null,
          confidenceInterval: null,
          unavailableReasons: ['environment-gated'],
        }
      : axis

  const axes = Object.fromEntries(
    AXIS_KEYS.map((k) => [
      k,
      gated(
        k === 'wastedMotion'
          ? wastedAxis
          : k === 'environmentMetabolism'
            ? metabolismAxis
            : k === 'artifactUptake'
              ? uptakeAxis
              : k === 'selfVerification'
                ? verificationAxis
                : k === 'recurrencePrevention'
                  ? recurrenceAxis
                  : axisFor(k),
      ),
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
    filesUnreadable: counts.filesUnreadable,
    filesWithoutRows: counts.filesWithoutRows,
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
    // Declared where it is wrong rather than quietly reworded. `toolError` and
    // `toolErrorAlt` carry a meaning string that says `window 内の`, and the
    // string is a closed-union member a receiver matches on -- so it cannot be
    // paraphrased without breaking the comparison it exists for. The count is
    // over all time until the rest of the windowing lands.
    // Derived from what the metrics actually carry, not asserted. The two
    // counts whose meaning promises a window are windowed now, so the list is
    // empty — and it fills again the moment one of them stops being.
    basisMismatch: basisMismatchesFor(WINDOW_BASIS.period),
    undatedRows: inputs.undatedRows,
    rowsOutOfWindow: inputs.rowsOutOfWindow,
    failureAttribution: {
      observed: counts.wasted.errorsObserved,
      inAxis2Numerator: counts.wasted.closure.numerator,
      excluded: counts.wasted.closure.excluded,
      balanced: counts.wasted.closure.balanced,
      byId: counts.wasted.attribution,
      denialKinds: counts.denialKinds,
    },
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
      // Both sides of each of these is a row counter, so both are windowed and
      // the rate means what its denominator says it means. That is what closes
      // the `window 内の` claim these two carry.
      toolError: windowed(
        booleanRate(
          windowedCounts.toolResultIsErrorTrue,
          windowedCounts.toolResultTotal,
          'window 内の tool_result ブロック総数（キーの有無を問わない）',
          'message.content[].tool_result.is_error',
        ),
      ),
      toolErrorAlt: windowed(
        booleanRate(
          windowedCounts.toolResultIsErrorTrue,
          windowedCounts.toolResultWithIsErrorKey,
          '🚨 事故#2 の当事者。**両方送る**。どちらが正かは受け取り側が決める',
          'message.content[].tool_result',
        ),
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
