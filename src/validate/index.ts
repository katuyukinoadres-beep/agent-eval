/**
 * Runs the rejection rules over an untrusted payload.
 *
 * Every check walks the value it was given rather than a typed view of it. The
 * payload arrives as parsed JSON from a machine this code did not build, so the
 * types in ../payload describe what we emit, not what we receive.
 */

import {
  ACTIVE_DAYS_METHOD,
  BOOLEAN_ZERO_DENOMINATOR_FLOOR,
  FLAG_REASONS,
  KNOWN_DAY_SOURCES,
  ORIGIN_COVERAGE_FLOOR,
  PARSE_FAILURE_CEILING,
  REQUIRED_MANIFEST_FIELDS,
  RULE_REASONS,
  TOOL_VERSION_CEILING,
  VALID_AVAILABILITY,
  type FlagId,
  type RuleId,
} from './rules.js'

export interface Violation {
  readonly rule: RuleId
  readonly path: string
  readonly detail: string
}

export interface Flag {
  readonly flag: FlagId
  readonly path: string
  readonly detail: string
}

export interface Verdict {
  readonly ok: boolean
  readonly violations: readonly Violation[]
  /**
   * Accepted but marked. A flagged payload still enters the population; the
   * receiver decides whether to leave it out of a given statistic. Refusing
   * these would lose submissions over readings that are merely suspect.
   */
  readonly flags: readonly Flag[]
  /** 422 when anything was refused. The payload does not enter the population. */
  readonly status: 200 | 422
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** `"15/18"` — the other form a rate arrives in, and the one V-5 used to miss. */
const RATE_STRING = /^\s*(\d+)\s*\/\s*(\d+)\s*$/

function walk(value: unknown, path: string, visit: (v: unknown, path: string) => void): void {
  visit(value, path)
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, visit))
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) walk(v, path === '' ? k : `${path}.${k}`, visit)
  }
}

export function validate(payload: unknown): Verdict {
  const out: Violation[] = []
  const flags: Flag[] = []
  const add = (rule: RuleId, path: string, detail: string): void => {
    out.push({ rule, path, detail })
  }
  const flag = (id: FlagId, path: string, detail: string): void => {
    flags.push({ flag: id, path, detail })
  }

  if (!isObj(payload)) {
    add('V-1', '', `payload is ${payload === null ? 'null' : typeof payload}, not an object`)
    return { ok: false, violations: out, flags, status: 422 }
  }

  // Read once, before the manifest block, because W-2 evaluates the sub-line
  // share per project as well as in aggregate.
  const env = payload['environment']

  // ── V-1 / V-2: the manifest ────────────────────────────────────────────────
  const manifest = payload['scanManifest']
  if (!isObj(manifest)) {
    add('V-1', 'scanManifest', RULE_REASONS['V-1'])
  } else {
    for (const f of REQUIRED_MANIFEST_FIELDS) {
      if (!(f in manifest) || manifest[f] === undefined) {
        add('V-2', `scanManifest.${f}`, `required field missing`)
      }
    }

    // ── V-9: the lines have to account for themselves ────────────────────────
    const { mainLines, subLines, linesRead, mainFiles, subFiles, filesRead } = manifest
    if (isNum(mainLines) && isNum(subLines) && isNum(linesRead) && mainLines + subLines !== linesRead) {
      add('V-9', 'scanManifest.linesRead', `${mainLines} + ${subLines} = ${mainLines + subLines}, not ${linesRead}`)
    }
    if (isNum(mainFiles) && isNum(subFiles) && isNum(filesRead) && mainFiles + subFiles !== filesRead) {
      add('V-9', 'scanManifest.filesRead', `${mainFiles} + ${subFiles} = ${mainFiles + subFiles}, not ${filesRead}`)
    }

    // ── V-11: activeDays may only union sources we can reason about ──────────
    const window = manifest['window']
    if (isObj(window)) {
      const method = window['activeDaysMethod']
      if (typeof method !== 'string') {
        add('V-11', 'scanManifest.window.activeDaysMethod', 'missing or not a string')
      } else {
        const m = ACTIVE_DAYS_METHOD.exec(method)
        if (m === null) {
          add('V-11', 'scanManifest.window.activeDaysMethod', `not a union of observed sources: ${method}`)
        } else {
          const named = (m[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          const unknown = named.filter((s) => !(KNOWN_DAY_SOURCES as readonly string[]).includes(s))
          if (unknown.length > 0) {
            add('V-11', 'scanManifest.window.activeDaysMethod', `unknown day source(s): ${unknown.join(', ')}`)
          }
        }
      }
    }

    // ── W-1: origin coverage ─────────────────────────────────────────────────
    const cov = manifest['originFieldCoverage']
    if (isObj(cov) && isNum(cov['numerator']) && isNum(cov['denominator']) && cov['denominator'] > 0) {
      const ratio = cov['numerator'] / cov['denominator']
      if (ratio < ORIGIN_COVERAGE_FLOOR) {
        flag('W-1', 'scanManifest.originFieldCoverage', `${(ratio * 100).toFixed(1)}% — ${FLAG_REASONS['W-1']}`)
      }
    }

    // ── W-3: version spread ──────────────────────────────────────────────────
    const distinct = manifest['toolVersionDistinct']
    if (isNum(distinct) && distinct > TOOL_VERSION_CEILING) {
      flag('W-3', 'scanManifest.toolVersionDistinct', `${distinct} versions — ${FLAG_REASONS['W-3']}`)
    }

    // ── W-5: parse failures ──────────────────────────────────────────────────
    const failed = manifest['linesParseFailed']
    const read = manifest['linesRead']
    if (isNum(failed) && isNum(read) && read > 0 && failed / read > PARSE_FAILURE_CEILING) {
      flag('W-5', 'scanManifest.linesParseFailed', `${failed}/${read} — ${FLAG_REASONS['W-5']}`)
    }

    // ── W-2: a sub-line share sitting at an edge it cannot legitimately reach ──
    //
    // Both edges, not just zero. A glob levelled one directory too deep matches
    // no main files at all, which pins the ratio at 1 and leaves a rule that
    // only watches for 0 silent.
    //
    // And per project, not only in aggregate. On this machine four of five
    // projects hold no lines while one holds them all; an aggregate ratio of
    // 0.42 looks healthy while four projects were missed entirely. The failure
    // this whole rule exists to catch is a partial miss.
    const scope = manifest['scope']
    const edgeIsImpossible = (ratio: number): boolean =>
      (scope === 'all' && (ratio === 0 || ratio === 1)) ||
      (scope === 'sub' && ratio === 0) ||
      (scope === 'main' && ratio === 1)

    const ratio = manifest['subLineRatio']
    if (isNum(ratio) && isNum(read) && read > 0 && edgeIsImpossible(ratio)) {
      flag('W-2', 'scanManifest.subLineRatio', `${ratio} under scope "${String(scope)}" — ${FLAG_REASONS['W-2']}`)
    }

    if (isObj(env) && Array.isArray(env['projects'])) {
      for (const [i, p] of (env['projects'] as unknown[]).entries()) {
        if (!isObj(p)) continue
        const lines = p['lines']
        const r = p['subLineRatio']
        // Skip a project with no lines: 0/0 is not an edge, it is an absence,
        // and there are four of them here.
        if (!isNum(lines) || lines === 0 || !isNum(r)) continue
        if (edgeIsImpossible(r)) {
          flag('W-2', `environment.projects[${i}].subLineRatio`, `${r} under scope "${String(scope)}" — ${FLAG_REASONS['W-2']}`)
        }
      }
    }
  }

  // ── V-3 / V-4 / V-5: every rate, wherever it sits ──────────────────────────
  // Walked over the whole payload rather than over a list of known rate paths.
  // recordRateCalendar was outside the original rule's reach, and a rule that
  // only guards the fields someone remembered is the same failure again.
  walk(payload, '', (v, path) => {
    if (isObj(v)) {
      const hasNum = 'numerator' in v
      const hasDen = 'denominator' in v
      if (hasNum && hasDen) {
        const n = v['numerator']
        const d = v['denominator']
        if (isNum(n) && isNum(d) && n > d) {
          add('V-5', path, `${n} / ${d} exceeds 1`)
        }
        // W-7. A zero denominator is not malformed — V-4 sees both parts
        // present, and W-6 only looks above a hundred — so it ships as a hole.
        // The spec's own glob for skillFired matches nothing on this machine.
        if (isNum(d) && d === 0) {
          flag('W-7', path, FLAG_REASONS['W-7'])
        }
        // W-6. Rides on booleanDerived from the type rather than a list here,
        // because a list drifts and the metric that falls off it is the one
        // that then reports a silent zero.
        if (v['booleanDerived'] === true && isNum(n) && isNum(d) && n === 0 && d > BOOLEAN_ZERO_DENOMINATOR_FLOOR) {
          flag('W-6', path, `0 / ${d} — ${FLAG_REASONS['W-6']}`)
        }
        if (!('denominatorMeaning' in v) && !('meaning' in v)) {
          add('V-3', path, RULE_REASONS['V-3'])
        }
      } else if (hasNum !== hasDen) {
        add('V-4', path, `has ${hasNum ? 'numerator' : 'denominator'} without the other`)
      }

      // A bare `rate` or `ratio` with no parts to recompute from.
      for (const key of ['rate', 'ratio', 'percentage', 'percent']) {
        if (key in v && !hasNum && !hasDen) {
          add('V-4', `${path}.${key}`, RULE_REASONS['V-4'])
        }
      }
    }

    if (typeof v === 'string') {
      const m = RATE_STRING.exec(v)
      if (m !== null) {
        const n = Number(m[1])
        const d = Number(m[2])
        if (n > d) add('V-5', path, `"${v}" exceeds 1`)
      }
    }
  })

  // ── V-6: the project list is the whole machine ─────────────────────────────
  if (isObj(env)) {
    const projects = env['projects']
    const count = env['projectCount']
    if (Array.isArray(projects) && isNum(count) && projects.length !== count) {
      add('V-6', 'environment.projects', `${projects.length} listed against projectCount ${count}`)
    }
  }

  // ── V-7 / V-10: the axes ───────────────────────────────────────────────────
  const axes = payload['axes']
  const linesRead = isObj(manifest) ? manifest['linesRead'] : undefined
  if (isObj(axes)) {
    for (const [name, axis] of Object.entries(axes)) {
      if (!isObj(axis)) continue

      const a = axis['availability']
      if (typeof a !== 'string' || !(VALID_AVAILABILITY as readonly string[]).includes(a)) {
        add('V-7', `axes.${name}.availability`, `${JSON.stringify(a)} is not one of ${VALID_AVAILABILITY.join(' | ')}`)
      }

      const s = axis['lineStates']
      if (isObj(s) && isNum(linesRead)) {
        const parts = ['available', 'not_applicable', 'parse_failed'].map((k) => s[k])
        if (parts.every(isNum)) {
          const total = parts.reduce((x, y) => x + y, 0)
          if (total !== linesRead) {
            add('V-10', `axes.${name}.lineStates`, `states total ${total}, linesRead is ${linesRead}`)
          }
        }
      }
    }
  }

  return {
    ok: out.length === 0,
    violations: out,
    flags,
    status: out.length === 0 ? 200 : 422,
  }
}
