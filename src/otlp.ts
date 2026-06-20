/**
 * OTLP-flat-line emitter — the canonical normalized trace shape.
 *
 * Every harness adapter projects its native session log onto `OtlpSpan[]`
 * and we serialize one span per JSONL line. This is the exact wire shape
 * `@tangle-network/agent-eval`'s `OtlpFileTraceStore` indexes
 * (`projectOtlpFlatLine` + `extractOtlpAttributes`). It is a flat subset, NOT
 * canonical OpenInference (kind lives in attributes; no resource/scope; root
 * parent is null) — external OpenInference engines like HALO need the canonical
 * form, which `external.ts` `toCanonicalOpenInference` produces.
 *
 * Attribute vocabulary the downstream analysts key off:
 *   - `openinference.span.kind`  → span kind (AGENT | LLM | TOOL | CHAIN)
 *   - `service.name`             → harness id (claude-code, codex, …)
 *   - `agent.name`               → agent / subagent name
 *   - `llm.model_name`           → model
 *   - `llm.input_tokens` / `llm.output_tokens` → behavioral token trajectories
 *   - `tool.name`                → tool histogram (monoculture / no-verify)
 *   - `step`                     → run order (falls back to start_time)
 */

export type OtlpSpanKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN' | 'SPAN'

export type OtlpStatusCode = 'OK' | 'ERROR' | 'UNSET'

export interface OtlpSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  start_time: string
  end_time: string
  status: { code: OtlpStatusCode; message?: string }
  attributes: Record<string, unknown>
}

export interface SpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string | null
  name: string
  kind: OtlpSpanKind
  startTime: string
  /** Defaults to startTime when the source has no explicit end. */
  endTime?: string
  status?: OtlpStatusCode
  statusMessage?: string
  service?: string | null
  agent?: string | null
  model?: string | null
  tool?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  /** Run-order pivot; the behavioral analyst orders trajectories by this. */
  step?: number
  /** Verbatim content the agentic analysts read via regex search. */
  content?: string | null
  /** Extra attributes merged last (escape hatch for harness-specific signal). */
  extra?: Record<string, unknown>
}

/**
 * Build one OTLP span line from a harness event. Only sets attribute keys
 * that carry real signal — an absent token count is omitted, not zeroed,
 * so the behavioral analyst's "no LLM data" case stays honest.
 */
export function span(input: SpanInput): OtlpSpan {
  const attributes: Record<string, unknown> = {
    'openinference.span.kind': input.kind,
  }
  if (input.service != null) attributes['service.name'] = input.service
  if (input.agent != null) attributes['agent.name'] = input.agent
  if (input.model != null) attributes['llm.model_name'] = input.model
  if (input.tool != null) attributes['tool.name'] = input.tool
  if (input.inputTokens != null) attributes['llm.input_tokens'] = input.inputTokens
  if (input.outputTokens != null) attributes['llm.output_tokens'] = input.outputTokens
  if (input.step != null) attributes.step = input.step
  if (input.content != null && input.content.length > 0) attributes['content'] = input.content
  if (input.extra) Object.assign(attributes, input.extra)

  const status: OtlpSpan['status'] = { code: input.status ?? 'OK' }
  if (input.statusMessage && input.statusMessage.length > 0) status.message = input.statusMessage

  return {
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId ?? null,
    name: input.name,
    start_time: input.startTime,
    end_time: input.endTime ?? input.startTime,
    status,
    attributes,
  }
}

/** Serialize spans to OTLP-JSONL (one span per line, trailing newline). */
export function serializeSpans(spans: readonly OtlpSpan[]): string {
  if (spans.length === 0) return ''
  return `${spans.map((s) => JSON.stringify(s)).join('\n')}\n`
}

/** Write spans to an OTLP-JSONL file (a temp file when no path is given). */
export async function writeOtlpFile(spans: readonly OtlpSpan[], outPath?: string): Promise<string> {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-')), 'spans.otlp.jsonl')
  await writeFile(path, serializeSpans(spans), 'utf8')
  return path
}
