import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTR } from './attributes.js'
import { capText } from './adapters/conversation.js'
import type { PolicyEvidenceRecord } from './evidence.js'
import type { OtlpSpan, OtlpSpanKind, OtlpStatusCode } from './otlp.js'
import { serializeSpans, span } from './otlp.js'
import { redactSpans } from './redact.js'

type JsonObject = Record<string, unknown>

export type TraceEvidenceInputFormat = 'policy-evidence' | 'sandbox-events' | 'openinference'
export type TraceEvidenceFormatOption = TraceEvidenceInputFormat | 'auto'

export interface TraceEvidenceExportOptions {
  readonly format?: TraceEvidenceFormatOption
  readonly sourcePath?: string
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
    const ms = Date.parse(value)
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

function copyDefined(target: JsonObject, entries: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value != null && value !== '') target[key] = value
  }
}

function parseJsonRows(text: string): { rows: unknown[]; wrapper?: JsonObject } {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('input file is empty')
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return { rows: parsed }
    if (isObject(parsed)) {
      const events = parsed.events
      if (Array.isArray(events)) return { rows: events, wrapper: parsed }
      return { rows: [parsed] }
    }
    throw new Error('input JSON must be an object, array, or JSONL rows')
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

function isOpenInferenceRow(row: unknown): row is JsonObject {
  if (!isObject(row)) return false
  return (
    typeof row.trace_id === 'string' &&
    typeof row.span_id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.start_time === 'string' &&
    typeof row.end_time === 'string' &&
    isObject(row.status) &&
    isObject(row.attributes) &&
    isObject(row.resource) &&
    isObject(row.scope)
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
  if (rows.some(looksLikeSandboxEvent)) return 'sandbox-events'
  throw new Error('could not detect input format; use --format policy-evidence, sandbox-events, or openinference')
}

function requirePolicyEvidenceRows(rows: readonly unknown[]): readonly PolicyEvidenceRecord[] {
  if (!rows.every(isPolicyEvidenceRow)) throw new Error('policy-evidence input must contain only traces.policy_evidence.session rows')
  return rows
}

function requireOpenInferenceRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (!rows.every(isOpenInferenceRow)) throw new Error('openinference input must contain only complete OpenInference span rows')
  return rows
}

function requireObjectRows(rows: readonly unknown[]): readonly JsonObject[] {
  if (!rows.every(isObject)) throw new Error('sandbox-events input must contain only JSON object events')
  return rows
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
      [ATTR.SUBJECT_KEY]: record.repo.subjectKey,
      [ATTR.GIT_REPOSITORY]: record.repo.repository,
      [ATTR.GIT_BRANCH_NAME]: record.repo.branch,
      [ATTR.GIT_COMMIT]: record.repo.commit,
      [ATTR.CWD]: record.repo.cwd ?? record.session.cwd,
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

function eventTimestamp(row: JsonObject, index: number): string {
  return firstTime(row, ['timestamp', 'time', 'createdAt', 'created_at', 'start_time', 'startTime']) ?? new Date(index).toISOString()
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

function sandboxEventsToSpans(rows: readonly JsonObject[], wrapper?: JsonObject): OtlpSpan[] {
  const context = wrapper ?? {}
  const traceId =
    findStringKey(context, ['trace_id', 'traceId', 'session_id', 'sessionId', 'run_id', 'runId'], 3) ??
    findStringKey(rows, ['trace_id', 'traceId', 'session_id', 'sessionId', 'run_id', 'runId'], 4) ??
    `sandbox:${hashId(rows, 32)}`
  const service = findStringKey(context, ['service', 'harness', 'source'], 2) ?? 'sandbox-opencode'
  const times = rows.map((row, i) => eventTimestamp(row, i)).sort()
  const rootId = `events:${hashId({ traceId, rows: rows.length })}`
  const hasError = rows.some((row) => eventStatus(row, eventType(row) ?? 'event').status === 'ERROR')
  const spans: OtlpSpan[] = [
    span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'sandbox.events',
      kind: 'AGENT',
      startTime: times[0] ?? new Date(0).toISOString(),
      endTime: times[times.length - 1] ?? times[0] ?? new Date(0).toISOString(),
      status: hasError ? 'ERROR' : 'OK',
      service,
      agent: service,
      extra: {
        'traces.source_format': 'sandbox-events',
        'traces.event_count': rows.length,
      },
    }),
  ]

  rows.forEach((row, index) => {
    const type = eventType(row) ?? 'event'
    const time = eventTimestamp(row, index)
    const { status, message } = eventStatus(row, type)
    const { kind, tool } = eventKind(row, type)
    const name = kind === 'TOOL' && tool ? `tool.${tool}` : `event.${type}`
    const extra: JsonObject = {
      'traces.source_format': 'sandbox-events',
      'traces.event.type': type,
      'traces.event.index': index,
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
      endTime: firstTime(row, ['end_time', 'endTime', 'completedAt', 'completed_at']) ?? time,
      status,
      statusMessage: message,
      service,
      agent: service,
      tool: kind === 'TOOL' ? tool ?? type : null,
      step: index,
      content: capText(stableJson(row)),
      extra,
    }))
  })

  return spans
}

function statusCode(value: unknown): OtlpStatusCode {
  return value === 'OK' || value === 'ERROR' || value === 'UNSET' ? value : 'UNSET'
}

function openInferenceToSpans(rows: readonly JsonObject[]): OtlpSpan[] {
  return rows.map((row) => {
    const attrs = isObject(row.attributes) ? { ...row.attributes } : {}
    const resource = objectValue(row.resource)
    const resourceAttrs = objectValue(resource?.attributes)
    if (resourceAttrs) copyDefined(attrs, resourceAttrs)
    const kind = stringValue(row.kind)
    if (kind && attrs['openinference.span.kind'] == null) attrs['openinference.span.kind'] = kind
    const status = objectValue(row.status)
    const message = stringValue(status?.message)
    return {
      trace_id: stringValue(row.trace_id) ?? hashId(row, 32),
      span_id: stringValue(row.span_id) ?? hashId({ row, field: 'span' }),
      parent_span_id: stringValue(row.parent_span_id) || null,
      name: stringValue(row.name) ?? 'span',
      start_time: stringValue(row.start_time) ?? new Date(0).toISOString(),
      end_time: stringValue(row.end_time) ?? stringValue(row.start_time) ?? new Date(0).toISOString(),
      status: { code: statusCode(status?.code), ...(message ? { message } : {}) },
      attributes: attrs,
    }
  })
}

export function exportTraceEvidenceRows(
  rows: readonly unknown[],
  opts: TraceEvidenceExportOptions = {},
  wrapper?: JsonObject,
): TraceEvidenceExportResult {
  const format = detectFormat(rows, opts.format ?? 'auto')
  const spans =
    format === 'policy-evidence'
      ? policyEvidenceToSpans(requirePolicyEvidenceRows(rows))
      : format === 'openinference'
        ? openInferenceToSpans(requireOpenInferenceRows(rows))
        : sandboxEventsToSpans(requireObjectRows(rows), wrapper)
  if (spans.length === 0) throw new Error(`no spans exported from ${format} input`)
  const redacted = redactSpans(spans)
  return {
    format,
    spans: redacted.spans,
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
