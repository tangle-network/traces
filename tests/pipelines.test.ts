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
  return span({
    traceId: 'sess',
    spanId: `t${i}`,
    parentSpanId: 'root',
    name: `tool.${name}`,
    kind: 'TOOL',
    startTime: new Date(1_000 + i * 1000).toISOString(),
    status,
    service: 'claude-code',
    tool: name,
    content: JSON.stringify(input),
    step: i,
    extra,
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
    // identical repeated calls also show as duplicates + errors
    expect(r.toolUse[0]!.duplicateRate).toBeGreaterThan(0)
    expect(r.toolUse[0]!.errorRate).toBe(1)
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

  it('reports retry follow-through against failed calls, not all calls', async () => {
    const spans = [
      span({ traceId: 'sess', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'other' }),
      toolCall(1, 'bash', { cmd: 'false' }, 'ERROR'),
      toolCall(2, 'read', { path: 'a' }),
      toolCall(3, 'bash', { cmd: 'true' }),
    ]

    const text = renderPipelines(await runPipelines(spans))

    expect(text).toContain('1/3 failed; 1/1 failed calls were followed by another call to that tool')
    expect(text).not.toContain('% retry')
  })
})
