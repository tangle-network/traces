import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AmpAdapter } from '../src/adapters/amp.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { CopilotAdapter } from '../src/adapters/copilot.js'
import { FactoryAdapter } from '../src/adapters/factory.js'
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
