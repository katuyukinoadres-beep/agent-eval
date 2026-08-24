#!/usr/bin/env node
/**
 * agent-eval — scores an AI agent environment from its own Claude Code logs.
 *
 * `scan` runs end to end and prints a payload. Four of eleven axes carry a
 * score; the rest report why they do not, so "your environment is small" stays
 * distinguishable from "this axis is not implemented yet". No axis is ever
 * given an invented number to fill a gap -- that is the failure this project
 * was built in response to.
 */
import { FIXTURE_NAMES, emit, isFixtureName } from './payload/emit.js'
import { defaultOptions, run as runScan } from './run.js'
import type { Flag, Violation } from './validate/index.js'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.js'

const HELP = [
  `agent-eval ${VERSION}`,
  '',
  'Scores this environment from its local Claude Code logs.',
  'Analysis stays on the machine; only scores leave it, and only on request.',
  '',
  '  --version              print the version',
  '  --help                 this text',
  `  emit --fixture <name>  print a reference payload (${FIXTURE_NAMES.join(', ')})`,
  '  scan [options]         read this machine and print a validated payload',
  '  scan --summary         the same run, reported rather than dumped',
  '',
  'scan options:',
  '  --repo <path>          take commit dates from this repository (repeatable)',
  '  --external-log <path>  CSV whose `date` column records closing entries',
  '  --at <iso8601>         the measurement timestamp to stamp (default: now)',
  '  --store                open ~/.agent-eval, so signatures are MAC-signed',
  '  --state-dir <path>     put the store somewhere else',
  '',
  'Scores 4 of 11 axes. The other 7 say why they have no number rather than',
  'carrying an invented one. Comparison against the previous window needs a',
  'second run with --store, and a window is the last 10 active days.',
  '',
  'Nothing is sent anywhere. See docs/PRIVACY.md for what is read and written,',
  'and docs/GUIDE.md for how to read the output.',
].join('\n')

interface Parsed {
  readonly repos: string[]
  readonly externalLog: string | null
  readonly at: string | null
  readonly summary: boolean
  readonly store: boolean
  readonly stateDir: string | null
  readonly error: string | null
}

function parseScanArgs(argv: readonly string[]): Parsed {
  const repos: string[] = []
  let externalLog: string | null = null
  let at: string | null = null
  let summary = false
  let store = false
  let stateDir: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--summary') summary = true
    else if (a === '--store') store = true
    else if (a === '--repo' || a === '--external-log' || a === '--at' || a === '--state-dir') {
      const v = argv[i + 1]
      // An option whose value is missing takes the next flag as its value and
      // then reports a clean run over the wrong inputs.
      if (v === undefined || v.startsWith('--')) {
        return { repos, externalLog, at, summary, store, stateDir, error: `${a} needs a value` }
      }
      if (a === '--repo') repos.push(v)
      else if (a === '--external-log') externalLog = v
      else if (a === '--state-dir') stateDir = v
      else at = v
      i += 1
    } else {
      return { repos, externalLog, at, summary, store, stateDir, error: `unknown scan option: ${a}` }
    }
  }
  // --state-dir without --store would silently do nothing.
  if (stateDir !== null && !store) {
    return { repos, externalLog, at, summary, store, stateDir, error: '--state-dir needs --store' }
  }
  return { repos, externalLog, at, summary, store, stateDir, error: null }
}

/**
 * One line about the snapshot, printed whether it worked or not.
 *
 * The wording is deliberate on two points. It carries no path -- a path holds
 * the OS username, and this output gets pasted into issues. And it says
 * "self-consistent" rather than "verified": the key is local and the hash
 * function public, so the chain establishes that nothing changed since it was
 * written, not that its owner did not write it that way.
 */
function snapshotLine(result: ReturnType<typeof runScan>): string {
  const s = result.snapshot
  if (s === null) return 'not written (--store to keep history)'
  if (s.kind === 'refused') return `REFUSED: ${s.reason} — ${s.detail}`
  const c = result.chain
  const chain =
    c === null
      ? ''
      : `, chain ${c.length} ${c.continuous ? 'self-consistent' : `with ${c.breaks.length} break(s)`}`
  const absent = s.blocksAbsent === 0 ? '' : ` — ${s.blocksAbsent} block(s) absent`
  return `wrote #${s.seq} (${s.hash.slice(7, 19)})${chain}${absent}`
}

/**
 * This window against the last one.
 *
 * Never says improved or worsened. A delta may only be named when its interval
 * excludes zero and its size clears the floor, and there is no interval yet, so
 * every delta here is shown and none is named. The wording matters: on the data
 * the floor was fitted to, one indicator moved +0.834pt significantly over one
 * pair of windows and -0.083pt over the same data cut differently.
 */
function comparisonLine(result: ReturnType<typeof runScan>): string {
  const c = result.comparison
  if (c === null) return 'no store opened'
  if (c.refused !== null) return `no delta — ${c.refused}`
  const named = c.perAxis.filter((a) => a.significant).length
  const parts = c.perAxis
    .map((a) => `${a.axis} ${a.delta >= 0 ? '+' : ''}${a.delta}`)
    .join(', ')
  const gap = named === 0 ? ' (none can be called a change: no interval yet)' : ''
  const excluded =
    c.excludedByFingerprint.length === 0
      ? ''
      : ` — ${c.excludedByFingerprint.length} axis(es) excluded, formula changed`
  // The composite delta, or the reason there is not one. It was structurally
  // null for the whole of the first build because nothing stored the previous
  // window's figure, and a missing line reads as "no change".
  const INDENT = '\n           '
  const total =
    c.delta === null
      ? `${INDENT}composite: withheld — the two windows did not measure the same axes`
      : `${INDENT}composite: ${c.compositeThen} → ${c.compositeNow} (${c.delta >= 0 ? '+' : ''}${c.delta})`
  return `${c.basis}, ${c.axes.length} axes: ${parts}${gap}${excluded}${total}`
}

/** The total, or why there is not one, plus which way it leans. */
function compositeLine(c: ReturnType<typeof runScan>['payload']['composite']): string {
  if (c.score === null) return `none — ${c.suppressedReason ?? 'unstated'}`
  const leaning =
    c.leans === null
      ? ''
      : ` — leans ${c.leans}${c.leans === 'mixed' ? ' (both directions, so neither can be told)' : ''}`
  const parts = [
    `${c.score} (${c.tier ?? '?'}) over ${c.axesUsed.length} axes`,
    c.outcomeScore === null ? null : `outcome ${c.outcomeScore}`,
    c.designScore === null ? null : `design ${c.designScore}`,
  ].filter((x): x is string => x !== null)
  return `${parts.join(', ')}${leaning}`
}

/** A short report, so the common case does not require reading 300 lines of JSON. */
function summarise(result: ReturnType<typeof runScan>): string {
  const { payload, validation, gateReasons } = result
  const m = payload.scanManifest
  const w = m.window
  const axes = Object.entries(payload.axes)
  const reasons = new Map<string, number>()
  for (const [, axis] of axes) {
    for (const r of axis.unavailableReasons) reasons.set(r, (reasons.get(r) ?? 0) + 1)
  }
  return [
    `agent-eval ${VERSION} — ${m.measuredAt}`,
    '',
    `scanned    ${m.filesRead} files, ${m.linesRead} lines, ${m.linesParseFailed} unparsed`,
    // Printed even at zero. A file that failed to open leaves every total short
    // together, so the identities still close and the gate still passes.
    `           ${m.filesUnreadable} unreadable, ${m.filesWithoutRows} with no rows`,
    // A row with no timestamp belongs to no window, so this is the standing
    // difference between a windowed count and its corpus-wide twin. Too large
    // here to leave a reader to infer from a gap between two totals.
    `           ${m.undatedRows} undated (in no window), ${m.rowsOutOfWindow.total} rows out of window`,
    `           main ${m.mainLines} / sub ${m.subLines} (share ${m.subLineRatio})`,
    `projects   ${payload.environment.projectCount}`,
    `versions   ${m.toolVersionDistinct}`,
    `origin     ${m.originFieldCoverage.numerator}/${m.originFieldCoverage.denominator} of user rows`,
    '',
    `window     ${w.activeDays} human-turn days, ${w.userRowDays} user-row days, ${w.windowSource}`,
    // The boundary decides what a day is, and `activeDaysInWindow === activeDays`
    // means the window cut nothing — a figure that did not move is not evidence
    // it works.
    `           ${w.activeDaysInWindow}/${w.activeDays} in window (${w.windowStart ?? '-'}..${w.windowEnd ?? '-'}), boundary ${w.dayBoundary}, ${w.activeDaysUtc} under UTC`,
    // The day the run happened on is reported and not scored. A day still being
    // written is a fraction of a day, and a window slot spent on it evicts a
    // whole one.
    `           ${w.inFlightDay === null ? 'no work today yet' : `today ${w.inFlightDay} in flight, not scored`}${w.includesInFlightDay ? ' (first window: used anyway)' : ''}`,
    // Said plainly while it is true. The window applies to the manifest's rate
    // metrics and not to the axis scores, and a reader who takes the block
    // above for the scope of the scores below has been misled by layout alone.
    // Derived, not asserted. Each axis carries the basis its inputs were taken
    // on, so this line cannot drift from what actually happened.
    ...(() => {
      const scored = axes.filter(([, a]) => a.score !== null)
      const outside = scored.filter(([, a]) => a.basis?.period !== 'window').map(([k]) => k)
      return [
        `           scored over the window: ${scored.length - outside.length}/${scored.length} axes${
          outside.length === 0 ? '' : ` — ${outside.join(', ')} over the whole corpus`
        }`,
        ...(m.basisMismatch.length === 0
          ? []
          : [`           🚨 ${m.basisMismatch.length} count(s) declare a period their basis does not match`]),
      ]
    })(),
    `evidence   ${m.externalLog.activeDays} days (${m.externalLog.activeDaysMethod})`,
    `record     ${m.externalLog.recordRate === null ? 'no day to divide by' : `${m.externalLog.recordRate.numerator}/${m.externalLog.recordRate.denominator}`}`,
    '',
    // The path is not printed. It is `<home>/.agent-eval`, so it carries the
    // OS username, and this output is meant to be pasteable into an issue.
    `store      ${result.stateDir === null ? 'not opened (--store to open it)' : 'opened'}`,
    // Always printed. A snapshot that silently failed to write is discovered a
    // window later, when the comparison it existed for cannot be made.
    `snapshot   ${snapshotLine(result)}`,
    `vs prev    ${comparisonLine(result)}`,
    `signatures ${result.signaturesSigned ? 'signed' : 'unsigned — the set is empty, not the environment'}`,
    '',
    `gate       ${gateReasons.length === 0 ? 'passed' : gateReasons.join(', ')}`,
    `axes       ${axes.filter(([, a]) => a.availability === 'available').length}/${axes.length} available`,
    ...axes
      .filter(([, a]) => a.score !== null)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, a]) => `           ${k.padEnd(22)} ${String(a.score).padStart(6)}`),
    '',
    // The total comes after the breakdown, not before it. The first release
    // does not lead with one number, and a total with no leaning beside it
    // reads as a plain measurement when its parts dropped terms.
    `composite  ${compositeLine(payload.composite)}`,
    ...[...reasons.entries()].sort().map(([r, n]) => `           ${n} × ${r}`),
    '',
    `validation ${validation.ok ? 'passed' : 'REFUSED'} (${validation.violations.length} violations, ${validation.flags.length} flags)`,
    ...validation.violations.map((v: Violation) => `           ${v.rule} ${v.path}: ${v.detail}`),
    ...validation.flags.map((f: Flag) => `           ${f.flag} ${f.path}: ${f.detail}`),
  ].join('\n')
}

export function run(argv: readonly string[]): { readonly code: number; readonly out: string } {
  const cmd = argv[0]
  if (cmd === '--version' || cmd === '-v') return { code: 0, out: VERSION }
  if (cmd === undefined || cmd === '--help' || cmd === '-h') return { code: 0, out: HELP }

  if (cmd === 'emit') {
    if (argv[1] !== '--fixture') return { code: 2, out: 'emit needs --fixture <name>' }
    const name = argv[2]
    // Refuses an unknown name rather than defaulting to base: a typo that
    // silently returns the reference payload is how a fixture gets mistaken for
    // a real reading.
    if (name === undefined || !isFixtureName(name)) {
      return { code: 2, out: `unknown fixture: ${name ?? '(none)'} — have ${FIXTURE_NAMES.join(', ')}` }
    }
    return { code: 0, out: emit(name) }
  }

  if (cmd === 'scan') {
    const parsed = parseScanArgs(argv.slice(1))
    if (parsed.error !== null) return { code: 2, out: parsed.error }

    const options = defaultOptions({
      repos: parsed.repos,
      closingLogPath: parsed.externalLog,
      useStore: parsed.store,
      stateDir: parsed.stateDir,
      ...(parsed.at === null ? {} : { measuredAt: parsed.at }),
    })
    const result = runScan(options)
    const out = parsed.summary ? summarise(result) : JSON.stringify(result.payload, null, 2)
    // Exit non-zero when the payload fails our own rules. Printing a refused
    // payload with a zero status is how it ends up piped somewhere.
    return { code: result.validation.ok ? 0 : 1, out }
  }

  return { code: 2, out: `unknown argument: ${cmd}` }
}

/**
 * Whether two paths name the same file on disk.
 *
 * Resolved, not compared as text. The check this replaces was
 * `import.meta.url.endsWith(argv[1])`, and those are not the same kind of
 * string: `import.meta.url` is a percent-encoded `file://` URL while `argv[1]`
 * is a raw path. A home directory called `C:\Users\First Last` gives
 * `with%20space` on one side and a literal space on the other, and they differ
 * again whenever a symlink is involved — which is precisely what `npm i -g`
 * creates on POSIX.
 *
 * The failure was silent in the worst way available. No match meant the body
 * below never ran, so the command printed nothing and exited 0: no message, no
 * stack, nothing to paste into an issue. Reproduced here — `--version` from a
 * path containing a space produced zero bytes and exit 0.
 *
 * No test caught it because not one of the suite's tests spawns the built
 * binary. The shipped artifact was the only thing never exercised.
 */
const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// Only act when executed directly, so importing this from a test does not run it.
const entry = process.argv[1]
if (entry !== undefined && sameFile(fileURLToPath(import.meta.url), entry)) {
  const { code, out } = run(process.argv.slice(2))
  ;(code === 0 ? process.stdout : process.stderr).write(`${out}\n`)
  process.exit(code)
}
