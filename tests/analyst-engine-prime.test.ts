import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { primeAnalyzer } from '../src/analyst-engine-prime.js'
import { spanEvidenceUri } from '../src/external-analysis-validation.js'
import { runExternalAnalyzers } from '../src/external.js'
import { span, writeOtlpFile, type OtlpSpan } from '../src/otlp.js'

/**
 * Integration suite: a REAL HTTP bridge on a real socket — no injected
 * transport. Every scenario the engine faces (well-formed replies, malformed
 * replies and their repair turn, non-200s, hangs, file delivery with cwd)
 * rides the production `httpJsonTransport` over localhost, and the two
 * headline claims — a large session analyzed via file delivery, and a failed
 * analyzer failing the CLI — run the real `traces analyze` CLI against the
 * same bridge.
 */

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
  finishReason?: string,
): string {
  return JSON.stringify({
    choices: [{ message: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    usage,
  })
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

interface BridgeCall {
  url: string
  body: {
    model: string
    messages: Array<{ role: string; content: string }>
    cwd?: string
  }
}

type ScriptedReply =
  | { status?: number; text: string; usage?: Record<string, unknown>; finishReason?: string }
  | { hang: true }
  | Error

/** A real localhost HTTP bridge with a scripted reply queue. */
async function startBridge(responses: ScriptedReply[]): Promise<{
  url: string
  calls: BridgeCall[]
  close: () => Promise<void>
}> {
  const calls: BridgeCall[] = []
  const queue = [...responses]
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      calls.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      const next = queue.shift()
      if (!next) {
        res.writeHead(500).end('scripted bridge: no response queued')
        return
      }
      if (next instanceof Error) {
        res.destroy(next)
        return
      }
      if ('hang' in next) return // accept, never respond: exercises the deadline
      res.writeHead(next.status ?? 200, { 'content-type': 'application/json' })
      const needsWrap = next.usage !== undefined || next.finishReason !== undefined
      const body = needsWrap && (next.status === undefined || next.status === 200)
        ? replyBody(next.text, next.usage ?? { prompt_tokens: 100, completion_tokens: 20, model_requests: 1 }, next.finishReason)
        : next.text
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    },
  }
}

const bridges: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of bridges) await close()
})

async function bridge(responses: ScriptedReply[]): Promise<{
  url: string
  calls: BridgeCall[]
}> {
  const started = await startBridge(responses)
  bridges.push(started.close)
  return started
}

describe('primeAnalyzer over a real HTTP bridge', () => {
  it('maps a well-formed reply to grounded findings and records usage', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { url, calls } = await bridge([{ text: replyBody(VALID_REPLY) }])
    const analyzer = primeAnalyzer({ bridgeUrl: url, model: 'prime/test-model' })

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
    expect(calls[0]!.url).toBe('/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('prime/test-model')
    expect(calls[0]!.body.cwd).toBeUndefined()
    const prompt = calls[0]!.body.messages[0]!.content
    expect(prompt).toContain('TRAJECTORY (1 trace(s); 3 spans')
    expect(prompt).toContain('"span_id":"tool-exec"')
    expect(prompt).toContain('OUTPUT CONTRACT')
  })

  it('treats zero findings from a well-formed reply as an honest null', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { url } = await bridge([
      { text: replyBody('```json\n{"answer":"clean run","findings":[]}\n```') },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.kind).toBe('findings')
    expect(result!.findings).toHaveLength(0)
    expect(result!.output).toContain('zero findings — an honest null, not a failure')
  })

  it('runs one bounded repair turn carrying the malformed reply but never the trajectory', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const malformed = 'I looked at the trace and found a tool failure but forgot the JSON.'
    const { url, calls } = await bridge([
      { text: malformed, usage: { prompt_tokens: 100, completion_tokens: 20, model_requests: 1 } },
      { text: VALID_REPLY, usage: { prompt_tokens: 50, completion_tokens: 10, model_requests: 1 } },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(1)
    expect(result!.output).toContain('repair: attempted (succeeded)')
    expect(result!.output).toContain('usage: calls=2 input_tokens=150 output_tokens=30')

    expect(calls).toHaveLength(2)
    const repairPrompt = calls[1]!.body.messages[0]!.content
    expect(repairPrompt).toContain('PREVIOUS REPLY:')
    expect(repairPrompt).toContain(malformed)
    expect(repairPrompt).not.toContain('TRAJECTORY (')
    expect(repairPrompt).not.toContain('"span_id":"tool-exec"')
  })

  it('falls back to findings.json when the reply cannot be parsed', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    // The scripted bridge plays the analyzer's part: write the payload file
    // into the request cwd with "tools", then send an unparseable reply.
    const { url } = await bridge([
      { text: 'the analysis is written to the payload file; see findings.json' },
    ])
    const server = { wrote: false }
    const wrap: PrimeTransport = async (request) => {
      if (!server.wrote && typeof request.body.cwd === 'string') {
        server.wrote = true
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(request.body.cwd, 'findings.json'), JSON.stringify({
          answer: 'tool-exec failed and the loop continued',
          findings: [{
            span_ids: ['tool-exec'],
            severity: 'high',
            area: 'tool-failure',
            claim: 'exec_command exited 1 and the run continued without addressing it',
            confidence: 0.9,
          }],
        }))
      }
      return { status: 200, text: replyBody('the analysis is written to the payload file; see findings.json') }
    }
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ bridgeUrl: url, transport: wrap, maxInlineChars: 300, perAttributeCharCap: 50 })],
      { spans },
    )
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(1)
    expect(result!.findings![0]!.evidence_refs[0]!.uri).toBe(spanEvidenceUri('trace-one', 'tool-exec'))
    expect(result!.output).toContain('reply channel: findings.json')
    expect(result!.output).toContain('answer: tool-exec failed')
  })

  it('prefers a well-formed reply over a payload file when both exist', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const wrap: PrimeTransport = async (request) => {
      if (typeof request.body.cwd === 'string') {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(request.body.cwd, 'findings.json'), JSON.stringify({
          answer: 'from the file',
          findings: [{ span_ids: ['root'], severity: 'info', area: 'file-channel', claim: 'should not be used', confidence: 0.5 }],
        }))
      }
      return { status: 200, text: replyBody(VALID_REPLY) }
    }
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ transport: wrap, delivery: 'file' })],
      { spans },
    )
    expect(result!.ok).toBe(true)
    expect(result!.output).toContain('answer: exec_command failed at step 2')
    expect(result!.output).not.toContain('reply channel:')
    expect(result!.findings![0]!.area).toBe('tool-failure')
  })

  it('reports both channels honestly when reply and findings.json are both unusable', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const wrap: PrimeTransport = async (request) => {
      if (typeof request.body.cwd === 'string') {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(request.body.cwd, 'findings.json'), 'not json at all\n{{{{')
      }
      return { status: 200, text: replyBody('prose only, twice') }
    }
    const { url } = await bridge([{ text: replyBody('ignored') }])
    void url
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ transport: wrap, delivery: 'file', repair: false })],
      { spans },
    )
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('no parseable JSON object in prime reply')
    expect(result!.error).toContain('findings.json unreadable')
  })

  it('salvages per-line findings from a JSONL payload file and counts dropped lines', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const wrap: PrimeTransport = async (request) => {
      if (typeof request.body.cwd === 'string') {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(request.body.cwd, 'findings.json'), [
          JSON.stringify({ answer: 'salvaged from lines' }),
          JSON.stringify({ span_ids: ['tool-exec'], severity: 'high', area: 'tool-failure', claim: 'first good row', confidence: 0.8 }),
          'this line is not json',
          JSON.stringify({ span_ids: ['llm-planning'], severity: 'low', area: 'second', claim: 'second good row', confidence: 0.7 }),
        ].join('\n'))
      }
      return { status: 200, text: replyBody('empty prose') }
    }
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ transport: wrap, delivery: 'file', repair: false })],
      { spans },
    )
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(2)
    expect(result!.output).toContain('answer: salvaged from lines')
    expect(result!.output).toContain('JSONL (2 row(s), 1 malformed line(s) dropped)')
  })

  it('classifies a length-capped reply as truncated and repairs compact', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    // Cut mid-array: ends with a nested finding's `}` — indistinguishable from
    // complete by tail character alone; finish_reason 'length' is authoritative.
    const cut = '```json\n{"answer":"x","findings":[{"span_ids":["tool-exec"],"severity":"high","area":"a","claim":"c","confidence":0.9}'
    const { url, calls } = await bridge([
      { text: cut, usage: { prompt_tokens: 10, completion_tokens: 10, model_requests: 1 } },
      { text: replyBody(VALID_REPLY, { prompt_tokens: 5, completion_tokens: 5, model_requests: 1 }) },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(true)
    expect(calls).toHaveLength(2)
    const repairPrompt = calls[1]!.body.messages[0]!.content
    expect(repairPrompt).toContain('cut off by the output limit')
    expect(repairPrompt).toContain('at most 3 findings')
    expect(repairPrompt).not.toContain('Preserve the span ids')
  })

  it('classifies a stopped reply as complete even when nothing parses', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const prose = 'I analyzed it thoroughly and forgot the JSON entirely.'
    const { url, calls } = await bridge([
      { text: prose, usage: { prompt_tokens: 10, completion_tokens: 10, model_requests: 1 }, finishReason: 'stop' },
      { text: replyBody(VALID_REPLY, { prompt_tokens: 5, completion_tokens: 5, model_requests: 1 }) },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(true)
    const repairPrompt = calls[1]!.body.messages[0]!.content
    expect(repairPrompt).toContain('Preserve the span ids')
    expect(repairPrompt).not.toContain('cut off by the output limit')
  })

  it('falls back to structure when the bridge reports no finish reason', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    // No finish_reason on the wire: a cut right after a nested `}` extracts no
    // object, so it is treated as truncated (a tail-character check alone
    // would have misread it as complete).
    const cut = '```json\n{"answer":"x","findings":[{"span_ids":["tool-exec"],"severity":"high","area":"a","claim":"c","confidence":0.9}'
    const { url, calls } = await bridge([
      { text: cut, usage: { prompt_tokens: 10, completion_tokens: 10, model_requests: 1 } },
      { text: replyBody(VALID_REPLY, { prompt_tokens: 5, completion_tokens: 5, model_requests: 1 }) },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(true)
    const repairPrompt = calls[1]!.body.messages[0]!.content
    expect(repairPrompt).toContain('cut off by the output limit')
  })

  it('fails the case when the reply is still malformed after the repair turn', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { url, calls } = await bridge([
      { text: replyBody('no json here') },
      { text: replyBody('still no json') },
    ])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
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
    const { url, calls } = await bridge([{ text: replyBody('prose only') }])
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ bridgeUrl: url, repair: false })],
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
    const { url } = await bridge([{ status: 502, text: 'bad gateway' }])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('bridge HTTP 502')
  })

  it('reports a dead bridge as a failed result', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    // A port that is open right now and closed before the call: real
    // ECONNREFUSED, no mocking of the transport.
    const dead = await startBridge([])
    const url = dead.url
    await dead.close()
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('bridge transport failure')
    expect(result!.error).toContain('ECONNREFUSED')
  })

  it('aborts a call that exceeds the deadline against a bridge that hangs', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { url } = await bridge([{ hang: true }])
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ bridgeUrl: url, timeoutMs: 25 })],
      { spans },
    )
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('bridge call exceeded 25ms')
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
    const { url } = await bridge([{ text: replyBody(reply) }])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
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
    const { url, calls } = await bridge([
      { text: replyBody('```json\n{"answer":"clean","findings":[]}\n```') },
    ])
    const analyzer = primeAnalyzer({ bridgeUrl: url, maxInlineChars: 4_000, perAttributeCharCap: 200 })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.output).toContain('per-attribute cap 200')
    const prompt = calls[0]!.body.messages[0]!.content
    expect(prompt).toContain('…[truncated 4800 chars]')
  })

  it('keeps the legacy refusal when delivery is pinned to inline and the capped projection is still oversized', async () => {
    const spans = fixtureSpans({ contentChars: 5_000 })
    const otlpPath = await writeOtlpFile(spans)
    const { url, calls } = await bridge([])
    const analyzer = primeAnalyzer({
      bridgeUrl: url, maxInlineChars: 300, perAttributeCharCap: 50, delivery: 'inline',
    })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(false)
    expect(result!.error).toContain('inline delivery impossible')
    expect(calls).toHaveLength(0)
  })

  it('delivers an oversized trajectory as a file in the request cwd instead of refusing', async () => {
    const spans = fixtureSpans({ contentChars: 5_000 })
    const otlpPath = await writeOtlpFile(spans)
    const { url, calls } = await bridge([{ text: replyBody(VALID_REPLY) }])
    const analyzer = primeAnalyzer({ bridgeUrl: url, maxInlineChars: 300, perAttributeCharCap: 50 })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.kind).toBe('findings')
    expect(result!.findings).toHaveLength(1)
    expect(result!.output).toContain('delivery: file-cwd (3 spans; trajectory.otlp.jsonl in cwd ')

    expect(calls).toHaveLength(1)
    const request = calls[0]!
    const cwd = request.body.cwd
    expect(typeof cwd).toBe('string')
    const shipped = await readFile(join(cwd!, 'trajectory.otlp.jsonl'), 'utf8')
    expect(shipped).toBe(await readFile(otlpPath, 'utf8'))
    const prompt = request.body.messages[0]!.content
    expect(prompt).toContain('trajectory.otlp.jsonl in your working directory')
    expect(prompt).toContain('It is NOT inlined in this prompt.')
    expect(prompt).toContain('recursive language model with a REPL')
    expect(prompt).not.toContain('"span_id":"tool-exec"')
  })

  it('forces file delivery when asked, even when the projection would fit inline', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { url, calls } = await bridge([{ text: replyBody(VALID_REPLY) }])
    const analyzer = primeAnalyzer({ bridgeUrl: url, delivery: 'file' })
    const [result] = await runExternalAnalyzers(otlpPath, [analyzer], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.output).toContain('delivery: file-cwd')
    expect(typeof calls[0]!.body.cwd).toBe('string')
    const prompt = calls[0]!.body.messages[0]!.content
    expect(prompt).not.toContain('full OpenInference span projection as JSON')
  })

  it('still grounds span ids against the artifact in file mode', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const reply = [
      '```json',
      JSON.stringify({
        answer: 'mixed',
        findings: [
          { span_ids: ['tool-exec'], severity: 'low', area: 'tool-failure', claim: 'real span', confidence: 0.5 },
          { span_ids: ['hallucinated-span'], severity: 'low', area: 'bad', claim: 'fake span', confidence: 0.5 },
        ],
      }),
      '```',
    ].join('\n')
    const { url } = await bridge([{ text: replyBody(reply) }])
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ bridgeUrl: url, delivery: 'file' })],
      { spans },
    )
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(1)
    expect(result!.output).toContain('findings: 1 mapped, 1 rejected')
    expect(result!.output).toContain("rejected[1]: span_id 'hallucinated-span' is not in the trajectory")
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
    const { url } = await bridge([{ text: replyBody(reply) }])
    const [result] = await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], { spans })
    expect(result!.ok).toBe(true)
    expect(result!.findings).toHaveLength(10)
    expect(result!.output).toContain('2 over the 10-finding cap dropped')
  })

  it('uses the caller prompt as the question when provided', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const { url, calls } = await bridge([
      { text: replyBody('```json\n{"answer":"ok","findings":[]}\n```') },
    ])
    await runExternalAnalyzers(otlpPath, [primeAnalyzer({ bridgeUrl: url })], {
      spans,
      prompt: 'find unsupported completion claims',
    })
    expect(calls[0]!.body.messages[0]!.content)
      .toContain('QUESTION: find unsupported completion claims')
  })

  it('rejects an unknown delivery mode up front', () => {
    expect(() => primeAnalyzer({ delivery: 'carrier-pigeon' as 'auto' })).toThrow(
      /delivery must be 'auto', 'file', or 'inline'/,
    )
  })
})

/** Spawn the real CLI without freezing this process's event loop: the HTTP
 *  bridge above lives in-process, so a synchronous spawn would starve the
 *  very server the CLI is calling. */
function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
  status: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'cli.ts'), ...args],
      { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c })
    child.stderr.on('data', (c: Buffer) => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', () => clearTimeout(timer))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
}

describe('prime file delivery through the real CLI', () => {
  /** A Claude session big enough that its projection overflows the 360k-char
   *  inline budget even AFTER the per-attribute cap, so the CLI run lands in
   *  file delivery for real. */
  async function writeLargeSession(home: string): Promise<void> {
    const projectDir = join(home, '.claude', 'projects', '-tmp-prime-e2e')
    await mkdir(projectDir, { recursive: true })
    const rows: string[] = [
      JSON.stringify({
        type: 'user', uuid: 'task-one', sessionId: 'prime-e2e',
        timestamp: '2026-01-01T00:00:00Z', userType: 'external', cwd: '/tmp',
        message: { role: 'user', content: 'run the long job' },
      }),
    ]
    for (let index = 0; index < 400; index += 1) {
      rows.push(JSON.stringify({
        type: 'assistant', uuid: `work-${index}`, parentUuid: index === 0 ? 'task-one' : `work-${index - 1}`,
        sessionId: 'prime-e2e', timestamp: `2026-01-01T${String(Math.floor((index + 1) / 60)).padStart(2, '0')}:${String((index + 1) % 60).padStart(2, '0')}Z`, cwd: '/tmp',
        message: {
          id: `msg-${index}`, role: 'assistant', model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id: `toolu-${index}`, name: 'Bash', input: { command: `step ${index}` } }],
        },
      }))
      rows.push(JSON.stringify({
        type: 'user', uuid: `result-${index}`, parentUuid: `work-${index}`,
        sessionId: 'prime-e2e', timestamp: `2026-01-01T${String(1 + Math.floor((index + 1) / 60)).padStart(2, '0')}:${String((index + 1) % 60).padStart(2, '0')}Z`, cwd: '/tmp',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-${index}`, content: 'x'.repeat(12_000) }] },
      }))
    }
    await writeFile(join(projectDir, 'prime-e2e.jsonl'), `${rows.join('\n')}\n`)
  }

  it('analyzes a large session via file delivery and a grounded reply, exit 0', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tt-prime-cli-'))
    await writeLargeSession(home)
    let shipped: { cwd: string; bytes: number; firstSpanId: string } | undefined
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const cwd = body.cwd
        const text = await readFile(join(cwd, 'trajectory.otlp.jsonl'), 'utf8')
        const firstSpanId = JSON.parse(text.split('\n')[0]!).span_id
        shipped = { cwd, bytes: Buffer.byteLength(text), firstSpanId }
        const reply = {
          answer: `file delivery ok: cited span read from the shipped artifact (${Buffer.byteLength(text)} bytes)`,
          findings: [{
            span_ids: [firstSpanId],
            severity: 'low',
            area: 'e2e-proof',
            claim: 'the trajectory arrived as a readable file in the request cwd',
            confidence: 0.99,
          }],
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, model_requests: 1 },
        }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const report = join(home, 'report.md')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FORCE_COLOR: '0', TRACES_PRIME_BRIDGE_URL: `http://127.0.0.1:${port}`, TRACES_PRIME_TIMEOUT_MS: '60000' }
    delete env.NODE_OPTIONS
    const run = await runCli(
      ['analyze', '--harness', 'claude-code', '--session', 'prime-e2e',
        '--analyzer', 'prime', '--out', report],
      env, 240_000)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))

    expect(run.status, run.stderr).toBe(0)
    expect(shipped).toBeDefined()
    expect(shipped!.bytes).toBeGreaterThan(360_000)
    const text = await readFile(report, 'utf8')
    expect(text).toContain('### prime (findings)')
    expect(text).toContain('delivery: file-cwd')
    expect(text).toContain('findings: 1 mapped, 0 rejected')
    await rm(home, { recursive: true, force: true })
  }, 300_000)

  it('fails the CLI with a non-zero exit when the bridge is dead', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tt-prime-dead-'))
    await writeLargeSession(home)
    const dead = await startBridge([])
    const url = dead.url
    await dead.close()

    const report = join(home, 'report.md')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FORCE_COLOR: '0', TRACES_PRIME_BRIDGE_URL: url }
    delete env.NODE_OPTIONS
    const run = await runCli(
      ['analyze', '--harness', 'claude-code', '--session', 'prime-e2e',
        '--analyzer', 'prime', '--out', report],
      env, 240_000)
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('external analyzer(s) failed')
    await rm(home, { recursive: true, force: true })
  }, 300_000)
})

/**
 * Opt-in run against a REAL bridge with a REAL prime-agent and a REAL model.
 * Skipped unless TRACES_PRIME_REAL_E2E=1 plus TRACES_PRIME_BRIDGE_URL and
 * TRACES_PRIME_MODEL are set; see docs/trace-analysts.md ("Verifying against a
 * real prime") for the full recipe — the facts that matter there: prime-agent
 * is a source build at the commit cli-bridge pins (not the npm package), the
 * bridge needs BRIDGE_BACKENDS=prime plus an operator models.json whose
 * apiKey names an exported env var, and the kernel wants a persistent
 * PRIME_AGENT_KERNEL_PYTHON so the isolated per-run HOME cannot orphan a
 * uv-managed interpreter that lives inside it.
 */
describe('primeAnalyzer against a real prime bridge (opt-in)', () => {
  it.skipIf(
    !process.env.TRACES_PRIME_REAL_E2E
      || !process.env.TRACES_PRIME_BRIDGE_URL
      || !process.env.TRACES_PRIME_MODEL,
  )('analyzes a real session end to end through the real RLM', async () => {
    const spans = fixtureSpans()
    const otlpPath = await writeOtlpFile(spans)
    const [result] = await runExternalAnalyzers(
      otlpPath,
      [primeAnalyzer({ delivery: 'file' })],
      { spans },
    )
    expect(result!.ok).toBe(true)
    // A real RLM reply that survives grounding: every finding cites spans the
    // artifact actually contains, or is rejected with a recorded reason.
    expect(result!.output).toMatch(/findings: \d+ mapped, \d+ rejected/)
  }, 1_200_000)
})
