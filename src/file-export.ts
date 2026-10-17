import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ATTR, stampEnvironmentAttrs } from './attributes.js'
import type { SessionEnvironment } from './types.js'
import { capText } from './adapters/conversation.js'
import { toolIoAttributes } from './adapters/tool-io.js'
import { appendAll } from './arrays.js'
import { readJsonl } from './jsonl.js'
import type { OtlpSpan, OtlpSpanKind, OtlpStatusCode } from './otlp.js'
import { otlpRowToSpan } from './otlp-input.js'
import { span } from './otlp.js'
import { redactSpans } from './redact.js'
import { validateOtlpSpans } from './span-validation.js'

type JsonObject = Record<string, unknown>

export type TraceEvidenceInputFormat = 'sandbox-events' | 'openinference'
export type TraceEvidenceFormatOption = TraceEvidenceInputFormat | 'auto'

export interface TraceEvidenceExportOptions {
  readonly format?: TraceEvidenceFormatOption
  readonly attributes?: JsonObject
}

export interface TraceEvidenceExportResult {
  readonly format: TraceEvidenceInputFormat
  readonly spans: OtlpSpan[]
  readonly redactionCount: number
  readonly redactionsByDetector: Record<string, number>
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

/**
 * An OTLP/OpenInference span row. `resource`, `scope` and `parent_span_id` are
 * OPTIONAL: they are optional in OTLP itself, and a conforming
 * `@tangle-network/agent-trace-contract` span omits `scope` entirely, so
 * detection accepts the standard shape, not only this package's own emission
 * of it.
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

function eventType(row: JsonObject): string | undefined {
  return stringValue(row.type) ?? stringValue(row.event) ?? stringValue(row.name) ?? stringValue(row.kind)
}

function looksLikeSandboxEvent(row: unknown): row is JsonObject {
  if (!isObject(row)) return false
  const type = eventType(row)?.toLowerCase()
  return type === 'start' || type === 'raw' || type === 'result' || type === 'done' || type === 'error'
}

/**
 * The evidence format these rows are, or undefined when none claims them. Span
 * rows are not evidence: a file of OTLP or OpenInference spans is read as
 * spans, so this answers only for the formats that need converting.
 */
export function detectEvidenceFormat(rows: readonly unknown[]): Exclude<TraceEvidenceInputFormat, 'openinference'> | undefined {
  if (rows.length === 0 || rows.every(isOpenInferenceRow)) return undefined
  if (rows.some(looksLikeSandboxEvent)) return 'sandbox-events'
  return undefined
}

function detectFormat(rows: readonly unknown[], requested: TraceEvidenceFormatOption): TraceEvidenceInputFormat {
  if (requested !== 'auto') return requested
  if (rows.length === 0) throw new Error('input contains no rows')
  if (rows.every(isOpenInferenceRow)) return 'openinference'
  if (rows.some(looksLikeSandboxEvent)) return 'sandbox-events'
  throw new Error('could not detect input format: expected OpenInference span rows or sandbox events')
}

function requireOpenInferenceRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (!rows.every(isOpenInferenceRow)) throw new Error('openinference input must contain only complete OpenInference span rows')
  return rows
}

function requireObjectRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (!rows.every(isObject)) throw new Error('sandbox-events input must contain only JSON object events')
  return rows
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
  // The run's summary: its `toolInvocations` list calls their own events already recorded.
  if (lowered === 'result') return { kind: 'CHAIN' }
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

/**
 * The tool part a sandbox event reports on. The Sandbox SDK records a tool
 * call as its own `message.part.updated` event (`data.part`) and again inside
 * the harness's raw envelope (`data.event.part`, OpenCode's `tool_use`), and a
 * part can be updated several times as it runs. All of them carry the same
 * part id, so the id is what makes one tool call one span.
 */
function toolPart(row: JsonObject): JsonObject | undefined {
  const data = objectValue(row.data)
  const part = objectValue(data?.part) ?? objectValue(row.part) ?? objectValue(objectValue(data?.event)?.part)
  return part && part.type === 'tool' && stringValue(part.id) ? part : undefined
}

/** What a tool part's events recorded: the call's name, input, output and error, the latest of each. */
interface ToolPartState {
  tool?: string
  input?: unknown
  output?: unknown
  error?: string
  start?: string
  end?: string
}

/** Fold one event's view of a tool part into what the part's earlier events recorded. */
function foldToolPart(into: ToolPartState, part: JsonObject): void {
  const state = objectValue(part.state)
  const time = objectValue(state?.time)
  into.tool = stringValue(part.tool) ?? into.tool
  // A pending part can carry an empty input before the call's real one arrives.
  const input = state?.input
  if (input !== undefined && !(isObject(input) && Object.keys(input).length === 0)) into.input = input
  if (state?.output !== undefined) into.output = state.output
  into.error = stringValue(state?.error) ?? into.error
  const start = isoTime(time?.start)
  if (start && (into.start === undefined || start < into.start)) into.start = start
  into.end = isoTime(time?.end) ?? into.end
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

  // One span per tool part: the part's last event carries its final state, its
  // earliest event carries when the call started, and an error reported by any
  // of its events stays an error.
  const lastEventOfPart = new Map<string, number>()
  const firstTimeOfPart = new Map<string, string>()
  const errorOfPart = new Map<string, { status: OtlpStatusCode; message?: string }>()
  const stateOfPart = new Map<string, ToolPartState>()
  rows.forEach((row, index) => {
    const toolPartOfRow = toolPart(row)
    if (toolPartOfRow === undefined) return
    const part = stringValue(toolPartOfRow.id)!
    lastEventOfPart.set(part, index)
    const state = stateOfPart.get(part) ?? {}
    foldToolPart(state, toolPartOfRow)
    stateOfPart.set(part, state)
    const time = eventTimestamp(row)
    const first = firstTimeOfPart.get(part)
    if (time && (first === undefined || time < first)) firstTimeOfPart.set(part, time)
    const partStatus = stringValue(objectValue(toolPartOfRow.state)?.status)
    const status = partStatus === 'error' || partStatus === 'failed'
      ? { status: 'ERROR' as const, ...(state.error ? { message: capText(state.error) } : {}) }
      : eventStatus(row, eventType(row) ?? 'event')
    if (status.status === 'ERROR') errorOfPart.set(part, status)
  })
  const mergedToolEvents = rows.filter((row, index) => {
    const part = stringValue(toolPart(row)?.id)
    return part !== undefined && lastEventOfPart.get(part) !== index
  }).length
  if (mergedToolEvents > 0) spans[0]!.attributes['traces.event.tool_part_updates_merged'] = mergedToolEvents

  let previousTime = rootStart
  rows.forEach((row, index) => {
    const part = stringValue(toolPart(row)?.id)
    if (part !== undefined && lastEventOfPart.get(part) !== index) return
    const partState = part !== undefined ? stateOfPart.get(part) : undefined
    const type = eventType(row) ?? 'event'
    const time = partState?.start ?? (part !== undefined ? firstTimeOfPart.get(part) : undefined) ?? eventTimestamp(row) ?? previousTime
    previousTime = time
    const { status, message } = (part !== undefined ? errorOfPart.get(part) : undefined) ?? eventStatus(row, type)
    const { kind, tool } = partState ? { kind: 'TOOL' as const, tool: partState.tool } : eventKind(row, type)
    const name = kind === 'TOOL' && tool ? `tool.${tool}` : `event.${type}`
    const toolInput = kind === 'TOOL'
      ? partState?.input ?? eventValue(row, ['toolInput', 'tool_input', 'input', 'args', 'arguments', 'full_command'])
      : undefined
    const toolOutput = kind === 'TOOL'
      ? partState?.output ?? partState?.error ?? eventValue(row, ['toolOutput', 'tool_output', 'output', 'result'])
      : undefined
    const invocations = type === 'result' ? objectValue(row.data)?.toolInvocations : undefined
    const extra: JsonObject = {
      'traces.source_format': 'sandbox-events',
      'traces.event.type': type,
      'traces.event.index': index,
      ...(kind === 'TOOL'
        ? toolIoAttributes({ input: toolInput, output: toolOutput, argsCaptured: toolInput !== undefined })
        : {}),
      // The Sandbox's own count of the run's tool calls, beside the tool spans counted from their events.
      ...(Array.isArray(invocations) ? { 'traces.event.tool_invocations': invocations.length } : {}),
    }
    copyDefined(extra, {
      'traces.event.part_id': part,
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
      endTime: partState?.end !== undefined && partState.end >= time ? partState.end : eventEndTimestamp(row, time),
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

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
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
  const converted = format === 'openinference'
    ? openInferenceToSpans(requireOpenInferenceRows(rows))
    : sandboxEventsToSpans(requireObjectRows(rows), wrapper)
  const spans = withExportAttributes(converted, opts.attributes)
  if (spans.length === 0) throw new Error(`no spans exported from ${format} input`)
  const redacted = redactSpans(spans)
  const validated = validateOtlpSpans(redacted.spans, `${format} export`)
  return {
    format,
    spans: validated,
    redactionCount: redacted.report.redactionCount,
    redactionsByDetector: redacted.report.byDetector,
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
    const redactionsByDetector: Record<string, number> = {}

    for await (const row of readJsonl<unknown>(inputPath)) {
      format ??= detectFormat([row], opts.format ?? 'auto')
      if (format === 'sandbox-events') {
        sandboxRows.push(row)
        continue
      }
      const converted = exportTraceEvidenceRows([row], { ...opts, format })
      appendAll(spans, converted.spans)
      redactionCount += converted.redactionCount
      for (const [rule, count] of Object.entries(converted.redactionsByDetector)) {
        redactionsByDetector[rule] = (redactionsByDetector[rule] ?? 0) + count
      }
    }

    if (!format) throw new Error('input file is empty')
    if (format === 'sandbox-events') {
      return exportTraceEvidenceRows(sandboxRows, { ...opts, format })
    }
    return {
      format,
      spans: validateOtlpSpans(spans, `${format} file export`),
      redactionCount,
      redactionsByDetector,
    }
  }
  const text = await readFile(inputPath, 'utf8')
  return exportTraceEvidenceText(text, opts)
}
