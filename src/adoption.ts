/**
 * Skill + subagent adoption metrics — deterministic.
 *
 * Reports three things:
 *   1. skill penetration — % of sessions that invoked any skill
 *   2. per-skill invocation frequency
 *   3. subagent (Task/Agent) spawn frequency
 *
 * CRITICAL undercount fix: the trace-level `Skill` tool-use count only sees
 * skills a session invoked *interactively*. Skills dispatched inside an
 * automation loop (e.g. `/evolve`, `/converge`) are logged to
 * `.evolve/skill-runs.jsonl` under the session's cwd and never surface as a
 * `Skill` tool span — historically ~370× more runs than the trace count. So we
 * read those files too and report "explicit invocations" and "loop-dispatched
 * runs" SEPARATELY, so neither silently reads as zero.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OtlpSpan } from './otlp.js'

export interface AdoptionReport {
  sessionCount: number
  /** Sessions that invoked ≥1 skill (explicitly, via the Skill tool). */
  sessionsWithSkill: number
  /** sessionsWithSkill / sessionCount (0 when no sessions). */
  skillPenetration: number
  /** Explicit `Skill` tool invocations per skill name, corpus-wide. */
  skillInvocations: Record<string, number>
  /** Total explicit `Skill` tool invocations. */
  totalSkillInvocations: number
  /** Subagent spawns per subagent type (from Task/Agent tool spans). */
  subagentSpawns: Record<string, number>
  /** Total subagent spawns. */
  totalSubagentSpawns: number
  /** Sessions that spawned ≥1 subagent. */
  sessionsWithSubagent: number
  /** Loop-dispatched skill runs per skill, read from `.evolve/skill-runs.jsonl`
   *  (NOT visible at trace level — counted separately to avoid silent zeros). */
  loopDispatchedRuns: Record<string, number>
  /** Total loop-dispatched skill runs. */
  totalLoopDispatchedRuns: number
  /** `.evolve/skill-runs.jsonl` files that were read. */
  skillRunFilesRead: number
}

/** A tool span the OTLP emitter wrote as `tool.<Name>`. */
function toolName(s: OtlpSpan): string | null {
  const n = s.attributes['tool.name']
  if (typeof n === 'string') return n
  if (s.name.startsWith('tool.')) return s.name.slice('tool.'.length)
  return null
}

function parseInput(s: OtlpSpan): Record<string, unknown> {
  const c = s.attributes['input.value'] ?? s.attributes.content
  if (typeof c !== 'string') return {}
  try {
    const v = JSON.parse(c)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Skill name from a `Skill` tool input — `skill` or `command` (matches both
 *  the Skill tool schema and extract.py's fallback). */
function skillNameOf(input: Record<string, unknown>): string {
  const v = input.skill ?? input.command
  return typeof v === 'string' && v.length > 0 ? v : '?'
}

/** Subagent type from a Task/Agent or provider-specific spawn tool input. */
function subagentTypeOf(input: Record<string, unknown>): string {
  const v = input.subagent_type ?? input.agent_type ?? input.type ?? input.name
  return typeof v === 'string' && v.length > 0 ? v : '?'
}

function isSpawnAgentTool(name: string): boolean {
  return name === 'spawn_agent' || name.endsWith('__spawn_agent')
}

/**
 * Count loop-dispatched skill runs from a `.evolve/skill-runs.jsonl` file's raw
 * contents. Each line records one or more skills under `skills` (array) or
 * `skill` (string) — the schema varies across producers, so accept both.
 */
export function countSkillRunsJsonl(raw: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let o: unknown
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, unknown>
    const names: string[] = []
    if (Array.isArray(rec.skills)) {
      for (const s of rec.skills) if (typeof s === 'string' && s) names.push(s)
    }
    if (typeof rec.skill === 'string' && rec.skill) names.push(rec.skill)
    if (names.length === 0) names.push('?')
    for (const n of names) out[n] = (out[n] ?? 0) + 1
  }
  return out
}

/** Read + count loop-dispatched runs from the `.evolve/skill-runs.jsonl` under
 *  each given cwd. Missing files are skipped (most sessions have none). */
async function readLoopRuns(cwds: Iterable<string>): Promise<{ counts: Record<string, number>; filesRead: number }> {
  const counts: Record<string, number> = {}
  let filesRead = 0
  const seen = new Set<string>()
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue
    seen.add(cwd)
    const path = join(cwd, '.evolve', 'skill-runs.jsonl')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    filesRead += 1
    for (const [k, v] of Object.entries(countSkillRunsJsonl(raw))) counts[k] = (counts[k] ?? 0) + v
  }
  return { counts, filesRead }
}

export interface AdoptionOptions {
  /** Session cwds to probe for `.evolve/skill-runs.jsonl`. The CLI passes the
   *  cwds of the analyzed sessions. */
  cwds?: readonly string[]
}

export async function analyzeAdoption(spans: readonly OtlpSpan[], opts: AdoptionOptions = {}): Promise<AdoptionReport> {
  const sessions = new Set<string>()
  const sessionsWithSkill = new Set<string>()
  const sessionsWithSubagent = new Set<string>()
  const skillInvocations: Record<string, number> = {}
  const subagentSpawns: Record<string, number> = {}
  const canonicalSubagentSessions = new Set<string>()
  const fallbackSubagents = new Map<string, string[]>()

  for (const s of spans) {
    sessions.add(s.trace_id)
    const tn = toolName(s)
    if (tn === 'Skill') {
      const name = skillNameOf(parseInput(s))
      skillInvocations[name] = (skillInvocations[name] ?? 0) + 1
      sessionsWithSkill.add(s.trace_id)
    } else if (tn === 'Task' || tn === 'Agent') {
      const type = subagentTypeOf(parseInput(s))
      subagentSpawns[type] = (subagentSpawns[type] ?? 0) + 1
      sessionsWithSubagent.add(s.trace_id)
      canonicalSubagentSessions.add(s.trace_id)
    } else if (tn && isSpawnAgentTool(tn)) {
      const types = fallbackSubagents.get(s.trace_id) ?? []
      types.push(subagentTypeOf(parseInput(s)))
      fallbackSubagents.set(s.trace_id, types)
    }
  }

  for (const [traceId, types] of fallbackSubagents) {
    if (canonicalSubagentSessions.has(traceId)) continue
    sessionsWithSubagent.add(traceId)
    for (const type of types) {
      subagentSpawns[type] = (subagentSpawns[type] ?? 0) + 1
    }
  }

  const { counts: loopDispatchedRuns, filesRead } = await readLoopRuns(opts.cwds ?? [])

  const totalSkillInvocations = Object.values(skillInvocations).reduce((a, b) => a + b, 0)
  const totalSubagentSpawns = Object.values(subagentSpawns).reduce((a, b) => a + b, 0)
  const totalLoopDispatchedRuns = Object.values(loopDispatchedRuns).reduce((a, b) => a + b, 0)

  return {
    sessionCount: sessions.size,
    sessionsWithSkill: sessionsWithSkill.size,
    skillPenetration: sessions.size === 0 ? 0 : sessionsWithSkill.size / sessions.size,
    skillInvocations,
    totalSkillInvocations,
    subagentSpawns,
    totalSubagentSpawns,
    sessionsWithSubagent: sessionsWithSubagent.size,
    loopDispatchedRuns,
    totalLoopDispatchedRuns,
    skillRunFilesRead: filesRead,
  }
}
