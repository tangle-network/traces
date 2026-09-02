import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ANALYST_MAX_OUTPUT_TOKENS,
  GPT_5_6_ANALYST_MAX_OUTPUT_TOKENS,
  analystMaxOutputTokens,
  createAnalystModelOwner,
} from '../src/analyst-model-call.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server | undefined

async function startGateway(handler: Handler): Promise<string> {
  const created = createServer(handler)
  server = created
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve))
  const { port } = created.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

afterEach(async () => {
  const running = server
  server = undefined
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()))
})

function owner(baseUrl: string) {
  return createAnalystModelOwner({
    apiKey: 'test-key',
    baseUrl,
    model: 'test-model',
    provider: 'test-provider',
  })
}

describe('analyst model owner', () => {
  it('uses a smaller GPT-5.6 reservation without narrowing other model families', () => {
    expect(analystMaxOutputTokens('gpt-5.6-luna')).toBe(GPT_5_6_ANALYST_MAX_OUTPUT_TOKENS)
    expect(analystMaxOutputTokens('openai/gpt-5.6-sol')).toBe(GPT_5_6_ANALYST_MAX_OUTPUT_TOKENS)
    expect(analystMaxOutputTokens('glm-5.2')).toBe(ANALYST_MAX_OUTPUT_TOKENS)

    const configured = createAnalystModelOwner({
      apiKey: 'test-key',
      baseUrl: 'https://router.example/v1',
      model: 'gpt-5.6-luna',
      provider: 'test-provider',
    })
    expect(configured.profile.model.maxVisibleOutputTokens)
      .toBe(GPT_5_6_ANALYST_MAX_OUTPUT_TOKENS)
  })

  it('uses Runtime to translate the analyst profile into one exact provider request', async () => {
    let body: Record<string, unknown> | undefined
    let idempotencyKey: string | undefined
    const baseUrl = await startGateway((req, res) => {
      idempotencyKey = req.headers['idempotency-key'] as string | undefined
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.002 },
          }),
        )
      })
    })
    const configured = owner(baseUrl)
    const result = await configured.call({
      callId: 'call-abc123',
      request: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'why did this run fail?' }],
        maxTokens: ANALYST_MAX_OUTPUT_TOKENS,
        thinking: 'disabled',
      },
      endpointFormat: 'chat-completions',
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(true)
    expect(body).toMatchObject({
      model: 'test-model',
      max_tokens: ANALYST_MAX_OUTPUT_TOKENS,
      reasoning_effort: 'none',
    })
    expect(body).not.toHaveProperty('thinking')
    expect(idempotencyKey).toBe('call-abc123')
    expect(configured.profile.model.reasoningEffort).toBe('none')
    expect(configured.callRef).toMatch(/^sha256:[a-f0-9]{64}$/u)
    if (!result.succeeded) return
    expect(result.response.content).toBe('ok')
    expect(result.receipt).toMatchObject({
      model: 'test-model',
      inputTokens: 11,
      outputTokens: 7,
      actualCostUsd: 0.002,
    })
    expect(result.execution).toMatchObject({
      kind: 'agent-runtime-profile-model-call',
      callId: 'call-abc123',
      executed: true,
      succeeded: true,
      model: 'test-model',
    })
  })

  it('returns explicit unknown usage and cost when transport fails before a receipt', async () => {
    const baseUrl = await startGateway((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model not found: test-model' } }))
    })
    const result = await owner(baseUrl).call({
      callId: 'call-failed',
      request: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: ANALYST_MAX_OUTPUT_TOKENS,
        thinking: 'disabled',
      },
      endpointFormat: 'chat-completions',
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.receipt).toMatchObject({ usageUnknown: true, costUnknown: true })
    expect(result.execution).toMatchObject({
      kind: 'agent-runtime-profile-model-call',
      executed: true,
      succeeded: false,
    })
  })
})
