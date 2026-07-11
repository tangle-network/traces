import { describe, expect, it } from 'vitest'
import { span } from '../src/otlp.js'
import { runPipelines } from '../src/pipelines.js'

/** Build a tool call span with given name + identical input (→ same argHash). */
function toolCall(i: number, name: string, input: unknown, status: 'OK' | 'ERROR' = 'OK') {
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
      toolCall(1, 'write_stdin', { session_id: 7, chars: '' }),
      toolCall(2, 'write_stdin', { session_id: 7, chars: '' }),
      toolCall(3, 'write_stdin', { session_id: 7, chars: '' }),
      toolCall(4, 'wait', { cell_id: 'a' }),
      toolCall(5, 'wait', { cell_id: 'a' }),
      toolCall(6, 'wait', { cell_id: 'a' }),
    ]
    const r = await runPipelines(spans)
    expect(r.stuckLoops.findings).toHaveLength(0)
    expect(r.toolUse[0]!.totalCalls).toBe(6)
  })
})
