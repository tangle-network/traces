/**
 * The codex parent-to-child join, on the file shape the lab actually runs.
 *
 * Measured 2026-09-01 (discovery #80): `traces analyze --harness codex --session <parent>
 * --workflow` reported `1 seed session, 1 resolved session, 0 relationship issues` for a parent
 * that had issued three `spawn_agent` calls, with the three child rollouts sitting in the same
 * directory. Two id-bearing join keys exist and both are absent on codex `exec` 0.148-0.152:
 * the `sub_agent_activity` event stream is never emitted (0 of 14 lab-captured rollouts), and the
 * spawn's own output is `{"task_name": "/root/c1_b_grid"}` with no agent id.
 *
 * These fixtures carry that exact shape: no `sub_agent_activity`, a `task_name`-only spawn result,
 * and children whose `session_meta` stamps `parent_thread_id` beside `agent_path`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import { collectSessionWorkflow, describeSessionRelationship } from '../src/index.js'
import type { SessionRef } from '../src/index.js'

const PARENT_ID = '01a05e99-3b2e-7023-91e4-0b43ce7d5477'
const CHILD_IDS = [
  '01a05eac-c4c2-7911-9582-731c6ebfcb69',
  '01a05eac-c4c2-7911-9582-731c6ebfcb70',
  '01a05eac-c4c2-7911-9582-731c6ebfcb71',
]
const AGENT_PATHS = ['/root/c1_b_grid', '/root/c2_s_constb', '/root/c3_mitigation']

let home: string
let sessionDir: string

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

/** A parent rollout that spawns by task name and never sees an agent id come back. */
function parentRollout(paths: readonly string[]): string {
  const rows = [
    line({
      type: 'session_meta',
      timestamp: '2026-09-01T20:11:34.000Z',
      payload: { id: PARENT_ID, cwd: '/home/agent/lab', originator: 'codex_exec' },
    }),
    line({
      type: 'turn_context',
      timestamp: '2026-09-01T20:11:35.000Z',
      payload: { model: 'gpt-5.4-codex' },
    }),
  ]
  paths.forEach((agentPath, index) => {
    const callId = `call_${index}`
    rows.push(line({
      type: 'response_item',
      timestamp: `2026-09-01T20:32:5${index}.000Z`,
      payload: {
        type: 'function_call',
        call_id: callId,
        name: 'spawn_agent',
        // The instruction itself is a Fernet ciphertext; only the task name is plaintext.
        arguments: JSON.stringify({ task_name: agentPath, message: 'gAAAAABo0000-ciphertext' }),
      },
    }))
    rows.push(line({
      type: 'response_item',
      timestamp: `2026-09-01T20:33:0${index}.000Z`,
      payload: {
        type: 'function_call_output',
        call_id: callId,
        // No agent id anywhere in the result. This is the whole defect.
        output: JSON.stringify({ task_name: agentPath }),
      },
    }))
  })
  rows.push(line({
    type: 'event_msg',
    timestamp: '2026-09-01T20:34:00.000Z',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 42730, output_tokens: 120 } } },
  }))
  return rows.join('')
}

/** A child rollout with the lineage codex really stamps on a spawned thread. */
function childRollout(id: string, agentPath: string, parentId = PARENT_ID): string {
  return [
    line({
      type: 'session_meta',
      timestamp: '2026-09-01T20:32:57.000Z',
      payload: {
        id,
        cwd: '/home/agent/lab',
        parent_thread_id: parentId,
        thread_source: 'subagent',
        agent_nickname: 'Turing',
        agent_path: agentPath,
        source: { subagent: { thread_spawn: { depth: 1, agent_path: agentPath, parent_thread_id: parentId } } },
      },
    }),
    // A forked child's rollout prepends the parent's rows, so the child's own work starts at the
    // `task_started` whose turn id IS its session id. Without it there is no fork boundary and the
    // file total overstates the child's spend by up to 937x.
    line({
      type: 'event_msg',
      timestamp: '2026-09-01T20:32:57.500Z',
      payload: { type: 'task_started', turn_id: id, started_at: 1788294777 },
    }),
    line({ type: 'turn_context', timestamp: '2026-09-01T20:32:58.000Z', payload: { model: 'gpt-5.4-codex' } }),
    line({
      type: 'event_msg',
      timestamp: '2026-09-01T20:33:05.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 553_755, output_tokens: 2049 } } },
    }),
  ].join('')
}

async function writeSession(name: string, body: string): Promise<string> {
  const path = join(sessionDir, name)
  await writeFile(path, body)
  return path
}

const parentRef = (path: string): SessionRef => ({
  harness: 'codex',
  sessionId: PARENT_ID,
  path,
  cwd: '/home/agent/lab',
  mtimeMs: 0,
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-join-'))
  sessionDir = join(home, 'sessions', '2026', '09', '01')
  await mkdir(sessionDir, { recursive: true })
  process.env.CODEX_HOME = home
})

afterEach(async () => {
  delete process.env.CODEX_HOME
  await rm(home, { recursive: true, force: true })
})

describe('codex parent-to-child join by agent path', () => {
  it('names every spawn that carries no child session id', async () => {
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, parentRollout(AGENT_PATHS))
    const adapter = new CodexAdapter()
    const ref = parentRef(path)
    const relationship = describeSessionRelationship(ref, await adapter.parse(ref))

    // The id-bearing keys really are empty — this is the state the old code called clean.
    expect(relationship.childSessionIds).toEqual([])
    expect(relationship.spawnedChildSessionIds).toEqual([])
    // The path key is present on all three.
    expect(relationship.unjoinedSpawnPaths).toEqual([...AGENT_PATHS].sort())
  })

  it('joins the three children the runtime never saw, and reports no issue once joined', async () => {
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, parentRollout(AGENT_PATHS))
    for (const [index, id] of CHILD_IDS.entries()) {
      await writeSession(`rollout-2026-09-01T20-32-57-${id}.jsonl`, childRollout(id, AGENT_PATHS[index]!))
    }
    const adapter = new CodexAdapter()
    const workflow = await collectSessionWorkflow(adapter, [parentRef(path)])

    expect(workflow.sessions.map((session) => session.relationship.sessionId).sort())
      .toEqual([PARENT_ID, ...CHILD_IDS].sort())
    expect(workflow.issues).toEqual([])
    expect(workflow.complete).toBe(true)

    const parent = workflow.sessions.find((session) => session.relationship.sessionId === PARENT_ID)!
    expect(parent.relationship.childSessionIds).toEqual([...CHILD_IDS].sort())
    expect(parent.relationship.spawnedChildSessionIds).toEqual([...CHILD_IDS].sort())
    for (const child of workflow.sessions.filter((session) => session.relationship.sessionId !== PARENT_ID)) {
      expect(child.relationship.parentSessionId).toBe(PARENT_ID)
      expect(child.relationship.role).toBe('child')
    }
  })

  it('never reports zero issues when a spawned child cannot be joined', async () => {
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, parentRollout(AGENT_PATHS))
    // Only one of the three children is on disk. The other two are real spawns with no file.
    await writeSession(
      `rollout-2026-09-01T20-32-57-${CHILD_IDS[0]}.jsonl`,
      childRollout(CHILD_IDS[0]!, AGENT_PATHS[0]!),
    )
    const workflow = await collectSessionWorkflow(new CodexAdapter(), [parentRef(path)])

    expect(workflow.complete).toBe(false)
    const unjoined = workflow.issues.filter((issue) => issue.kind === 'unjoined-child')
    expect(unjoined).toHaveLength(2)
    expect(unjoined.map((issue) => (issue as { agentPath: string }).agentPath).sort())
      .toEqual([AGENT_PATHS[1], AGENT_PATHS[2]].sort())
    for (const issue of unjoined) {
      expect(issue).toMatchObject({ parentSessionId: PARENT_ID, reason: 'not-found' })
    }
  })

  it('reports an ambiguous pair rather than picking one file', async () => {
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, parentRollout([AGENT_PATHS[0]!]))
    await writeSession(`rollout-2026-09-01T20-32-57-${CHILD_IDS[0]}.jsonl`, childRollout(CHILD_IDS[0]!, AGENT_PATHS[0]!))
    await writeSession(`rollout-2026-09-01T20-32-58-${CHILD_IDS[1]}.jsonl`, childRollout(CHILD_IDS[1]!, AGENT_PATHS[0]!))
    const workflow = await collectSessionWorkflow(new CodexAdapter(), [parentRef(path)])

    expect(workflow.complete).toBe(false)
    expect(workflow.issues).toEqual([{
      kind: 'unjoined-child',
      parentSessionId: PARENT_ID,
      agentPath: AGENT_PATHS[0],
      reason: 'ambiguous',
      candidates: [CHILD_IDS[0], CHILD_IDS[1]].sort(),
    }])
  })

  it('never joins a child that names a different parent', async () => {
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, parentRollout([AGENT_PATHS[0]!]))
    // Same agent path, another parent's child. The pair is the key; the path alone is not.
    await writeSession(
      `rollout-2026-09-01T20-32-57-${CHILD_IDS[0]}.jsonl`,
      childRollout(CHILD_IDS[0]!, AGENT_PATHS[0]!, 'some-other-parent-thread'),
    )
    const workflow = await collectSessionWorkflow(new CodexAdapter(), [parentRef(path)])

    expect(workflow.sessions).toHaveLength(1)
    expect(workflow.issues).toEqual([{
      kind: 'unjoined-child',
      parentSessionId: PARENT_ID,
      agentPath: AGENT_PATHS[0],
      reason: 'not-found',
    }])
  })

  it('an adapter with no path join still states the miss', async () => {
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, parentRollout([AGENT_PATHS[0]!]))
    const adapter = new CodexAdapter()
    const withoutJoin = Object.create(adapter) as CodexAdapter
    Object.defineProperty(withoutJoin, 'locateSpawnedChildren', { value: undefined })
    const workflow = await collectSessionWorkflow(withoutJoin, [parentRef(path)])

    expect(workflow.complete).toBe(false)
    expect(workflow.issues).toEqual([{
      kind: 'unjoined-child',
      parentSessionId: PARENT_ID,
      agentPath: AGENT_PATHS[0],
      reason: 'unsupported',
    }])
  })

  it('a resolved id keeps its own join; the path key is only the fallback', async () => {
    const rows = [
      line({ type: 'session_meta', timestamp: '2026-09-01T20:11:34.000Z', payload: { id: PARENT_ID, cwd: '/home/agent/lab' } }),
      line({
        type: 'response_item',
        timestamp: '2026-09-01T20:32:50.000Z',
        payload: { type: 'function_call', call_id: 'c0', name: 'spawn_agent', arguments: JSON.stringify({ task_name: AGENT_PATHS[0] }) },
      }),
      line({
        type: 'response_item',
        timestamp: '2026-09-01T20:33:00.000Z',
        payload: { type: 'function_call_output', call_id: 'c0', output: JSON.stringify({ agent_id: CHILD_IDS[0] }) },
      }),
    ].join('')
    const path = await writeSession(`rollout-2026-09-01T20-11-34-${PARENT_ID}.jsonl`, rows)
    const adapter = new CodexAdapter()
    const ref = parentRef(path)
    const relationship = describeSessionRelationship(ref, await adapter.parse(ref))

    expect(relationship.childSessionIds).toEqual([CHILD_IDS[0]])
    // The spawn resolved by id, so it is not on the fallback list at all.
    expect(relationship.unjoinedSpawnPaths).toEqual([])
  })
})
