import { describe, expect, it } from 'vitest'
import { span } from '../src/otlp.js'
import { toRuntimeStore } from '../src/runtime-store.js'

function trace(traceId: string) {
  return [
    span({
      traceId,
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
    }),
    span({
      traceId,
      spanId: 'step-1',
      parentSpanId: 'root',
      name: 'message.assistant',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:01.000Z',
    }),
  ]
}

describe('toRuntimeStore', () => {
  it('namespaces span and parent IDs so updates affect exactly one trace', async () => {
    const { store } = await toRuntimeStore([...trace('trace-a'), ...trace('trace-b')])

    await store.updateSpan('trace-a:step-1', { name: 'mutated' })
    const spans = await store.spans()
    const first = spans.find((item) => item.spanId === 'trace-a:step-1')
    const second = spans.find((item) => item.spanId === 'trace-b:step-1')

    expect(first).toMatchObject({
      name: 'mutated',
      parentSpanId: 'trace-a:root',
      attributes: {
        'traces.source.trace_id': 'trace-a',
        'traces.source.span_id': 'step-1',
        'traces.source.parent_span_id': 'root',
      },
    })
    expect(second).toMatchObject({
      name: 'message.assistant',
      parentSpanId: 'trace-b:root',
    })
  })

  it('rejects duplicate source identities before writing any runtime state', async () => {
    const item = trace('trace-a')[0]!

    await expect(toRuntimeStore([item, { ...item }])).rejects.toThrow(
      'duplicate span identity (trace-a, root)',
    )
  })
})
