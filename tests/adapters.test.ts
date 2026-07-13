import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AmpAdapter } from '../src/adapters/amp.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { capText, CONTENT_CAP } from '../src/adapters/conversation.js'
import { CodexAdapter } from '../src/adapters/codex.js'
import { CopilotAdapter } from '../src/adapters/copilot.js'
import { FactoryAdapter } from '../src/adapters/factory.js'
import { ForgeAdapter } from '../src/adapters/forge.js'
import { GeminiAdapter } from '../src/adapters/gemini.js'
import { OpencodeAdapter } from '../src/adapters/opencode.js'
import { PiAdapter } from '../src/adapters/pi.js'
import { QwenAdapter } from '../src/adapters/qwen.js'
import { JsonlParseError } from '../src/jsonl.js'
import type { OtlpSpan } from '../src/otlp.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'tt-adapters-'))

function refFor(path: string, harness: string): SessionRef {
  return { harness, sessionId: 'fixture', path, cwd: null, mtimeMs: 0 }
}
const llm = (s: OtlpSpan[]) => s.find((x) => x.attributes['openinference.span.kind'] === 'LLM')
const tool = (s: OtlpSpan[]) => s.find((x) => x.attributes['openinference.span.kind'] === 'TOOL')
const userPrompt = (s: OtlpSpan[]) => s.find((x) => x.name === 'user.prompt')

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  )
}

function spanDigest(spans: OtlpSpan[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(spans))).digest('hex')
}

async function expectJsonlParseFailure(
  parse: Promise<unknown>,
  sourcePath: string,
  lineNumber: number,
  rawSecret: string,
): Promise<void> {
  const error = await parse.then(
    () => undefined,
    (cause: unknown) => cause,
  )

  expect(error).toBeInstanceOf(JsonlParseError)
  expect(error).toMatchObject({
    name: 'JsonlParseError',
    message: `Invalid JSONL at ${sourcePath}:${lineNumber}`,
    sourcePath,
    lineNumber,
  })
  expect(String(error)).not.toContain(rawSecret)
  expect(JSON.stringify(error)).not.toContain(rawSecret)
  expect((error as Error).stack).not.toContain(rawSecret)
}

describe('JSONL adapter streaming', () => {
  const adapters = [
    { harness: 'claude-code', make: () => new ClaudeAdapter() },
    { harness: 'github-copilot', make: () => new CopilotAdapter() },
    { harness: 'factory', make: () => new FactoryAdapter() },
    { harness: 'pi', make: () => new PiAdapter() },
    { harness: 'qwen', make: () => new QwenAdapter() },
  ]

  it.each(adapters)('$harness propagates a missing session file', async ({ harness, make }) => {
    await expect(make().parse(refFor(join(dir, 'missing-session.jsonl'), harness))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it.each(adapters)('$harness propagates malformed main-session JSON with its location', async ({ harness, make }) => {
    const path = join(dir, `${harness}-malformed-session.jsonl`)
    const rawSecret = `secret-${harness}-session-row`
    writeFileSync(path, `{}\n${rawSecret}\n{}\n`)

    await expectJsonlParseFailure(make().parse(refFor(path, harness)), path, 2, rawSecret)
  })

  it('propagates malformed Claude subagent JSON with its location', async () => {
    const path = join(dir, 'claude-malformed-subagent.jsonl')
    writeFileSync(path, '{}\n')
    const subDir = join(dir, 'claude-malformed-subagent', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const subagentPath = join(subDir, 'agent-secret.jsonl')
    const rawSecret = 'secret-claude-subagent-row'
    writeFileSync(subagentPath, `{}\n${rawSecret}\n{}\n`)

    await expectJsonlParseFailure(
      new ClaudeAdapter().parse(refFor(path, 'claude-code')),
      subagentPath,
      2,
      rawSecret,
    )
  })

  it('parses a 100 MB file with a fixed 128 MB heap', () => {
    const path = join(dir, 'large-ignored-session.jsonl')
    // Unique payloads prevent string deduplication from hiding retained rows.
    const suffix = 'x'.repeat(2040)
    const file = openSync(path, 'w')
    try {
      for (let start = 0; start < 50_000; start += 100) {
        const chunk = Array.from({ length: 100 }, (_, offset) =>
          JSON.stringify({ type: 'ignored', payload: `${start + offset}:${suffix}` }),
        )
        writeSync(file, `${chunk.join('\n')}\n`)
      }
    } finally {
      closeSync(file)
    }

    const adapterUrl = pathToFileURL(join(process.cwd(), 'src/adapters/claude.ts')).href
    const childSource = `
      import { ClaudeAdapter } from ${JSON.stringify(adapterUrl)}
      const spans = await new ClaudeAdapter().parse({
        harness: 'claude-code',
        sessionId: 'large',
        path: ${JSON.stringify(path)},
        cwd: null,
        mtimeMs: 0,
      })
      process.stdout.write(String(spans.length))
    `
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' }
    delete env.NODE_OPTIONS
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=128', '--import', 'tsx', '--input-type=module', '--eval', childSource],
      { cwd: process.cwd(), encoding: 'utf8', env, timeout: 30_000 },
    )

    expect(child.status, child.stderr || child.error?.message).toBe(0)
    expect(child.stdout).toBe('1')
  })
})

describe('amp adapter (thread JSON, camelCase usage)', () => {
  it('sums cache+fresh input tokens and flags tool errors', async () => {
    const path = join(dir, 'T-x.json')
    writeFileSync(
      path,
      JSON.stringify({
        id: 'T-x',
        created: 1000,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'please run ls' }] },
          {
            role: 'assistant',
            messageId: 1,
            usage: { model: 'claude', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 25 },
            content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true }] },
        ],
      }),
    )
    const spans = await new AmpAdapter().parse(refFor(path, 'amp'))
    expect(llm(spans)?.attributes['llm.input_tokens']).toBe(175)
    expect(llm(spans)?.attributes['llm.output_tokens']).toBe(10)
    expect(tool(spans)?.status.code).toBe('ERROR')
    // The human's prompt is captured; the tool-result-only user turn is not.
    expect(userPrompt(spans)?.attributes['content']).toContain('please run ls')
    expect(spans.filter((x) => x.name === 'user.prompt')).toHaveLength(1)
  })
})

describe('copilot adapter (event envelope, toolCallId join)', () => {
  it('carries ephemeral input tokens onto the LLM span and joins tool errors by id', async () => {
    const path = join(dir, 'copilot-events.jsonl')
    writeFileSync(
      path,
      [
        { type: 'assistant.usage', data: { inputTokens: 900, model: 'gpt-5' } },
        { type: 'assistant.message', timestamp: '2026-01-01T00:00:00Z', data: { messageId: 'm1', content: 'hi', outputTokens: 30 } },
        { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'shell', arguments: { cmd: 'x' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 't1', success: false, error: { message: 'boom' } } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    const spans = await new CopilotAdapter().parse(refFor(path, 'github-copilot'))
    expect(spanDigest(spans)).toBe('94cfe096ae5b7e1c9182306c8db364a0440212e8b9f97e84b2afc7c9f45d8d52')
    expect(llm(spans)?.attributes['llm.input_tokens']).toBe(900)
    expect(llm(spans)?.attributes['llm.output_tokens']).toBe(30)
    expect(tool(spans)?.status.code).toBe('ERROR')
    expect(tool(spans)?.status.message).toContain('boom')
    // Assistant text is captured; Copilot's log format carries no user prompt.
    expect(llm(spans)?.attributes['content']).toBe('hi')
    expect(userPrompt(spans)).toBeUndefined()
  })
})

describe('qwen adapter (flat ChatRecord, genai parts)', () => {
  it('reads Gemini-API token names and functionCall/functionResponse', async () => {
    const path = join(dir, 'qwen.jsonl')
    writeFileSync(
      path,
      [
        { type: 'user', sessionId: 's', message: { role: 'user', parts: [{ text: 'go' }] } },
        {
          type: 'assistant',
          sessionId: 's',
          model: 'qwen3',
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40 },
          message: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { p: 'a' } } }] },
        },
        { type: 'tool_result', sessionId: 's', toolCallResult: { status: 'error' }, message: { role: 'user', parts: [{ functionResponse: { name: 'read_file' } }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    const spans = await new QwenAdapter().parse(refFor(path, 'qwen'))
    expect(spanDigest(spans)).toBe('e351b605d91cc5c0217ca4bdab22aedc3b34db32cfcfea1777bba754764266c4')
    expect(llm(spans)?.attributes['llm.input_tokens']).toBe(500)
    expect(llm(spans)?.attributes['llm.output_tokens']).toBe(40)
    expect(tool(spans)?.attributes['tool.name']).toBe('read_file')
    expect(tool(spans)?.status.code).toBe('ERROR')
    // The user turn becomes a user.prompt span; the functionResponse (role:user) turn does not.
    expect(userPrompt(spans)?.attributes['content']).toBe('go')
    expect(spans.filter((x) => x.name === 'user.prompt')).toHaveLength(1)
  })
})

describe('factory adapter (Anthropic blocks + settings sidecar)', () => {
  it('pulls model from sidecar and maps tool_use/tool_result blocks', async () => {
    const base = join(dir, 'fac-sess')
    writeFileSync(
      `${base}.jsonl`,
      [
        { type: 'session_start', id: 'sess', cwd: '/x' },
        { type: 'message', id: 'a1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'edit', input: {} }] } },
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    writeFileSync(`${base}.settings.json`, JSON.stringify({ model: 'claude-opus-4-5', tokenUsage: { inputTokens: 1234, outputTokens: 56 } }))
    const spans = await new FactoryAdapter().parse(refFor(`${base}.jsonl`, 'factory'))
    expect(spanDigest(spans)).toBe('670b89a0d703b8181c605e44168b945edb66825952d714fc9d9e2430731b1ef5')
    expect(llm(spans)?.attributes['llm.model_name']).toBe('claude-opus-4-5')
    expect(tool(spans)?.attributes['tool.name']).toBe('edit')
    expect(tool(spans)?.status.code).toBe('ERROR')
    const root = spans.find((s) => s.attributes['openinference.span.kind'] === 'AGENT')
    expect(root?.attributes['session.input_tokens']).toBe(1234)
  })
})

describe('claude adapter (conversation capture)', () => {
  it('preserves complete output while folding subagents under their Agent call', async () => {
    const path = join(dir, 'claude.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          sessionId: 'claude-trace',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'assistant', model: 'opus', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { task: 'inspect' } }] },
        }),
        JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', is_error: false, content: 'done' }] } }),
      ].join('\n'),
    )
    const subDir = join(dir, 'claude', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-a.jsonl'),
      [
        { type: 'user', uuid: 'su1', timestamp: '2026-01-01T00:00:01.100Z', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'inspect' }] } },
        {
          type: 'assistant',
          uuid: 'sa1',
          timestamp: '2026-01-01T00:00:01.200Z',
          message: { role: 'assistant', model: 'haiku', usage: { input_tokens: 2, output_tokens: 1 }, content: [{ type: 'text', text: 'found it' }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    writeFileSync(join(subDir, 'agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'agent-call' }))

    const spans = await new ClaudeAdapter().parse(refFor(path, 'claude-code'))
    expect(spanDigest(spans)).toBe('07c0e5ddeb1f8ec5f219431173dc4f2b36ed074aae35ce150c6c86d612e286ac')
    expect(spans.map((item) => item.name)).toEqual(['session', 'user.prompt', 'llm.turn', 'tool.Agent', 'user.prompt', 'llm.turn'])
    expect(spans.every((item) => item.trace_id === 'claude-trace')).toBe(true)
    expect(spans[0]).toMatchObject({ start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:00:02Z' })
    const agentCall = tool(spans)
    expect(agentCall).toMatchObject({ end_time: '2026-01-01T00:00:02Z', status: { code: 'OK' } })
    expect(spans.filter((item) => item.attributes['agent.name'] === 'subagent:Explore').every((item) => item.parent_span_id === agentCall?.span_id)).toBe(true)
  })
})

// Conversation capture across every adapter: the user's prompt becomes a
// `user.prompt` span, the assistant's prose lands as `content` somewhere, and a
// tool call is recorded. (content lives in attributes['content'], any span kind.)
const hasContent = (s: OtlpSpan[], text: string) => s.some((x) => x.attributes['content'] === text)

describe('conversation capture — JSONL adapters', () => {
  const cases: Array<{ name: string; file: string; make: () => { parse(r: SessionRef): Promise<OtlpSpan[]> }; lines: unknown[]; toolName: string }> = [
    {
      name: 'codex', file: 'rollout-x.jsonl', make: () => new CodexAdapter(), toolName: 'test_tool',
      lines: [
        { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 's1', cwd: '/x' } },
        { type: 'turn_context', timestamp: '2026-06-20T00:00:01Z', payload: { model: 'gpt-4' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:02Z', payload: { type: 'message', role: 'user', content: 'hello world' } },
        { type: 'event_msg', timestamp: '2026-06-20T00:00:03Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:04Z', payload: { type: 'function_call', call_id: 'c1', name: 'test_tool', arguments: '{"a":1}' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:06Z', payload: { type: 'message', role: 'assistant', content: 'on it' } },
      ],
    },
    {
      name: 'pi', file: 'pi.jsonl', make: () => new PiAdapter(), toolName: 'test_tool',
      lines: [
        { type: 'session', id: 'trace-123', timestamp: '2026-06-20T10:00:00Z' },
        { type: 'message', id: 'm0', timestamp: '2026-06-20T10:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } },
        { type: 'message', id: 'm1', timestamp: '2026-06-20T10:00:02Z', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'on it' }, { type: 'tool_call', id: 'tc1', toolName: 'test_tool', input: { p: 1 } }] } },
      ],
    },
    {
      name: 'factory', file: 'fac.jsonl', make: () => new FactoryAdapter(), toolName: 'example_tool',
      lines: [
        { type: 'session_start', id: 'trace123', timestamp: '2026-06-20T00:00:00Z' },
        { type: 'message', id: 'msg1', timestamp: '2026-06-20T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } },
        { type: 'message', id: 'msg2', timestamp: '2026-06-20T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'tool1', name: 'example_tool', input: { k: 'v' } }] } },
      ],
    },
  ]
  for (const c of cases) {
    it(`${c.name} captures user.prompt + assistant text + a tool call`, async () => {
      const path = join(dir, c.file)
      writeFileSync(path, c.lines.map((l) => JSON.stringify(l)).join('\n'))
      const spans = await c.make().parse(refFor(path, c.name))
      if (c.name === 'pi') {
        expect(spanDigest(spans)).toBe('34349866cdd14e36ff4868c4299ded65958c853dd44c160d48526ec919af061b')
      }
      expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
      expect(hasContent(spans, 'on it')).toBe(true)
      expect(tool(spans)?.attributes['tool.name']).toBe(c.toolName)
    })
  }
})

describe('codex current tool and subagent events', () => {
  it('captures custom tool calls, joins their outputs, and tracks subagent lifecycles', async () => {
    const path = join(dir, 'rollout-codex-current.jsonl')
    const startedAt = Date.parse('2026-07-11T09:00:05.000Z')
    writeFileSync(
      path,
      [
        { type: 'session_meta', timestamp: '2026-07-11T09:00:00.000Z', payload: { id: 'codex-current', cwd: '/x' } },
        { type: 'turn_context', timestamp: '2026-07-11T09:00:01.000Z', payload: { model: 'gpt-5' } },
        { type: 'event_msg', timestamp: '2026-07-11T09:00:02.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 4 } } } },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:03.000Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-1',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'pnpm test' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.000Z',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'custom-1',
            output: [{ type: 'input_text', text: 'Command failed with exit code 1' }],
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.100Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-2',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'rm -rf build' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.200Z',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-2', output: 'Script completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.300Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-3',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'curl -X POST https://example.test/release' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.400Z',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-3', output: 'Script completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.500Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-4',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'curl https://example.test/health' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.600Z',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-4', output: 'Script completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.700Z',
          payload: {
            type: 'function_call',
            call_id: 'blocking-1',
            name: 'wait',
            arguments: '{"cell_id":"running-1"}',
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.800Z',
          payload: { type: 'function_call_output', call_id: 'blocking-1', output: 'Completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.900Z',
          payload: {
            type: 'function_call',
            call_id: 'domain-wait-1',
            name: 'wait',
            arguments: '{"job_id":"domain-1"}',
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.000Z',
          payload: { type: 'function_call_output', call_id: 'domain-wait-1', output: 'Completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.100Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'malformed-input-1',
            name: 'exec',
            input: { cmd: 'ls' },
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.200Z',
          payload: { type: 'custom_tool_call_output', call_id: 'malformed-input-1', output: 'Completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.300Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'write-stdin-1',
            name: 'exec',
            input: "const r = await tools.write_stdin({ session_id: 7, chars: '' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.400Z',
          payload: { type: 'custom_tool_call_output', call_id: 'write-stdin-1', output: 'Completed' },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:05.500Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'spawn-1',
            occurred_at_ms: startedAt,
            agent_thread_id: 'thread-1',
            agent_path: '/root/paper_audit',
            kind: 'started',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:06.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'message-1',
            occurred_at_ms: startedAt + 1_000,
            agent_thread_id: 'thread-1',
            agent_path: '/root/paper_audit',
            kind: 'interacted',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:07.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'interrupt-1',
            occurred_at_ms: startedAt + 2_000,
            agent_thread_id: 'thread-1',
            agent_path: '/root/paper_audit',
            kind: 'interrupted',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:08.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'spawn-2',
            occurred_at_ms: startedAt + 3_000,
            agent_thread_id: 'thread-2',
            agent_path: '/root/runtime_audit',
            kind: 'started',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:09.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'complete-2',
            occurred_at_ms: startedAt + 4_000,
            agent_thread_id: 'thread-2',
            agent_path: '/root/runtime_audit',
            kind: 'completed',
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    )

    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))
    const tools = spans.filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    expect(tools).toHaveLength(10)
    const verifications = tools.filter((item) => item.attributes['tool.name'] === 'exec_command.verify')
    expect(verifications).toHaveLength(2)
    const failedVerification = verifications.find((item) => item.status.code === 'ERROR')
    expect(failedVerification?.attributes.content).toContain('tools.exec_command')
    expect(failedVerification?.attributes['traces.codex.call_type']).toBe('custom_tool_call')
    expect(failedVerification?.attributes['traces.codex.outer_tool_name']).toBe('exec')
    expect(failedVerification?.attributes['traces.codex.nested_tool_name']).toBe('exec_command')
    expect(failedVerification?.status.message).toContain('Command failed')
    expect(verifications.find((item) => item.status.code === 'OK')?.attributes.content).toContain('/health')
    const mutations = tools.filter((item) => item.attributes['tool.name'] === 'exec_command')
    expect(mutations).toHaveLength(2)
    expect(mutations.map((item) => item.attributes.content)).toEqual([
      expect.stringContaining('rm -rf build'),
      expect.stringContaining('curl -X POST'),
    ])
    expect(mutations.every((item) => item.status.code === 'OK')).toBe(true)

    const waits = tools.filter((item) => item.attributes['tool.name'] === 'wait')
    expect(waits).toHaveLength(2)
    expect(waits.find((item) => String(item.attributes.content).includes('cell_id'))?.attributes['traces.expected_blocking']).toBe(true)
    expect(waits.find((item) => String(item.attributes.content).includes('job_id'))?.attributes['traces.expected_blocking']).toBeUndefined()
    expect(waits.every((item) => item.status.code === 'OK')).toBe(true)

    const malformed = tools.find((item) => item.attributes['tool.name'] === 'exec')
    expect(malformed?.attributes.content).toBe('{"cmd":"ls"}')
    expect(malformed?.status.code).toBe('OK')

    const writeStdin = tools.find((item) => item.attributes['tool.name'] === 'write_stdin')
    expect(writeStdin?.attributes['traces.expected_blocking']).toBe(true)
    expect(writeStdin?.status.code).toBe('OK')

    const agents = tools.filter((item) => item.attributes['tool.name'] === 'Agent')
    expect(agents).toHaveLength(2)
    const agent = agents.find((item) => String(item.attributes.content).includes('paper_audit'))
    expect(JSON.parse(String(agent?.attributes.content))).toEqual({
      subagent_type: 'paper_audit',
      agent_path: '/root/paper_audit',
      agent_thread_id: 'thread-1',
    })
    expect(agent?.start_time).toBe('2026-07-11T09:00:05.000Z')
    expect(agent?.end_time).toBe('2026-07-11T09:00:07.000Z')
    expect(agent?.status).toEqual({ code: 'ERROR', message: 'subagent interrupted' })

    const completed = agents.find((item) => String(item.attributes.content).includes('runtime_audit'))
    expect(completed?.start_time).toBe('2026-07-11T09:00:08.000Z')
    expect(completed?.end_time).toBe('2026-07-11T09:00:09.000Z')
    expect(completed?.status).toEqual({ code: 'OK' })
  })

  it.each([
    ['curl https://example.test/health', 'exec_command.verify'],
    ['curl -X HEAD https://example.test/health', 'exec_command.verify'],
    ['curl -F file=@x https://example.test/upload', 'exec_command'],
    ["curl --json '{\"ok\":true}' https://example.test", 'exec_command'],
    ['curl -T ./x https://example.test/upload', 'exec_command'],
    ['curl -d@payload.json https://example.test', 'exec_command'],
    ['curl -X PURGE https://example.test/cache', 'exec_command'],
  ])('classifies curl command %s as %s', async (command, expectedTool) => {
    const path = join(dir, `rollout-codex-curl-${expectedTool}-${command.length}.jsonl`)
    writeFileSync(
      path,
      [
        { type: 'session_meta', timestamp: '2026-07-11T09:00:00.000Z', payload: { id: `curl-${command}`, cwd: '/x' } },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:01.000Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'curl-1',
            name: 'exec',
            input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} })`,
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:02.000Z',
          payload: { type: 'custom_tool_call_output', call_id: 'curl-1', output: 'Completed' },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    )
    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))
    const tool = spans.find((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    expect(tool?.attributes['tool.name']).toBe(expectedTool)
  })
})

describe('conversation capture — single-JSON adapters', () => {
  it('gemini captures user.prompt + assistant text + a tool call', async () => {
    const path = join(dir, 'gem.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: 'g1',
        startTime: '2026-06-20T00:00:00Z',
        messages: [
          { id: 'm0', type: 'user', content: 'hello world', timestamp: '2026-06-20T00:00:00Z' },
          { id: 'm1', type: 'assistant', content: 'on it', timestamp: '2026-06-20T00:00:01Z', model: 'gemini', tokens: { input: 2, output: 2 }, toolCalls: [{ id: 'tc0', name: 'test-tool', args: { k: 'v' }, status: 'ok' }] },
        ],
      }),
    )
    const spans = await new GeminiAdapter().parse(refFor(path, 'gemini'))
    expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
    expect(hasContent(spans, 'on it')).toBe(true)
    expect(tool(spans)?.attributes['tool.name']).toBe('test-tool')
  })

  it('forge captures user.prompt + assistant text + a tool call', async () => {
    const path = join(dir, 'x-dump.json')
    writeFileSync(
      path,
      JSON.stringify({
        conversation_id: 'c1',
        messages: [
          { text: { role: 'user', content: 'hello world' }, usage: {} },
          { text: { role: 'assistant', content: 'on it', model: 'claude-opus', tool_calls: [{ name: 'test_tool', call_id: 'c1', arguments: { k: 'v' } }] }, usage: { prompt_tokens: { actual: 100 }, completion_tokens: { actual: 50 } } },
        ],
      }),
    )
    const spans = await new ForgeAdapter().parse(refFor(path, 'forge'))
    expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
    expect(hasContent(spans, 'on it')).toBe(true)
    expect(tool(spans)?.attributes['tool.name']).toBe('test_tool')
  })
})

describe('opencode adapter (split-dir conversation capture)', () => {
  it('reads message text parts as user.prompt + assistant content', async () => {
    // opencode resolves `part/` from XDG_DATA_HOME/opencode/storage, not relative
    // to the message dir, so point XDG_DATA_HOME at the fixture root.
    const base = mkdtempSync(join(tmpdir(), 'tt-oc-'))
    const storage = join(base, 'opencode', 'storage')
    const w = (rel: string, body: unknown) => {
      const p = join(storage, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(body))
    }
    w('message/session-001/msg-001.json', { id: 'msg-001', role: 'user', modelID: null, tokens: { input: 10, output: 0 }, time: { created: 1_000_000, completed: 1_000_100 } })
    w('message/session-001/msg-002.json', { id: 'msg-002', role: 'assistant', modelID: 'claude', tokens: { input: 10, output: 20 }, time: { created: 1_000_100, completed: 1_000_500 } })
    w('part/msg-001/part-001.json', { type: 'text', text: 'hello world' })
    w('part/msg-002/part-001.json', { type: 'text', text: 'on it' })
    w('part/msg-002/part-002.json', { type: 'tool', tool: 'bash', callID: 'call-001', state: { status: 'ok', input: { command: 'ls' } } })
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = base
    try {
      const spans = await new OpencodeAdapter().parse(refFor(join(storage, 'message', 'session-001'), 'opencode'))
      expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
      expect(hasContent(spans, 'on it')).toBe(true)
      expect(tool(spans)?.attributes['tool.name']).toBe('bash')
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
    }
  })
})

describe('capText', () => {
  it('trims short text and marks truncation with the dropped count', () => {
    expect(capText('  hi  ')).toBe('hi')
    const long = 'x'.repeat(CONTENT_CAP + 50)
    const out = capText(long)
    expect(out.startsWith('x'.repeat(CONTENT_CAP))).toBe(true)
    expect(out).toContain('[+50 chars]')
    expect(out.length).toBeLessThan(long.length)
  })
})

// A codex *continuation* session leads with a session_meta that has no cwd (or a
// turn_context); cwd must be recovered from a later cwd-bearing line so the
// session still gets repo labels instead of coming back cwd:null.
describe('codex cwd recovery — continuation sessions', () => {
  it('recovers cwd from turn_context when the leading session_meta lacks it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-codex-cont-'))
    const day = join(base, 'sessions', '2026', '06', '20')
    mkdirSync(day, { recursive: true })
    const lines = [
      { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 'cont1' } },
      { type: 'turn_context', timestamp: '2026-06-20T00:00:01Z', payload: { model: 'gpt-4', cwd: '/home/u/code/myrepo' } },
    ]
    writeFileSync(join(day, 'rollout-2026-06-20T00-00-00-cont1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = base
    try {
      const refs = await new CodexAdapter().locate({})
      expect(refs.find((r) => r.sessionId === 'cont1')?.cwd).toBe('/home/u/code/myrepo')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })
})

// Gemini/Qwen-family sessions live at tmp/<projectHash>/chats/; for a *registered*
// project the hash IS the project name, reversible via <home>/projects.json →
// recover cwd. (Unregistered/digest dirs stay null — unavoidable.)
describe('gemini cwd recovery — registered projects', () => {
  it('resolves cwd from projects.json for a registered project name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-gem-home-'))
    mkdirSync(join(home, '.gemini', 'tmp', 'myrepo', 'chats'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: { '/home/u/code/myrepo': 'myrepo' } }))
    writeFileSync(join(home, '.gemini', 'tmp', 'myrepo', 'chats', 'session-1.json'), JSON.stringify({ sessionId: 's1', messages: [] }))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const refs = await new GeminiAdapter().locate({})
      expect(refs.find((r) => r.sessionId === 'session-1')?.cwd).toBe('/home/u/code/myrepo')
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
    }
  })
})
