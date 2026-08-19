#!/usr/bin/env node
/**
 * agent-eval — scores an AI agent environment from its own Claude Code logs.
 *
 * Nothing here reads a log yet. This entry point exists so the toolchain has
 * something real to compile and run: tsc and vitest had never executed against
 * source in this repository, and a build that has never run is not a build.
 */
import { VERSION } from './version.js'

const HELP = [
  `agent-eval ${VERSION}`,
  '',
  'Scores this environment from its local Claude Code logs.',
  'Analysis stays on the machine; only scores leave it, and only on request.',
  '',
  '  --version    print the version',
  '  --help       this text',
  '',
  'No scoring commands yet — see docs/PHASE0_PLAN.md for what lands when.',
].join('\n')

export function run(argv: readonly string[]): { readonly code: number; readonly out: string } {
  const cmd = argv[0]
  if (cmd === '--version' || cmd === '-v') return { code: 0, out: VERSION }
  if (cmd === undefined || cmd === '--help' || cmd === '-h') return { code: 0, out: HELP }
  return { code: 2, out: `unknown argument: ${cmd}` }
}

// Only act when executed directly, so importing this from a test does not run it.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url.endsWith(entry.split('\\').join('/'))) {
  const { code, out } = run(process.argv.slice(2))
  ;(code === 0 ? process.stdout : process.stderr).write(`${out}\n`)
  process.exit(code)
}
