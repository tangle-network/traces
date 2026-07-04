import { describe, expect, it } from 'vitest'
import {
  analyzeLiveBatch,
  serializeTraceStreamEvent,
  span,
  streamSessions,
  traceStreamEventsFromSpans,
  type HarnessTraceAdapter,
  type OtlpSpan,
  type SessionRef,
  type TraceStreamEvent,
} from '../src/index.js'

const ref: SessionRef = {
  harness: 'synthetic',
  sessionId: 'sess-live',
  path: '/tmp/sess-live.jsonl',
  cwd: '/work/project',
  mtimeMs: Date.parse('2026-01-01T00:00:10.000Z'),
}

function liveSpans(): OtlpSpan[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  return [
    span({
      traceId: 'sess-live',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: new Date(base).toISOString(),
      service: 'synthetic',
      extra: { 'tangle.cwd': '/work/project' },
    }),
    span({
      traceId: 'sess-live',
      spanId: 'test-1',
      parentSpanId: 'root',
      name: 'tool.bash',
      kind: 'TOOL',
      startTime: new Date(base + 1_000).toISOString(),
      service: 'synthetic',
      tool: 'bash',
      content: 'pnpm test',
      status: 'ERROR',
      step: 1,
    }),
    span({
      traceId: 'sess-live',
      spanId: 'test-2',
      parentSpanId: 'root',
      name: 'tool.bash',
      kind: 'TOOL',
      startTime: new Date(base + 2_000).toISOString(),
      service: 'synthetic',
      tool: 'bash',
      content: 'pnpm test',
      status: 'ERROR',
      step: 2,
    }),
    span({
      traceId: 'sess-live',
      spanId: 'test-3',
      parentSpanId: 'root',
      name: 'tool.bash',
      kind: 'TOOL',
      startTime: new Date(base + 3_000).toISOString(),
      service: 'synthetic',
      tool: 'bash',
      content: 'pnpm test',
      status: 'ERROR',
      step: 3,
    }),
    span({
      traceId: 'sess-live',
      spanId: 'claim-1',
      parentSpanId: 'root',
      name: 'assistant.message',
      kind: 'LLM',
      startTime: new Date(base + 4_000).toISOString(),
      service: 'synthetic',
      content: 'Done. The bug is fixed and tests pass.',
      step: 4,
    }),
  ]
}

describe('live trace intelligence', () => {
  it('turns an online span batch into semantic findings beyond identical-tool alerts', () => {
    const batch = analyzeLiveBatch(liveSpans(), {
      generatedAt: '2026-01-01T00:00:05.000Z',
      session: { harness: 'synthetic', sessionId: 'sess-live', cwd: '/work/project', path: ref.path },
    })

    expect(batch.kind).toBe('traces.live_batch')
    expect(batch.toolCallCount).toBe(3)
    expect(batch.erroredToolCallCount).toBe(3)
    expect(batch.verificationCallCount).toBe(3)
    expect(batch.findings.map((f) => f.ruleId).sort()).toEqual([
      'completion-claim-without-verification',
      'same-failing-command',
      'verification-without-change',
    ])
    const repeated = batch.findings.find((f) => f.ruleId === 'same-failing-command')
    expect(repeated?.action).toContain('Stop rerunning it')
    expect(repeated?.evidence[0]?.spanIds).toEqual(['test-1', 'test-2', 'test-3'])
  })

  it('builds replayable JSONL stream events for visualizers and downstream agents', () => {
    const events = traceStreamEventsFromSpans(liveSpans(), {
      ref,
      generatedAt: '2026-01-01T00:00:05.000Z',
    })

    expect(events[0]?.event).toBe('session')
    expect(events.filter((event) => event.event === 'span')).toHaveLength(liveSpans().length)
    expect(events.some((event) => event.event === 'analysis_batch')).toBe(true)
    expect(events.filter((event) => event.event === 'finding')).toHaveLength(3)
    const line = serializeTraceStreamEvent(events.find((event) => event.event === 'finding')!)
    expect(JSON.parse(line).finding.ruleId).toBeTruthy()
  })

  it('streams live sessions without re-emitting unchanged span pulses across ticks', async () => {
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [ref]
      },
      async parse() {
        return liveSpans()
      },
    }
    const controller = new AbortController()
    const events: TraceStreamEvent[] = []
    let ticks = 0
    await streamSessions({
      adapters: [adapter],
      intervalMs: 250,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.event === 'tick') {
          ticks += 1
          if (ticks === 2) controller.abort()
        }
      },
    })

    expect(events.filter((event) => event.event === 'span')).toHaveLength(liveSpans().length)
    expect(events.filter((event) => event.event === 'analysis_batch')).toHaveLength(2)
    expect(events.filter((event) => event.event === 'finding')).toHaveLength(3)
  })
})
