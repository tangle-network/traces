import { describe, expect, it } from 'vitest'
import {
  EmptySessionError,
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

async function scanIds(options: Parameters<typeof scanSessions>[0]): Promise<string[]> {
  const ids: string[] = []
  for await (const session of scanSessions(options)) ids.push(session.ref.sessionId)
  return ids
}

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
  it('continues only when onError explicitly handles empty and failed sessions', async () => {
    const errors: Array<{ error: unknown; ref?: SessionRef }> = []
    const out = await scanIds({
      adapters: [adapter({ s1: oneSpan(), s2: [], s3: 'throw' })],
      onError: (error, sessionRef) => errors.push({ error, ref: sessionRef }),
    })

    expect(out).toEqual(['s1'])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ ref: ref('s2') })
    expect(errors[0]!.error).toBeInstanceOf(EmptySessionError)
    expect(errors[1]).toMatchObject({ ref: ref('s3') })
    expect(errors[1]!.error).toEqual(new Error('parse boom'))
  })

  it('rethrows parse failures by default', async () => {
    await expect(scanIds({ adapters: [adapter({ s1: 'throw' })] })).rejects.toThrow('parse boom')
  })

  it('rethrows locate failures by default', async () => {
    const failingLocate: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        throw new Error('locate boom')
      },
      async parse() {
        return oneSpan()
      },
    }

    await expect(scanIds({ adapters: [failingLocate] })).rejects.toThrow('locate boom')
  })

  it('forwards strict corruption mode to adapters', async () => {
    let received: string | undefined
    const strictAdapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [ref('strict')]
      },
      async parse(_ref, options) {
        received = options?.corruptionMode
        return oneSpan()
      },
    }

    await expect(scanIds({ adapters: [strictAdapter], corruptionMode: 'strict' })).resolves.toEqual(['strict'])
    expect(received).toBe('strict')
  })

  it('does not hide a degraded unknown-cwd session behind the cwd filter', async () => {
    const degraded = ref('degraded')
    degraded.integrity = {
      status: 'degraded_not_lossless',
      corruptions: [{
        receiptVersion: 1,
        kind: 'jsonl_corruption',
        status: 'degraded_not_lossless',
        harness: degraded.harness,
        sessionId: degraded.sessionId,
        sourcePath: degraded.path,
        lineNumber: 1,
        byteOffset: 0,
        byteLength: 3,
        sha256: '0'.repeat(64),
        rawBytes: 'local_source_only',
      }],
    }
    const degradedAdapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [degraded]
      },
      async parse() {
        return oneSpan()
      },
    }

    await expect(scanIds({ adapters: [degradedAdapter], cwd: '/expected/repo' })).resolves.toEqual(['degraded'])
  })

  it('rejects a discovered session that parses to zero spans', async () => {
    const error = await scanIds({ adapters: [adapter({ s2: [] })] }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(EmptySessionError)
    expect(error).toMatchObject({ sourcePath: '/tmp/s2' })
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
  it('parses ISO and epoch-millis strings, including a real epoch-zero value', () => {
    expect(parseIsoToEpochMs('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(parseIsoToEpochMs('1700000000000')).toBe(1_700_000_000_000)
    expect(parseIsoToEpochMs('0')).toBe(0)
  })

  it('rejects empty, malformed, and non-finite timestamps', () => {
    expect(() => parseIsoToEpochMs('')).toThrow(/non-empty/)
    expect(() => parseIsoToEpochMs('not-a-date')).toThrow(/invalid timestamp/)
    expect(() => parseIsoToEpochMs('999999999999999999999999')).toThrow(/invalid timestamp/)
  })
})

describe('environment identity attributes', () => {
  it('round-trips a SessionEnvironment through span attributes without clobbering adapter values', async () => {
    const { environmentFromSpanAttributes, stampEnvironmentAttrs } = await import('../src/attributes.js')
    const environment = {
      image: 'ghcr.io/tangle-network/sandbox:base',
      imageDigest: `sha256:${'d'.repeat(64)}`,
      sandboxId: 'sbx-rt-1',
      cwd: '/workspace/repo',
    }
    const spans = [
      { attributes: { 'container.image.name': 'adapter-set:keep' } as Record<string, unknown> },
      { attributes: {} as Record<string, unknown> },
    ]
    stampEnvironmentAttrs(spans, environment)
    expect(spans[0]!.attributes['container.image.name']).toBe('adapter-set:keep')
    expect(spans[1]!.attributes['container.image.name']).toBe('ghcr.io/tangle-network/sandbox:base')
    expect(environmentFromSpanAttributes([spans[1]!])).toEqual(environment)
  })

  it('returns null when no environment identity was ever recorded', async () => {
    const { environmentFromSpanAttributes } = await import('../src/attributes.js')
    expect(environmentFromSpanAttributes([{ attributes: { unrelated: 'x' } }])).toBeNull()
  })
})
