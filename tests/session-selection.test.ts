import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectSessionSelection,
  span,
  type HarnessTraceAdapter,
  type OtlpSpan,
  type SessionRef,
} from '../src/index.js'

function ref(id: string, path: string): SessionRef {
  return {
    harness: 'synthetic',
    sessionId: id,
    path,
    cwd: '/repo',
    mtimeMs: 0,
  }
}

function sessionSpans(
  id: string,
  relationship: { parent?: string; children?: readonly string[] } = {},
): OtlpSpan[] {
  return [span({
    traceId: id,
    spanId: `root:${id}`,
    name: 'session',
    kind: 'AGENT',
    startTime: '2026-01-01T00:00:00.000Z',
    service: 'synthetic',
    extra: {
      'traces.session.role': relationship.parent ? 'child' : 'operator',
      ...(relationship.parent ? { 'traces.parent_session_id': relationship.parent } : {}),
      ...(relationship.children
        ? { 'traces.child_session_ids': JSON.stringify(relationship.children) }
        : {}),
    },
  })]
}

describe('session selection', () => {
  it('expands and byte-binds a selected workflow through the public API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-selection-'))
    const root = ref('root', join(dir, 'root.jsonl'))
    const child = ref('child', join(dir, 'child.jsonl'))
    await writeFile(root.path, '{"session":"root"}\n', 'utf8')
    await writeFile(child.path, '{"session":"child"}\n', 'utf8')
    const scopes: Array<{ id: string; scope: string | undefined }> = []
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [root, child]
      },
      async parse(selected, options) {
        scopes.push({ id: selected.sessionId, scope: options?.taskScope })
        return selected.sessionId === 'root'
          ? sessionSpans('root', { children: ['child'] })
          : sessionSpans('child', { parent: 'root' })
      },
    }

    const selection = await collectSessionSelection(
      [{ adapter, refs: [root] }],
      { workflow: true, taskScope: 'latest', bindSources: true },
    )

    expect(selection.workflow).toEqual({
      seedSessionIds: ['root'],
      complete: true,
      issues: [],
    })
    expect(selection.rows.map((row) => ({
      id: row.ref.sessionId,
      taskScope: row.taskScope,
      digestLength: row.sourceSha256?.length,
    }))).toEqual([
      { id: 'root', taskScope: 'latest', digestLength: 64 },
      { id: 'child', taskScope: 'all', digestLength: 64 },
    ])
    expect(scopes).toEqual([
      { id: 'root', scope: 'latest' },
      { id: 'child', scope: 'all' },
      { id: 'root', scope: 'latest' },
      { id: 'child', scope: 'all' },
    ])
  })

  it('rejects relationship drift between workflow discovery and byte binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-selection-drift-'))
    const root = ref('root', join(dir, 'root.jsonl'))
    const child = ref('child-a', join(dir, 'child.jsonl'))
    await writeFile(root.path, '{"session":"root"}\n', 'utf8')
    await writeFile(child.path, '{"session":"child-a"}\n', 'utf8')
    let rootParses = 0
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [root, child]
      },
      async parse(selected) {
        if (selected.sessionId === 'child-a') return sessionSpans('child-a', { parent: 'root' })
        rootParses += 1
        return sessionSpans('root', { children: [rootParses === 1 ? 'child-a' : 'child-b'] })
      },
    }

    await expect(collectSessionSelection(
      [{ adapter, refs: [root] }],
      { workflow: true, bindSources: true },
    )).rejects.toThrow(`session relationships changed during workflow selection: ${root.path}`)
  })

  it('rejects a source file changed while its bound row is parsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-selection-mutation-'))
    const root = ref('root', join(dir, 'root.jsonl'))
    await writeFile(root.path, '{"state":1}\n', 'utf8')
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [root]
      },
      async parse() {
        await writeFile(root.path, '{"state":2}\n', 'utf8')
        return sessionSpans('root')
      },
    }

    await expect(collectSessionSelection(
      [{ adapter, refs: [root] }],
      { bindSources: true },
    )).rejects.toThrow(`session source changed while parsing; refusing unbound evidence: ${root.path}`)
  })

  it('binds every adapter-declared source file and rejects a nested worker mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-selection-composite-mutation-'))
    const root = ref('root', join(dir, 'root.jsonl'))
    const worker = join(dir, 'worker.jsonl')
    await writeFile(root.path, '{"session":"root"}\n', 'utf8')
    await writeFile(worker, '{"state":1}\n', 'utf8')
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [root]
      },
      async sourcePaths() {
        return [root.path, worker]
      },
      async parse() {
        await writeFile(worker, '{"state":2}\n', 'utf8')
        return sessionSpans('root')
      },
    }

    await expect(collectSessionSelection(
      [{ adapter, refs: [root] }],
      { bindSources: true },
    )).rejects.toThrow(`session source changed while parsing; refusing unbound evidence: ${root.path}`)
  })
})
