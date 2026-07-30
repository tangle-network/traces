import { describe, expect, it } from 'vitest'
import type { OtlpSpan } from '../src/otlp.js'
import { span } from '../src/otlp.js'
import { parseSession } from '../src/session-source.js'
import type { HarnessTraceAdapter, SessionRef } from '../src/types.js'

const ref: SessionRef = {
  harness: 'hostile',
  sessionId: 'session-1',
  path: '/tmp/session-1.jsonl',
  cwd: null,
  mtimeMs: 0,
}

function validSpan(): OtlpSpan {
  return span({
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'session',
    kind: 'AGENT',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
  })
}

function adapterReturning(values: readonly unknown[]): HarnessTraceAdapter {
  return {
    harness: 'hostile',
    async locate() {
      return [ref]
    },
    async parse() {
      return values as OtlpSpan[]
    },
  }
}

describe('parseSession span validation', () => {
  it('rejects duplicate trace and span identities from public adapters', async () => {
    const item = validSpan()

    await expect(parseSession(adapterReturning([item, { ...item }]), ref)).rejects.toThrow(
      'duplicate span identity (trace-1, span-1)',
    )
  })

  it('rejects malformed timestamps from public adapters', async () => {
    await expect(
      parseSession(adapterReturning([{ ...validSpan(), start_time: 'not-a-date' }]), ref),
    ).rejects.toThrow(/start_time must be a finite/)
  })

  it('rejects intervals whose end precedes their start', async () => {
    await expect(
      parseSession(
        adapterReturning([{
          ...validSpan(),
          start_time: '2026-01-01T00:00:02.000Z',
          end_time: '2026-01-01T00:00:01.000Z',
        }]),
        ref,
      ),
    ).rejects.toThrow(/end_time must not precede start_time/)
  })

  it('rejects missing required fields from public adapters', async () => {
    const item = { ...validSpan() } as Record<string, unknown>
    delete item.name

    await expect(parseSession(adapterReturning([item]), ref)).rejects.toThrow(
      /name must be a non-empty string/,
    )
  })
})
