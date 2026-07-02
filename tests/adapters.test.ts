import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import type { OtlpSpan } from '../src/otlp.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'tt-adapters-'))

function refFor(path: string, harness: string): SessionRef {
  return { harness, sessionId: 'fixture', path, cwd: null, mtimeMs: 0 }
}
const llm = (s: OtlpSpan[]) => s.find((x) => x.attributes['openinference.span.kind'] === 'LLM')
const tool = (s: OtlpSpan[]) => s.find((x) => x.attributes['openinference.span.kind'] === 'TOOL')
const userPrompt = (s: OtlpSpan[]) => s.find((x) => x.name === 'user.prompt')

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
    expect(llm(spans)?.attributes['llm.model_name']).toBe('claude-opus-4-5')
    expect(tool(spans)?.attributes['tool.name']).toBe('edit')
    expect(tool(spans)?.status.code).toBe('ERROR')
    const root = spans.find((s) => s.attributes['openinference.span.kind'] === 'AGENT')
    expect(root?.attributes['session.input_tokens']).toBe(1234)
  })
})

describe('claude adapter (conversation capture)', () => {
  it('captures the user prompt + assistant text, but not a tool-result-only turn', async () => {
    const path = join(dir, 'claude.jsonl')
    writeFileSync(
      path,
      [
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'assistant', model: 'claude-opus', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }] },
        },
        { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: 'files' }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    const spans = await new ClaudeAdapter().parse(refFor(path, 'claude-code'))
    expect(userPrompt(spans)?.attributes['content']).toBe('do the thing')
    expect(spans.filter((x) => x.name === 'user.prompt')).toHaveLength(1)
    expect(llm(spans)?.attributes['content']).toBe('on it')
    expect(tool(spans)?.attributes['tool.name']).toBe('bash')
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
      expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
      expect(hasContent(spans, 'on it')).toBe(true)
      expect(tool(spans)?.attributes['tool.name']).toBe(c.toolName)
    })
  }
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
