import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { span } from '../src/otlp.js'
import { redactSpans } from '../src/redact.js'
import { executeUpload, toTraceSpanEvents } from '../src/upload.js'
import { alreadyUploaded, sessionHash, uploadKey } from '../src/upload-state.js'

const root = () =>
  span({ traceId: 't', spanId: 'root', name: 'session', kind: 'AGENT', startTime: '2026-01-01T00:00:00.000Z', service: 'claude-code' })

function toolSpan(content: string) {
  return span({
    traceId: 't',
    spanId: 's1',
    parentSpanId: 'root',
    name: 'tool.bash',
    kind: 'TOOL',
    startTime: '2026-01-01T00:00:01.000Z',
    service: 'claude-code',
    tool: 'bash',
    content,
  })
}

describe('redactSpans', () => {
  it('scrubs secrets/PII from span attributes and reports per-rule counts', () => {
    const { spans, report } = redactSpans([
      toolSpan('curl -H "Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" https://x; mail jane@acme.com'),
    ])
    const content = String(spans[0]!.attributes.content)
    expect(content).not.toContain('ghp_0123456789')
    expect(content).not.toContain('jane@acme.com')
    expect(content).toMatch(/\[redacted:/)
    expect(report.redactionCount).toBeGreaterThanOrEqual(2)
    expect(Object.keys(report.byRule)).toEqual(expect.arrayContaining(['email']))
  })

  it('leaves benign content untouched', () => {
    const { spans, report } = redactSpans([toolSpan('ls -la && npm test')])
    expect(spans[0]!.attributes.content).toBe('ls -la && npm test')
    expect(report.redactionCount).toBe(0)
  })

  it('scrubs credentials embedded in URLs (userinfo + secret query params)', () => {
    const { spans } = redactSpans([
      toolSpan('git clone https://bob:p4ssw0rd-secret@github.com/x/y.git; curl "https://api.x.com/v1?api_key=ABCDEF123456&page=2"'),
    ])
    const c = String(spans[0]!.attributes.content)
    expect(c).not.toContain('p4ssw0rd-secret')
    expect(c).not.toContain('ABCDEF123456')
    expect(c).toContain('page=2') // non-secret params survive
  })
})

describe('executeUpload --no-content', () => {
  const item = (content: string) => ({
    ref: { harness: 'claude-code', sessionId: 'sess1', path: '/x', cwd: null, mtimeMs: 0 },
    spans: [span({ traceId: 't', spanId: 'u', name: 'user.prompt', kind: 'CHAIN' as const, startTime: '2026-01-01T00:00:00.000Z', content })],
    redaction: { redactionCount: 0, byRule: {} },
    hash: 'h1',
    isNew: true,
  })

  it('strips prompt/response content from the OTLP that would be sent', async () => {
    const plan = { items: [item('my secret prompt text')], state: {} }
    const kept = join(tmpdir(), `tt-keep-${process.pid}.jsonl`)
    const stripped = join(tmpdir(), `tt-strip-${process.pid}.jsonl`)
    await executeUpload(plan, { dryRun: true, otlpOut: kept })
    await executeUpload(plan, { dryRun: true, otlpOut: stripped, stripContent: true })
    expect(readFileSync(kept, 'utf8')).toContain('my secret prompt text')
    expect(readFileSync(stripped, 'utf8')).not.toContain('my secret prompt text')
  })
})

describe('toTraceSpanEvents', () => {
  it('maps to OTel wire shape, ISO→nanos, root gets metadata', () => {
    const events = toTraceSpanEvents([root(), toolSpan('ls')], { 'tangle.harness': 'claude-code', 'redaction.count': 0 })
    const r = events.find((e) => e.spanId === 'root')!
    expect(r.startTimeUnixNano).toBe(Date.parse('2026-01-01T00:00:00.000Z') * 1_000_000)
    expect(r.attributes['tangle.harness']).toBe('claude-code')
    // non-root span does NOT carry the session metadata
    const t = events.find((e) => e.spanId === 's1')!
    expect(t.attributes['tangle.harness']).toBeUndefined()
    expect(t.parentSpanId).toBe('root')
    expect(t.attributes['tool.name']).toBe('bash')
    // every span carries session id (= trace id) + provenance for server dedup
    for (const e of events) {
      expect(e.attributes['tangle.sessionId']).toBe('t')
      expect(e.attributes['tangle.ingest_source']).toBe('cli')
    }
  })
})

describe('dedup state', () => {
  it('hash is stable for unchanged spans and changes when the set grows', () => {
    const a = [root(), toolSpan('ls')]
    const b = [root(), toolSpan('ls')]
    expect(sessionHash(a)).toBe(sessionHash(b))
    expect(sessionHash([...a, toolSpan('pwd')])).not.toBe(sessionHash(a))
  })

  it('alreadyUploaded matches on harness:sessionId + hash', () => {
    const h = sessionHash([root()])
    const state = { [uploadKey('claude-code', 'sess1')]: { hash: h, uploadedAt: 'x', harness: 'claude-code', spanCount: 1 } }
    expect(alreadyUploaded(state, 'claude-code', 'sess1', h)).toBe(true)
    expect(alreadyUploaded(state, 'claude-code', 'sess1', 'different')).toBe(false)
    expect(alreadyUploaded(state, 'codex', 'sess1', h)).toBe(false)
  })
})
