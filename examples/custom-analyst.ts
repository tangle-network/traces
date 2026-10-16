/**
 * Run a deterministic custom analyst over a real session, or use --fixture for
 * a known three-error input whose output is stable enough to inspect.
 *
 *   pnpm tsx examples/custom-analyst.ts
 *   pnpm tsx examples/custom-analyst.ts --fixture
 *
 * Each name comes from its owner: the analyst contract from agent-eval, the
 * span builders from agent-trace-contract, and reading and analysis from
 * traces. The fixture is what a producer you control would emit: contract
 * spans, written as OTLP-JSONL and read back the way `traces analyze <file>`
 * reads them.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Analyst, AnalystRegistry, makeFinding } from '@tangle-network/agent-eval/analyst'
import type { TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { type ContractSpan, contractSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { analyzeSpans, type OtlpSpan, readOtlpInput, scanSessions } from '@tangle-network/traces'

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

const service = { 'service.name': 'example' }

export function knownBadSpans(): ContractSpan[] {
  const traceId = 'fixture-three-failures'
  const root = 'fixture-root'
  return [
    contractSpan({ traceId, spanId: root, name: 'session', kind: 'AGENT', startTime: '2026-01-01T00:00:00.000Z', attributes: service }),
    ...[1, 2, 3].map((attempt) =>
      toolSpan({
        traceId,
        spanId: `failed-${attempt}`,
        parentSpanId: root,
        name: 'tool.exec',
        toolName: 'exec',
        startTime: `2026-01-01T00:00:0${attempt}.000Z`,
        endTime: `2026-01-01T00:00:0${attempt}.100Z`,
        status: { code: 'STATUS_CODE_ERROR', message: `Command failed with exit code 127 on attempt ${attempt}` },
        attributes: { ...service, 'input.value': JSON.stringify({ command: 'missing-command' }) },
      }),
    ),
    contractSpan({
      traceId,
      spanId: 'unsupported-claim',
      parentSpanId: root,
      name: 'message.assistant',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:04.000Z',
      attributes: { ...service, content: 'Implemented successfully. Everything works.' },
    }),
  ]
}

export function knownGoodSpans(): ContractSpan[] {
  const traceId = 'fixture-verified-change'
  const root = 'fixture-root'
  return [
    contractSpan({ traceId, spanId: root, name: 'session', kind: 'AGENT', startTime: '2026-01-01T00:00:00.000Z', attributes: service }),
    toolSpan({
      traceId,
      spanId: 'edit-1',
      parentSpanId: root,
      name: 'tool.apply_patch',
      toolName: 'apply_patch',
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:01.100Z',
      status: { code: 'STATUS_CODE_OK' },
      attributes: { ...service, 'input.value': 'change code' },
    }),
    toolSpan({
      traceId,
      spanId: 'verify-1',
      parentSpanId: root,
      name: 'tool.exec',
      toolName: 'exec',
      startTime: '2026-01-01T00:00:02.000Z',
      endTime: '2026-01-01T00:00:02.100Z',
      status: { code: 'STATUS_CODE_OK' },
      attributes: { ...service, 'input.value': 'pnpm test', 'output.value': '12 tests passed' },
    }),
    contractSpan({
      traceId,
      spanId: 'answer-1',
      parentSpanId: root,
      name: 'message.assistant',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:03.000Z',
      attributes: { ...service, content: 'Implemented the change. pnpm test passed: 12/12.' },
    }),
  ]
}

/** Contract spans as traces reads them: written as OTLP-JSONL, then read back. */
async function readEmitted(spans: readonly ContractSpan[]): Promise<OtlpSpan[]> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-custom-analyst-'))
  try {
    const path = join(dir, 'spans.otlp.jsonl')
    await writeFile(path, `${spans.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
    return (await readOtlpInput(path)).spans
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The most recent session of the first harness on this machine that has one. */
async function newestSession(): Promise<OtlpSpan[]> {
  for await (const session of scanSessions({ last: 1 })) return session.spans
  throw new Error('no recent sessions found')
}

async function main(): Promise<void> {
  const registry = new AnalystRegistry()
  registry.register(failedToolAnalyst)

  const spans = process.argv.includes('--fixture')
    ? await readEmitted(knownBadSpans())
    : process.argv.includes('--good-fixture')
      ? await readEmitted(knownGoodSpans())
      : await newestSession()

  const { result } = await analyzeSpans(spans, { registry })
  console.log(JSON.stringify(result.findings, null, 2))
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
