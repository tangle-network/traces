/**
 * The third-party pi-dynamic-workflows extension's PersistedRunState.
 * Its run JSON is not a Pi native session: children may exist only in its
 * compact history. Preserve those limits rather than manufacture native IDs,
 * phase clocks, provider calls or usage from the extension's scalar estimate.
 */
import { readFile } from 'node:fs/promises'
import { contractSpan, deriveHexId } from '@tangle-network/agent-trace-contract'
import {
  SOURCE_MISSING_CHANNELS_ATTR,
  SESSION_TOTAL_CACHE_WRITE_ATTR,
  SESSION_TOTAL_CACHED_INPUT_ATTR,
  SESSION_TOTAL_INPUT_ATTR,
  SESSION_TOTAL_OUTPUT_ATTR,
  SESSION_TOTAL_TOKENS_ATTR,
} from '../attributes.js'
import type { OtlpSpan } from '../otlp.js'
import { otlpRowToSpan, SUBSTITUTED_FIELDS_ATTR } from '../otlp-input.js'
import { validateOtlpSpans } from '../span-validation.js'
import { SUBAGENT_SPAN_ATTR } from './provenance.js'

type RecordValue = Record<string, unknown>

export interface PiWorkflowRunInput {
  readonly spans: OtlpSpan[]
  readonly unknowns: readonly string[]
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Recognize the extension's persisted run, not an arbitrary JSON object. */
export function isPiWorkflowRun(value: unknown): value is RecordValue {
  return record(value)
    && text(value.runId) !== undefined
    && text(value.workflowName) !== undefined
    && Array.isArray(value.phases)
    && Array.isArray(value.agents)
    && text(value.status) !== undefined
}

function instant(value: unknown): string | undefined {
  // Persisted run/agent instants are ISO; history entries use epoch millis.
  const ms = typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? Date.parse(value) : NaN
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime())
    ? new Date(ms).toISOString() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function status(value: unknown): 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' | 'STATUS_CODE_UNSET' {
  return value === 'completed' || value === 'done' ? 'STATUS_CODE_OK'
    : value === 'failed' || value === 'error' ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_UNSET'
}

function normalized(init: Parameters<typeof contractSpan>[0]): OtlpSpan {
  const converted = otlpRowToSpan(contractSpan(init), init.traceId)
  if (!converted.span) throw new Error('Pi workflow produced an invalid contract span')
  return converted.span
}

/** Only the provider-reported breakdown is usage; `agent.tokens` may be an estimate. */
function usageAttributes(value: unknown): RecordValue | undefined {
  if (!record(value)) return undefined
  const input = count(value.input)
  const output = count(value.output)
  const cacheRead = count(value.cacheRead)
  const cacheWrite = count(value.cacheWrite)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined
  const prompt = input + cacheRead + cacheWrite
  const total = prompt + output
  if (!Number.isSafeInteger(total) || (value.total !== undefined && count(value.total) !== total)) return undefined
  return {
    [SESSION_TOTAL_INPUT_ATTR]: prompt,
    [SESSION_TOTAL_OUTPUT_ATTR]: output,
    [SESSION_TOTAL_CACHED_INPUT_ATTR]: cacheRead,
    [SESSION_TOTAL_CACHE_WRITE_ATTR]: cacheWrite,
    [SESSION_TOTAL_TOKENS_ATTR]: total,
    'gen_ai.usage.input_tokens': input,
    'gen_ai.usage.output_tokens': output,
    'gen_ai.usage.cache_read.input_tokens': cacheRead,
    'gen_ai.usage.cache_creation.input_tokens': cacheWrite,
    ...(typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0
      ? { 'gen_ai.usage.cost_usd': value.cost } : {}),
  }
}

interface Missing {
  agents: number
  agentEnds: number
  usage: number
  toolTimes: number
  histories: number
}

function toolHistory(
  agent: RecordValue,
  traceId: string,
  parentSpanId: string,
  callIdentity: string,
  missing: Missing,
): OtlpSpan[] {
  if (!Array.isArray(agent.history)) {
    missing.histories += 1
    return []
  }
  const spans: OtlpSpan[] = []
  for (const [index, entry] of agent.history.entries()) {
    if (!record(entry) || entry.kind !== 'toolCall') continue
    const at = instant(entry.timestamp)
    const name = text(entry.toolName)
    if (!at || !name) {
      missing.toolTimes += 1
      continue
    }
    // Compact history has no call ID. Never pair a result by tool name/order,
    // or count a toolResult as another invocation. Its timestamp is a point.
    spans.push(normalized({
      traceId,
      spanId: deriveHexId(`${traceId}:${callIdentity}:history:${index}`, 8),
      parentSpanId,
      name: `tool.${name}`,
      kind: 'TOOL',
      startTime: at,
      status: { code: 'STATUS_CODE_UNSET' },
      attributes: {
        'gen_ai.tool.name': name,
        'agent.parent.confidence': 'explicit',
        [SUBAGENT_SPAN_ATTR]: true,
        'traces.pi.workflow.history_index': index,
        [SUBSTITUTED_FIELDS_ATTR]: 'end_time',
      },
    }))
  }
  return spans
}

function coverageReasons(run: RecordValue, phases: number, missing: Missing): string[] {
  const unknowns = [
    'Workflow phase names have no recorded phase start/end timestamps; no timed phase spans were invented.',
    'Agent history is compacted; observed tool calls do not establish complete tool coverage or call/result durations.',
    'Agent model names are requested configuration, not provider-served model evidence.',
    'Run aggregate usage may include estimates, replay or retry spend; only reported per-agent usage breakdowns are retained.',
  ]
  if (phases === 0) unknowns[0] = 'No workflow phases were recorded.'
  if (!instant(run.completedAt)) unknowns.push('Workflow completion time is unavailable; updatedAt is not an execution end time.')
  if (missing.agents) unknowns.push(`${missing.agents} agent records lack a valid identity or start/end interval and are unplaced.`)
  if (missing.agentEnds) unknowns.push(`${missing.agentEnds} agent records lack an end timestamp; their spans are point observations.`)
  if (missing.usage) unknowns.push(`${missing.usage} agent records lack a complete reported usage breakdown; scalar token estimates were not counted.`)
  if (missing.toolTimes) unknowns.push(`${missing.toolTimes} tool-call history entries lack a recorded tool name or timestamp and are unplaced.`)
  if (missing.histories) unknowns.push(`${missing.histories} agent records have no retained tool history.`)
  return unknowns
}

/** Read one extension run into the same contract spans every Traces input uses. */
export async function parsePiWorkflowRun(path: string): Promise<PiWorkflowRunInput> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('Pi workflow run JSON could not be read')
  }
  return normalizePiWorkflowRun(value)
}

/** The same projection for file refs and the existing text/row input boundary. */
export function normalizePiWorkflowRun(value: unknown): PiWorkflowRunInput {
  if (!isPiWorkflowRun(value)) throw new Error('Input is not a pi-dynamic-workflows persisted run')
  const runId = text(value.runId)!
  const startedAt = instant(value.startedAt)
  if (!startedAt) throw new Error('Pi workflow run has no recorded valid start timestamp')
  const completedAt = instant(value.completedAt)
  if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('Pi workflow completion precedes its recorded start')
  }
  const traceId = deriveHexId(`pi-dynamic-workflows:${runId}`, 16)
  const rootId = deriveHexId(`${traceId}:run`, 8)
  const phases = [...new Set((value.phases as unknown[]).filter((phase): phase is string => text(phase) !== undefined))]
  const root = normalized({
    traceId,
    spanId: rootId,
    name: 'pi.workflow',
    kind: 'AGENT',
    startTime: startedAt,
    ...(completedAt ? { endTime: completedAt } : {}),
    status: { code: status(value.status) },
    attributes: {
      'service.name': 'pi-dynamic-workflows',
      [SOURCE_MISSING_CHANNELS_ATTR]: JSON.stringify(['human-turns']),
      'tangle.harness': 'pi',
      'tangle.sessionId': runId,
      'traces.pi.workflow.run_id': runId,
      ...(text(value.sessionId) ? { 'traces.parent_session_id': value.sessionId } : {}),
      'traces.pi.workflow.phase_names': JSON.stringify(phases),
      ...(!completedAt ? { [SUBSTITUTED_FIELDS_ATTR]: 'end_time' } : {}),
    },
  })
  const spans: OtlpSpan[] = [root]
  const missing: Missing = { agents: 0, agentEnds: 0, usage: 0, toolTimes: 0, histories: 0 }
  const identities = new Set<string>()
  for (const input of value.agents as unknown[]) {
    if (!record(input)) {
      missing.agents += 1
      continue
    }
    const key = text(input.callId) ?? (count(input.id) !== undefined ? `agent:${String(input.id)}` : undefined)
    const start = instant(input.startedAt)
    const end = instant(input.endedAt)
    if (!key || !start || (end && Date.parse(end) < Date.parse(start))) {
      missing.agents += 1
      continue
    }
    if (identities.has(key)) throw new Error('Pi workflow run contains duplicate agent call identity')
    identities.add(key)
    if (!end) missing.agentEnds += 1
    const usage = usageAttributes(input.tokenUsage)
    if (!usage) missing.usage += 1
    const agentId = deriveHexId(`${traceId}:${key}`, 8)
    spans.push(normalized({
      traceId,
      spanId: agentId,
      parentSpanId: rootId,
      name: 'pi.workflow.agent',
      kind: 'AGENT',
      startTime: start,
      ...(end ? { endTime: end } : {}),
      status: { code: status(input.status) },
      attributes: {
        'service.name': 'pi-dynamic-workflows',
      [SOURCE_MISSING_CHANNELS_ATTR]: JSON.stringify(['human-turns']),
        'agent.name': key,
        'agent.parent.confidence': 'explicit',
        [SUBAGENT_SPAN_ATTR]: true,
        'traces.pi.workflow.call_id': key,
        ...(text(input.phase) ? { 'traces.pi.workflow.phase': input.phase } : {}),
        ...(text(input.model) ? { 'traces.pi.workflow.requested_model': input.model } : {}),
        ...(!end ? { [SUBSTITUTED_FIELDS_ATTR]: 'end_time' } : {}),
        ...(usage ?? {}),
      },
    }))
    spans.push(...toolHistory(input, traceId, agentId, key, missing))
  }
  const unknowns = coverageReasons(value, phases.length, missing)
  root.attributes['traces.source.unknowns'] = JSON.stringify(unknowns)
  return { spans: validateOtlpSpans(spans, 'Pi workflow'), unknowns }
}
