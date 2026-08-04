import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  firstNumberAttr,
  LLM_CACHED_TOKEN_ATTR_KEYS,
  LLM_CACHED_TOKENS,
  LLM_CACHE_WRITE_TOKEN_ATTR_KEYS,
  LLM_CACHE_WRITE_TOKENS,
  LLM_COST_ATTR_KEYS,
  LLM_COST_USD,
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_INPUT_TOKENS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKENS,
  LLM_REASONING_TOKEN_ATTR_KEYS,
  LLM_REASONING_TOKENS,
} from '@tangle-network/agent-eval/trace-attributes'
import { ATTR, sessionIdFromAttributes, stampEnvironmentAttrs } from './attributes.js'
import type { SessionEnvironment } from './types.js'
import { capText } from './adapters/conversation.js'
import { toolIoAttributes } from './adapters/tool-io.js'
import { appendAll } from './arrays.js'
import {
  chatTrajectoryToSpans,
  isChatTrajectory,
  isChatTrajectoryMessage,
} from './chat-trajectory.js'
import type { PolicyEvidenceRecord } from './evidence.js'
import { readJsonl } from './jsonl.js'
import type { OtlpSpan, OtlpSpanKind, OtlpStatusCode } from './otlp.js'
import { capturedToolIo, inferSpanKind, otlpRowToSpan } from './otlp-input.js'
import { serializeSpans, span } from './otlp.js'
import { redactSpans } from './redact.js'
import { validateOtlpSpans } from './span-validation.js'

type JsonObject = Record<string, unknown>

export type TraceEvidenceInputFormat =
  | 'policy-evidence'
  | 'sandbox-events'
  | 'openinference'
  | 'intelligence-spans'
  | 'chat-trajectory'
export type TraceEvidenceFormatOption = TraceEvidenceInputFormat | 'auto'

export interface TraceEvidenceExportOptions {
  readonly format?: TraceEvidenceFormatOption
  readonly sourcePath?: string
  readonly attributes?: JsonObject
}

export interface TraceEvidenceExportResult {
  readonly format: TraceEvidenceInputFormat
  readonly spans: OtlpSpan[]
  readonly redactionCount: number
  readonly redactionsByRule: Record<string, number>
}

function isObject(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function objectValue(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (!isObject(v)) return v
    return Object.keys(v).sort().reduce<JsonObject>((acc, key) => {
      acc[key] = v[key]
      return acc
    }, {})
  })
}

function hashId(value: unknown, chars = 16): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, chars)
}

function isoTime(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed
    const ms = Date.parse(normalized)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  return undefined
}

function firstTime(obj: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = isoTime(obj[key])
    if (value) return value
  }
  return undefined
}

function firstTimeDeep(value: unknown, keys: readonly string[], depth = 5): string | undefined {
  if (depth < 0) return undefined
  if (isObject(value)) {
    const direct = firstTime(value, keys)
    if (direct) return direct
    for (const child of Object.values(value)) {
      const found = firstTimeDeep(child, keys, depth - 1)
      if (found) return found
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstTimeDeep(child, keys, depth - 1)
      if (found) return found
    }
  }
  return undefined
}

function copyDefined(target: JsonObject, entries: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value != null && value !== '') target[key] = value
  }
}

function parseJsonRows(text: string): { rows: unknown[]; wrapper?: JsonObject } {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('input file is empty')
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return { rows: parsed }
      if (isObject(parsed)) {
        const events = parsed.events
        if (Array.isArray(events)) return { rows: events, wrapper: parsed }
        return { rows: [parsed] }
      }
      throw new Error('input JSON must be an object, array, or JSONL rows')
    } catch (error) {
      const hasMultipleRows = /\r?\n/.test(trimmed)
      if (!hasMultipleRows) throw error
    }
  }
  return {
    rows: trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  }
}

function isPolicyEvidenceRow(row: unknown): row is PolicyEvidenceRecord {
  return isObject(row) && row.kind === 'traces.policy_evidence.session'
}

/**
 * An OTLP/OpenInference span row. `resource`, `scope` and `parent_span_id` are
 * OPTIONAL: they are optional in OTLP itself, and a conforming
 * `@tangle-network/agent-trace-contract` span omits `scope` entirely. Requiring
 * them sent contract-shaped files down the `intelligence-spans` reader, which
 * rewrites rather than preserves — detection has to accept the standard shape,
 * not only this package's own emission of it.
 */
function isOpenInferenceRow(row: unknown): row is JsonObject {
  if (!isObject(row)) return false
  return (
    typeof row.trace_id === 'string' &&
    typeof row.span_id === 'string' &&
    (row.parent_span_id == null || typeof row.parent_span_id === 'string') &&
    typeof row.name === 'string' &&
    typeof row.start_time === 'string' &&
    typeof row.end_time === 'string' &&
    isObject(row.status) &&
    isObject(row.attributes) &&
    (row.resource === undefined || isObject(row.resource)) &&
    (row.scope === undefined || isObject(row.scope)) &&
    (row.links === undefined || Array.isArray(row.links))
  )
}

function isIntelligenceSpanRow(row: unknown): row is JsonObject {
  if (!isObject(row)) return false
  return (
    typeof row.trace_id === 'string' &&
    typeof row.name === 'string' &&
    isObject(row.attributes) &&
    (row.start_unix_nano != null || row.start_time != null || row.received_at != null)
  )
}

function eventType(row: JsonObject): string | undefined {
  return stringValue(row.type) ?? stringValue(row.event) ?? stringValue(row.name) ?? stringValue(row.kind)
}

function looksLikeSandboxEvent(row: unknown): row is JsonObject {
  if (!isObject(row)) return false
  const type = eventType(row)?.toLowerCase()
  return type === 'start' || type === 'raw' || type === 'result' || type === 'done' || type === 'error'
}

function detectFormat(rows: readonly unknown[], requested: TraceEvidenceFormatOption): TraceEvidenceInputFormat {
  if (requested !== 'auto') return requested
  if (rows.length === 0) throw new Error('input contains no rows')
  if (rows.every(isPolicyEvidenceRow)) return 'policy-evidence'
  if (rows.every(isOpenInferenceRow)) return 'openinference'
  if (rows.every(isIntelligenceSpanRow)) return 'intelligence-spans'
  if (rows.every(isChatTrajectory) || rows.every(isChatTrajectoryMessage)) return 'chat-trajectory'
  if (rows.some(looksLikeSandboxEvent)) return 'sandbox-events'
  throw new Error('could not detect input format; use --format policy-evidence, sandbox-events, openinference, intelligence-spans, or chat-trajectory')
}

function requirePolicyEvidenceRows(rows: readonly unknown[]): readonly PolicyEvidenceRecord[] {
  if (!rows.every(isPolicyEvidenceRow)) throw new Error('policy-evidence input must contain only traces.policy_evidence.session rows')
  return rows
}

function requireOpenInferenceRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (!rows.every(isOpenInferenceRow)) throw new Error('openinference input must contain only complete OpenInference span rows')
  return rows
}

function requireIntelligenceSpanRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (rows.length > 0 && rows.every(isOpenInferenceRow)) {
    throw new Error(
      'intelligence-spans input is already complete OpenInference; use --format auto or --format openinference to preserve it losslessly',
    )
  }
  if (!rows.every(isIntelligenceSpanRow)) throw new Error('intelligence-spans input must contain only Intelligence span rows')
  return rows
}

function requireObjectRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (!rows.every(isObject)) throw new Error('sandbox-events input must contain only JSON object events')
  return rows
}

function chatTrajectoryRowsToSpans(
  rows: readonly unknown[],
  sourcePath?: string,
): OtlpSpan[] {
  if (rows.every(isChatTrajectoryMessage)) {
    return chatTrajectoryToSpans(rows, { sourcePath })
  }
  if (!rows.every(isChatTrajectory)) {
    throw new Error('chat-trajectory input must be one message array or trajectory objects')
  }
  return rows.flatMap((trajectory) => chatTrajectoryToSpans(trajectory, { sourcePath }))
}

function evidenceTimeBounds(record: PolicyEvidenceRecord): { start: string; end: string } {
  const sessionTime = new Date(record.session.mtimeMs).toISOString()
  const start = record.metrics.firstSpanAt ?? record.generatedAt ?? sessionTime
  const end = record.metrics.lastSpanAt ?? start
  return { start, end }
}

function policyEvidenceToSpans(records: readonly PolicyEvidenceRecord[]): OtlpSpan[] {
  return records.map((record) => {
    const { start, end } = evidenceTimeBounds(record)
    const traceId = record.session.sessionId || hashId(record, 32)
    const extra: JsonObject = {
      'traces.source_format': 'policy-evidence',
      'traces.policy_evidence.schema_version': record.schemaVersion,
      'traces.policy_evidence.kind': record.kind,
      'traces.session.id': record.session.sessionId,
      'traces.session.path': record.session.path,
      'traces.session.cwd': record.session.cwd,
      'traces.session.mtime_ms': record.session.mtimeMs,
      'traces.metrics.span_count': record.metrics.spanCount,
      'traces.metrics.llm_turn_count': record.metrics.llmTurnCount,
      'traces.metrics.tool_call_count': record.metrics.toolCallCount,
      'traces.metrics.errored_tool_call_count': record.metrics.erroredToolCallCount,
      'traces.metrics.input_tokens': record.metrics.inputTokens,
      'traces.metrics.output_tokens': record.metrics.outputTokens,
      'traces.execution': stableJson(record.execution),
      'traces.metrics.models': record.metrics.models,
      'traces.metrics.tools': stableJson(record.metrics.tools),
      'traces.signals.stuck_loop_count': record.signals.stuckLoopCount,
      'traces.signals.affected_run_ratio': record.signals.affectedRunRatio,
      'traces.signals.stuck_loops': stableJson(record.signals.stuckLoops),
      'traces.signals.stuck_loops_omitted': record.signals.stuckLoopsOmitted,
      'traces.signals.tool_error_rate': record.signals.toolErrorRate,
      'traces.provenance.source': record.provenance.source,
      'traces.provenance.evidence_kind': record.provenance.evidenceKind,
      'traces.provenance.otlp_path': record.provenance.otlpPath,
      'traces.provenance.source_sha256': record.provenance.sourceSha256,
      [ATTR.SUBJECT_KEY]: record.repo.subjectKey,
      [ATTR.GIT_REPOSITORY]: record.repo.repository,
      [ATTR.GIT_BRANCH_NAME]: record.repo.branch,
      [ATTR.GIT_COMMIT]: record.repo.commit,
      [ATTR.CWD]: record.repo.cwd ?? record.session.cwd,
      [ATTR.REPO_RESOLUTION_SOURCE]: record.repo.resolutionSource,
    }
    return span({
      traceId,
      spanId: `policy:${hashId(record)}`,
      parentSpanId: null,
      name: 'policy_evidence.session',
      kind: 'AGENT',
      startTime: start,
      endTime: end,
      service: record.session.harness,
      agent: 'traces',
      inputTokens: record.execution.execution.tokenUsage.totals.input,
      outputTokens: record.execution.execution.tokenUsage.totals.output,
      reasoningTokens: record.execution.execution.tokenUsage.totals.reasoning,
      cachedInputTokens: record.execution.execution.tokenUsage.totals.cached,
      cacheWriteInputTokens: record.execution.execution.tokenUsage.totals.cacheWrite,
      content: capText(stableJson({
        session: record.session,
        repo: record.repo,
        metrics: record.metrics,
        signals: record.signals,
        provenance: record.provenance,
      })),
      extra,
    })
  })
}

function findStringKey(value: unknown, keys: readonly string[], depth = 4): string | undefined {
  if (depth < 0) return undefined
  if (isObject(value)) {
    for (const key of keys) {
      const found = stringValue(value[key])
      if (found) return found
    }
    for (const child of Object.values(value)) {
      const found = findStringKey(child, keys, depth - 1)
      if (found) return found
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findStringKey(child, keys, depth - 1)
      if (found) return found
    }
  }
  return undefined
}

function eventValue(row: JsonObject, keys: readonly string[]): unknown {
  const scopes = [row, objectValue(row.data), objectValue(row.payload)]
  for (const scope of scopes) {
    if (!scope) continue
    for (const key of keys) {
      if (scope[key] !== undefined) return scope[key]
    }
  }
  return undefined
}

function eventTimestamp(row: JsonObject): string | undefined {
  return firstTimeDeep(row, [
    'timestamp',
    'start_time',
    'startTime',
    'startedAt',
    'createdAt',
    'created_at',
    'created',
    'time',
  ])
}

function eventEndTimestamp(row: JsonObject, fallback: string): string {
  return firstTimeDeep(row, [
    'end_time',
    'endTime',
    'completedAt',
    'completed_at',
    'finishedAt',
    'updatedAt',
    'updated_at',
    'updated',
  ]) ?? fallback
}

function eventStatus(row: JsonObject, type: string): { status: OtlpStatusCode; message?: string } {
  const lowered = type.toLowerCase()
  const errorMessage =
    stringValue(row.error) ??
    findStringKey(row, ['error', 'errorMessage', 'error_message'], 3)
  if (lowered.includes('error') || errorMessage) {
    const message = errorMessage ?? stringValue(row.message)
    return { status: 'ERROR', ...(message ? { message: capText(message) } : {}) }
  }
  return { status: 'OK' }
}

function eventKind(row: JsonObject, type: string): { kind: OtlpSpanKind; tool?: string } {
  const lowered = type.toLowerCase()
  const tool = findStringKey(row, ['tool', 'toolName', 'tool_name'], 4)
  if (tool || lowered.includes('tool') || stableJson(row).includes('tool-invocation')) return { kind: 'TOOL', tool }
  if (lowered.includes('llm') || lowered === 'token') return { kind: 'LLM' }
  return { kind: 'CHAIN' }
}

/**
 * Environment identity for a recorded sandbox session. Two sources, wrapper
 * context winning: explicit `image`/`imageDigest`/`sandboxId`/`cwd` keys on
 * the wrapper object, else the stream's own `runtime.ready` event — the
 * session-gateway event that names the sandbox and the image it booted.
 * Null when the recording carries neither: "environment not captured" must
 * stay distinguishable from a captured environment downstream.
 */
function sandboxEventsEnvironment(
  context: JsonObject,
  rows: readonly JsonObject[],
): SessionEnvironment | null {
  const ready = rows.find((row) => eventType(row) === 'runtime.ready')
  const readyData = ready && isObject(ready.data) ? ready.data : undefined
  const pick = (keys: readonly string[]): string | undefined =>
    findStringKey(context, keys, 2) ?? (readyData ? findStringKey(readyData, keys, 2) : undefined)
  const image = pick(['image'])
  const imageDigest = pick(['imageDigest', 'image_digest'])
  const sandboxId = pick(['sandboxId', 'sandbox_id'])
  const cwd = pick(['cwd', 'workspaceRoot', 'workspace_root'])
  if (!image && !imageDigest && !sandboxId && !cwd) return null
  return {
    ...(image ? { image } : {}),
    ...(imageDigest ? { imageDigest } : {}),
    ...(sandboxId ? { sandboxId } : {}),
    cwd: cwd ?? null,
  }
}

/**
 * Model identity and token usage recorded on one LLM event row, across the
 * key spellings sandbox recorders use (`usage.prompt_tokens` OpenAI-style,
 * `tokenUsage.inputTokens` opencode-style, bare snake_case). Absent values
 * stay absent — a zero here would claim a measured count that never was.
 */
function llmEventUsage(row: JsonObject): {
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
} {
  const num = (keys: readonly string[]): number | undefined => {
    for (const key of keys) {
      const direct = numberValue(row[key])
      if (direct !== undefined) return direct
      for (const nest of ['data', 'usage', 'tokenUsage']) {
        const container = row[nest]
        if (!isObject(container)) continue
        const value = numberValue(container[key])
        if (value !== undefined) return value
        for (const inner of ['usage', 'tokenUsage']) {
          const deep = container[inner]
          if (isObject(deep)) {
            const deepValue = numberValue(deep[key])
            if (deepValue !== undefined) return deepValue
          }
        }
      }
    }
    return undefined
  }
  const model = findStringKey(row, ['model'], 3)
  const inputTokens = num(['prompt_tokens', 'input_tokens', 'inputTokens'])
  const outputTokens = num(['completion_tokens', 'output_tokens', 'outputTokens'])
  const costUsd = num(['totalCostUsd', 'total_cost_usd', 'costUsd', 'cost_usd'])
  return {
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

function sandboxEventsToSpans(rows: readonly JsonObject[], wrapper?: JsonObject): OtlpSpan[] {
  const context = wrapper ?? {}
  const sessionId =
    findStringKey(context, ['session_id', 'sessionId'], 3) ??
    findStringKey(rows, ['session_id', 'sessionId'], 4)
  const traceId =
    findStringKey(context, ['trace_id', 'traceId'], 3) ??
    findStringKey(rows, ['trace_id', 'traceId'], 4) ??
    sessionId ??
    findStringKey(context, ['run_id', 'runId'], 3) ??
    findStringKey(rows, ['run_id', 'runId'], 4) ??
    `sandbox:${hashId(rows, 32)}`
  const service = findStringKey(context, ['service', 'harness', 'source'], 2) ?? 'sandbox-opencode'
  const times = rows.flatMap((row) => {
    const time = eventTimestamp(row)
    return time ? [time] : []
  }).sort()
  const rootId = `events:${hashId({ traceId, rows: rows.length })}`
  const hasError = rows.some((row) => eventStatus(row, eventType(row) ?? 'event').status === 'ERROR')
  const rootStart = times[0] ?? new Date(0).toISOString()
  const rootEnd = times[times.length - 1] ?? rootStart
  const spans: OtlpSpan[] = [
    span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'sandbox.events',
      kind: 'AGENT',
      startTime: rootStart,
      endTime: rootEnd,
      status: hasError ? 'ERROR' : 'OK',
      service,
      agent: service,
      extra: {
        'traces.source_format': 'sandbox-events',
        'traces.event_count': rows.length,
      },
    }),
  ]

  let previousTime = rootStart
  rows.forEach((row, index) => {
    const type = eventType(row) ?? 'event'
    const time = eventTimestamp(row) ?? previousTime
    previousTime = time
    const { status, message } = eventStatus(row, type)
    const { kind, tool } = eventKind(row, type)
    const name = kind === 'TOOL' && tool ? `tool.${tool}` : `event.${type}`
    const toolInput = kind === 'TOOL'
      ? eventValue(row, ['toolInput', 'tool_input', 'input', 'args', 'arguments', 'full_command'])
      : undefined
    const extra: JsonObject = {
      'traces.source_format': 'sandbox-events',
      'traces.event.type': type,
      'traces.event.index': index,
      ...(kind === 'TOOL'
        ? toolIoAttributes({
            input: toolInput,
            output: eventValue(row, ['toolOutput', 'tool_output', 'output', 'result']),
            argsCaptured: toolInput !== undefined,
          })
        : {}),
    }
    copyDefined(extra, {
      'traces.event.id': stringValue(row.id),
      'traces.event.raw_type': stringValue(row.type),
      'traces.event.raw_event': stringValue(row.event),
    })
    spans.push(span({
      traceId,
      spanId: `event:${index}:${hashId(row)}`,
      parentSpanId: rootId,
      name,
      kind,
      startTime: time,
      endTime: eventEndTimestamp(row, time),
      status,
      statusMessage: message,
      service,
      agent: service,
      tool: kind === 'TOOL' ? tool ?? type : null,
      step: index,
      content: capText(stableJson(row)),
      extra,
      ...(kind === 'LLM' ? llmEventUsage(row) : {}),
    }))
  })

  // Environment identity rides every span so `toOpenInferenceSpan` lifts it
  // into the OTLP resource block — the sandbox class is replay-eligible only
  // if the image recorded at runtime survives export.
  stampEnvironmentAttrs(spans, sandboxEventsEnvironment(context, rows) ?? undefined)

  if (!sessionId) return spans
  return spans.map((item) => ({
    ...item,
    attributes: { ...item.attributes, [ATTR.SESSION_ID]: sessionId },
  }))
}

function statusCode(value: unknown): OtlpStatusCode {
  if (value === 'OK' || value === 'STATUS_CODE_OK') return 'OK'
  if (value === 'ERROR' || value === 'STATUS_CODE_ERROR') return 'ERROR'
  return 'UNSET'
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function unixNanoTime(value: unknown): string | undefined {
  if (value == null) return undefined
  try {
    const ns = typeof value === 'bigint' ? value : BigInt(String(value))
    return new Date(Number(ns / 1_000_000n)).toISOString()
  } catch {
    return undefined
  }
}

function firstNumber(row: JsonObject, attrs: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = firstNumberAttr(row, [key]) ?? firstNumberAttr(attrs, [key])
    if (value !== null) return value
  }
  return undefined
}

const COMPUTED_SPAN_ATTRIBUTES = new Set([
  'openinference.span.kind',
  'service.name',
  'agent.name',
  'llm.model_name',
  'tool.name',
  'llm.input_tokens',
  'llm.output_tokens',
  LLM_INPUT_TOKENS,
  LLM_OUTPUT_TOKENS,
  LLM_REASONING_TOKENS,
  LLM_CACHED_TOKENS,
  LLM_CACHE_WRITE_TOKENS,
  LLM_COST_USD,
  'step',
  'content',
])

function preserveRawAttributes(attrs: JsonObject): JsonObject {
  const preserved: JsonObject = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (COMPUTED_SPAN_ATTRIBUTES.has(key)) {
      preserved[`traces.raw_attribute.${key}`] = value
    } else {
      preserved[key] = value
    }
  }
  return preserved
}

function intelligenceSpansToSpans(rows: readonly JsonObject[]): OtlpSpan[] {
  return rows.map((row, index) => {
    const attrs = { ...(objectValue(row.attributes) ?? {}) }
    const name = stringValue(row.name) ?? 'intelligence.span'
    const startTime =
      unixNanoTime(row.start_unix_nano) ??
      isoTime(row.start_time) ??
      stringValue(row.start_time) ??
      isoTime(row.received_at) ??
      stringValue(row.received_at) ??
      ''
    const endTime =
      unixNanoTime(row.end_unix_nano) ??
      isoTime(row.end_time) ??
      stringValue(row.end_time) ??
      startTime
    const model =
      stringValue(row.model) ??
      stringValue(attrs['llm.model_name']) ??
      stringValue(attrs.model) ??
      stringValue(attrs['gen_ai.request.model'])
    const tool =
      stringValue(attrs['tool.name']) ??
      stringValue(attrs.tool_name) ??
      stringValue(attrs['mcp.tool.name'])
    const kind = inferSpanKind(name, attrs)
    const sourceStatus = objectValue(row.status)
    const sessionId = stringValue(row.session_id) ?? sessionIdFromAttributes(attrs)
    const extra: JsonObject = {
      ...preserveRawAttributes(attrs),
      ...(kind === 'TOOL' ? capturedToolIo(attrs) : {}),
      'traces.source_format': 'intelligence-spans',
      'traces.row.index': index,
    }
    copyDefined(extra, {
      'traces.row.id': stringValue(row.id),
      [ATTR.SESSION_ID]: sessionId,
      'session.id': sessionId,
      'run.id': stringValue(row.run_id),
      'thread.id': stringValue(row.thread_id),
      'scenario.id': stringValue(row.scenario_id),
      'generation.id': stringValue(row.generation),
      'cell.id': stringValue(row.cell_id),
      'project.key': stringValue(row.project_key),
      'redaction.version': stringValue(row.redaction_version),
      'traces.received_at': isoTime(row.received_at),
    })
    return span({
      traceId: stringValue(row.trace_id) ?? hashId(row, 32),
      spanId: stringValue(row.id) ?? hashId({ row, field: 'span' }),
      parentSpanId: stringValue(row.parent_span_id) ?? null,
      name,
      kind,
      startTime,
      endTime,
      status: statusCode(row.status_code ?? sourceStatus?.code),
      statusMessage: stringValue(row.status_message) ?? stringValue(sourceStatus?.message),
      service: stringValue(attrs['service.name']) ?? stringValue(attrs.service_name) ?? 'tangle-intelligence',
      agent: stringValue(attrs['agent.name']) ?? stringValue(attrs['service.name']) ?? null,
      model,
      tool,
      inputTokens: firstNumber(row, attrs, ['input_tokens', ...LLM_INPUT_TOKEN_ATTR_KEYS]),
      outputTokens: firstNumber(row, attrs, ['output_tokens', ...LLM_OUTPUT_TOKEN_ATTR_KEYS]),
      reasoningTokens: firstNumber(row, attrs, LLM_REASONING_TOKEN_ATTR_KEYS),
      cachedInputTokens: firstNumber(row, attrs, LLM_CACHED_TOKEN_ATTR_KEYS),
      cacheWriteInputTokens: firstNumber(row, attrs, LLM_CACHE_WRITE_TOKEN_ATTR_KEYS),
      costUsd: firstNumber(row, attrs, ['cost_usd', ...LLM_COST_ATTR_KEYS]),
      step: numberValue(attrs['interaction.sequence']) ?? index,
      content:
        stringValue(attrs.user_prompt) ??
        stringValue(attrs['gen_ai.prompt.messages']) ??
        stringValue(attrs['log.content.task']) ??
        null,
      extra,
    })
  })
}

/**
 * Every status spelling an OpenInference/OTLP row may use. Anything else is a
 * value this package cannot map, and mapping it to UNSET would silently turn an
 * unreadable verdict into "no verdict recorded".
 */
const OPEN_INFERENCE_STATUS_CODES = new Set([
  'OK',
  'ERROR',
  'UNSET',
  'STATUS_CODE_OK',
  'STATUS_CODE_ERROR',
  'STATUS_CODE_UNSET',
])

/**
 * OpenInference/OTLP rows to spans, through the ONE row reader
 * (`otlpRowToSpan`) that `--otlp` ingest also uses — same normalization, same
 * link preservation, no second definition of "what an OTLP span means here".
 *
 * The two callers differ only in policy at this boundary: `export` is an
 * explicit conversion of a file the caller vouched for, so an unreadable row —
 * including an unmappable status code — fails loud; `readOtlpInput` reads
 * FOREIGN traces, so it reports the same defect as a finding and continues.
 */
function openInferenceToSpans(rows: readonly JsonObject[]): OtlpSpan[] {
  return rows.map((row) => {
    const status = objectValue(row.status)
    const code = status?.code
    if (code != null && !(typeof code === 'string' && OPEN_INFERENCE_STATUS_CODES.has(code))) {
      throw new TypeError('OpenInference status.code must be OK, ERROR, UNSET, or its STATUS_CODE_* form')
    }
    const traceId = stringValue(row.trace_id)
    const converted = otlpRowToSpan(row, traceId ?? 'openinference')
    if (!converted.span) {
      throw new TypeError(`openinference row is not a usable span: ${converted.issue?.detail ?? 'unknown reason'}`)
    }
    return converted.span
  })
}

function normalizeAttributes(attributes: JsonObject | undefined): JsonObject {
  const normalized: JsonObject = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!key || value == null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value
    } else if (Array.isArray(value) && value.every((item) =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    )) {
      normalized[key] = value
    } else {
      normalized[key] = stableJson(value)
    }
  }
  return normalized
}

function withExportAttributes(spans: readonly OtlpSpan[], attributes: JsonObject | undefined): OtlpSpan[] {
  const normalized = normalizeAttributes(attributes)
  if (Object.keys(normalized).length === 0) return [...spans]
  return spans.map((s) => ({ ...s, attributes: { ...s.attributes, ...normalized } }))
}

export function exportTraceEvidenceRows(
  rows: readonly unknown[],
  opts: TraceEvidenceExportOptions = {},
  wrapper?: JsonObject,
): TraceEvidenceExportResult {
  const format = detectFormat(rows, opts.format ?? 'auto')
  const converted =
    format === 'policy-evidence'
      ? policyEvidenceToSpans(requirePolicyEvidenceRows(rows))
      : format === 'openinference'
        ? openInferenceToSpans(requireOpenInferenceRows(rows))
        : format === 'intelligence-spans'
          ? intelligenceSpansToSpans(requireIntelligenceSpanRows(rows))
          : format === 'chat-trajectory'
            ? chatTrajectoryRowsToSpans(rows, opts.sourcePath)
            : sandboxEventsToSpans(requireObjectRows(rows), wrapper)
  const spans = withExportAttributes(converted, opts.attributes)
  if (spans.length === 0) throw new Error(`no spans exported from ${format} input`)
  const redacted = redactSpans(spans)
  const validated = validateOtlpSpans(redacted.spans, `${format} export`)
  return {
    format,
    spans: validated,
    redactionCount: redacted.report.redactionCount,
    redactionsByRule: redacted.report.byRule,
  }
}

export function exportTraceEvidenceText(text: string, opts: TraceEvidenceExportOptions = {}): TraceEvidenceExportResult {
  const parsed = parseJsonRows(text)
  return exportTraceEvidenceRows(parsed.rows, opts, parsed.wrapper)
}

export async function exportTraceEvidenceFile(
  inputPath: string,
  opts: TraceEvidenceExportOptions = {},
): Promise<TraceEvidenceExportResult> {
  if (/\.(?:jsonl|ndjson)$/i.test(inputPath)) {
    let format: TraceEvidenceInputFormat | undefined
    const spans: OtlpSpan[] = []
    const sandboxRows: unknown[] = []
    let redactionCount = 0
    const redactionsByRule: Record<string, number> = {}

    for await (const row of readJsonl<unknown>(inputPath)) {
      format ??= detectFormat([row], opts.format ?? 'auto')
      if (format === 'sandbox-events') {
        sandboxRows.push(row)
        continue
      }
      const converted = exportTraceEvidenceRows([row], {
        ...opts,
        sourcePath: inputPath,
        format,
      })
      appendAll(spans, converted.spans)
      redactionCount += converted.redactionCount
      for (const [rule, count] of Object.entries(converted.redactionsByRule)) {
        redactionsByRule[rule] = (redactionsByRule[rule] ?? 0) + count
      }
    }

    if (!format) throw new Error('input file is empty')
    if (format === 'sandbox-events') {
      return exportTraceEvidenceRows(sandboxRows, {
        ...opts,
        sourcePath: inputPath,
        format,
      })
    }
    return {
      format,
      spans: validateOtlpSpans(spans, `${format} file export`),
      redactionCount,
      redactionsByRule,
    }
  }
  const text = await readFile(inputPath, 'utf8')
  return exportTraceEvidenceText(text, { ...opts, sourcePath: inputPath })
}

export async function writeTraceEvidenceExportFile(
  inputPath: string,
  outPath?: string,
  opts: TraceEvidenceExportOptions = {},
): Promise<TraceEvidenceExportResult & { path: string }> {
  const result = await exportTraceEvidenceFile(inputPath, opts)
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-export-')), 'spans.openinference.jsonl')
  await writeFile(path, serializeSpans(result.spans), 'utf8')
  return { ...result, path }
}
