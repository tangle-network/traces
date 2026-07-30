/**
 * Run a deterministic custom analyst over a real session, or use --fixture for
 * a known three-error input whose output is stable enough to inspect.
 *
 *   pnpm tsx examples/custom-analyst.ts
 *   pnpm tsx examples/custom-analyst.ts --fixture
 */
import {
  AnalystRegistry,
  type Analyst,
  analyzeSpans,
  collectSessions,
  makeFinding,
  type OtlpSpan,
  span,
  type TraceAnalysisStore,
} from '@tangle-network/traces'

export const failedToolAnalyst: Analyst<TraceAnalysisStore> = {
  id: 'failed-tool-clusters',
  description: 'Groups failed spans by stable error signature and cites one exact span per group.',
  inputKind: 'trace-store',
  cost: { kind: 'deterministic' },
  version: '1.0.0',
  async analyze(store) {
    const overview = await store.getOverview({ has_errors: true })
    return overview.error_clusters.map((cluster) => {
      const traceId = cluster.exemplar_trace_ids[0]
      const spanId = cluster.exemplar_span_ids[0]
      return makeFinding({
        analyst_id: 'failed-tool-clusters',
        area: 'tool-use',
        subject: cluster.signature,
        claim: `${cluster.span_count} failed span(s) share the error: ${cluster.status_message_sample}`,
        rationale: `The error affected ${cluster.trace_count}/${overview.errors.trace_count} trace(s) with errors.`,
        severity: cluster.span_count >= 3 ? 'high' : 'medium',
        evidence_refs: traceId && spanId
          ? [{
              kind: 'span',
              uri: `trace://${encodeURIComponent(traceId)}/span/${encodeURIComponent(spanId)}`,
              excerpt: cluster.status_message_sample,
            }]
          : [],
        recommended_action: `Fix or change the retry policy for ${cluster.tool_name ?? cluster.span_name ?? 'the failing operation'}.`,
        validation_plan: 'Rerun the same task and confirm this error signature is absent.',
        confidence: 1,
        metadata: {
          deterministic: true,
          signature: cluster.signature,
          trace_count: cluster.trace_count,
          span_count: cluster.span_count,
        },
        id_basis: cluster.signature,
      })
    })
  },
}

export function knownBadSpans(): OtlpSpan[] {
  const root = 'fixture-root'
  return [
    span({
      traceId: 'fixture-three-failures',
      spanId: root,
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
      service: 'example',
    }),
    ...[1, 2, 3].map((attempt) =>
      span({
        traceId: 'fixture-three-failures',
        spanId: `failed-${attempt}`,
        parentSpanId: root,
        name: 'tool.exec',
        kind: 'TOOL',
        startTime: `2026-01-01T00:00:0${attempt}.000Z`,
        endTime: `2026-01-01T00:00:0${attempt}.100Z`,
        status: 'ERROR',
        statusMessage: `Command failed with exit code 127 on attempt ${attempt}`,
        service: 'example',
        tool: 'exec',
        step: attempt,
        extra: { 'input.value': JSON.stringify({ command: 'missing-command' }) },
      }),
    ),
    span({
      traceId: 'fixture-three-failures',
      spanId: 'unsupported-claim',
      parentSpanId: root,
      name: 'message.assistant',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:04.000Z',
      service: 'example',
      step: 4,
      content: 'Implemented successfully. Everything works.',
    }),
  ]
}

export function knownGoodSpans(): OtlpSpan[] {
  const root = 'fixture-root'
  return [
    span({
      traceId: 'fixture-verified-change',
      spanId: root,
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
      service: 'example',
    }),
    span({
      traceId: 'fixture-verified-change',
      spanId: 'edit-1',
      parentSpanId: root,
      name: 'tool.apply_patch',
      kind: 'TOOL',
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:01.100Z',
      service: 'example',
      tool: 'apply_patch',
      step: 1,
      extra: { 'input.value': 'change code' },
    }),
    span({
      traceId: 'fixture-verified-change',
      spanId: 'verify-1',
      parentSpanId: root,
      name: 'tool.exec',
      kind: 'TOOL',
      startTime: '2026-01-01T00:00:02.000Z',
      endTime: '2026-01-01T00:00:02.100Z',
      service: 'example',
      tool: 'exec',
      step: 2,
      extra: {
        'input.value': 'pnpm test',
        'output.value': '12 tests passed',
      },
    }),
    span({
      traceId: 'fixture-verified-change',
      spanId: 'answer-1',
      parentSpanId: root,
      name: 'message.assistant',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:03.000Z',
      service: 'example',
      step: 3,
      content: 'Implemented the change. pnpm test passed: 12/12.',
    }),
  ]
}

async function main(): Promise<void> {
  const registry = new AnalystRegistry()
  registry.register(failedToolAnalyst)

  let spans: readonly OtlpSpan[]
  if (process.argv.includes('--fixture')) {
    spans = knownBadSpans()
  } else if (process.argv.includes('--good-fixture')) {
    spans = knownGoodSpans()
  } else {
    const [session] = await collectSessions({ all: true, last: 1, redact: false })
    if (!session) throw new Error('no recent sessions found')
    spans = session.spans
  }

  const { result } = await analyzeSpans(spans, { registry })
  console.log(JSON.stringify(result.findings, null, 2))
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
