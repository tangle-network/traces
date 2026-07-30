import { describe, expect, it, vi } from 'vitest'
import {
  collectSessionWorkflow,
  describeSessionRelationship,
  SessionWorkflowError,
  span,
  type HarnessTraceAdapter,
  type OtlpSpan,
  type SessionRef,
} from '../src/index.js'

interface Node {
  readonly id: string
  readonly path?: string
  readonly parent?: string
  readonly children?: readonly string[]
  readonly spawned?: readonly string[]
  readonly resumed?: readonly string[]
  readonly nickname?: string
  readonly depth?: number
  readonly mtimeMs?: number
}

function ref(node: Node): SessionRef {
  return {
    harness: 'synthetic',
    sessionId: node.id,
    path: node.path ?? `/sessions/${node.id}.jsonl`,
    cwd: '/repo',
    mtimeMs: node.mtimeMs ?? 0,
  }
}

function spans(node: Node): OtlpSpan[] {
  const result: OtlpSpan[] = [span({
    traceId: node.id,
    spanId: `root:${node.id}`,
    name: 'session',
    kind: 'AGENT',
    startTime: new Date(node.mtimeMs ?? 0).toISOString(),
    service: 'synthetic',
    extra: {
      'traces.session.role': node.parent ? 'child' : 'operator',
      ...(node.parent ? { 'traces.parent_session_id': node.parent } : {}),
      ...(node.children ? { 'traces.child_session_ids': JSON.stringify(node.children) } : {}),
      ...(node.nickname ? { 'traces.codex.agent_nickname': node.nickname } : {}),
      ...(node.depth !== undefined ? { 'traces.codex.agent_depth': node.depth } : {}),
    },
  })]
  if (node.resumed) {
    result.push(span({
      traceId: node.id,
      spanId: `send:${node.id}`,
      parentSpanId: `root:${node.id}`,
      name: 'tool.send_input',
      kind: 'TOOL',
      startTime: new Date(node.mtimeMs ?? 0).toISOString(),
      service: 'synthetic',
      extra: {
        'traces.codex.agent_operation': 'send_input',
        'traces.codex.agent_session_ids': JSON.stringify(node.resumed),
      },
    }))
  }
  if (node.spawned) {
    result.push(span({
      traceId: node.id,
      spanId: `spawn:${node.id}`,
      parentSpanId: `root:${node.id}`,
      name: 'tool.spawn_agent',
      kind: 'TOOL',
      startTime: new Date(node.mtimeMs ?? 0).toISOString(),
      service: 'synthetic',
      extra: {
        'traces.codex.agent_operation': 'spawn_agent',
        'traces.codex.agent_session_ids': JSON.stringify(node.spawned),
      },
    }))
  }
  return result
}

function adapter(nodes: readonly Node[]): HarnessTraceAdapter {
  const spansByPath = new Map(nodes.map((node) => [ref(node).path, spans(node)]))
  return {
    harness: 'synthetic',
    async locate() {
      return nodes.map(ref)
    },
    async parse(session) {
      const found = spansByPath.get(session.path)
      if (!found) throw new Error(`missing fixture ${session.path}`)
      return structuredClone(found)
    },
  }
}

describe('session workflows', () => {
  it('rejects an empty seed selection', async () => {
    await expect(collectSessionWorkflow(adapter([]), []))
      .rejects.toMatchObject({ code: 'SESSION_WORKFLOW_EMPTY_SELECTION' })
  })

  it('expands from a nested child to its parent, siblings, and descendants by stable ID', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['worker-a', 'worker-b'], nickname: 'same-name', mtimeMs: 4_000 },
      { id: 'worker-a', parent: 'root', children: ['nested'], nickname: 'same-name', depth: 1, mtimeMs: 3_000 },
      { id: 'worker-b', parent: 'root', nickname: 'same-name', depth: 1, mtimeMs: 1_000 },
      { id: 'nested', parent: 'worker-a', nickname: 'same-name', depth: 2, mtimeMs: 2_000 },
    ]
    const source = adapter(nodes)

    const workflow = await collectSessionWorkflow(source, [ref(nodes[3]!)])

    expect(workflow.complete).toBe(true)
    expect(workflow.seedSessionIds).toEqual(['nested'])
    expect(workflow.sessions.map((session) => session.relationship.sessionId)).toEqual([
      'root',
      'worker-a',
      'nested',
      'worker-b',
    ])
    expect(workflow.sessions.map((session) => session.relationship.agentNickname)).toEqual([
      'same-name',
      'same-name',
      'same-name',
      'same-name',
    ])
  })

  it('reports a referenced session that is not available instead of claiming a complete tree', async () => {
    const root = { id: 'root', children: ['missing-child'] }

    const workflow = await collectSessionWorkflow(adapter([root]), [ref(root)])

    expect(workflow.complete).toBe(false)
    expect(workflow.issues).toEqual([{
      kind: 'missing-session',
      sessionId: 'missing-child',
      referencedBySessionId: 'root',
      relation: 'child',
    }])
  })

  it('does not choose between duplicate files for a referenced session ID', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'] },
      { id: 'child', path: '/sessions/child-a.jsonl', parent: 'root' },
      { id: 'child', path: '/sessions/child-b.jsonl', parent: 'root' },
    ]

    const workflow = await collectSessionWorkflow(adapter(nodes), [ref(nodes[0]!)])

    expect(workflow.complete).toBe(false)
    expect(workflow.issues).toEqual([{
      kind: 'ambiguous-session',
      sessionId: 'child',
      referencedBySessionId: 'root',
      relation: 'child',
      paths: ['/sessions/child-a.jsonl', '/sessions/child-b.jsonl'],
    }])
  })

  it('reports contradictory parent links and cycles without recursing forever', async () => {
    const nodes: Node[] = [
      { id: 'a', parent: 'b', children: ['b'] },
      { id: 'b', parent: 'a', children: ['a'] },
    ]

    const workflow = await collectSessionWorkflow(adapter(nodes), [ref(nodes[0]!)])

    expect(workflow.complete).toBe(false)
    expect(workflow.sessions).toHaveLength(2)
    expect(workflow.issues).toContainEqual({ kind: 'cycle', sessionIds: ['a', 'b'] })
  })

  it('reports a child whose declared parent did not record the reverse link', async () => {
    const nodes: Node[] = [
      { id: 'root' },
      { id: 'child', parent: 'root' },
    ]

    const workflow = await collectSessionWorkflow(adapter(nodes), nodes.map(ref))

    expect(workflow.complete).toBe(false)
    expect(workflow.issues).toContainEqual({
      kind: 'parent-conflict',
      sessionId: 'child',
      declaredParentSessionId: 'root',
      referencedParentSessionIds: [],
    })
  })

  it('stops before parsing past the configured session limit', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'] },
      { id: 'child', parent: 'root' },
    ]

    await expect(collectSessionWorkflow(adapter(nodes), [ref(nodes[0]!)], { maxSessions: 1 }))
      .rejects.toMatchObject({ code: 'SESSION_WORKFLOW_LIMIT_EXCEEDED' } satisfies Partial<SessionWorkflowError>)
  })

  it('uses stable-ID lookup without cataloging unrelated sessions when the adapter supports it', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'] },
      { id: 'child', parent: 'root' },
      { id: 'unrelated' },
    ]
    const source = adapter(nodes)
    source.locate = vi.fn(async () => {
      throw new Error('full catalog should not run')
    })
    source.locateBySessionId = vi.fn(async (sessionId) =>
      nodes.filter((node) => node.id === sessionId).map(ref),
    )

    const workflow = await collectSessionWorkflow(source, [ref(nodes[0]!)])

    expect(workflow.complete).toBe(true)
    expect(workflow.sessions.map((session) => session.relationship.sessionId)).toEqual(['root', 'child'])
    expect(source.locate).not.toHaveBeenCalled()
    expect(source.locateBySessionId).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed relationship attributes instead of dropping the link', () => {
    const session = ref({ id: 'root' })
    const malformed = spans({ id: 'root' })
    malformed[0]!.attributes['traces.child_session_ids'] = '{not-json'

    expect(() => describeSessionRelationship(session, malformed)).toThrowError(
      expect.objectContaining({ code: 'SESSION_WORKFLOW_INVALID_RELATION' }),
    )
  })

  it('honors cancellation before discovery or parsing', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const source = adapter([{ id: 'root' }])
    source.locate = vi.fn(source.locate)

    await expect(collectSessionWorkflow(source, [ref({ id: 'root' })], { signal: controller.signal }))
      .rejects.toThrow('stop')
    expect(source.locate).not.toHaveBeenCalled()
  })

  it('forwards cancellation into an active parser and returns before its delay', async () => {
    const controller = new AbortController()
    const root = { id: 'root' }
    let parserStopped = false
    const source = adapter([root])
    source.parse = async (session, options) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        const stop = (): void => {
          clearTimeout(timer)
          parserStopped = true
          reject(options?.signal?.reason)
        }
        options?.signal?.addEventListener('abort', stop, { once: true })
      })
      return spans(root)
    }
    const startedAt = performance.now()
    setTimeout(() => controller.abort(new Error('stop')), 20)

    await expect(collectSessionWorkflow(source, [ref(root)], { signal: controller.signal }))
      .rejects.toThrow('stop')

    expect(performance.now() - startedAt).toBeLessThan(150)
    expect(parserStopped).toBe(true)
  })

  it('returns promptly when a custom parser ignores cancellation', async () => {
    const controller = new AbortController()
    const root = { id: 'root' }
    let receivedSignal: AbortSignal | undefined
    const source = adapter([root])
    source.parse = async (_session, options) => {
      receivedSignal = options?.signal
      return new Promise<OtlpSpan[]>(() => {})
    }
    const startedAt = performance.now()
    setTimeout(() => controller.abort(new Error('stop')), 20)

    await expect(collectSessionWorkflow(source, [ref(root)], { signal: controller.signal }))
      .rejects.toThrow('stop')

    expect(performance.now() - startedAt).toBeLessThan(150)
    expect(receivedSignal).toBe(controller.signal)
  })

  it('resolves a latest child to the exact parent task by stable child ID', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'] },
      { id: 'child', parent: 'root' },
    ]
    const scopes: Array<{ id: string; scope: string | undefined; turnId: string | undefined }> = []
    const source = adapter(nodes)
    const parse = source.parse.bind(source)
    source.parse = async (session, options) => {
      scopes.push({
        id: session.sessionId,
        scope: options?.taskScope,
        turnId: options?.taskTurnId,
      })
      return parse(session, options)
    }
    source.resolveParentTask = async (session, childSessionId) => {
      expect(session.sessionId).toBe('root')
      expect(childSessionId).toBe('child')
      return { kind: 'resolved', turnId: 'parent-turn' }
    }

    const workflow = await collectSessionWorkflow(source, [ref(nodes[1]!)], { taskScope: 'latest' })

    expect(workflow.complete).toBe(true)
    expect(scopes).toEqual([
      { id: 'child', scope: 'latest', turnId: undefined },
      { id: 'root', scope: 'turn', turnId: 'parent-turn' },
    ])
    expect(workflow.sessions.find((session) => session.relationship.sessionId === 'child')?.taskScope).toBe('latest')
    expect(workflow.sessions.find((session) => session.relationship.sessionId === 'root')).toMatchObject({
      taskScope: 'turn',
      taskTurnId: 'parent-turn',
    })
  })

  it('does not widen to all parent history when exact parent-task metadata is unavailable', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'] },
      { id: 'child', parent: 'root' },
    ]
    const source = adapter(nodes)
    source.resolveParentTask = async () => ({
      kind: 'unavailable',
      reason: 'parent-turn-metadata-missing',
    })

    const workflow = await collectSessionWorkflow(source, [ref(nodes[1]!)], { taskScope: 'latest' })

    expect(workflow.sessions.map((session) => session.relationship.sessionId)).toEqual(['child'])
    expect(workflow.complete).toBe(false)
    expect(workflow.issues).toEqual([{
      kind: 'unresolved-parent-task',
      parentSessionId: 'root',
      childSessionId: 'child',
      reason: 'parent-turn-metadata-missing',
    }])
  })

  it('reads existing workers targeted by a latest parent task at their latest task', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['new-child'], resumed: ['existing-child'] },
      { id: 'new-child', parent: 'root' },
      { id: 'existing-child', parent: 'root' },
    ]
    const scopes: Array<{ id: string; scope: string | undefined }> = []
    const source = adapter(nodes)
    const parse = source.parse.bind(source)
    source.parse = async (session, options) => {
      scopes.push({ id: session.sessionId, scope: options?.taskScope })
      return parse(session, options)
    }

    const workflow = await collectSessionWorkflow(source, [ref(nodes[0]!)], { taskScope: 'latest' })

    expect(workflow.complete).toBe(true)
    expect(scopes).toEqual([
      { id: 'root', scope: 'latest' },
      { id: 'existing-child', scope: 'latest' },
      { id: 'new-child', scope: 'all' },
    ])
  })

  it('keeps the full history of a child spawned and then steered in the selected task', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'], spawned: ['child'], resumed: ['child'] },
      { id: 'child', parent: 'root' },
    ]
    const scopes: Array<{ id: string; scope: string | undefined }> = []
    const source = adapter(nodes)
    const parse = source.parse.bind(source)
    source.parse = async (session, options) => {
      scopes.push({ id: session.sessionId, scope: options?.taskScope })
      const result = await parse(session, options)
      if (session.sessionId !== 'child') return result
      for (const [index, content] of ['INITIAL', 'FOLLOWUP'].entries()) {
        result.push(span({
          traceId: 'child',
          spanId: `prompt:${index}`,
          parentSpanId: 'root:child',
          name: 'user.prompt',
          kind: 'CHAIN',
          startTime: new Date(index).toISOString(),
          service: 'synthetic',
          extra: { content },
        }))
      }
      return result
    }

    const workflow = await collectSessionWorkflow(source, [ref(nodes[0]!)], { taskScope: 'latest' })

    expect(workflow.complete).toBe(true)
    expect(scopes).toEqual([
      { id: 'root', scope: 'latest' },
      { id: 'child', scope: 'all' },
    ])
    expect(workflow.sessions[0]?.relationship).toMatchObject({
      spawnedChildSessionIds: ['child'],
      resumedChildSessionIds: [],
    })
    expect(
      workflow.sessions
        .find((session) => session.relationship.sessionId === 'child')
        ?.spans.filter((item) => item.name === 'user.prompt')
        .map((item) => item.attributes.content),
    ).toEqual(['INITIAL', 'FOLLOWUP'])
  })

  it('keeps an explicit all-history child seed when its parent infers latest', async () => {
    const nodes: Node[] = [
      { id: 'root', children: ['child'], resumed: ['child'] },
      { id: 'child', parent: 'root' },
    ]
    const scopes: Array<{ id: string; scope: string | undefined }> = []
    const source = adapter(nodes)
    const parse = source.parse.bind(source)
    source.parse = async (session, options) => {
      scopes.push({ id: session.sessionId, scope: options?.taskScope })
      return parse(session, options)
    }

    const workflow = await collectSessionWorkflow(source, nodes.map(ref), { taskScope: 'all' })

    expect(workflow.complete).toBe(true)
    expect(scopes).toEqual([
      { id: 'root', scope: 'all' },
      { id: 'child', scope: 'all' },
    ])
  })
})
