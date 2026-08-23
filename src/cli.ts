#!/usr/bin/env node
/**
 * agent-eval — scores an AI agent environment from its own Claude Code logs.
 *
 * `scan` runs end to end and prints a payload. It does not print a score: the
 * rate-to-score formula lives in the v1 axes document, which is not in this
 * repository, and a number invented to fill the gap is the failure this project
 * was built in response to. Every axis reports why it has none.
 */
import { FIXTURE_NAMES, emit, isFixtureName } from './payload/emit.js'
import { defaultOptions, run as runScan } from './run.js'
import type { Flag, Violation } from './validate/index.js'
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
  'No scores yet — the rate-to-score formula is unresolved. See docs/PHASE0_PLAN.md.',
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
    `           main ${m.mainLines} / sub ${m.subLines} (share ${m.subLineRatio})`,
    `projects   ${payload.environment.projectCount}`,
    `versions   ${m.toolVersionDistinct}`,
    `origin     ${m.originFieldCoverage.numerator}/${m.originFieldCoverage.denominator} of user rows`,
    '',
    `window     ${w.activeDays} human-turn days, ${w.userRowDays} user-row days, ${w.windowSource}`,
    `evidence   ${m.externalLog.activeDays} days (${m.externalLog.activeDaysMethod})`,
    `record     ${m.externalLog.recordRate.numerator}/${m.externalLog.recordRate.denominator}`,
    '',
    `store      ${result.stateDir ?? 'not opened (--store to open it)'}`,
    // Always printed. A snapshot that silently failed to write is discovered a
    // window later, when the comparison it existed for cannot be made.
    `snapshot   ${snapshotLine(result)}`,
    `signatures ${result.signaturesSigned ? 'signed' : 'unsigned — the set is empty, not the environment'}`,
    '',
    `gate       ${gateReasons.length === 0 ? 'passed' : gateReasons.join(', ')}`,
    `axes       ${axes.filter(([, a]) => a.availability === 'available').length}/${axes.length} available`,
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

// Only act when executed directly, so importing this from a test does not run it.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('\\').join('/'))) {
  const { code, out } = run(process.argv.slice(2))
  ;(code === 0 ? process.stdout : process.stderr).write(`${out}\n`)
  process.exit(code)
}
