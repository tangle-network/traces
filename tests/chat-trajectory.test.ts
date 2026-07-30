import { describe, expect, it } from 'vitest'
import { chatTrajectoryToSpans } from '../src/chat-trajectory.js'
import { exportTraceEvidenceRows } from '../src/file-export.js'

const trajectory = {
  instance_id: 'case-1',
  trajectory_format: 'mini-swe-agent-1',
  info: { model_stats: { instance_cost: 0.25, api_calls: 2 } },
  messages: [
    { role: 'system', content: 'Solve the task.', timestamp: 1_700_000_000 },
    { role: 'user', content: 'Fix the parser.', timestamp: 1_700_000_001 },
    {
      role: 'assistant',
      content: 'I will inspect it.',
      timestamp: 1_700_000_002,
      extra: {
        response: {
          model: 'gpt-5',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 2 },
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
      },
    },
    { role: 'user', content: '<returncode>0</returncode>', timestamp: 1_700_000_003 },
    { role: 'assistant', content: 'Tests pass.', timestamp: 1_700_000_004 },
  ],
}

describe('chatTrajectoryToSpans', () => {
  it('preserves assistant action ordinals and captured model usage', () => {
    const spans = chatTrajectoryToSpans(trajectory)

    expect(spans).toHaveLength(6)
    expect(spans.every((item) => item.trace_id === 'case-1')).toBe(true)
    expect(spans.map((item) => item.span_id)).toEqual([
      'root',
      'message-1',
      'message-2',
      'step-1',
      'message-4',
      'step-2',
    ])
    expect(spans[0]?.attributes).toMatchObject({
      'llm.cost_usd': 0.25,
      'trajectory.action_count': 2,
      'trajectory.api_calls': 2,
      'trajectory.timestamps_synthetic': false,
    })
    expect(spans[3]?.attributes).toMatchObject({
      'llm.model_name': 'gpt-5',
      'llm.token_count.prompt': 10,
      'llm.token_count.completion': 5,
      'llm.token_count.reasoning': 2,
      'llm.token_count.prompt_cache_hit': 3,
      step: 1,
    })
  })

  it('can align labels that count every message', () => {
    const spans = chatTrajectoryToSpans(
      [
        { role: 'human', content: 'Start' },
        { role: 'Planner', content: 'Delegate' },
        { role: 'Worker', content: 'Act' },
      ],
      { traceId: 'multi-agent-1', stepMode: 'message' },
    )

    expect(spans.slice(1).map((item) => item.span_id)).toEqual(['step-1', 'step-2', 'step-3'])
    expect(spans[2]?.attributes).toMatchObject({
      'agent.name': 'Planner',
      'trajectory.role': 'Planner',
      step: 2,
    })
  })

  it('detects trajectory objects and bare message arrays', () => {
    const objectResult = exportTraceEvidenceRows([trajectory])
    const arrayResult = exportTraceEvidenceRows(trajectory.messages)

    expect(objectResult.format).toBe('chat-trajectory')
    expect(objectResult.spans).toHaveLength(6)
    expect(arrayResult.format).toBe('chat-trajectory')
    expect(arrayResult.spans).toHaveLength(6)
  })

  it('rejects an explicitly malformed message timestamp', () => {
    expect(() => chatTrajectoryToSpans([
      { role: 'user', content: 'Start', timestamp: 'not-a-date' },
    ])).toThrow(/message 1 has an invalid timestamp/)
  })

  it('rejects partial timestamps instead of mixing real and synthetic time', () => {
    expect(() =>
      chatTrajectoryToSpans([
        { role: 'user', content: 'Start', timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'Finish' },
      ]),
    ).toThrow(/timestamps must be present on every message or none/)
  })

  it('rejects timestamps that contradict transcript order', () => {
    expect(() =>
      chatTrajectoryToSpans([
        { role: 'user', content: 'Start', timestamp: '2026-01-01T00:00:01Z' },
        { role: 'assistant', content: 'Finish', timestamp: '2026-01-01T00:00:00Z' },
      ]),
    ).toThrow(/message 2 timestamp precedes message 1/)
  })

  it('rejects duplicate trajectory identities in one export', () => {
    expect(() => exportTraceEvidenceRows([trajectory, trajectory])).toThrow(
      /duplicate span identity \(case-1, root\)/,
    )
  })
})
