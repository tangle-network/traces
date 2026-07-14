import { describe, expect, it } from 'vitest'
import { parseClaudeStream } from '../src/adapters/claude.js'
import { serializeSpans, span } from '../src/otlp.js'

describe('otlp span builder', () => {
  it('sets the vocabulary keys the analysts read', () => {
    const s = span({
      traceId: 't1',
      spanId: 's1',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:00Z',
      service: 'claude-code',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 10,
      costUsd: 0.02,
      step: 0,
    })
    expect(s.attributes['openinference.span.kind']).toBe('LLM')
    expect(s.attributes['service.name']).toBe('claude-code')
    expect(s.attributes['llm.model_name']).toBe('claude-opus-4-8')
    expect(s.attributes['llm.token_count.prompt']).toBe(100)
    expect(s.attributes['llm.token_count.completion']).toBe(20)
    expect(s.attributes['llm.token_count.reasoning']).toBe(5)
    expect(s.attributes['llm.token_count.prompt_cache_hit']).toBe(50)
    expect(s.attributes['llm.token_count.prompt_cache_write']).toBe(10)
    expect(s.attributes['tangle.llm.context_tokens']).toBe(160)
    expect(s.attributes['llm.cost_usd']).toBe(0.02)
    expect(s.attributes.step).toBe(0)
  })

  it('omits absent token counts rather than zeroing them', () => {
    const s = span({ traceId: 't', spanId: 's', name: 'x', kind: 'LLM', startTime: 'now' })
    expect('llm.token_count.prompt' in s.attributes).toBe(false)
    expect('llm.token_count.completion' in s.attributes).toBe(false)
  })

  it('serializes one span per line with a trailing newline', () => {
    const out = serializeSpans([
      span({ traceId: 't', spanId: 'a', name: 'x', kind: 'AGENT', startTime: 'now' }),
      span({ traceId: 't', spanId: 'b', name: 'y', kind: 'LLM', startTime: 'now' }),
    ])
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).span_id).toBe('a')
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('claude transcript → spans', () => {
  it('emits an LLM span with billed tokens and a child TOOL span, backfilling error status', () => {
    const events = [
      {
        type: 'assistant',
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200 },
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { cmd: 'ls' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-01-01T00:00:05Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'boom' }] },
      },
    ]
    const { spans, toolSpanByUseId } = parseClaudeStream(events, {
      traceId: 'sess',
      agent: 'claude-code',
      startStep: 0,
      idPrefix: '',
      rootParent: 'root',
    })

    const llm = spans.find((s) => s.attributes['openinference.span.kind'] === 'LLM')
    expect(llm?.attributes['llm.token_count.prompt']).toBe(1000)
    expect(llm?.attributes['llm.token_count.prompt_cache_hit']).toBe(200)
    expect(llm?.attributes['tangle.llm.context_tokens']).toBe(1200)
    expect(llm?.attributes['llm.token_count.completion']).toBe(50)

    const tool = toolSpanByUseId.get('call-1')
    expect(tool?.attributes['tool.name']).toBe('Bash')
    expect(tool?.parent_span_id).toBe(llm?.span_id)
    expect(tool?.status.code).toBe('ERROR')
    expect(tool?.status.message).toContain('boom')
  })
})
