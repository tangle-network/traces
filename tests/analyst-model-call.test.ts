import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnalystModelCall, PROVIDER_ERROR_BODY_LIMIT } from '../src/analyst-model-call.js'

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

function chatRequest(model = 'test-model') {
  return {
    model,
    messages: [{ role: 'user' as const, content: 'why did this run fail?' }],
  }
}

function callArgs(request: ReturnType<typeof chatRequest>, signal: AbortSignal) {
  // Shape of one admitted call the loopback proxy hands to the execution owner.
  return { request, callId: 'call-abc123', signal } as unknown as Parameters<
    ReturnType<typeof createAnalystModelCall>
  >[0]
}

describe('analyst model call', () => {
  it('returns a receipt and execution evidence, and sends callId as the idempotency key', async () => {
    let seenIdempotencyKey: string | undefined
    const baseUrl = await startGateway((req, res) => {
      seenIdempotencyKey = req.headers['idempotency-key'] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      )
    })

    const call = createAnalystModelCall({ apiKey: 'test-key', baseUrl })
    const result = await call(callArgs(chatRequest(), new AbortController().signal))

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) return
    expect(result.response.content).toBe('ok')
    expect(result.receipt.inputTokens).toBe(11)
    expect(result.receipt.outputTokens).toBe(7)
    // callId must reach the provider so a retried-but-already-billed call is
    // not charged twice.
    expect(seenIdempotencyKey).toBe('call-abc123')
    const execution = result.execution as Record<string, unknown>
    expect(execution.callId).toBe('call-abc123')
    expect(execution.servedModel).toBe('test-model')
    expect(execution.finishReason).toBe('stop')
  })

  it('keeps the provider reason in execution evidence on a non-2xx response', async () => {
    const baseUrl = await startGateway((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model not found: test-model', type: 'invalid_request_error' } }))
    })

    const call = createAnalystModelCall({ apiKey: 'test-key', baseUrl })
    const result = await call(callArgs(chatRequest(), new AbortController().signal))

    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    const execution = result.execution as Record<string, unknown>
    expect(execution.status).toBe(400)
    expect(String(execution.body)).toContain('model not found: test-model')
    expect(String(execution.body).length).toBeLessThanOrEqual(PROVIDER_ERROR_BODY_LIMIT)
    expect(execution.aborted).toBe(false)
    // A failed call must never read as a free, measured call.
    expect(result.receipt.costUnknown).toBe(true)
    expect(result.receipt.usageUnknown).toBe(true)
  })

  it('does not mark a provider timeout as a cancellation', async () => {
    const baseUrl = await startGateway(() => {
      // Never responds, so callLlm's own per-attempt timeout fires.
      })

    const call = createAnalystModelCall({ apiKey: 'test-key', baseUrl })
    // callLlm aborts an internal controller to enforce this timeout, so the
    // error arrives as an AbortError even though nobody cancelled the call.
    const request = { ...chatRequest(), timeoutMs: 250 }
    const result = await call(callArgs(request, new AbortController().signal))

    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    // The bridge retries a transient failure and gives up on a cancelled one,
    // so a timeout must not carry the cancellation marker.
    expect(result.error.startsWith('AbortError:')).toBe(false)
    expect((result.execution as Record<string, unknown>).aborted).toBe(false)
  })

  it('marks an aborted call so it is distinguishable from a transient failure', async () => {
    const controller = new AbortController()
    const baseUrl = await startGateway(() => {
      // Never responds: the abort is the only way this call ends.
      controller.abort()
    })

    const call = createAnalystModelCall({ apiKey: 'test-key', baseUrl })
    const result = await call(callArgs(chatRequest(), controller.signal))

    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error.startsWith('AbortError:')).toBe(true)
    const execution = result.execution as Record<string, unknown>
    expect(execution.aborted).toBe(true)
    expect(execution.callId).toBe('call-abc123')
  })
})
