import { describe, expect, it } from 'vitest'
import { span } from '../src/otlp.js'
import { runPipelines } from '../src/pipelines.js'
import { renderPipelines } from '../src/report.js'

/** Build a tool call span with given name + identical input (→ same argHash). */
function toolCall(
  i: number,
  name: string,
  input: unknown,
  status: 'OK' | 'ERROR' = 'OK',
  extra?: Record<string, unknown>,
) {
  const startMs = 1_000 + i * 1000
  return span({
    traceId: 'sess',
    spanId: `t${i}`,
    parentSpanId: 'root',
    name: `tool.${name}`,
    kind: 'TOOL',
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(startMs + 100).toISOString(),
    status,
    service: 'claude-code',
    tool: name,
    step: i,
    extra: { 'input.value': JSON.stringify(input), ...extra },
  })
}

describe('runPipelines (reuses agent-eval stuckLoopView + computeToolUseMetrics)', () => {
  it('flags a stuck loop when a tool is called ≥3× with identical args', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      toolCall(1, 'bash', { cmd: 'npm test' }, 'ERROR'),
      toolCall(2, 'bash', { cmd: 'npm test' }, 'ERROR'),
      toolCall(3, 'bash', { cmd: 'npm test' }, 'ERROR'),
    ]
    const r = await runPipelines(spans)
    expect(r.stuckLoops.findings.length).toBe(1)
    expect(r.stuckLoops.findings[0]!.toolName).toBe('bash')
    expect(r.stuckLoops.findings[0]!.occurrences).toBe(3)
    expect(r.stuckLoops.affectedRunRatio).toBe(1)
    const text = renderPipelines(r)
    expect(text).toContain('Stuck loops')
    // identical repeated calls also show as duplicates + errors
    expect(r.toolUse[0]!.duplicateRate).toBeGreaterThan(0)
    expect(r.toolUse[0]!.errorRate).toBe(1)
    expect(r.toolUse[0]!.byTool.bash?.avgLatencyMs).toBe(100)
  })

  it('does not flag distinct calls as a loop', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      toolCall(1, 'bash', { cmd: 'ls' }),
      toolCall(2, 'bash', { cmd: 'cat a' }),
      toolCall(3, 'read', { path: 'b' }),
    ]
    const r = await runPipelines(spans)
    expect(r.stuckLoops.findings.length).toBe(0)
  })

  it('does not treat missing tool arguments as repeated calls', async () => {
    const spans = [
      span({
        traceId: 'sess',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'claude-code',
      }),
      toolCall(1, 'bash', undefined),
      toolCall(2, 'bash', undefined),
      toolCall(3, 'bash', undefined),
    ]

    const result = await runPipelines(spans)

    expect(result.stuckLoops.findings).toHaveLength(0)
    expect(result.toolUse[0]).toMatchObject({
      totalCalls: 3,
      callsWithCapturedArgs: 0,
      duplicateRate: 0,
    })
  })

  it('honors an explicit unavailable marker even when stale content exists', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      toolCall(1, 'bash', undefined, 'OK', { content: 'stale', 'tool.args_captured': false }),
      toolCall(2, 'bash', undefined, 'OK', { content: 'stale', 'tool.args_captured': false }),
      toolCall(3, 'bash', undefined, 'OK', { content: 'stale', 'tool.args_captured': false }),
    ]

    const result = await runPipelines(spans)

    expect(result.stuckLoops.findings).toHaveLength(0)
    expect(result.toolUse[0]).toMatchObject({
      callsWithCapturedArgs: 0,
      duplicateRate: 0,
    })
  })

  it('does not infer tool arguments from descriptive span content', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      toolCall(1, 'bash', undefined, 'OK', { content: 'same telemetry envelope' }),
      toolCall(2, 'bash', undefined, 'OK', { content: 'same telemetry envelope' }),
      toolCall(3, 'bash', undefined, 'OK', { content: 'same telemetry envelope' }),
    ]

    const result = await runPipelines(spans)

    expect(result.stuckLoops.findings).toHaveLength(0)
    expect(result.toolUse[0]).toMatchObject({ callsWithCapturedArgs: 0, duplicateRate: 0 })
  })

  it('compares captured no-argument calls', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      toolCall(1, 'list', undefined, 'OK', { 'tool.args_captured': true }),
      toolCall(2, 'list', undefined, 'OK', { 'tool.args_captured': true }),
      toolCall(3, 'list', undefined, 'OK', { 'tool.args_captured': true }),
    ]

    const result = await runPipelines(spans)

    expect(result.stuckLoops.findings).toHaveLength(1)
    expect(result.toolUse[0]).toMatchObject({
      callsWithCapturedArgs: 3,
      duplicateRate: 2 / 3,
    })
  })

  it('does not call repeated blocking waits a stuck loop', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'codex' }),
      toolCall(1, 'write_stdin', { session_id: 7, chars: '' }, 'OK', { 'traces.expected_blocking': true }),
      toolCall(2, 'write_stdin', { session_id: 7, chars: '' }, 'OK', { 'traces.expected_blocking': true }),
      toolCall(3, 'write_stdin', { session_id: 7, chars: '' }, 'OK', { 'traces.expected_blocking': true }),
      toolCall(4, 'wait', { cell_id: 'a' }, 'OK', { 'traces.expected_blocking': true }),
      toolCall(5, 'wait', { cell_id: 'a' }, 'OK', { 'traces.expected_blocking': true }),
      toolCall(6, 'wait', { cell_id: 'a' }, 'OK', { 'traces.expected_blocking': true }),
    ]
    const r = await runPipelines(spans)
    expect(r.stuckLoops.findings).toHaveLength(0)
    expect(r.toolUse[0]!.totalCalls).toBe(6)
  })

  it('still flags repeated domain waits that are not marked as expected blocking', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'other' }),
      toolCall(1, 'wait', { job_id: 7 }),
      toolCall(2, 'wait', { job_id: 7 }),
      toolCall(3, 'wait', { job_id: 7 }),
    ]
    const r = await runPipelines(spans)
    expect(r.stuckLoops.findings).toHaveLength(1)
    expect(r.stuckLoops.findings[0]!.toolName).toBe('wait')
    expect(r.stuckLoops.findings[0]!.occurrences).toBe(3)
  })

  it('does not combine identical calls separated by more than a minute', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      toolCall(1, 'bash', { cmd: 'npm test' }),
      toolCall(62, 'bash', { cmd: 'npm test' }),
      toolCall(123, 'bash', { cmd: 'npm test' }),
    ]

    expect((await runPipelines(spans)).stuckLoops.findings).toHaveLength(0)
  })

  it('reports retry follow-through against failed calls, not all calls', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'other' }),
      toolCall(1, 'bash', { cmd: 'false' }, 'ERROR'),
      toolCall(2, 'read', { path: 'a' }),
      toolCall(3, 'bash', { cmd: 'true' }),
    ]

    const text = renderPipelines(await runPipelines(spans))

    expect(text).toContain('1/3 failed; 1/1 failed calls followed by another same-tool call (100%)')
    expect(text).not.toContain('% retry')
  })

  it('clusters failed runs from any errored span without treating incomplete runs as failures', async () => {
    const spans = [
      span({
        traceId: 'failed',
        spanId: 'failed-root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:00:01.000Z',
      }),
      span({
        traceId: 'failed',
        spanId: 'failed-operation',
        parentSpanId: 'failed-root',
        name: 'tool.execution',
        kind: 'CHAIN',
        startTime: '2026-01-01T00:00:00.100Z',
        endTime: '2026-01-01T00:00:00.200Z',
        status: 'ERROR',
        statusMessage: 'Shell command failed',
      }),
      span({
        traceId: 'successful',
        spanId: 'successful-root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-01-01T00:00:02.000Z',
        endTime: '2026-01-01T00:00:03.000Z',
      }),
    ]

    const result = await runPipelines(spans)

    expect(result.failureClusters).toMatchObject({ totalFailures: 1, totalRuns: 2 })
    expect(result.failureClusters.clusters).toEqual([
      expect.objectContaining({
        failureClass: 'unknown',
        runCount: 1,
        exampleError: 'Shell command failed',
      }),
    ])
    const report = renderPipelines(result)
    expect(report).toContain('**Execution failures:** 1/2 run(s)')
    expect(report).toContain('| unknown | 1 | not captured | `failed` | Shell command failed |')
  })
})
