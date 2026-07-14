/**
 * Skill + subagent adoption metrics — deterministic.
 *
 * Reports three things:
 *   1. explicit skill invocation rate over sessions with dedicated telemetry
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
import { toolArgumentsFromAttributes } from './adapters/tool-io.js'
import {
  indexSessionIdsByTrace,
  type SessionIdentityConflict,
} from './attributes.js'
import type { OtlpSpan } from './otlp.js'

export interface AdoptionReport {
  /** Identified sessions plus traces that lack session identity. */
  executionGroupCount: number
  identifiedSessionCount: number
  unassignedTraceCount: number
  /** Traces omitted from session grouping because their source IDs disagree. */
  sessionIdentityConflicts: readonly SessionIdentityConflict[]
  /** Sessions that invoked ≥1 skill (explicitly, via the Skill tool). */
  sessionsWithSkill: number
  /** sessionsWithSkill / skillTelemetrySessions; null when invocation is not measurable. */
  skillPenetration: number | null
  /** Whether explicit Skill events can measure all, some, or none of the selected sessions. */
  skillTelemetryStatus: 'measured' | 'partial' | 'unsupported' | 'unknown'
  /** Sessions whose harness exposes a dedicated Skill event. */
  skillTelemetrySessions: number
  /** Sessions containing materialized skill instructions or a skill catalog. */
  sessionsWithMaterializedSkills: number
  /** Sessions with tool inputs that reference a SKILL.md path. */
  sessionsWithSkillFileReference: number
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
  const captured = toolArgumentsFromAttributes(s.attributes)
  if (!captured.argsCaptured) return {}
  if (captured.args && typeof captured.args === 'object') {
    return captured.args as Record<string, unknown>
  }
  if (typeof captured.args !== 'string') return {}
  try {
    const v = JSON.parse(captured.args)
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

type SkillTelemetryCapability = 'supported' | 'unsupported' | 'unknown'

function skillTelemetryCapability(service: unknown): SkillTelemetryCapability {
  if (service === 'claude-code') return 'supported'
  if (service === 'codex') return 'unsupported'
  return 'unknown'
}

const MATERIALIZED_SKILL_RE =
  /<skills_instructions>|(?:^|\n)#{1,3}\s+(?:available\s+)?skills\b|base directory for this skill:/i

function hasMaterializedSkillEvidence(s: OtlpSpan): boolean {
  if (s.name !== 'message.developer' && s.attributes['tangle.actor'] !== 'injected') return false
  const content = s.attributes.content
  return typeof content === 'string' && MATERIALIZED_SKILL_RE.test(content)
}

function hasSkillFileReference(s: OtlpSpan): boolean {
  if (s.attributes['openinference.span.kind'] !== 'TOOL') return false
  const input = s.attributes['input.value']
  return typeof input === 'string' && input.includes('SKILL.md')
}

function telemetryStatus(
  measured: number,
  unsupported: number,
  unknown: number,
): AdoptionReport['skillTelemetryStatus'] {
  if (measured > 0 && unsupported === 0 && unknown === 0) return 'measured'
  if (measured > 0) return 'partial'
  if (unsupported > 0 && unknown === 0) return 'unsupported'
  return 'unknown'
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
  const { sessionByTrace, conflicts } = indexSessionIdsByTrace(spans)
  const identifiedSessions = new Set(sessionByTrace.values())
  const unassignedTraceIds = new Set(
    spans.map((span) => span.trace_id).filter((traceId) => !sessionByTrace.has(traceId)),
  )
  const executionGroup = (span: OtlpSpan) =>
    sessionByTrace.get(span.trace_id) ?? `trace:${span.trace_id}`
  const sessions = new Set<string>()
  const sessionsWithSkill = new Set<string>()
  const sessionsWithSubagent = new Set<string>()
  const sessionsWithMaterializedSkills = new Set<string>()
  const sessionsWithSkillFileReference = new Set<string>()
  const skillInvocations: Record<string, number> = {}
  const subagentSpawns: Record<string, number> = {}
  const canonicalSubagentSessions = new Set<string>()
  const fallbackSubagents = new Map<string, string[]>()
  const sessionCapabilities = new Map<string, SkillTelemetryCapability>()

  for (const s of spans) {
    const group = executionGroup(s)
    sessions.add(group)
    const observedCapability = skillTelemetryCapability(s.attributes['service.name'])
    const currentCapability = sessionCapabilities.get(group) ?? 'unknown'
    if (observedCapability === 'supported' || currentCapability === 'unknown') {
      sessionCapabilities.set(group, observedCapability)
    }
    if (hasMaterializedSkillEvidence(s)) sessionsWithMaterializedSkills.add(group)
    if (hasSkillFileReference(s)) sessionsWithSkillFileReference.add(group)
    const tn = toolName(s)
    if (tn === 'Skill') {
      sessionCapabilities.set(group, 'supported')
      const name = skillNameOf(parseInput(s))
      skillInvocations[name] = (skillInvocations[name] ?? 0) + 1
      sessionsWithSkill.add(group)
    } else if (tn === 'Task' || tn === 'Agent') {
      const type = subagentTypeOf(parseInput(s))
      subagentSpawns[type] = (subagentSpawns[type] ?? 0) + 1
      sessionsWithSubagent.add(group)
      canonicalSubagentSessions.add(group)
    } else if (tn && isSpawnAgentTool(tn)) {
      const types = fallbackSubagents.get(group) ?? []
      types.push(subagentTypeOf(parseInput(s)))
      fallbackSubagents.set(group, types)
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
  let skillTelemetrySessions = 0
  let skillTelemetryUnsupportedSessions = 0
  let skillTelemetryUnknownSessions = 0
  for (const traceId of sessions) {
    const capability = sessionCapabilities.get(traceId) ?? 'unknown'
    if (capability === 'supported') skillTelemetrySessions += 1
    else if (capability === 'unsupported') skillTelemetryUnsupportedSessions += 1
    else skillTelemetryUnknownSessions += 1
  }

  return {
    executionGroupCount: sessions.size,
    identifiedSessionCount: identifiedSessions.size,
    unassignedTraceCount: unassignedTraceIds.size,
    sessionIdentityConflicts: conflicts,
    sessionsWithSkill: sessionsWithSkill.size,
    skillPenetration: skillTelemetrySessions === 0 ? null : sessionsWithSkill.size / skillTelemetrySessions,
    skillTelemetryStatus: telemetryStatus(
      skillTelemetrySessions,
      skillTelemetryUnsupportedSessions,
      skillTelemetryUnknownSessions,
    ),
    skillTelemetrySessions,
    sessionsWithMaterializedSkills: sessionsWithMaterializedSkills.size,
    sessionsWithSkillFileReference: sessionsWithSkillFileReference.size,
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
