import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { AnalystRegistry, makeFinding } from '@tangle-network/agent-eval/analyst'
// The SDK through its public façade; the analyst extension point's types come from their owner, agent-eval.
import { analyzeSpans, type OtlpSpan } from '../src/index.js'
import { span } from '../src/otlp.js'

beforeAll(() => {
  // Isolate dedup-state writes from the real ~/.local/state.
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'traces-state-'))
})

/** A root + N identical bash calls that the loop detector flags. */
function loopSpans(n: number): OtlpSpan[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  const out: OtlpSpan[] = [
    span({ traceId: 't', spanId: 'root', name: 'session', kind: 'AGENT', startTime: '2026-01-01T00:00:00.000Z', service: 'synthetic' }),
  ]
  for (let i = 0; i < n; i++) {
    out.push(
      span({
        traceId: 't',
        spanId: `tool-${i}`,
        parentSpanId: 'root',
        name: 'tool.bash',
        kind: 'TOOL',
        startTime: new Date(base + (i + 1) * 1000).toISOString(),
        endTime: new Date(base + (i + 1) * 1000 + 100).toISOString(),
        service: 'synthetic',
        tool: 'bash',
        extra: { 'input.value': 'ls -la' },
      }),
    )
  }
  return out
}

function tokenTrajectorySpans(
  inputs: readonly (number | null)[],
  outputs: readonly (number | null)[],
): OtlpSpan[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  return [
    span({
      traceId: 'token-trend',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: new Date(base).toISOString(),
      service: 'synthetic',
    }),
    ...inputs.map((inputTokens, index) =>
      span({
        traceId: 'token-trend',
        spanId: `llm-${index}`,
        parentSpanId: 'root',
        name: 'llm.turn',
        kind: 'LLM',
        startTime: new Date(base + (index + 1) * 1000).toISOString(),
        endTime: new Date(base + (index + 1) * 1000 + 100).toISOString(),
        service: 'synthetic',
        inputTokens,
        outputTokens: outputs[index],
        step: index,
      })),
  ]
}

describe('analyzeSpans (bring-your-own analysts)', () => {
  it('runs a caller-supplied AnalystRegistry instead of the built-in suite', async () => {
    const registry = new AnalystRegistry()
    registry.register({
      id: 'my-analyst',
      description: 'a custom third-party analyst',
      inputKind: 'trace-store',
      cost: { kind: 'deterministic' },
      version: '1.0.0',
      async analyze() {
        return [makeFinding({ analyst_id: 'my-analyst', area: 'custom', claim: 'hello from my analyst', severity: 'info', evidence_refs: [], confidence: 0.9 })]
      },
    })
    const { result } = await analyzeSpans(loopSpans(2), { registry })
    expect(result.findings.some((f) => f.claim === 'hello from my analyst')).toBe(true)
  })

  it('forwards one cancellation signal through custom analyst runs', async () => {
    const controller = new AbortController()
    const reason = new Error('stop custom analysis')
    const registry = new AnalystRegistry()
    let observedSignal: AbortSignal | undefined
    registry.register({
      id: 'cancellable-analyst',
      description: 'observes cancellation',
      inputKind: 'trace-store',
      cost: { kind: 'deterministic' },
      version: '1.0.0',
      async analyze(_store, context) {
        observedSignal = context.signal
        controller.abort(reason)
        return []
      },
    })

    await expect(
      analyzeSpans(loopSpans(2), { registry, signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(observedSignal).toBe(controller.signal)
  })

  it('rejects endpoint-only token trends when the session contains compaction resets and output increases', async () => {
    const inputs = [25_073, 100_000, 240_000, 30_000, 120_000, 210_878]
    const outputs = [934, 150, 1_200, 120, 900, 137]
    expect(inputs.at(-1)! / inputs[0]!).toBeGreaterThan(3)
    expect(outputs.at(-1)).toBeLessThan(outputs[0]!)
    expect(inputs.some((value, index) => index > 0 && value < inputs[index - 1]!)).toBe(true)
    expect(outputs.some((value, index) => index > 0 && value > outputs[index - 1]!)).toBe(true)

    const { result } = await analyzeSpans(tokenTrajectorySpans(inputs, outputs))
    const subjects = result.findings.map((finding) => finding.subject)
    expect(subjects).not.toContain('monotonic-input-growth')
    expect(subjects).not.toContain('output-length-decay')
    const behavioral = result.per_analyst.find((item) => item.analyst_id === 'efficiency-behavioral')
    expect(behavioral?.findings_count).toBe(
      result.findings.filter((finding) => finding.analyst_id === 'efficiency-behavioral').length,
    )
  })

  it('retains token findings when every paired transition supports the stated trend', async () => {
    const { result } = await analyzeSpans(
      tokenTrajectorySpans([100, 200, 300, 400, 500], [500, 400, 300, 200, 100]),
    )
    const subjects = result.findings.map((finding) => finding.subject)
    expect(subjects).toContain('monotonic-input-growth')
    expect(subjects).toContain('output-length-decay')
  })

  it('rejects output decay when no paired input trajectory supports the context claim', async () => {
    const { result } = await analyzeSpans(
      tokenTrajectorySpans([null, null, null], [400, 200, 100]),
    )
    expect(result.findings.map((finding) => finding.subject)).not.toContain('output-length-decay')
  })
})
