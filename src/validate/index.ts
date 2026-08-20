/**
 * Runs the rejection rules over an untrusted payload.
 *
 * Every check walks the value it was given rather than a typed view of it. The
 * payload arrives as parsed JSON from a machine this code did not build, so the
 * types in ../payload describe what we emit, not what we receive.
 */

import {
  ACTIVE_DAYS_METHOD,
  KNOWN_DAY_SOURCES,
  REQUIRED_MANIFEST_FIELDS,
  RULE_REASONS,
  VALID_AVAILABILITY,
  type RuleId,
} from './rules.js'

export interface Violation {
  readonly rule: RuleId
  readonly path: string
  readonly detail: string
}

export interface Verdict {
  readonly ok: boolean
  readonly violations: readonly Violation[]
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
  const add = (rule: RuleId, path: string, detail: string): void => {
    out.push({ rule, path, detail })
  }

  if (!isObj(payload)) {
    add('V-1', '', `payload is ${payload === null ? 'null' : typeof payload}, not an object`)
    return { ok: false, violations: out, status: 422 }
  }

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
  const env = payload['environment']
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

  return { ok: out.length === 0, violations: out, status: out.length === 0 ? 200 : 422 }
}
