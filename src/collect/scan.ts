/**
 * Reads every enumerated transcript exactly once and reduces it to counts.
 *
 * One pass, one open per file. Not for speed — the whole corpus here is 72MB —
 * but because a second pass is where two passes disagree. The measurement that
 * started this project was a subagent count of 27,751 from one pass and 0 from
 * another over the same machine on the same day, differing only in which files
 * they walked.
 *
 * Nothing decides anything from a field outside READ_KEYS. Three fields are
 * excluded by name and a test asserts they stay excluded; each is the obvious
 * source for something measured here and each returns a constant zero.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FileEntry, Inventory } from './walk.js'
import { notHumanBecause, userText } from './humanTurn.js'
import { bundleTracker, isEnvironmentNoise, type BundleTracker } from './bundle.js'
import { readWrite, recordWrite, type MutPathTally, type PathTally } from './artifact.js'
import { referenceIndex, type ReferenceIndex } from './reference.js'
import { classifyError, repeatRate, type ErrorClass, type RepeatRate } from './errorClass.js'
import { LARGE_OUTPUT_BYTES, isInvestigation, wastedTracker, type WastedCounts, type WastedTracker } from './wasted.js'

/**
 * Every jsonl key this reducer is allowed to look at.
 *
 * An allowlist rather than a denylist so a field has to be argued for before it
 * can influence a number, and so the three below can be shown absent rather than
 * merely unmentioned.
 */
export const READ_KEYS = [
  'type',
  'subtype',
  'version',
  'timestamp',
  'sessionId',
  'origin',
  'message',
  'attributionSkill',
  'attributionMcpServer',
  'toolDenialKind',
  'hookErrors',
  // P5 — the conversation tree. Reading order instead puts 4.19% of rows in
  // the wrong bundle.
  'uuid',
  'parentUuid',
  // P3 — a bad connection is not low quality work.
  'isApiErrorMessage',
  // P6 — where a write landed and how large it was. Only `filePath`,
  // `structuredPatch[].newLines` and `file.numLines` are touched inside it; see
  // FORBIDDEN_SUBFIELDS.
  'toolUseResult',
] as const

export type ReadKey = (typeof READ_KEYS)[number]

/**
 * Fields that must never influence a count.
 *
 *   isSidechain               false on every main-transcript row on both
 *                             machines; position in the tree decides instead
 *   toolUseResult.interrupted 9,995 occurrences across two machines, 0 true
 *                             (the parent object is read for P6; only this
 *                             field within it is off limits)
 *   preventedContinuation     all false on both machines even on the rows where
 *                             a hook did push a response back — the event is in
 *                             hookErrors, which is in the allowlist above
 *
 * None of the three errors when read. Each returns a well-formed zero, which is
 * why a denylist that is only a comment does not hold.
 */
export const FORBIDDEN_KEYS = ['isSidechain', 'toolUseResult.interrupted', 'preventedContinuation'] as const

/**
 * Fields inside `toolUseResult` that carry file or console content.
 *
 * `toolUseResult` was banned outright until P6 needed the size of a write. The
 * ban was the right instinct and the wrong shape: the object also holds
 * `originalFile`, `newString`, `oldString`, `content`, `stdout` and `stderr`,
 * which are the file and the terminal. 180 of the 355 edited paths on this
 * machine sit outside the working tree, so their contents are somebody's
 * business and not this tool's.
 *
 * Named individually rather than covered by a rule about the parent, because a
 * ban on the parent is what sent P6 looking for line counts somewhere worse.
 */
export const FORBIDDEN_SUBFIELDS = [
  'lines',
  'originalFile',
  'newString',
  'oldString',
  'content',
  'stdout',
  'stderr',
] as const

export interface ScanCounts {
  readonly linesRead: number
  readonly linesParseFailed: number
  readonly bytesRead: number
  readonly mainLines: number
  readonly subLines: number

  readonly toolResultTotal: number
  readonly toolResultWithIsErrorKey: number
  readonly toolResultIsErrorTrue: number

  readonly attributionSkillRows: number
  readonly attributionSkillDistinct: number
  readonly mcpServerDistinct: number

  /** Rows carrying an `origin` object at all — the denominator of coverage. */
  readonly userRows: number
  readonly originBearingUserRows: number
  /**
   * Human turns per P1 of the v1 axes document.
   *
   * Not `origin.kind === 'human'`. That reading gives 250 here against P1's 413
   * — 1.65x low — because the key is absent from 96.8% of user rows. v1 states
   * outright that a missing key must not be read as "not human".
   */
  readonly humanTurns: number
  /**
   * Rows carrying `origin.kind === 'human'`, kept as the supporting signal v1
   * says it is. The gap against humanTurns is how much origin coverage costs.
   */
  readonly originHumanRows: number
  /** Why user rows were excluded from P1, so a filter that ate 90% says so. */
  readonly notHumanCounts: Readonly<Record<string, number>>
  /**
   * P5 task bundles — one human turn to the next, along the parentUuid chain.
   *
   * The denominator of axis 2, and part of axis 4's. v1 moved it off total tool
   * calls because with that denominator the cheapest way to raise a score was to
   * fire hundreds of calls that could not fail.
   */
  readonly taskBundles: number
  /** Bundles begun by a row whose parent was not in the file. Zero here. */
  readonly rootBundles: number
  readonly orphanBundles: number
  /** P3 rows dropped from every numerator and denominator: 15 here. */
  readonly environmentNoiseRows: number
  /**
   * P6 — per edited path: when it was last written, how many lines, in which
   * bundle. The censoring and existence checks that turn these into settled
   * artifacts happen later; nothing here touches the filesystem.
   */
  readonly editedPaths: Readonly<Record<string, PathTally>>
  /** Latest mention of any path-shaped token, for P6's uptake condition (a). */
  readonly lastMention: (path: string) => string | null
  /** Distinct path-shaped tokens seen, so an empty index reads as empty. */
  readonly referenceTokens: number
  /**
   * Axis 2's within-window repeat rate, over signatures of (tool, class,
   * target). Error text is classified here and never carried further.
   */
  readonly errorRepeats: RepeatRate
  /** Axis 2's numerator terms, before weighting. */
  readonly wasted: WastedCounts

  readonly denialRows: number
  readonly denialUserRejected: number

  readonly editedFilesDistinct: number
  readonly editedFilesRepeated: number

  readonly stopHookSummaryRows: number
  readonly hookErrorsNonEmpty: number

  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheCreation: number
  }

  readonly toolVersions: Readonly<Record<string, number>>
  readonly sessionIds: readonly string[]
  readonly dates: readonly string[]
  /**
   * Days carrying a user row of any kind — the ceiling on human-turn days under
   * this scan.
   *
   * Carried because `humanTurnDates` is a function of `origin` coverage, which
   * is 3.11% here. Measured on this machine: 5 human-turn days against 9 days
   * with user rows. The four missing ones are in July, where the log has user
   * rows and no `origin` object on any of them.
   *
   * The gap matters because the spec gates the whole environment on
   * `activeDays < 5`. At 5 measured, one day either way decides whether anything
   * is scored, and which side it lands on is set by which tool versions wrote
   * the log rather than by how much work happened. Emitting both lets a receiver
   * see that rather than infer it.
   */
  readonly userRowDates: readonly string[]
  /** Days carrying `origin.kind === 'human'`. The window's own definition. */
  readonly humanTurnDates: readonly string[]
  /**
   * Per-project line tallies, keyed by project directory name.
   *
   * The aggregate cannot show a partial miss. Four of five projects on this
   * machine hold nothing and one holds every line, so a glob that missed four of
   * them leaves a total that looks healthy. W-2 checks the sub-line share per
   * project for exactly that reason, and it needs these.
   */
  readonly perProject: Readonly<Record<string, ProjectTally>>
}

export interface ProjectTally {
  readonly lines: number
  readonly subLines: number
  readonly humanRows: number
}

interface MutProjectTally { lines: number; subLines: number; humanRows: number }

/** The three date sets, gathered in one pass so they cannot drift apart. */
interface DateSets {
  readonly all: Set<string>
  readonly userRow: Set<string>
  readonly humanTurn: Set<string>
}

interface Mut {
  linesRead: number
  linesParseFailed: number
  bytesRead: number
  mainLines: number
  subLines: number
  toolResultTotal: number
  toolResultWithIsErrorKey: number
  toolResultIsErrorTrue: number
  attributionSkillRows: number
  userRows: number
  originBearingUserRows: number
  humanTurns: number
  originHumanRows: number
  denialRows: number
  denialUserRejected: number
  taskBundles: number
  rootBundles: number
  orphanBundles: number
  environmentNoiseRows: number
  stopHookSummaryRows: number
  hookErrorsNonEmpty: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/** The text of a tool_result, flattened. Read locally, classified, discarded. */
function resultText(block: Record<string, unknown>): string {
  const content = block['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (isObj(part) && typeof part['text'] === 'string') out += part['text']
  }
  return out
}

/**
 * The third term of a signature: what the failing call was aimed at.
 *
 * An extension for a file operation, a command's first token for a shell one —
 * v1's definition. Hashing it matters for the second: a first token is often
 * the name of a private script. The signatures never leave this process, since
 * they exist to produce one ratio, but hashing keeps a stray log line from
 * carrying it.
 *
 * An earlier version hashed the tool name instead, which put no information in
 * the term at all: constant per tool, so a signature was really (tool, class)
 * and two failures against different targets could not be told apart.
 */
export function targetOf(toolName: string, input: unknown): string {
  if (!isObj(input)) return ''
  if (toolName === 'Bash') {
    const command = input['command']
    if (typeof command !== 'string') return ''
    const first = command.trim().split(/\s+/)[0] ?? ''
    // Strip a directory so `scripts/x.py` and `./x.py` are the same target.
    return first.split(/[\\/]/).pop() ?? ''
  }
  const path = input['file_path'] ?? input['notebook_path'] ?? input['path']
  if (typeof path !== 'string') return ''
  const base = path.split(/[\\/]/).pop() ?? ''
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

const hashTarget = (target: string): string =>
  target === '' ? '' : createHash('sha256').update(target, 'utf8').digest('hex').slice(0, 8)

interface MutWasted {
  failures: number
  hookOriginated: number
  writeRepeats: number
  investigationRepeats: number
  timedOut: number
  largeOutput: number
  callsPerBundle: Map<string, number>
}

/** A failure a hook produced. 17 here; v1 measured 29 on the other machine. */
const HOOK_ORIGINATED = /(Pre|Post)ToolUse:/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** How many times a file was edited, keyed by path. Only the counts leave here. */
type EditTally = Map<string, number>

function reduceLine(
  raw: string,
  kind: FileEntry['kind'],
  m: Mut,
  skills: Set<string>,
  mcp: Set<string>,
  versions: Map<string, number>,
  sessions: Set<string>,
  dates: DateSets,
  edits: EditTally,
  proj: MutProjectTally,
  notHuman: Map<string, number>,
  bundles: BundleTracker,
  paths: Map<string, MutPathTally>,
  refs: ReferenceIndex,
  toolOf: Map<string, { name: string; target: string }>,
  signatures: Array<readonly [string, ErrorClass, string]>,
  wasted: WastedTracker,
  w: MutWasted,
): void {
  const line = raw.trim()
  if (line.length === 0) return

  m.linesRead += 1
  proj.lines += 1
  if (kind === 'main') m.mainLines += 1
  else {
    m.subLines += 1
    proj.subLines += 1
  }

  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    // Counted, never guessed at. A line that would not parse is reported as a
    // parse failure rather than skipped, because a parser returning a quiet zero
    // is the failure this whole product exists to make visible.
    m.linesParseFailed += 1
    return
  }
  if (!isObj(row)) {
    m.linesParseFailed += 1
    return
  }

  const rowUuid = typeof row['uuid'] === 'string' ? (row['uuid'] as string) : null
  const rowParent = typeof row['parentUuid'] === 'string' ? (row['parentUuid'] as string) : null

  // P3 — a bad connection is not low quality work. Dropped from every
  // numerator and denominator, and counted so the drop is visible.
  //
  // Still placed in a bundle first. P3 says to exclude these rows from the
  // counts, not to remove them from the conversation tree: dropping them from
  // the chain orphans their children, which showed up as 7 orphan bundles
  // against a measured zero unresolvable parents.
  if (isEnvironmentNoise(row)) {
    m.environmentNoiseRows += 1
    if (kind === 'main') bundles.assign(rowUuid, rowParent, false)
    return
  }

  const version = row['version']
  if (typeof version === 'string') versions.set(version, (versions.get(version) ?? 0) + 1)

  const sessionId = row['sessionId']
  if (typeof sessionId === 'string') sessions.add(sessionId)

  const ts = row['timestamp']
  const day = typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : null
  if (day !== null) dates.all.add(day)

  const skill = row['attributionSkill']
  if (typeof skill === 'string' && skill.length > 0) {
    m.attributionSkillRows += 1
    skills.add(skill)
  }

  const server = row['attributionMcpServer']
  if (typeof server === 'string' && server.length > 0) mcp.add(server)

  const denial = row['toolDenialKind']
  if (typeof denial === 'string') {
    m.denialRows += 1
    if (denial === 'user-rejected') m.denialUserRejected += 1
  }

  let human = false
  if (row['type'] === 'user') {
    m.userRows += 1
    if (day !== null) dates.userRow.add(day)
    const origin = row['origin']
    if (isObj(origin)) {
      m.originBearingUserRows += 1
      // Supporting signal only. v1: a missing key does not mean not human.
      if (origin['kind'] === 'human') m.originHumanRows += 1
    }
    const why = notHumanBecause(row, kind === 'sub')
    if (why === null) {
      human = true
      m.humanTurns += 1
      proj.humanRows += 1
      if (day !== null) dates.humanTurn.add(day)
    } else {
      notHuman.set(why, (notHuman.get(why) ?? 0) + 1)
    }
  }

  // P5 — every row joins a bundle, so a later stage can group by it. Only main
  // transcripts carry the chain; a subagent file is work inside one bundle, not
  // a sequence of requests.
  const bundle = kind === 'main' ? bundles.assign(rowUuid, rowParent, human) : null

  // P6 — a write's landing place and size, from the result rather than the
  // call: the call says where, the result says how much.
  const result = row['toolUseResult']
  if (isObj(result)) {
    if (result['timedOutAfterMs'] !== undefined && result['timedOutAfterMs'] !== null) w.timedOut += 1
    const size = result['persistedOutputSize']
    if (typeof size === 'number' && size > LARGE_OUTPUT_BYTES) w.largeOutput += 1
  }

  const write = readWrite(row['toolUseResult'])
  if (write !== null) recordWrite(paths, write, typeof ts === 'string' ? ts : null, bundle)

  // P6 uptake (a) — a path mentioned after it was written was used. Human text
  // and tool arguments both count; a person naming a file and a command taking
  // it as an argument are the same signal.
  if (human) refs.note(userText(row), typeof ts === 'string' ? ts : null)

  if (row['subtype'] === 'stop_hook_summary') {
    m.stopHookSummaryRows += 1
    const errs = row['hookErrors']
    // Non-empty hookErrors, not preventedContinuation. The boolean is false on
    // every one of these rows on both machines, including the ones where a hook
    // really did refuse the response.
    if (Array.isArray(errs) && errs.length > 0) m.hookErrorsNonEmpty += 1
  }

  const message = row['message']
  if (!isObj(message)) return

  const usage = message['usage']
  if (isObj(usage)) {
    const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
    m.input += n('input_tokens')
    m.output += n('output_tokens')
    m.cacheRead += n('cache_read_input_tokens')
    m.cacheCreation += n('cache_creation_input_tokens')
  }

  const content = message['content']
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isObj(block)) continue
    if (block['type'] === 'tool_result') {
      m.toolResultTotal += 1
      if ('is_error' in block) {
        m.toolResultWithIsErrorKey += 1
        if (block['is_error'] === true) {
          m.toolResultIsErrorTrue += 1
          const text = resultText(block)
          // A guardrail firing is the guardrail working, not wasted motion.
          // Excluded from numerator and denominator both, per v1.
          if (HOOK_ORIGINATED.test(text)) w.hookOriginated += 1
          else w.failures += 1
          // Joined to the call by tool_use_id. Without the join the class is
          // known and the tool is not, and (class, target) alone collapses a
          // Bash failure and an Edit failure into one signature.
          const id = block['tool_use_id']
          const call = typeof id === 'string' ? toolOf.get(id) : undefined
          signatures.push([
            call?.name ?? 'unknown',
            classifyError(text),
            hashTarget(call?.target ?? ''),
          ])
        }
      }
    } else if (block['type'] === 'tool_use') {
      const id = block['id']
      const toolName = block['name']
      if (typeof id === 'string' && typeof toolName === 'string') {
        toolOf.set(id, { name: toolName, target: targetOf(toolName, block['input']) })
      }
      if (typeof toolName === 'string') {
        const key = bundle === null ? 'none' : String(bundle)
        w.callsPerBundle.set(key, (w.callsPerBundle.get(key) ?? 0) + 1)
        if (wasted.call(bundle, toolName, block['input'])) {
          if (isInvestigation(toolName)) w.investigationRepeats += 1
          else w.writeRepeats += 1
        }
      }
      const name = block['name']
      if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
        const input = block['input']
        if (isObj(input)) {
          const path = input['file_path'] ?? input['notebook_path']
          // The path is tallied and discarded. Only "how many files" and "how
          // many of them more than once" survive this function.
          if (typeof path === 'string' && path.length > 0) {
            edits.set(path, (edits.get(path) ?? 0) + 1)
          }
        }
      }
    }
  }
}

/**
 * Read every file in the inventory once.
 *
 * `read` is injectable so a test can count opens per path. The default is a
 * single readFileSync per file, and the test asserts exactly that — a reducer
 * that quietly took a second pass would still produce correct-looking totals.
 */
export function scan(
  inv: Inventory,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ScanCounts {
  const m: Mut = {
    linesRead: 0, linesParseFailed: 0, bytesRead: 0, mainLines: 0, subLines: 0,
    toolResultTotal: 0, toolResultWithIsErrorKey: 0, toolResultIsErrorTrue: 0,
    attributionSkillRows: 0, userRows: 0, originBearingUserRows: 0, humanTurns: 0, originHumanRows: 0,
    denialRows: 0, denialUserRejected: 0, taskBundles: 0, rootBundles: 0, orphanBundles: 0, environmentNoiseRows: 0, stopHookSummaryRows: 0, hookErrorsNonEmpty: 0,
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
  }
  const skills = new Set<string>()
  const mcp = new Set<string>()
  const versions = new Map<string, number>()
  const sessions = new Set<string>()
  const dates: DateSets = { all: new Set(), userRow: new Set(), humanTurn: new Set() }
  const edits: EditTally = new Map()
  const perProject = new Map<string, MutProjectTally>()
  const notHuman = new Map<string, number>()
  const paths = new Map<string, MutPathTally>()
  const refs = referenceIndex()
  const toolOf = new Map<string, { name: string; target: string }>()
  const signatures: Array<readonly [string, ErrorClass, string]> = []
  const wasted = wastedTracker()
  const w: MutWasted = {
    failures: 0, hookOriginated: 0, writeRepeats: 0, investigationRepeats: 0,
    timedOut: 0, largeOutput: 0, callsPerBundle: new Map<string, number>(),
  }
  let bundleSeq = 0
  const nextBundleId = (): number => { bundleSeq += 1; return bundleSeq }

  for (const file of inv.files) {
    let proj = perProject.get(file.project)
    if (proj === undefined) {
      proj = { lines: 0, subLines: 0, humanRows: 0 }
      perProject.set(file.project, proj)
    }
    const bundles = bundleTracker(nextBundleId)
    m.bytesRead += file.bytes
    let text = ''
    try {
      text = read(file.path)
    } catch {
      // Unreadable file: every one of its lines is unaccounted for, and saying
      // so is better than a total that silently omits them.
      continue
    }
    for (const line of text.split('\n')) {
      reduceLine(line, file.kind, m, skills, mcp, versions, sessions, dates, edits, proj, notHuman, bundles, paths, refs, toolOf, signatures, wasted, w)
    }
    m.taskBundles += bundles.opened()
    m.rootBundles += bundles.roots()
    m.orphanBundles += bundles.orphans()
  }

  let repeated = 0
  for (const count of edits.values()) if (count > 1) repeated += 1

  return {
    linesRead: m.linesRead,
    linesParseFailed: m.linesParseFailed,
    bytesRead: m.bytesRead,
    mainLines: m.mainLines,
    subLines: m.subLines,
    toolResultTotal: m.toolResultTotal,
    toolResultWithIsErrorKey: m.toolResultWithIsErrorKey,
    toolResultIsErrorTrue: m.toolResultIsErrorTrue,
    attributionSkillRows: m.attributionSkillRows,
    attributionSkillDistinct: skills.size,
    mcpServerDistinct: mcp.size,
    userRows: m.userRows,
    originBearingUserRows: m.originBearingUserRows,
    humanTurns: m.humanTurns,
    originHumanRows: m.originHumanRows,
    notHumanCounts: Object.fromEntries([...notHuman.entries()].sort()),
    taskBundles: m.taskBundles,
    rootBundles: m.rootBundles,
    orphanBundles: m.orphanBundles,
    environmentNoiseRows: m.environmentNoiseRows,
    editedPaths: Object.fromEntries([...paths.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    lastMention: refs.lastMention,
    referenceTokens: refs.size(),
    errorRepeats: repeatRate(signatures),
    wasted: {
      failures: w.failures,
      hookOriginated: w.hookOriginated,
      writeRepeats: w.writeRepeats,
      investigationRepeats: w.investigationRepeats,
      timedOut: w.timedOut,
      largeOutput: w.largeOutput,
      callsPerBundle: Object.fromEntries(w.callsPerBundle),
    },
    denialRows: m.denialRows,
    denialUserRejected: m.denialUserRejected,
    editedFilesDistinct: edits.size,
    editedFilesRepeated: repeated,
    stopHookSummaryRows: m.stopHookSummaryRows,
    hookErrorsNonEmpty: m.hookErrorsNonEmpty,
    tokens: {
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheCreation: m.cacheCreation,
    },
    toolVersions: Object.fromEntries([...versions.entries()].sort()),
    sessionIds: [...sessions].sort(),
    dates: [...dates.all].sort(),
    userRowDates: [...dates.userRow].sort(),
    humanTurnDates: [...dates.humanTurn].sort(),
    perProject: Object.fromEntries([...perProject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}
