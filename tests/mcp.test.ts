/**
 * `traces mcp` over stdio, the way an MCP client runs it: the server answers
 * `tools/list` with agent-eval's read-only span tools over the spans a ref
 * selected, and a `tools/call` result is redacted and carries the
 * untrusted-text notice. 1.0 keeps today's behavior; the job tools are U13 (1.1).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UNTRUSTED_TRACE_TEXT } from '@tangle-network/agent-eval/traces'
import { deriveHexId, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { describe, expect, it } from 'vitest'
import { CLI } from './run-cli.js'

const TRACE = deriveHexId('mcp-smoke-trace', 16)
/** A credential in a tool's input: the server must never serve it. */
const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'

interface RpcMessage {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

/** A JSON-RPC client on a spawned `traces mcp`: one request per line, answered by id. */
function connect(argv: readonly string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, { resolve: (message: RpcMessage) => void; reject: (error: Error) => void }>()
  let stdout = ''
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
    for (let newline = stdout.indexOf('\n'); newline >= 0; newline = stdout.indexOf('\n')) {
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as RpcMessage
      if (message.id !== undefined) pending.get(message.id)?.resolve(message)
      if (message.id !== undefined) pending.delete(message.id)
    }
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      for (const { reject } of pending.values()) reject(new Error(`traces mcp exited ${code}: ${stderr}`))
      resolve(code)
    })
  })
  let nextId = 1
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  return {
    request(method: string, params: Record<string, unknown> = {}): Promise<RpcMessage> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ id, method, params })
      })
    },
    notify(method: string): void {
      write({ method })
    },
    async close(): Promise<number | null> {
      child.stdin.end()
      return exited
    },
    stderr: () => stderr,
  }
}

describe('traces mcp', () => {
  it('serves the span tools over stdio, redacted and marked untrusted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-mcp-'))
    const spans = join(dir, 'spans.otlp.jsonl')
    await writeFile(spans, `${[
      llmSpan({
        traceId: TRACE,
        spanId: deriveHexId('mcp-llm', 8),
        parentSpanId: null,
        name: 'turn',
        model: 'glm-5.2',
        inputTokens: 40,
        outputTokens: 8,
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:00:01.000Z',
      }),
      toolSpan({
        traceId: TRACE,
        spanId: deriveHexId('mcp-tool', 8),
        parentSpanId: null,
        name: 'bash',
        toolName: 'bash',
        startTime: '2026-01-01T00:00:01.000Z',
        endTime: '2026-01-01T00:00:02.000Z',
        attributes: { 'input.value': `curl -H "Authorization: Bearer ${TOKEN}" https://example.com` },
      }),
    ].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const server = connect(['mcp', spans], {
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOME: join(dir, 'home'),
      XDG_STATE_HOME: join(dir, 'state'),
    })
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'traces' }, capabilities: { tools: {} } })
    server.notify('notifications/initialized')

    const listed = await server.request('tools/list')
    const tools = (listed.result!.tools as Array<{ name: string; annotations: Record<string, boolean> }>)
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'countTraces', 'getDatasetOverview', 'queryTraces', 'searchSpan', 'searchTrace', 'viewSpans', 'viewTrace',
    ])
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })

    const called = await server.request('tools/call', { name: 'viewTrace', arguments: { trace_id: TRACE } })
    expect(called.error).toBeUndefined()
    const text = (called.result!.content as Array<{ text: string }>)[0]!.text
    expect((called.result!.structuredContent as { untrusted: string }).untrusted).toBe(UNTRUSTED_TRACE_TEXT)
    expect(text).toContain('bash')
    expect(text).toContain('[REDACTED')
    expect(text).not.toContain(TOKEN)
    expect(server.stderr()).toContain('traces mcp: serving 2 span(s) over stdio')

    expect(await server.close()).toBe(0)
  }, 60_000)
})
