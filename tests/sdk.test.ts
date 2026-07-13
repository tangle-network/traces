import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
// Import through the public façade — this also asserts the library surface exports resolve.
import {
  AnalystRegistry,
  analyzeSpans,
  collectSessions,
  executeUpload,
  makeFinding,
  type HarnessTraceAdapter,
  type ObservedLoop,
  type OtlpSpan,
  type SessionRef,
  span,
  type UploadPlan,
  watchSessions,
} from '../src/index.js'

beforeAll(() => {
  // Isolate dedup-state writes from the real ~/.local/state.
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'traces-state-'))
})

const ref: SessionRef = { harness: 'synthetic', sessionId: 'sess-1', path: '/tmp/sess', cwd: null, mtimeMs: 0 }

function adapterOf(spans: OtlpSpan[]): HarnessTraceAdapter {
  return { harness: 'synthetic', async locate() { return [ref] }, async parse() { return spans } }
}

/** A root + N identical bash calls → a stuck loop the detector flags. */
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
        service: 'synthetic',
        tool: 'bash',
        content: 'ls -la',
      }),
    )
  }
  return out
}

describe('watchSessions (observer event API)', () => {
  it('emits onReport + a deduped onLoop over a custom adapter, and stops on abort', async () => {
    const controller = new AbortController()
    const loops: ObservedLoop[] = []
    let reports = 0
    await watchSessions({
      adapters: [adapterOf(loopSpans(4))],
      intervalMs: 250,
      minLoopOccurrences: 3,
      signal: controller.signal,
      onReport: () => { reports += 1 },
      onLoop: (l) => { loops.push(l) },
      onTick: () => controller.abort(), // one cycle, then stop
    })
    expect(reports).toBeGreaterThanOrEqual(1)
    expect(loops).toHaveLength(1)
    expect(loops[0]!.toolName).toBe('bash')
    expect(loops[0]!.occurrences).toBeGreaterThanOrEqual(3)
  })

  it('routes a throwing onLoop to onError instead of crashing the loop', async () => {
    const controller = new AbortController()
    const errors: unknown[] = []
    await watchSessions({
      adapters: [adapterOf(loopSpans(4))],
      intervalMs: 250,
      minLoopOccurrences: 3,
      signal: controller.signal,
      onLoop: () => { throw new Error('boom') },
      onError: (e) => errors.push(e),
      onTick: () => controller.abort(),
    })
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
  })
})

describe('collectSessions (batch seam)', () => {
  it('redacts by default and can return raw spans', async () => {
    const spans = [
      span({ traceId: 't', spanId: 's', name: 'tool.bash', kind: 'TOOL', startTime: '2026-01-01T00:00:00.000Z', service: 'synthetic', tool: 'bash', content: 'mail jane@acme.com' }),
    ]
    const adapter = adapterOf(spans)
    const [redacted] = await collectSessions({ adapters: [adapter] })
    expect(String(redacted!.spans[0]!.attributes.content)).toContain('[redacted:')
    expect(redacted!.redaction!.redactionCount).toBeGreaterThanOrEqual(1)

    const [raw] = await collectSessions({ adapters: [adapter], redact: false })
    expect(raw!.spans[0]!.attributes.content).toBe('mail jane@acme.com')
    expect(raw!.redaction).toBeUndefined()
  })
})

describe('executeUpload (pluggable backend)', () => {
  it('routes redacted spans to a custom backend and records dedup state', async () => {
    const spans = loopSpans(2)
    const plan: UploadPlan = {
      items: [{ ref: { ...ref, sessionId: 'sess-x' }, spans, redaction: { redactionCount: 0, byRule: {} }, hash: 'hash1', isNew: true }],
      state: {},
    }
    const calls: { count: number; key?: string }[] = []
    const res = await executeUpload(plan, {
      backend: {
        async ingestTraces(events, key) {
          calls.push({ count: events.length, key })
          return { accepted: events.length }
        },
      },
    })
    expect(res.uploadedSessions).toBe(1)
    expect(res.acceptedSpans).toBe(spans.length)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.key).toContain('sess-x')
    expect(plan.state['synthetic:sess-x']!.hash).toBe(calls[0]!.key!.split(':').at(-1))
    expect(plan.state['synthetic:sess-x']!.hash).not.toBe('hash1')
  })
})

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
})
