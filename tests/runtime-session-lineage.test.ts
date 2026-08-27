import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type {
  RuntimeControllerTurnReceipt,
  SupervisorRunSessionLineage,
} from '@tangle-network/agent-eval/supervisor-run'
import { analyzeAdoption } from '../src/adoption.js'
import { PiAdapter } from '../src/adapters/pi.js'
import { span } from '../src/otlp.js'
import { analyzeReactions } from '../src/reactions.js'
import {
  parseCliBridgeSessionMap,
  stampRuntimeSessionLineage,
} from '../src/runtime-session-lineage.js'
import { describeSessionRelationship } from '../src/session-relationship.js'

const FIXTURE = new URL(
  './fixtures/runtime-session-map/recursive-steering-smoke.json',
  import.meta.url,
)
const PI_FIXTURE = new URL(
  './fixtures/pi/recursive-steering-observability.jsonl',
  import.meta.url,
)

function runtimeLineage(input: {
  nodeId: string
  backend: string
  nativeSessionId: string
  cwd?: string
  parentNodeId: string | null
  depth: number
  childNodeIds: readonly string[]
  controllerTurns?: readonly RuntimeControllerTurnReceipt[]
}): SupervisorRunSessionLineage {
  return {
    nodeId: input.nodeId,
    parentNodeId: input.parentNodeId,
    depth: input.depth,
    childNodeIds: input.childNodeIds,
    providerSession: {
      provider: 'cli-bridge',
      backend: input.backend,
      externalId: input.nodeId,
      nativeSessionId: input.nativeSessionId,
      cwd: input.cwd ?? `/workspaces/${encodeURIComponent(input.nodeId)}`,
      nativePromptCount: Math.max(
        1,
        ...(input.controllerTurns ?? []).map((receipt) => receipt.ordinal),
      ),
      controllerTurns: input.controllerTurns ?? [],
    },
  }
}

describe('Runtime native-session lineage', () => {
  it('normalizes the sanitized successful cli-bridge session map without metadata', async () => {
    const bindings = parseCliBridgeSessionMap(await readFile(FIXTURE, 'utf8'))

    expect(bindings).toEqual([
      {
        provider: 'cli-bridge',
        backend: 'pi',
        externalId: 'recursive-steering-smoke',
        nativeSessionId: '00000000-0000-4000-8000-000000000001',
        cwd: '/workspaces/recursive-steering-smoke',
        nativePromptCount: 1,
        controllerTurns: [
          {
            ordinal: 1,
            runId: 'recursive-steering-smoke:turn:1',
            bridgeRequestDigest: `sha256:${'a'.repeat(64)}`,
            promptSha256:
              'sha256:6ad905561d745a11be6d1a2511e9f2da2011c4c6191d34d58aaa0a1a9a2f5ee7',
            startedAt: 1_785_434_400_500,
            endedAt: 1_785_434_409_000,
          },
        ],
      },
      {
        provider: 'cli-bridge',
        backend: 'pi',
        externalId: 'recursive-steering-smoke:s0',
        nativeSessionId: '00000000-0000-4000-8000-000000000002',
        cwd: '/workspaces/recursive-steering-smoke%3As0',
        nativePromptCount: 2,
        controllerTurns: [
          {
            ordinal: 1,
            runId: 'recursive-steering-smoke:s0:turn:1',
            bridgeRequestDigest: `sha256:${'b'.repeat(64)}`,
            promptSha256:
              'sha256:1b72d6f85ebccfdb38366cee929ae64847c88d7ea95aaa0fa15da96c3a3b73ec',
            startedAt: 1_785_434_410_500,
            endedAt: 1_785_434_413_000,
          },
        ],
      },
    ])
    expect(Object.isFrozen(bindings)).toBe(true)
    expect(Object.isFrozen(bindings[0])).toBe(true)
    expect(Object.isFrozen(bindings[0]?.controllerTurns)).toBe(true)
    expect(Object.isFrozen(bindings[0]?.controllerTurns?.[0])).toBe(true)
    expect(bindings[0]).not.toHaveProperty('metadata')
  })

  it('refuses malformed or ambiguous bridge rows', () => {
    expect(() => parseCliBridgeSessionMap('{')).toThrow(/valid JSON/)
    expect(() => parseCliBridgeSessionMap('{}')).toThrow(/data array/)
    expect(() =>
      parseCliBridgeSessionMap(
        JSON.stringify({ data: [{ externalId: 'root', backend: 'pi' }] }),
      ),
    ).toThrow(/internalId/)
    expect(() =>
      parseCliBridgeSessionMap(
        JSON.stringify({
          data: [
            {
              externalId: 'root',
              backend: 'pi',
              internalId: 'native-1',
              cwd: '/workspace',
              turns: 1,
            },
            {
              externalId: 'root',
              backend: 'pi',
              internalId: 'native-2',
              cwd: '/workspace',
              turns: 1,
            },
          ],
        }),
      ),
    ).toThrow(/repeat one external id/)
    expect(
      parseCliBridgeSessionMap(
        JSON.stringify({
          data: [
            {
              externalId: 'historical-root',
              backend: 'pi',
              internalId: 'native-1',
              cwd: '/workspace',
              turns: 1,
            },
            {
              externalId: 'current-root',
              backend: 'pi',
              internalId: 'native-1',
              cwd: '/workspace',
              turns: 1,
            },
          ],
        }),
      ),
    ).toHaveLength(2)
    expect(() =>
      parseCliBridgeSessionMap(
        JSON.stringify({
          data: [
            {
              externalId: 'root',
              backend: 'pi',
              internalId: 'native-1',
              cwd: '/workspace',
              turns: 1,
              controllerTurns: [
                {
                  ordinal: 2,
                  runId: 'root:turn:2',
                  bridgeRequestDigest: `sha256:${'a'.repeat(64)}`,
                  promptSha256: `sha256:${'b'.repeat(64)}`,
                  startedAt: '2026-07-30T00:00:00.000Z',
                  endedAt: '2026-07-30T00:00:01.000Z',
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/ordinal must be within/)
    expect(() =>
      parseCliBridgeSessionMap(
        JSON.stringify({
          data: [
            {
              externalId: 'root',
              backend: 'pi',
              internalId: 'native-1',
              cwd: '/workspace',
              nativePromptCount: 0,
            },
          ],
        }),
      ),
    ).toThrow(/nativePromptCount must be a positive/)
  })

  it('stamps exact parent, depth, and child identity without mutating native spans', () => {
    const native = [
      span({
        traceId: 'native-child',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-07-30T00:00:00.000Z',
        service: 'pi',
      }),
      span({
        traceId: 'native-child',
        spanId: 'assistant',
        parentSpanId: 'root',
        name: 'message.assistant',
        kind: 'LLM',
        startTime: '2026-07-30T00:00:01.000Z',
        service: 'pi',
        content: 'Now I must continue.',
      }),
      span({
        traceId: 'native-child',
        spanId: 'resumed-runtime-input',
        parentSpanId: 'root',
        name: 'user.prompt',
        kind: 'CHAIN',
        startTime: '2026-07-30T00:00:02.000Z',
        content: 'Build this exactly once. Do not hardcode the result.',
        extra: { 'tangle.actor': 'human' },
      }),
    ]
    const stamped = stampRuntimeSessionLineage(native, runtimeLineage({
      nodeId: 'run:s0',
      backend: 'pi',
      nativeSessionId: 'native-child',
      cwd: '/workspaces/run%3As0',
      parentNodeId: 'run',
      depth: 1,
      childNodeIds: ['run:s0:s0'],
      controllerTurns: [
        {
          ordinal: 1,
          runId: 'run:s0:turn:1',
          bridgeRequestDigest: `sha256:${'a'.repeat(64)}`,
          promptSha256:
            'sha256:fa8eca1d5caa48e71cafec9ad1fb93c6611ec261c17a8b10748ed0c8abbc0a57',
          startedAt: 1_785_369_601_500,
          endedAt: 1_785_369_602_500,
        },
      ],
    }))

    expect(stamped[0]?.attributes).toMatchObject({
      'traces.session.role': 'child',
      'traces.session.depth': 1,
      'traces.parent_session_id': 'run',
      'traces.child_session_ids': '["run:s0:s0"]',
      'traces.runtime.node_id': 'run:s0',
      'traces.runtime.parent_node_id': 'run',
      'traces.provider.provider': 'cli-bridge',
      'traces.provider.backend': 'pi',
      'traces.provider.external_id': 'run:s0',
      'traces.provider.native_session_id': 'native-child',
      'traces.provider.trace_id': 'native-child',
      'traces.runtime.exact_prompt_count': 1,
      'traces.provider.native_prompt_count': 1,
      'traces.runtime.missing_prompt_ordinals': '[]',
      'tangle.sessionId': 'run:s0',
    })
    expect(stamped.every((item) => item.trace_id === 'run:s0')).toBe(true)
    expect(stamped.map((item) => item.span_id)).toEqual(['root', 'resumed-runtime-input'])
    expect(stamped[1]).not.toBe(native[2])
    expect(native[0]?.attributes).not.toHaveProperty('traces.session.role')
    expect(native[2]?.attributes['tangle.actor']).toBe('human')
    expect(stamped[1]?.attributes['tangle.actor']).toBe('agent')
    expect(analyzeReactions(native).humanReactionTurns).toBe(1)
    expect(analyzeReactions(stamped).humanReactionTurns).toBe(0)
    expect(
      describeSessionRelationship(
        {
          harness: 'pi',
          sessionId: 'native-child',
          path: '/sessions/native-child.jsonl',
          cwd: null,
          mtimeMs: 0,
        },
        stamped,
      ),
    ).toMatchObject({
      sessionId: 'run:s0',
      role: 'child',
      parentSessionId: 'run',
      childSessionIds: ['run:s0:s0'],
      depth: 1,
    })
  })

  it('keeps mixed Pi/Codex native ids as provenance behind canonical Runtime ids', () => {
    const nativeSessionId = 'same-native-id'
    const nativeSpan = (service: string) => [
      span({
        traceId: nativeSessionId,
        spanId: `root:${service}`,
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-07-30T00:00:00.000Z',
        service,
      }),
    ]
    const root = stampRuntimeSessionLineage(nativeSpan('pi'), runtimeLineage({
      nodeId: 'run',
      backend: 'pi',
      nativeSessionId,
      parentNodeId: null,
      depth: 0,
      childNodeIds: ['run:s0'],
    }))
    const child = stampRuntimeSessionLineage(nativeSpan('codex'), runtimeLineage({
      nodeId: 'run:s0',
      backend: 'codex',
      nativeSessionId,
      parentNodeId: 'run',
      depth: 1,
      childNodeIds: [],
    }))

    expect(root[0]?.trace_id).toBe('run')
    expect(child[0]?.trace_id).toBe('run:s0')
    expect(root[0]?.attributes['traces.provider.native_session_id']).toBe(nativeSessionId)
    expect(child[0]?.attributes['traces.provider.native_session_id']).toBe(nativeSessionId)
    expect(child[0]?.attributes['traces.parent_session_id']).toBe('run')
    expect(root[0]?.attributes['traces.child_session_ids']).toBe('["run:s0"]')
  })

  it('never rewrites an unreceipted or mismatched native prompt as agent input', () => {
    const native = [
      span({
        traceId: 'native',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-07-30T00:00:00.000Z',
      }),
      span({
        traceId: 'native',
        spanId: 'prompt',
        parentSpanId: 'root',
        name: 'user.prompt',
        kind: 'CHAIN',
        startTime: '2026-07-30T00:00:01.000Z',
        content: 'human follow-up',
        extra: { 'tangle.actor': 'human' },
      }),
    ]
    const lineage = runtimeLineage({
      nodeId: 'run',
      backend: 'pi',
      nativeSessionId: 'native',
      parentNodeId: null,
      depth: 0,
      childNodeIds: [],
    })
    const unreceipted = stampRuntimeSessionLineage(native, lineage)
    expect(unreceipted).toHaveLength(1)
    expect(unreceipted[0]?.attributes).toMatchObject({
      'traces.runtime.exact_prompt_count': 0,
      'traces.provider.native_prompt_count': 1,
      'traces.runtime.missing_prompt_ordinals': '[1]',
    })
    expect(() =>
      stampRuntimeSessionLineage(native, {
        ...lineage,
        providerSession: {
          ...lineage.providerSession!,
          controllerTurns: [
            {
              ordinal: 1,
              runId: 'run:turn:1',
              bridgeRequestDigest: `sha256:${'a'.repeat(64)}`,
              promptSha256: `sha256:${'b'.repeat(64)}`,
              startedAt: 1_785_369_600_500,
              endedAt: 1_785_369_601_500,
            },
          ],
        },
      }),
    ).toThrow(/maps to 0 exact native provider prompts/)
  })

  it('attributes only the exact resumed turn and stops before the next native prompt', () => {
    const native = [
      span({
        traceId: 'native-resumed',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-07-30T00:00:00.000Z',
        endTime: '2026-07-30T00:00:30.000Z',
      }),
      span({
        traceId: 'native-resumed',
        spanId: 'stale-prompt',
        parentSpanId: 'root',
        name: 'user.prompt',
        kind: 'CHAIN',
        startTime: '2026-07-30T00:00:01.000Z',
        content: 'stale human prompt',
        extra: { 'tangle.actor': 'human' },
      }),
      span({
        traceId: 'native-resumed',
        spanId: 'stale-response',
        parentSpanId: 'root',
        name: 'message.assistant',
        kind: 'LLM',
        startTime: '2026-07-30T00:00:02.000Z',
      }),
      span({
        traceId: 'native-resumed',
        spanId: 'controller-prompt',
        parentSpanId: 'root',
        name: 'user.prompt',
        kind: 'CHAIN',
        startTime: '2026-07-30T00:00:10.000Z',
        content: 'exact controller prompt',
        extra: { 'tangle.actor': 'human' },
      }),
      span({
        traceId: 'native-resumed',
        spanId: 'controller-response',
        parentSpanId: 'root',
        name: 'message.assistant',
        kind: 'LLM',
        startTime: '2026-07-30T00:00:11.000Z',
      }),
      span({
        traceId: 'native-resumed',
        spanId: 'next-native-prompt',
        parentSpanId: 'root',
        name: 'user.prompt',
        kind: 'CHAIN',
        startTime: '2026-07-30T00:00:12.000Z',
        content: 'unreceipted native prompt',
        extra: { 'tangle.actor': 'human' },
      }),
      span({
        traceId: 'native-resumed',
        spanId: 'next-native-response',
        parentSpanId: 'root',
        name: 'message.assistant',
        kind: 'LLM',
        startTime: '2026-07-30T00:00:13.000Z',
      }),
    ]
    const receipt: RuntimeControllerTurnReceipt = {
      ordinal: 2,
      runId: 'run:turn:2',
      bridgeRequestDigest: `sha256:${'a'.repeat(64)}`,
      promptSha256:
        'sha256:e25fc876a91b3376119248cbb2fefe9be8878b60b63f0a8ba32f3609aca87418',
      startedAt: Date.parse('2026-07-30T00:00:09.000Z'),
      endedAt: Date.parse('2026-07-30T00:00:20.000Z'),
    }
    const stamped = stampRuntimeSessionLineage(native, {
      ...runtimeLineage({
        nodeId: 'run',
        backend: 'pi',
        nativeSessionId: 'native-resumed',
        parentNodeId: null,
        depth: 0,
        childNodeIds: [],
        controllerTurns: [receipt],
      }),
      providerSession: {
        ...runtimeLineage({
          nodeId: 'run',
          backend: 'pi',
          nativeSessionId: 'native-resumed',
          parentNodeId: null,
          depth: 0,
          childNodeIds: [],
        }).providerSession!,
        nativePromptCount: 3,
        controllerTurns: [receipt],
      },
    })

    expect(stamped.map((item) => item.span_id)).toEqual([
      'root',
      'controller-prompt',
      'controller-response',
    ])
    expect(stamped[0]?.start_time).toBe('2026-07-30T00:00:10.000Z')
    expect(stamped[0]?.end_time).toBe('2026-07-30T00:00:12.000Z')
    expect(stamped[0]?.attributes).toMatchObject({
      'traces.runtime.exact_prompt_count': 1,
      'traces.provider.native_prompt_count': 3,
      'traces.runtime.missing_prompt_ordinals': '[1,3]',
    })
    expect(stamped[1]?.attributes['tangle.actor']).toBe('agent')
    expect(stamped.some((item) => item.span_id === 'next-native-prompt')).toBe(false)
  })

  it('keeps Runtime steering out of human praise and counts only the successful Pi spawn', async () => {
    const path = decodeURIComponent(PI_FIXTURE.pathname)
    const spans = await new PiAdapter().parse({
      harness: 'pi',
      sessionId: '00000000-0000-4000-8000-000000000001',
      path,
      cwd: '/workspaces/recursive-steering-smoke',
      mtimeMs: 0,
    })
    const downMessage = spans.find(
      (item) =>
        item.name === 'user.prompt'
        && String(item.attributes.content).includes('agent-runtime.down-messages'),
    )
    const initialPrompt = spans.find(
      (item) =>
        item.name === 'user.prompt'
        && item.attributes.content === 'Run one recursive steering smoke test.',
    )
    const adoption = await analyzeAdoption(spans)

    expect(initialPrompt?.attributes['traces.prompt_sha256']).toBe(
      'sha256:6ad905561d745a11be6d1a2511e9f2da2011c4c6191d34d58aaa0a1a9a2f5ee7',
    )
    expect(downMessage?.attributes['tangle.actor']).toBe('agent')
    expect(analyzeReactions(spans).signals.praise).toBe(0)
    expect(adoption.totalSubagentSpawns).toBe(1)
    expect(adoption.subagentSpawns).toEqual({ 'steering-child': 1 })
  })
})
