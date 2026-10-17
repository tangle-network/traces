/**
 * What `traces ask` talks to, faked only at its process boundaries: the model
 * endpoint is an HTTP server here, and the DSPy bridge is `stub-bridge.mjs`,
 * the child process `TRACES_PYTHON` (or `uvx` on PATH) names. Everything
 * between them is the real path: the engine, its model proxy, Runtime's router
 * transport and traces' retry.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveHexId, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'

const STUB = join(dirname(fileURLToPath(import.meta.url)), 'stub-bridge.mjs')

/** The key every run sends; the endpoint checks it, and it never leaves the machine. */
export const ASK_KEY = 'test-key-never-sent-upstream'

/** One synthetic session: a prompt, a failing shell command, a reply. */
export async function writeAskSession(dir: string, name = 'session'): Promise<{ path: string; traceId: string; toolSpanId: string }> {
  const traceId = deriveHexId(`ask-${name}`, 16)
  const toolSpanId = deriveHexId(`ask-${name}-tool`, 8)
  const path = join(dir, `${name}.otlp.jsonl`)
  await mkdir(dir, { recursive: true })
  await writeFile(path, `${[
    llmSpan({
      traceId,
      spanId: deriveHexId(`ask-${name}-turn`, 8),
      parentSpanId: null,
      name: 'turn',
      model: 'glm-5.2',
      inputTokens: 10,
      outputTokens: 2,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
    }),
    toolSpan({
      traceId,
      spanId: toolSpanId,
      parentSpanId: null,
      name: 'bash',
      toolName: 'bash',
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:02.000Z',
      status: { code: 'STATUS_CODE_ERROR' },
    }),
  ].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return { path, traceId, toolSpanId }
}

/** What the stub bridge does for a question whose text contains `match`. */
export interface BridgeScript {
  readonly match: string
  /** Calls made through the engine's model proxy before answering. Default 1. */
  readonly modelCalls?: number
  readonly answer?: string
  /** With `modelCalls: 0`: die at startup with this stderr, as a missing bridge does. */
  readonly fail?: string
}

/**
 * Write the stub bridge as an executable at `path`, for `TRACES_PYTHON` or as
 * `uvx` on PATH. Each run appends its argv, question and instructions to `<path>.log.jsonl`.
 */
export async function writeStubBridge(path: string, questions: readonly BridgeScript[]): Promise<{ path: string; log: string }> {
  const plan = `${path}.plan.json`
  const log = `${path}.log.jsonl`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(plan, JSON.stringify({ log, questions }), 'utf8')
  await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${STUB}' '${plan}' "$@"\n`, { mode: 0o755 })
  return { path, log }
}

/**
 * How the endpoint answers one model call. `ok` streams a completion from the
 * model asked for; the others are the Tangle router's own refusals:
 * `billing` (a billing outage, retried), `payment` (a key that cannot pay),
 * `pricing` (an unknown model on a key with no allow-list, a 503) and
 * `substituted` (a completion from a model other than the one asked for).
 */
export type EndpointReply = 'ok' | 'billing' | 'payment' | 'pricing' | 'substituted'

const REFUSALS: Readonly<Record<'billing' | 'payment' | 'pricing', readonly [number, Record<string, string>]>> = {
  billing: [503, { message: 'Billing is temporarily unavailable. Retry shortly.', type: 'server_error', code: 'billing_unavailable' }],
  payment: [402, {
    message: 'Inference requires verified paid access. Add funds or activate a paid seat at id.tangle.tools.',
    type: 'insufficient_funds',
    code: 'payment_required',
  }],
  pricing: [503, {
    message: 'Trusted pricing is unavailable for the direct provider selected for model "MODEL".',
    type: 'server_error',
    code: 'provider_pricing_unavailable',
  }],
}

export interface FakeEndpoint {
  /** `OPENAI_BASE_URL` for the run. */
  readonly baseUrl: string
  /** Every chat completion request, in arrival order. */
  readonly requests: Array<{ readonly model: string; readonly authorized: boolean }>
  close(): Promise<void>
}

/**
 * An OpenAI-compatible endpoint that answers the n-th request with
 * `replies[n]`, and every later one with the last reply.
 */
export async function startEndpoint(replies: readonly EndpointReply[]): Promise<FakeEndpoint> {
  const requests: Array<{ model: string; authorized: boolean }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string }
      requests.push({ model: body.model, authorized: req.headers.authorization === `Bearer ${ASK_KEY}` })
      const reply = replies[Math.min(requests.length, replies.length) - 1]!
      if (reply !== 'ok' && reply !== 'substituted') {
        const [status, error] = REFUSALS[reply]
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { ...error, message: error.message!.replace('MODEL', body.model) } }))
        return
      }
      const model = reply === 'ok' ? body.model : 'accounts/fireworks/models/glm-5p3'
      const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(frame({ model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }))
      res.write(frame({ model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 2, total_tokens: 122, cost: 0.0004 } }))
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
