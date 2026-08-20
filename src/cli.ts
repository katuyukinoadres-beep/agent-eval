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
  '',
  'No scores yet — the rate-to-score formula is unresolved. See docs/PHASE0_PLAN.md.',
].join('\n')

interface Parsed {
  readonly repos: string[]
  readonly externalLog: string | null
  readonly at: string | null
  readonly summary: boolean
  readonly error: string | null
}

function parseScanArgs(argv: readonly string[]): Parsed {
  const repos: string[] = []
  let externalLog: string | null = null
  let at: string | null = null
  let summary = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--summary') summary = true
    else if (a === '--repo' || a === '--external-log' || a === '--at') {
      const v = argv[i + 1]
      // An option whose value is missing takes the next flag as its value and
      // then reports a clean run over the wrong inputs.
      if (v === undefined || v.startsWith('--')) {
        return { repos, externalLog, at, summary, error: `${a} needs a value` }
      }
      if (a === '--repo') repos.push(v)
      else if (a === '--external-log') externalLog = v
      else at = v
      i += 1
    } else {
      return { repos, externalLog, at, summary, error: `unknown scan option: ${a}` }
    }
  }
  return { repos, externalLog, at, summary, error: null }
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
