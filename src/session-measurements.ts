import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
import { computeAdoption, type AdoptionReport } from './adoption.js'
import { canonicalJson } from './adapters/tool-io.js'
import { INHERITED_SOURCE_ATTR } from './adapters/provenance.js'
import { summarizeSpanExecution } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import type { SessionFact } from './session-facts.js'
import { describeSessionRelationship, type SessionRelationship } from './session-relationship.js'

/** Coverage counts refer to observed records, never an assertion that capture was complete. */
export interface CoveredMeasurement {
  readonly total: number | null
  readonly measured: number
  readonly eligible: number
  readonly unavailable: string | null
}
export interface ToolMeasurement {
  readonly name: string
  readonly calls: number
  readonly outcomes: { readonly ok: number; readonly error: number; readonly unset: number }
  readonly inputBytes: CoveredMeasurement
  readonly outputBytes: CoveredMeasurement
  /** Recorded call-to-result interval. Not CPU time or model latency; overlaps may occur. */
  readonly callToResultMs: CoveredMeasurement
  readonly spanIds: readonly string[]
}
export interface CompactionMeasurement {
  readonly spanId: string
  readonly at: string
  readonly sincePreviousMs: number | null
  readonly latencyMs: number | null
  readonly tokensBefore: number | null
  readonly tokensAfter: number | null
}
export interface ContentFootprint {
  readonly spanId: string
  readonly field: string
  readonly bytes: number
  readonly lines: number
  readonly entries: number | null
  /** Source representation, not the reconstructed full model request. */
  readonly scope: 'captured-attribute'
}
export interface SessionMeasurements {
  readonly execution: ExecutionReport | null
  readonly adoption: AdoptionReport
  readonly relationship: SessionRelationship
  readonly tools: readonly ToolMeasurement[]
  readonly observedSpawns: number
  readonly spawnIntervalsMs: readonly { readonly spanId: string; readonly intervalMs: number | null }[]
  readonly compactions: SessionFact<readonly CompactionMeasurement[]>
  readonly contextFootprints: readonly ContentFootprint[]
  readonly coverage: {
    readonly profile: string
    readonly materializedResources: string
    readonly contextTokens: string
    readonly toolTokens: string
    readonly compaction: string
    readonly semanticAssessments: string
  }
}
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

function measure(spans: readonly OtlpSpan[], read: (span: OtlpSpan) => number | null, reason: string): CoveredMeasurement {
  let total = 0
  let measured = 0
  for (const span of spans) {
    const value = read(span)
    if (value !== null) { total += value; measured += 1 }
  }
  return {
    total: measured > 0 || spans.length === 0 ? total : null,
    measured,
    eligible: spans.length,
    unavailable: measured === spans.length ? null : reason,
  }
}
function bytes(span: OtlpSpan, side: 'input' | 'output'): number | null {
  const recorded = number(span.attributes[`traces.${side}.bytes`])
  if (recorded !== null) return recorded
  const text = span.attributes[`${side}.value`]
  if (typeof text !== 'string' || span.attributes[`traces.${side}.truncated`] === true) return null
  return Buffer.byteLength(text)
}
function toolMeasurements(tools: readonly OtlpSpan[]): ToolMeasurement[] {
  const groups = new Map<string, OtlpSpan[]>()
  for (const tool of tools) {
    const name = typeof tool.attributes['tool.name'] === 'string'
      ? tool.attributes['tool.name'] : tool.name
    const group = groups.get(name)
    if (group) group.push(tool)
    else groups.set(name, [tool])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, spans]) => ({
    name,
    calls: spans.length,
    outcomes: {
      ok: spans.filter((span) => span.status.code === 'OK').length,
      error: spans.filter((span) => span.status.code === 'ERROR').length,
      unset: spans.filter((span) => span.status.code === 'UNSET').length,
    },
    inputBytes: measure(spans, (span) => bytes(span, 'input'), 'Input byte count missing or truncated without a size receipt.'),
    outputBytes: measure(spans, (span) => bytes(span, 'output'), 'Output byte count missing or truncated without a size receipt.'),
    callToResultMs: measure(spans, (span) => {
      if (span.status.code === 'UNSET') return null
      const elapsed = Date.parse(span.end_time) - Date.parse(span.start_time)
      // Legacy readers use start == end when no end was recorded. Do not turn that into zero latency.
      return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null
    }, 'A completed span with distinct recorded endpoints is required; equal endpoints may be an adapter default.'),
    spanIds: spans.map((span) => span.span_id),
  }))
}
function compactions(spans: readonly OtlpSpan[]): SessionFact<readonly CompactionMeasurement[]> {
  const events = spans.filter((span) => span.name === 'session.compacted'
    && span.attributes[INHERITED_SOURCE_ATTR] !== 'pre-task-prefix')
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
  if (events.length === 0) return {
    value: null, spanIds: [],
    unavailable: 'No compaction boundary was captured. This does not establish that no compaction occurred.',
  }
  return {
    value: events.map((span, i) => {
      const previous = i > 0 ? events[i - 1] : undefined
      const interval = previous ? Date.parse(span.start_time) - Date.parse(previous.start_time) : NaN
      return {
        spanId: span.span_id,
        at: span.start_time,
        sincePreviousMs: Number.isFinite(interval) && interval >= 0 ? interval : null,
        latencyMs: number(span.attributes['traces.compaction.latency_ms']),
        tokensBefore: number(span.attributes['traces.compaction.tokens_before']),
        tokensAfter: number(span.attributes['traces.compaction.tokens_after']),
      }
    }),
    spanIds: events.map((span) => span.span_id), unavailable: null,
    partial: 'Observed boundaries only. Latency and context sizes are null unless the source explicitly records them.',
  }
}
function contextFootprints(spans: readonly OtlpSpan[]): ContentFootprint[] {
  const out: ContentFootprint[] = []
  for (const span of spans) {
    const fields = ['gen_ai.tool.definitions', 'gen_ai.system_instructions']
    if (span.name === 'message.system' || span.name === 'message.developer'
      || (span.name === 'user.prompt' && span.attributes['tangle.actor'] === 'injected')) fields.push('content')
    for (const field of fields) {
      const value = span.attributes[field]
      if (value === undefined || value === null) continue
      const text = typeof value === 'string' ? value : canonicalJson(value)
      let entries: number | null = Array.isArray(value) ? value.length : null
      if (typeof value === 'string') {
        try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) entries = parsed.length } catch { /* text */ }
      }
      out.push({ spanId: span.span_id, field, bytes: Buffer.byteLength(text), lines: text.split('\n').length, entries, scope: 'captured-attribute' })
    }
  }
  return out
}

/** Called by the existing session facts sheet; no filesystem, inference, or private content in the result. */
export function computeSessionMeasurements(
  spans: readonly OtlpSpan[], tools: readonly OtlpSpan[], sessionId: string | null, harness: string | null,
): SessionMeasurements {
  const spawns = tools.filter((span) => span.attributes['traces.agent.spawn'] === true
    || span.attributes['traces.codex.agent_operation'] === 'spawn_agent')
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
  return {
    observedSpawns: spawns.length,
    spawnIntervalsMs: spawns.map((span, i) => {
      const previous = spawns[i - 1]
      const interval = previous ? Date.parse(span.start_time) - Date.parse(previous.start_time) : NaN
      return { spanId: span.span_id, intervalMs: Number.isFinite(interval) && interval >= 0 ? interval : null }
    }),
    execution: spans.length > 0 ? summarizeSpanExecution(spans) : null,
    adoption: computeAdoption(spans),
    relationship: describeSessionRelationship({
      sessionId: sessionId ?? spans[0]?.trace_id ?? '', harness: harness ?? '', path: '', cwd: null, mtimeMs: 0,
    }, spans),
    tools: toolMeasurements(tools),
    compactions: compactions(spans),
    contextFootprints: contextFootprints(spans),
    coverage: {
      profile: 'Native spans do not establish the authored or effective AgentProfile revision; join the Runtime profile receipt by recorded identity.',
      materializedResources: 'Captured attributes measure only the visible representation. Missing tools, skills, MCP definitions, and resources are unknown.',
      contextTokens: 'No tokenizer estimates are substituted for the actual request. Per-component context token counts require producer telemetry.',
      toolTokens: 'Tool byte counts are not model input tokens; token attribution to tool content is not captured.',
      compaction: 'Only recorded boundaries are counted. Zero-duration adapter defaults are not measured compaction latency.',
      semanticAssessments: 'Success at the task, useful skill application, waste, reward hacking, safety, and dishonesty require separately attributed evaluation.',
    },
  }
}

