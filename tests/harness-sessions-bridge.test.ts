import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAdapter } from '../src/registry.js'
import { parseSession } from '../src/session-source.js'

const row = (timestamp: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, message: { type, payload } })

describe('shared native-session bridge', () => {
  it('analyzes Kimi with a real human prompt, model usage, and a tool result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-kimi-bridge-'))
    const path = join(dir, 'wire.jsonl')
    await writeFile(path, [
      row(1791331200, 'TurnBegin', { user_input: 'Inspect the repository' }),
      row(1791331201, 'StepBegin', {}),
      row(1791331202, 'ToolCall', { id: 'call-1', function: { name: 'Shell', arguments: '{"command":"pwd"}' } }),
      row(1791331203, 'ToolResult', { tool_call_id: 'call-1', return_value: { output: '/work', is_error: false } }),
      row(1791331204, 'StatusUpdate', { token_usage: { input_other: 3, output: 5, input_cache_read: 7 } }),
      row(1791331205, 'TurnEnd', {}),
    ].join('\n') + '\n')

    const adapter = resolveAdapter('kimi')!
    const spans = await parseSession(adapter, {
      harness: 'kimi', sessionId: 'test-kimi', path, cwd: null, mtimeMs: 0,
    })
    expect(spans.find((span) => span.name === 'user.prompt')?.attributes).toMatchObject({
      'tangle.actor': 'human', content: 'Inspect the repository',
    })
    expect(spans.find((span) => span.name === 'llm.call')?.attributes).toMatchObject({
      'llm.token_count.prompt': 3,
      'llm.token_count.completion': 5,
      'llm.token_count.prompt_cache_hit': 7,
    })
    expect(spans.find((span) => span.name === 'tool.Shell')?.attributes['tool.name']).toBe('Shell')
    expect(spans.every((span) => ['OK', 'ERROR', 'UNSET'].includes(span.status.code))).toBe(true)
  })

  it('refuses a timestamp-free native session rather than inventing epoch work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-kimi-no-time-'))
    const path = join(dir, 'wire.jsonl')
    await writeFile(path, JSON.stringify({ message: { type: 'TurnBegin', payload: { user_input: 'hello' } } }) + '\n')
    const adapter = resolveAdapter('kimi')!
    await expect(parseSession(adapter, {
      harness: 'kimi', sessionId: 'missing-time', path, cwd: null, mtimeMs: 0,
    })).rejects.toThrow(/produced no spans/)
  })
})
