import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  httpJsonTransport,
  primeAnalyzer,
  type PrimeTransport,
  type PrimeTransportRequest,
} from '../src/analyst-engine-prime.js'
import { spanEvidenceUri } from '../src/external-analysis-validation.js'
import { runExternalAnalyzers } from '../src/external.js'
import { span, writeOtlpFile, type OtlpSpan } from '../src/otlp.js'

function fixtureSpans(options: { contentChars?: number } = {}): OtlpSpan[] {
  return [
    span({
      traceId: 'trace-one',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
      service: 'codex',
    }),
    span({
      traceId: 'trace-one',
      spanId: 'llm-planning',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:01.000Z',
      step: 1,
      inputTokens: 100,
      outputTokens: 20,
      content: options.contentChars ? 'x'.repeat(options.contentChars) : 'I will inspect the repository.',
    }),
    span({
      traceId: 'trace-one',
      spanId: 'tool-exec',
      parentSpanId: 'llm-planning',
      name: 'tool.exec_command',
      kind: 'TOOL',
      startTime: '2026-01-01T00:00:02.000Z',
      step: 2,
      tool: 'exec_command',
      status: 'ERROR',
      statusMessage: 'exit 1',
    }),
  ]
}

function replyBody(
  content: string,
  usage: Record<string, unknown> | undefined = { prompt_tokens: 100, completion_tokens: 20, model_requests: 1 },
): string {
  return JSON.stringify({ choices: [{ message: { content } }], usage })
}

const VALID_REPLY = [
  '```json',
  JSON.stringify({
    answer: 'exec_command failed at step 2 and the failure went unhandled',
    findings: [
      {
        span_ids: ['tool-exec', 'llm-planning'],
        severity: 'high',
        area: 'tool-failure',
        claim: 'exec_command exited 1 and the run continued without addressing it',
        action: 'inspect the failing command before the next model turn',
        confidence: 0.85,
      },
    ],
  }),
  '```',
].join('\n')

interface FakeCall {
  request: PrimeTransportRequest
}

function fakeBridge(responses: Array<{ status?: number; text: string } | Error>): {
  transport: PrimeTransport
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const queue = [...responses]
  const transport: PrimeTransport = async (request) => {
    calls.push({ request })
    const next = queue.shift()
    if (!next) throw new Error('fake bridge: no response queued')
    if (next instanceof Error) throw next
    return { status: next.status ?? 200, text: next.text }
  }
  return { transport, calls }
}

describe('primeAnalyzer', () => {
  it('maps a well-formed reply to grounded findings and records usage', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport, calls } = fakeBridge([{ text: replyBody(VALID_REPLY) }])
    const analyzer = primeAnalyzer({ transport, model: 'prime/test-model' })

    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.kind).toBe('findings')
    expect(result!.analyzer).toBe('prime')
    expect(result!.findings).toHaveLength(1)
    const finding = result!.findings![0]!
    expect(finding.analyst_id).toBe('prime')
    expect(finding.severity).toBe('high')
    expect(finding.area).toBe('tool-failure')
    expect(finding.recommended_action).toContain('inspect the failing command')
    expect(finding.evidence_refs.map((ref) => ref.uri)).toEqual([
      spanEvidenceUri('trace-one', 'tool-exec'),
      spanEvidenceUri('trace-one', 'llm-planning'),
    ])
    expect(finding.metadata).toEqual({ engine: 'prime', model: 'prime/test-model' })
    expect(Number.isFinite(Date.parse(finding.produced_at))).toBe(true)

    expect(result!.output).toContain('answer: exec_command failed at step 2')
    expect(result!.output).toContain('findings: 1 mapped, 0 rejected')
    expect(result!.output).toContain('usage: calls=1 input_tokens=100 output_tokens=20')
    expect(result!.output).toContain('cost=uncaptured')
    expect(result!.output).toContain('delivery: inline-json')
    expect(result!.output).toContain('per-attribute cap none')

    expect(calls).toHaveLength(1)
    const prompt = calls[0]!.request.body.messages[0]!.content
    expect(calls[0]!.request.url).toBe('http://localhost:4181/v1/chat/completions')
    expect(calls[0]!.request.body.model).toBe('prime/test-model')
    expect(prompt).toContain('TRAJECTORY (1 trace(s); 3 spans')
    expect(prompt).toContain('"span_id":"tool-exec"')
    expect(prompt).toContain('OUTPUT CONTRACT')
  })

  it('treats zero findings from a well-formed reply as an honest null', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport } = fakeBridge([
      { text: replyBody('```json\n{"answer":"clean run","findings":[]}\n```') },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.kind).toBe('findings')
    expect(result!.findings).toHaveLength(0)
    expect(result!.output).toContain('zero findings — an honest null, not a failure')
  })

  it('runs one bounded repair turn carrying the malformed reply but never the trajectory', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const malformed = 'I looked at the trace and found a tool failure but forgot the JSON.'
    const { transport, calls } = fakeBridge([
      { text: replyBody(malformed, { prompt_tokens: 100, completion_tokens: 20, model_requests: 1 }) },
      { text: replyBody(VALID_REPLY, { prompt_tokens: 50, completion_tokens: 10, model_requests: 1 }) },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(1)
    expect(result!.output).toContain('repair: attempted (succeeded)')
    expect(result!.output).toContain('usage: calls=2 input_tokens=150 output_tokens=30')

    expect(calls).toHaveLength(2)
    const repairPrompt = calls[1]!.request.body.messages[0]!.content
    expect(repairPrompt).toContain('PREVIOUS REPLY:')
    expect(repairPrompt).toContain(malformed)
    expect(repairPrompt).not.toContain('TRAJECTORY (')
    expect(repairPrompt).not.toContain('"span_id":"tool-exec"')
  })

  it('fails the case when the reply is still malformed after the repair turn', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport, calls } = fakeBridge([
      { text: replyBody('no json here') },
      { text: replyBody('still no json') },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.kind).toBe('report')
    expect(result!.error).toContain('no parseable JSON object')
    expect(result!.error).toContain('even after the bounded repair turn')
    expect(result!.output).toContain('no json here')
    expect(calls).toHaveLength(2)
  })

  it('makes a single call and fails loud when repair is disabled', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport, calls } = fakeBridge([{ text: replyBody('prose only') }])
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ transport, repair: false })],
      { spans },
    )
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('no parseable JSON object')
    expect(result!.error).not.toContain('repair turn')
    expect(calls).toHaveLength(1)
  })

  it('reports a non-200 bridge status as a failed result, never a thrown run', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport } = fakeBridge([{ status: 502, text: 'bad gateway' }])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('bridge HTTP 502')
  })

  it('reports a transport failure as a failed result', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport } = fakeBridge([new Error('connect ECONNREFUSED 127.0.0.1:4181')])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('bridge transport failure')
    expect(result!.error).toContain('ECONNREFUSED')
  })

  it('rejects rows citing unknown spans or invalid fields while keeping valid rows', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const reply = [
      '```json',
      JSON.stringify({
        answer: 'mixed quality reply',
        findings: [
          {
            span_ids: ['tool-exec'],
            severity: 'medium',
            area: 'tool-failure',
            claim: 'the failing exec was never retried',
            confidence: 0.6,
          },
          {
            span_ids: ['no-such-span'],
            severity: 'high',
            area: 'hallucination',
            claim: 'cites a span that does not exist',
            confidence: 0.9,
          },
          {
            span_ids: ['root'],
            severity: 'catastrophic',
            area: 'bad-severity',
            claim: 'severity outside the enum',
            confidence: 0.5,
          },
        ],
      }),
      '```',
    ].join('\n')
    const { transport } = fakeBridge([{ text: replyBody(reply) }])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(1)
    expect(result!.findings![0]!.claim).toBe('the failing exec was never retried')
    expect(result!.output).toContain('findings: 1 mapped, 2 rejected')
    expect(result!.output).toContain("rejected[1]: span_id 'no-such-span' is not in the trajectory")
    expect(result!.output).toContain('rejected[2]: severity outside the analyst severity enum')
  })

  it('re-renders with the per-attribute cap when the projection is oversized', async () => {
    const spans = fixtureSpans({ contentChars: 5_000 })
    const otlpPath = await writeOtlpFile(spans)
    const { transport, calls } = fakeBridge([
      { text: replyBody('```json\n{"answer":"clean","findings":[]}\n```') },
    ])
    const analyzer = primeAnalyzer({ transport, maxInlineChars: 4_000, perAttributeCharCap: 200 })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.output).toContain('per-attribute cap 200')
    const prompt = calls[0]!.request.body.messages[0]!.content
    expect(prompt).toContain('…[truncated 4800 chars]')
  })

  it('fails loud without calling the bridge when the capped projection is still oversized', async () => {
    const spans = fixtureSpans({ contentChars: 5_000 })
    const otlpPath = await writeOtlpFile(spans)
    const { transport, calls } = fakeBridge([])
    const analyzer = primeAnalyzer({ transport, maxInlineChars: 300, perAttributeCharCap: 50 })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('inline delivery impossible')
    expect(calls).toHaveLength(0)
  })

  it('aborts a call that exceeds the deadline, including on injected transports', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const transport: PrimeTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    const analyzer = primeAnalyzer({ transport, timeoutMs: 25 })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('bridge call exceeded 25ms')
  })

  it('drops findings over the cap and says so', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const rows = Array.from({ length: 12 }, (_v, i) => ({
      span_ids: ['tool-exec'],
      severity: 'low',
      area: 'noise',
      claim: `finding number ${i}`,
      confidence: 0.4,
    }))
    const reply = `\`\`\`json\n${JSON.stringify({ answer: 'noisy', findings: rows })}\n\`\`\``
    const { transport } = fakeBridge([{ text: replyBody(reply) }])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(10)
    expect(result!.output).toContain('2 over the 10-finding cap dropped')
  })

  it('uses the caller prompt as the question when provided', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { transport, calls } = fakeBridge([
      { text: replyBody('```json\n{"answer":"ok","findings":[]}\n```') },
    ])
    await runExternalAnalyzers(otlpPath, [primeAnalyzer({ transport })], {
      spans,
      prompt: 'find unsupported completion claims',
    })
    expect(calls[0]!.request.body.messages[0]!.content)
      .toContain('QUESTION: find unsupported completion claims')
  })
})

describe('httpJsonTransport', () => {
  it('POSTs the chat body and returns status and text from a local server', async () => {
    const received: Array<{ url: string; body: unknown }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(replyBody('```json\n{"answer":"ok","findings":[]}\n```'))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const response = await httpJsonTransport({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        body: { model: 'prime/test-model', messages: [{ role: 'user', content: 'hello' }] },
        signal: new AbortController().signal,
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.text).choices[0].message.content).toContain('"answer"')
      expect(received[0]!.url).toBe('/v1/chat/completions')
      expect(received[0]!.body).toEqual({
        model: 'prime/test-model',
        messages: [{ role: 'user', content: 'hello' }],
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('rejects non-http(s) bridge urls', () => {
    expect(() =>
      httpJsonTransport({
        url: 'ftp://localhost/v1/chat/completions',
        body: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
        signal: new AbortController().signal,
      })).toThrow(/must be http: or https:/)
  })
})
