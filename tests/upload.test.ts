import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toolIoAttributes } from '../src/adapters/tool-io.js'
import { span } from '../src/otlp.js'
import { applyRedactor, redactSpans } from '../src/redact.js'
import { executeUpload, PartialUploadError, toTraceSpanEvents } from '../src/upload.js'
import type { UploadBackend, UploadPlan } from '../src/upload.js'
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

function uploadItem(content: string) {
  const captured = span({
    traceId: 't',
    spanId: 'u',
    name: 'user.prompt',
    kind: 'CHAIN' as const,
    startTime: '2026-01-01T00:00:00.000Z',
    content,
  })
  Object.assign(
    captured.attributes,
    toolIoAttributes({ input: 'captured tool input', output: 'captured tool output' }),
  )
  captured.status = { code: 'ERROR', message: 'captured tool output failed' }
  return {
    ref: { harness: 'claude-code', sessionId: 'sess1', path: '/x/session.jsonl', cwd: null, mtimeMs: 0 },
    spans: [captured],
    redaction: { redactionCount: 0, byRule: {} },
    hash: 'source-hash',
    isNew: true,
  }
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

  it('recomputes captured tool metadata from the final redacted values', () => {
    const githubToken = `ghp_${'a'.repeat(36)}`
    const source = toolSpan('run tool')
    Object.assign(
      source.attributes,
      toolIoAttributes({
        input: { token: githubToken },
        output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      }),
    )
    expect(String(source.attributes['input.value'])).toContain(githubToken)
    expect(String(source.attributes['output.value'])).toContain('abcdefghijklmnopqrstuvwxyz')
    const rawInputDigest = source.attributes['traces.input.sha256']
    const rawOutputDigest = source.attributes['traces.output.sha256']

    const { spans, report } = redactSpans([source])
    const attributes = spans[0]!.attributes
    const input = String(attributes['input.value'])
    const output = String(attributes['output.value'])
    expect(input).not.toContain(githubToken)
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(attributes['traces.input.bytes']).toBe(Buffer.byteLength(input))
    expect(attributes['traces.input.sha256']).toBe(createHash('sha256').update(input).digest('hex'))
    expect(attributes['traces.input.sha256']).not.toBe(rawInputDigest)
    expect(attributes['traces.output.bytes']).toBe(Buffer.byteLength(output))
    expect(attributes['traces.output.sha256']).toBe(createHash('sha256').update(output).digest('hex'))
    expect(attributes['traces.output.sha256']).not.toBe(rawOutputDigest)
    expect(attributes['traces.output.truncated']).toBe(false)
    expect(report.redactionCount).toBeGreaterThanOrEqual(2)
  })

  it('removes raw length metadata from a truncated value after redaction', () => {
    const githubToken = `ghp_${'a'.repeat(36)}`
    const source = toolSpan('run tool')
    Object.assign(source.attributes, toolIoAttributes({ output: `${githubToken}:${'x'.repeat(20_000)}` }))
    const rawBytes = source.attributes['traces.output.bytes']

    const { spans } = redactSpans([source])
    const attributes = spans[0]!.attributes
    const output = String(attributes['output.value'])
    expect(output).not.toContain(githubToken)
    expect(output).toMatch(/\[truncated\]$/)
    expect(output).not.toMatch(/truncated \d+ bytes/)
    expect(attributes['traces.output.bytes']).toBe(Buffer.byteLength(output))
    expect(attributes['traces.output.bytes']).not.toBe(rawBytes)
    expect(attributes['traces.output.sha256']).toBe(createHash('sha256').update(output).digest('hex'))
  })
})

describe('applyRedactor', () => {
  it('scrubs conversation content and standard tool input/output values', async () => {
    const conversation = span({
      traceId: 't',
      spanId: 'u',
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:00.000Z',
      content: 'Ask Private Name',
    })
    const capturedTool = toolSpan('')
    Object.assign(
      capturedTool.attributes,
      toolIoAttributes({ input: { name: 'Private Name' }, output: 'Found Private Name' }),
    )
    capturedTool.status = { code: 'ERROR', message: 'Found Private Name' }
    const rawInputDigest = capturedTool.attributes['traces.input.sha256']
    const rawOutputDigest = capturedTool.attributes['traces.output.sha256']
    const source = [conversation, capturedTool]
    const redactor = {
      name: 'test',
      redactText: async (texts: readonly string[]) => texts.map((text) => text.replace('Private Name', '[NAME]')),
    }

    const { spans, changed } = await applyRedactor(source, redactor)
    expect(changed).toBe(4)
    expect(spans[0]!.attributes.content).toBe('Ask [NAME]')
    expect(spans[1]!.attributes['input.value']).toBe('{"name":"[NAME]"}')
    expect(spans[1]!.attributes['output.value']).toBe('Found [NAME]')
    expect(spans[1]!.status.message).toBe('Found [NAME]')
    expect(spans[1]!.attributes['traces.input.sha256']).toBe(
      createHash('sha256').update('{"name":"[NAME]"}').digest('hex'),
    )
    expect(spans[1]!.attributes['traces.input.sha256']).not.toBe(rawInputDigest)
    expect(spans[1]!.attributes['traces.output.sha256']).toBe(
      createHash('sha256').update('Found [NAME]').digest('hex'),
    )
    expect(spans[1]!.attributes['traces.output.sha256']).not.toBe(rawOutputDigest)
    expect(source[1]!.attributes['output.value']).toBe('Found Private Name')
    expect(source[1]!.status.message).toBe('Found Private Name')
  })
})

describe('executeUpload --no-content', () => {
  it('strips prompt, response, tool values, derived metadata, and status prose', async () => {
    const plan = { items: [uploadItem('my secret prompt text')], state: {} }
    const kept = join(tmpdir(), `tt-keep-${process.pid}.jsonl`)
    const stripped = join(tmpdir(), `tt-strip-${process.pid}.jsonl`)
    await executeUpload(plan, { dryRun: true, otlpOut: kept })
    await executeUpload(plan, { dryRun: true, otlpOut: stripped, stripContent: true })
    const keptText = readFileSync(kept, 'utf8')
    const strippedText = readFileSync(stripped, 'utf8')
    expect(keptText).toContain('my secret prompt text')
    expect(keptText).toContain('captured tool output')
    expect(strippedText).not.toContain('my secret prompt text')
    expect(strippedText).not.toContain('captured tool input')
    expect(strippedText).not.toContain('captured tool output')
    expect(strippedText).not.toContain('traces.input.')
    expect(strippedText).not.toContain('traces.output.')
    expect(strippedText).not.toContain('captured tool output failed')
  })
})

describe('executeUpload final identity and acceptance', () => {
  function plan(): UploadPlan {
    return { items: [uploadItem('full prompt content')], state: {} }
  }

  it('deduplicates the exact final payload and separates privacy modes and redactors', async () => {
    const uploadPlan = plan()
    const calls: Array<{ events: Parameters<UploadBackend['ingestTraces']>[0]; key: string }> = []
    const backend: UploadBackend = {
      async ingestTraces(events, key) {
        calls.push({ events, key: key! })
        return { accepted: events.length }
      },
    }

    await executeUpload(uploadPlan, { backend })
    const full = calls.at(-1)!
    expect(full.events[0]!.attributes.content).toBe('full prompt content')
    expect(uploadPlan.state['claude-code:sess1']!.hash).toBe(full.key.split(':').at(-1))

    const repeated = await executeUpload(uploadPlan, { backend })
    expect(repeated).toMatchObject({ uploadedSessions: 0, skippedSessions: 1 })
    expect(calls).toHaveLength(1)

    await executeUpload(uploadPlan, { backend, stripContent: true })
    const metadataOnly = calls.at(-1)!
    expect(metadataOnly.key).not.toBe(full.key)
    expect(metadataOnly.events[0]!.attributes.content).toBeUndefined()
    expect(metadataOnly.events[0]!.attributes['input.value']).toBeUndefined()
    expect(metadataOnly.events[0]!.attributes['traces.input.sha256']).toBeUndefined()
    expect(metadataOnly.events[0]!.status?.message).toBeUndefined()
    expect(uploadPlan.state['claude-code:sess1']!.hash).toBe(metadataOnly.key.split(':').at(-1))

    const scrub = (name: string) => ({
      name,
      redactText: async (texts: readonly string[]) => texts.map((text) => text.replace('full prompt', '[PROMPT]')),
    })
    await executeUpload(uploadPlan, { backend, redactor: scrub('scrubber-a') })
    const scrubberA = calls.at(-1)!
    await executeUpload(uploadPlan, { backend, redactor: scrub('scrubber-b') })
    const scrubberB = calls.at(-1)!
    expect(scrubberA.events[0]!.attributes.content).toBe('[PROMPT] content')
    expect(scrubberB.events[0]!.attributes.content).toBe('[PROMPT] content')
    expect(scrubberA.key).not.toBe(metadataOnly.key)
    expect(scrubberB.key).not.toBe(scrubberA.key)
    expect(uploadPlan.state['claude-code:sess1']!.hash).toBe(scrubberB.key.split(':').at(-1))
  })

  it('does not mark a partially accepted session complete', async () => {
    const uploadPlan = plan()
    const error = await executeUpload(uploadPlan, {
      backend: {
        async ingestTraces(events) {
          return { accepted: events.length - 1 }
        },
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(PartialUploadError)
    expect(error).toMatchObject({
      sessionKey: 'claude-code:sess1',
      accepted: 0,
      expected: 1,
    })
    expect(uploadPlan.state).toEqual({})
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

  it('hash changes when captured tool output changes', () => {
    const first = toolSpan('')
    const second = toolSpan('')
    Object.assign(first.attributes, toolIoAttributes({ output: 'success output' }))
    Object.assign(second.attributes, toolIoAttributes({ output: 'failed output' }))
    expect(sessionHash([first])).not.toBe(sessionHash([second]))
  })

  it('alreadyUploaded matches on harness:sessionId + hash', () => {
    const h = sessionHash([root()])
    const state = { [uploadKey('claude-code', 'sess1')]: { hash: h, uploadedAt: 'x', harness: 'claude-code', spanCount: 1 } }
    expect(alreadyUploaded(state, 'claude-code', 'sess1', h)).toBe(true)
    expect(alreadyUploaded(state, 'claude-code', 'sess1', 'different')).toBe(false)
    expect(alreadyUploaded(state, 'codex', 'sess1', h)).toBe(false)
  })
})
