import { describe, expect, it } from 'vitest'
import { ATTR } from '../src/attributes.js'
import {
  buildPolicyEvidenceRecord,
  collectPolicyEvidence,
  serializePolicyEvidence,
} from '../src/evidence.js'
import { span } from '../src/otlp.js'
import type { OtlpSpan } from '../src/otlp.js'
import type { HarnessTraceAdapter, SessionRef } from '../src/types.js'

const ref: SessionRef = {
  harness: 'synthetic',
  sessionId: 'sess-policy',
  path: '/tmp/sess-policy.jsonl',
  cwd: '/work/agent-lab',
  mtimeMs: 1_800_000_000_000,
}

function policySpans(): OtlpSpan[] {
  const repo = {
    [ATTR.SUBJECT_KEY]: 'github.com/tangle-network/agent-lab',
    [ATTR.GIT_REPOSITORY]: 'github.com/tangle-network/agent-lab',
    [ATTR.GIT_BRANCH_NAME]: 'research/x',
    [ATTR.GIT_COMMIT]: 'abc1234',
    [ATTR.CWD]: '/work/agent-lab',
    [ATTR.REPO_RESOLUTION_SOURCE]: 'span-path',
  }
  return [
    span({
      traceId: 'sess-policy',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-06-26T00:00:00.000Z',
      service: 'codex',
      extra: repo,
    }),
    span({
      traceId: 'sess-policy',
      spanId: 'llm-1',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-06-26T00:00:01.000Z',
      service: 'codex',
      model: 'glm-5.2',
      inputTokens: 100,
      outputTokens: 20,
      extra: repo,
    }),
    ...[1, 2, 3].map((i) =>
      span({
        traceId: 'sess-policy',
        spanId: `tool-${i}`,
        parentSpanId: 'llm-1',
        name: 'tool.bash',
        kind: 'TOOL',
        startTime: `2026-06-26T00:00:0${i + 1}.000Z`,
        service: 'codex',
        tool: 'bash',
        status: 'ERROR',
        extra: { ...repo, 'input.value': JSON.stringify({ cmd: 'pnpm test' }) },
      })),
  ]
}

describe('policy evidence export', () => {
  it('summarizes a session as miner-ready evidence, not a campaign cell', async () => {
    const record = await buildPolicyEvidenceRecord(ref, policySpans(), {
      generatedAt: '2026-06-26T00:00:10.000Z',
      otlpPath: '/tmp/spans.otlp.jsonl',
    })

    expect(record.kind).toBe('traces.policy_evidence.session')
    expect(record.session.sessionId).toBe('sess-policy')
    expect(record.repo.subjectKey).toBe('github.com/tangle-network/agent-lab')
    expect(record.repo.branch).toBe('research/x')
    expect(record.repo.resolutionSource).toBe('span-path')
    expect(record.metrics.spanCount).toBe(5)
    expect(record.metrics.llmTurnCount).toBe(1)
    expect(record.metrics.toolCallCount).toBe(3)
    expect(record.metrics.erroredToolCallCount).toBe(3)
    expect(record.metrics.inputTokens).toBe(100)
    expect(record.metrics.outputTokens).toBe(20)
    expect(record.metrics.models).toEqual(['glm-5.2@otlp'])
    expect(record.metrics.tools).toEqual([{ name: 'bash', calls: 3, errors: 3 }])
    expect(record.signals.stuckLoopCount).toBe(1)
    expect(record.signals.stuckLoops[0]).toEqual({ toolName: 'bash', occurrences: 3 })
    expect(record.signals.stuckLoopsOmitted).toBe(0)
    expect(record.signals.toolErrorRate).toBe(1)
    expect(record.provenance.notCampaignCell).toBe(true)
    expect(record.provenance.otlpPath).toBe('/tmp/spans.otlp.jsonl')

    const [line] = serializePolicyEvidence([record]).trim().split('\n')
    expect(JSON.parse(line!).provenance.notCampaignCell).toBe(true)
  })

  it('uses resolved span cwd for the session row when the source ref cwd was missing', async () => {
    const record = await buildPolicyEvidenceRecord(
      { ...ref, cwd: null },
      policySpans(),
      { generatedAt: '2026-06-26T00:00:10.000Z' },
    )

    expect(record.session.cwd).toBe('/work/agent-lab')
    expect(record.repo.cwd).toBe('/work/agent-lab')
  })

  it('collects policy evidence through the public scan path', async () => {
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [ref]
      },
      async parse() {
        return policySpans()
      },
    }

    const [record] = await collectPolicyEvidence({
      adapters: [adapter],
      generatedAt: '2026-06-26T00:00:10.000Z',
    })
    expect(record?.session.harness).toBe('synthetic')
    expect(record?.metrics.toolCallCount).toBe(3)
  })
})
