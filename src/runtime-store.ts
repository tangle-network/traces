/**
 * Project normalized `OtlpSpan[]` onto agent-eval's runtime trace store.
 *
 * The behavioral/agentic analysts consume the OTLP analyst store; the
 * loop/waste pipelines (`stuckLoopView`, `toolWasteView`) and tool-use
 * metrics consume the runtime `TraceStore` (`Span` with `toolName`/`args`/
 * `startedAt`). This converter is the single bridge — one function, every
 * harness — so traces reuses those shipped detectors instead of
 * reimplementing loop/stall detection.
 *
 * Tool `args` is the captured OpenInference input value; `stuckLoopView`
 * hashes it (`argHash`) so identical repeated calls collapse to one finding.
 */

import { InMemoryTraceStore, type Span } from '@tangle-network/agent-eval'
import { toolArgumentsFromAttributes } from './adapters/tool-io.js'
import type { OtlpSpan, OtlpSpanKind } from './otlp.js'
import { validateOtlpSpans } from './span-validation.js'
import { parseIsoToEpochMs as ms } from './time.js'

/**
 * Contract span kind → runtime span kind.
 *
 * EVALUATOR and RETRIEVER map to `custom`, not to the runtime's `judge` /
 * `retrieval`: those shapes REQUIRE fields an OTLP span does not carry
 * (`judgeId`/`targetSpanId`/`dimension`/`score`, `query`/`hits`), so claiming
 * them would hand the pipelines a span with invented values. The OTLP-level
 * kind is preserved verbatim in `attributes`.
 */
const KIND: Record<OtlpSpanKind, Span['kind']> = {
  AGENT: 'agent',
  LLM: 'llm',
  TOOL: 'tool',
  CHAIN: 'custom',
  EVALUATOR: 'custom',
  RETRIEVER: 'custom',
  UNKNOWN: 'custom',
}

export interface RuntimeTrace {
  store: InMemoryTraceStore
  runIds: string[]
}

export async function toRuntimeStore(spans: readonly OtlpSpan[]): Promise<RuntimeTrace> {
  const validated = validateOtlpSpans(spans, 'runtime store input')
  const store = new InMemoryTraceStore()
  const runs = new Map<string, { startedAt: number; endedAt: number; failed: boolean }>()

  for (const item of validated) {
    const startedAt = ms(item.start_time)
    const endedAt = ms(item.end_time)
    const terminalFailure = item.parent_span_id === null && item.status.code === 'ERROR'
    const current = runs.get(item.trace_id)
    runs.set(item.trace_id, current
      ? {
          startedAt: Math.min(current.startedAt, startedAt),
          endedAt: Math.max(current.endedAt, endedAt),
          failed: current.failed || terminalFailure,
        }
      : { startedAt, endedAt, failed: terminalFailure })
  }

  for (const [runId, run] of runs) {
    await store.appendRun({
      runId,
      scenarioId: 'session',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      status: run.failed ? 'failed' : 'completed',
    })
  }

  for (const s of validated) {
    const kind = KIND[s.attributes['openinference.span.kind'] as OtlpSpanKind] ?? 'custom'
    const startedAt = ms(s.start_time)
    const endedAt = ms(s.end_time)
    const attributes = {
      ...s.attributes,
      'traces.source.trace_id': s.trace_id,
      'traces.source.span_id': s.span_id,
      ...(s.parent_span_id === null
        ? {}
        : { 'traces.source.parent_span_id': s.parent_span_id }),
    }
    const base = {
      spanId: runtimeSpanId(s.trace_id, s.span_id),
      parentSpanId:
        s.parent_span_id === null
          ? undefined
          : runtimeSpanId(s.trace_id, s.parent_span_id),
      runId: s.trace_id,
      name: s.name,
      startedAt,
      endedAt,
      status: s.status.code === 'ERROR' ? ('error' as const) : ('ok' as const),
      error: s.status.message,
      attributes,
    }

    const tool = kind === 'tool' ? toolArgumentsFromAttributes(s.attributes) : undefined
    const span: Span =
      kind === 'tool'
        ? ({
            ...base,
            kind: 'tool',
            toolName: String(s.attributes['tool.name'] ?? 'tool'),
            args: tool!.args,
            argsCaptured: tool!.argsCaptured,
            latencyMs: Math.max(0, endedAt - startedAt),
          } as Span)
        : ({ ...base, kind } as Span)

    await store.appendSpan(span)
  }

  return { store, runIds: [...runs.keys()] }
}

function runtimeSpanId(traceId: string, spanId: string): string {
  return `${encodeURIComponent(traceId)}:${encodeURIComponent(spanId)}`
}
