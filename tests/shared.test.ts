import { describe, expect, it } from 'vitest'
import {
  type HarnessTraceAdapter,
  listAdapters,
  type OtlpSpan,
  parseIsoToEpochMs,
  scanSessions,
  selectAdapters,
  type SessionRef,
  span,
} from '../src/index.js'

const ref = (id: string): SessionRef => ({ harness: 'synthetic', sessionId: id, path: `/tmp/${id}`, cwd: null, mtimeMs: 0 })

function adapter(sessions: Record<string, OtlpSpan[] | 'throw'>): HarnessTraceAdapter {
  return {
    harness: 'synthetic',
    async locate() {
      return Object.keys(sessions).map(ref)
    },
    async parse(r) {
      const s = sessions[r.sessionId]
      if (s === 'throw') throw new Error('parse boom')
      return s ?? []
    },
  }
}
const oneSpan = (): OtlpSpan[] => [
  span({ traceId: 't', spanId: 's', name: 'session', kind: 'AGENT', startTime: '2026-01-01T00:00:00.000Z' }),
]

describe('selectAdapters', () => {
  it('explicit adapters win over all/harnesses', () => {
    const a = adapter({})
    expect(selectAdapters({ adapters: [a], all: true })).toEqual([a])
  })
  it('all / unspecified → every registered adapter', () => {
    expect(selectAdapters({ all: true })).toHaveLength(listAdapters().length)
    expect(selectAdapters({})).toHaveLength(listAdapters().length)
  })
  it('named harnesses resolve; an unknown one throws (fail-loud)', () => {
    expect(selectAdapters({ harnesses: ['claude-code'] })[0]!.harness).toBe('claude-code')
    expect(() => selectAdapters({ harnesses: ['nope-xyz'] })).toThrow(/unknown harness/)
  })
})

describe('scanSessions', () => {
  it('yields non-empty sessions, skips empty, routes parse errors to onError', async () => {
    const errors: unknown[] = []
    const out: string[] = []
    for await (const s of scanSessions({
      adapters: [adapter({ s1: oneSpan(), s2: [], s3: 'throw' })],
      onError: (e) => errors.push(e),
    })) {
      out.push(s.ref.sessionId)
      expect(s.spans.length).toBeGreaterThan(0)
    }
    expect(out).toEqual(['s1']) // s2 empty → skipped, s3 threw → onError
    expect(errors).toHaveLength(1)
  })
  it('stops immediately when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const out: string[] = []
    for await (const s of scanSessions({ adapters: [adapter({ s1: oneSpan() })], signal: c.signal })) {
      out.push(s.ref.sessionId)
    }
    expect(out).toEqual([])
  })
})

describe('parseIsoToEpochMs', () => {
  it('parses ISO + epoch-ms strings, 0 on empty/bad', () => {
    expect(parseIsoToEpochMs('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(parseIsoToEpochMs('1700000000000')).toBe(1_700_000_000_000)
    expect(parseIsoToEpochMs('')).toBe(0)
    expect(parseIsoToEpochMs('not-a-date')).toBe(0)
  })
})
