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
 * Tool `args` is the verbatim tool input we stored on the span's `content`;
 * `stuckLoopView` hashes it (`argHash`) so identical repeated calls collapse
 * to one loop finding.
 */

import { InMemoryTraceStore } from '@tangle-network/agent-eval'
import type { Run, Span } from '@tangle-network/agent-eval'
import type { OtlpSpan, OtlpSpanKind } from './otlp.js'

const KIND: Record<OtlpSpanKind, Span['kind']> = {
  AGENT: 'agent',
  LLM: 'llm',
  TOOL: 'tool',
  CHAIN: 'custom',
  SPAN: 'custom',
}

function ms(iso: string): number {
  const n = Date.parse(iso)
  return Number.isNaN(n) ? 0 : n
}

export interface RuntimeTrace {
  store: InMemoryTraceStore
  runIds: string[]
}

export async function toRuntimeStore(spans: readonly OtlpSpan[]): Promise<RuntimeTrace> {
  const store = new InMemoryTraceStore()
  const runIds = new Set<string>()

  for (const s of spans) {
    if (!runIds.has(s.trace_id)) {
      runIds.add(s.trace_id)
      await store.appendRun({ runId: s.trace_id, scenarioId: 'session' } as Run)
    }

    const kind = KIND[s.attributes['openinference.span.kind'] as OtlpSpanKind] ?? 'custom'
    const base = {
      spanId: s.span_id,
      parentSpanId: s.parent_span_id ?? undefined,
      runId: s.trace_id,
      name: s.name,
      startedAt: ms(s.start_time),
      endedAt: ms(s.end_time),
      status: s.status.code === 'ERROR' ? ('error' as const) : ('ok' as const),
      error: s.status.message,
      attributes: s.attributes,
    }

    const span: Span =
      kind === 'tool'
        ? ({
            ...base,
            kind: 'tool',
            toolName: String(s.attributes['tool.name'] ?? 'tool'),
            args: s.attributes.content ?? '',
          } as Span)
        : ({ ...base, kind } as Span)

    await store.appendSpan(span)
  }

  return { store, runIds: [...runIds] }
}
