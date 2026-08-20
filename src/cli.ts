#!/usr/bin/env node
/**
 * agent-eval — scores an AI agent environment from its own Claude Code logs.
 *
 * Nothing here reads a log yet. This entry point exists so the toolchain has
 * something real to compile and run: tsc and vitest had never executed against
 * source in this repository, and a build that has never run is not a build.
 */
import { FIXTURE_NAMES, emit, isFixtureName } from './payload/emit.js'
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
  '',
  'No scanning yet — see docs/PHASE0_PLAN.md for what lands when.',
].join('\n')

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

  return { code: 2, out: `unknown argument: ${cmd}` }
}

// Only act when executed directly, so importing this from a test does not run it.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('\\').join('/'))) {
  const { code, out } = run(process.argv.slice(2))
  ;(code === 0 ? process.stdout : process.stderr).write(`${out}\n`)
  process.exit(code)
}
