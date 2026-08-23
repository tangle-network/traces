import { describe, expect, it } from 'vitest'
import { classifyFailureFollowUps } from '../src/failure-followup.js'
import { span } from '../src/otlp.js'
import { runPipelines } from '../src/pipelines.js'
import { renderPipelines } from '../src/report.js'

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
    extra: input === undefined
      ? { ...extra }
      : { 'input.value': JSON.stringify(input), ...extra },
  })
}

const root = span({
  traceId: 'sess',
  spanId: 'root',
  name: 'session',
  kind: 'AGENT',
  startTime: new Date(0).toISOString(),
  service: 'claude-code',
})

describe('classifyFailureFollowUps', () => {
  it('labels an identical re-send after a failure as blind', () => {
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', { cmd: 'npm test' }, 'ERROR'),
      toolCall(2, 'bash', { cmd: 'npm test' }),
    ])
    expect(r.failures).toBe(1)
    expect(r.followed).toBe(1)
    expect(r.blind).toBe(1)
    expect(r.adapted).toBe(0)
    expect(r.followUpSucceeded).toBe(1)
    expect(r.blindByTool).toEqual({ bash: 1 })
    expect(r.items[0]).toMatchObject({ kind: 'blind', toolName: 'bash', followUpSucceeded: true })
  })

  it('labels a changed-args follow-up as adapted', () => {
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', { cmd: 'npm test' }, 'ERROR'),
      toolCall(2, 'bash', { cmd: 'npm test -- --run' }),
    ])
    expect(r.blind).toBe(0)
    expect(r.adapted).toBe(1)
    expect(r.followUpSucceeded).toBe(1)
  })

  it('classifies the next call of the SAME tool, skipping other tools between', () => {
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', { cmd: 'false' }, 'ERROR'),
      toolCall(2, 'read', { path: 'a' }),
      toolCall(3, 'bash', { cmd: 'false' }, 'ERROR'),
    ])
    // First bash failure's follow-up is the identical bash call at step 3,
    // which itself failed and was never followed.
    expect(r.failures).toBe(2)
    expect(r.followed).toBe(1)
    expect(r.blind).toBe(1)
    expect(r.followUpSucceeded).toBe(0)
    expect(r.items.find((item) => item.failedSpanId === 't3')?.kind).toBe('none')
  })

  it('reports a failure with no later same-tool call as none', () => {
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', { cmd: 'false' }, 'ERROR'),
      toolCall(2, 'read', { path: 'a' }),
    ])
    expect(r.failures).toBe(1)
    expect(r.followed).toBe(0)
    expect(r.items[0]).toMatchObject({ kind: 'none', followUpSpanId: null, followUpSucceeded: null })
  })

  it('marks pairs without captured args as not comparable, never guessed', () => {
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', undefined, 'ERROR'),
      toolCall(2, 'bash', undefined),
    ])
    expect(r.argsUnknown).toBe(1)
    expect(r.blind).toBe(0)
    expect(r.adapted).toBe(0)
  })

  it('prefers the full-input sha256 over a truncated input.value', () => {
    // Same full input on both sides (same sha), but the captured raw text
    // differs because one side was truncated — sha decides: blind.
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', { cmd: 'long command…[a]' }, 'ERROR', { 'traces.input.sha256': 'abc' }),
      toolCall(2, 'bash', { cmd: 'long command…[b]' }, 'OK', { 'traces.input.sha256': 'abc' }),
    ])
    expect(r.blind).toBe(1)
    expect(r.adapted).toBe(0)
  })

  it('excludes expected-blocking failures — an identical re-poll is the protocol working', () => {
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'wait', { job: 7 }, 'ERROR', { 'traces.expected_blocking': true }),
      toolCall(2, 'wait', { job: 7 }, 'ERROR', { 'traces.expected_blocking': true }),
      toolCall(3, 'wait', { job: 7 }, 'OK', { 'traces.expected_blocking': true }),
    ])
    expect(r.failures).toBe(0)
    expect(r.items).toHaveLength(0)
  })

  it('never pairs a failure with a call from another trace', () => {
    const other = span({
      traceId: 'other',
      spanId: 'o1',
      name: 'tool.bash',
      kind: 'TOOL',
      startTime: new Date(5_000).toISOString(),
      status: 'OK',
      service: 'claude-code',
      tool: 'bash',
      step: 1,
      extra: { 'input.value': JSON.stringify({ cmd: 'false' }) },
    })
    const r = classifyFailureFollowUps([
      root,
      toolCall(1, 'bash', { cmd: 'false' }, 'ERROR'),
      other,
    ])
    expect(r.followed).toBe(0)
    expect(r.items[0]?.kind).toBe('none')
  })
})

describe('renderPipelines with failure follow-ups', () => {
  it('splits the follow-up count into blind vs adapted and names blind offenders', async () => {
    const r = await runPipelines([
      root,
      toolCall(1, 'bash', { cmd: 'npm test' }, 'ERROR'),
      toolCall(2, 'bash', { cmd: 'npm test' }),
      toolCall(3, 'bash', { cmd: 'false' }, 'ERROR'),
      toolCall(4, 'bash', { cmd: 'true' }),
    ])
    const text = renderPipelines(r)
    expect(text).toContain(
      '2/2 failed calls followed by another same-tool call (100%) — 1 blind (identical args), 1 adapted (changed args); 2/2 follow-ups succeeded',
    )
    expect(text).toContain('Blind retries (same args re-sent after a failure): `bash` ×1')
  })

  it('omits the blind-retry line when every follow-up adapted', async () => {
    const r = await runPipelines([
      root,
      toolCall(1, 'bash', { cmd: 'false' }, 'ERROR'),
      toolCall(2, 'bash', { cmd: 'true' }),
    ])
    const text = renderPipelines(r)
    expect(text).toContain('1/1 failed calls followed by another same-tool call (100%) — 0 blind (identical args), 1 adapted (changed args)')
    expect(text).not.toContain('Blind retries')
  })
})
