/**
 * A Runtime run's agents as the Sandbox streamed them, read while the run still runs.
 *
 * A settle exports each agent's native session to the run's retained OTLP. Until then, and for
 * the executions a reopen starts after that export, the run's retained live stream
 * (`evidence/live-stream/`) is its only record of what the agents did. Each execution's events
 * are read with the shared `sandbox.events` reader and projected as any native session is.
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { sandboxEventsSession } from '@tangle-network/harness-sessions'
import { RUNTIME_INPUT_FLOOR_ATTR, RUNTIME_OUTPUT_FLOOR_ATTR, SESSION_TOTAL_INPUT_ATTR, SESSION_TOTAL_OUTPUT_ATTR, stampSessionIdentity } from '../attributes.js'
import type { OtlpSpan } from '../otlp.js'
import type { RunContextNode } from '../supervisor-run-context.js'
import { projectHarnessSession } from './harness-sessions.js'

const LIVE_STREAM_DIR = join('evidence', 'live-stream')
/** The journal's own driver usage, carried onto a node's one live session: the stream has no token counts. */
const USAGE_ATTRS = [SESSION_TOTAL_INPUT_ATTR, SESSION_TOTAL_OUTPUT_ATTR, RUNTIME_INPUT_FLOOR_ATTR, RUNTIME_OUTPUT_FLOOR_ATTR, 'traces.runtime.token_coverage']
/** Coverage lines, short enough for the text report's one line each. */
export const LIVE_STREAM_UNKNOWN = 'live stream: tool calls, no model calls until the sessions are exported'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

interface Execution {
  readonly nodeId: string
  readonly startedAt: number
  readonly harness: string | null
  readonly backend: Json | null
  readonly events: Json[]
  /** Events the Sandbox dropped from this stream when its buffer overflowed, as it recorded them. */
  readonly dropped: number
}

/** One execution's stream: when it started, its backend, and the part events the shared reader folds. */
async function readExecution(path: string, nodeId: string): Promise<Execution | null> {
  let startedAt: number | null = null
  let harness: string | null = null
  let backend: Json | null = null
  let dropped = 0
  const events: Json[] = []
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Most rows are transport (model progress, heartbeats, raw backend events): parse only what is read.
      const first = startedAt === null
      if (!first && !line.includes('"message.part.updated"') && !line.includes('"execution.started"') && !line.includes('"buffer.overflow"') &&
        (harness !== null || !line.includes('"backend"'))) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue } // a stream still being written can end in a partial row
      if (!isObject(row)) continue
      if (first) startedAt = Date.parse(String(row.at))
      const data = isObject(row.data) ? row.data : null
      if (row.type === 'message.part.updated' && data && isObject(data.part)) events.push(row)
      else if (row.type === 'execution.started' && data) backend = isObject(data.effectiveBackend) ? data.effectiveBackend : null
      else if (row.type === 'raw' && data) harness ??= str(data.backend)
      else if (row.type === 'buffer.overflow' && data) {
        const count = (isObject(data.properties) ? data.properties : data).droppedCount
        dropped += typeof count === 'number' && count > 0 ? count : 0
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return startedAt === null || !Number.isFinite(startedAt) ? null : { nodeId, startedAt, harness, backend, events, dropped }
}

/**
 * Spans for each node's executions that its exported sessions do not cover: those that started
 * after `coveredUntil(node)` (epoch ms; null when nothing covers the node). Each native session
 * is one `session` span carrying the node's identity, as an exported session does.
 */
export async function readRuntimeLiveStreams(
  runDir: string,
  runId: string,
  nodes: readonly RunContextNode[],
  journal: ReadonlyMap<string, OtlpSpan>,
  coveredUntil: (nodeId: string) => number | null,
  /** Native sessions other sources hold, by node: a live worker's parent can be one. */
  exportedSessions: ReadonlyMap<string, string> = new Map(),
): Promise<{ spans: OtlpSpan[]; nodes: Set<string>; unknowns: string[] }> {
  let state: unknown
  try {
    state = JSON.parse(await readFile(join(runDir, LIVE_STREAM_DIR, 'state.json'), 'utf8'))
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { spans: [], nodes: new Set(), unknowns: missing ? [] : ['The run\'s live stream state could not be read; agents without an exported session are unread.'] }
  }
  const recorded = isObject(state) && isObject(state.executions) ? state.executions : {}
  const written = isObject(state) ? Date.parse(String(state.at)) : NaN
  const writtenAt = Number.isFinite(written) ? written : null
  const byNode = new Map(nodes.map((node) => [node.id, node]))
  const executions: Execution[] = []
  for (const [id, value] of Object.entries(recorded)) {
    const nodeId = isObject(value) ? str(value.nodeId) : null
    if (nodeId === null || !byNode.has(nodeId) || id.includes('/') || id.includes('\\')) continue
    const execution = await readExecution(join(runDir, LIVE_STREAM_DIR, encodeURIComponent(nodeId), `${id}.jsonl`), nodeId)
    const covered = coveredUntil(nodeId)
    if (execution && (covered === null || execution.startedAt > covered)) executions.push(execution)
  }
  executions.sort((a, b) => a.startedAt - b.startedAt)
  const dropped = new Map<string, number>()
  for (const { nodeId, dropped: count } of executions) if (count > 0) dropped.set(nodeId, (dropped.get(nodeId) ?? 0) + count)
  // A node's executions continue one native session or start another; the part events name it.
  const sessions = new Map<string, { nodeId: string; harness: string | null; backend: Json | null; events: Json[] }>()
  for (const execution of executions) {
    for (const event of execution.events) {
      const part = (event.data as Json).part as Json
      const session = str(part.sessionID)
      if (session === null) continue
      const key = `${execution.nodeId}\n${session}`
      const into = sessions.get(key) ?? { nodeId: execution.nodeId, harness: null, backend: null, events: [] }
      into.harness ??= execution.harness
      into.backend ??= execution.backend
      into.events.push(event)
      sessions.set(key, into)
    }
  }
  const sessionOf = new Map<string, string>(exportedSessions)
  const perNode = new Map<string, number>()
  for (const key of sessions.keys()) {
    const [nodeId, session] = key.split('\n') as [string, string]
    if (!sessionOf.has(nodeId)) sessionOf.set(nodeId, session)
    perNode.set(nodeId, (perNode.get(nodeId) ?? 0) + 1)
  }
  const spans: OtlpSpan[] = []
  const read = new Set<string>()
  for (const [key, { nodeId, harness, backend, events }] of sessions) {
    const nativeSessionId = key.split('\n')[1]!
    const node = byNode.get(nodeId)!
    const session = sandboxEventsSession({ harness: harness ?? 'sandbox', nativeSessionId, task: '', answer: '', events })
    if (!session.startedAt) continue
    const { spans: projected, root } = await projectHarnessSession(session, harness ?? 'sandbox')
    const profile = backend && isObject(backend.profile) ? str(backend.profile.name) : null
    const parentSession = node.parent === null ? null : sessionOf.get(node.parent) ?? null
    Object.assign(root.attributes, {
      'tangle.run.id': runId, 'tangle.node.id': nodeId, 'gen_ai.agent.id': nodeId, 'tangle.node.label': node.label,
      'tangle.node.state': node.status, 'tangle.node.depth': node.depth,
      'traces.runtime.run_id': runId, 'traces.runtime.node_id': nodeId, 'traces.source.live_stream': true,
      ...(backend && str(backend.model) ? { 'agent.model': str(backend.model) } : {}),
      ...(profile ? { 'agent.profile.name': profile } : {}),
      ...(parentSession ? { 'tangle.harness_session.parent': parentSession, 'traces.parent_session_id': parentSession } : {}),
      'traces.session.role': node.parent === null ? 'operator' : 'child',
    })
    if (perNode.get(nodeId) === 1) {
      const recordedUsage = journal.get(nodeId)?.attributes ?? {}
      for (const attr of USAGE_ATTRS) if (recordedUsage[attr] !== undefined) root.attributes[attr] = recordedUsage[attr]
    }
    // A node the journal has not settled is still running: its record runs to the stream's last write.
    if (node.settledAt === null) {
      if (writtenAt !== null && writtenAt > Date.parse(root.end_time)) root.end_time = new Date(writtenAt).toISOString()
      root.attributes['tangle.harness_session.ending'] = 'running'
      root.status = { code: 'UNSET' }
    }
    // Every span names its native session, as a session read from its file does.
    stampSessionIdentity(projected, nativeSessionId)
    spans.push(...projected)
    read.add(nodeId)
  }
  const unknowns = read.size > 0 ? [LIVE_STREAM_UNKNOWN] : []
  for (const [nodeId, count] of dropped) {
    if (read.has(nodeId)) unknowns.push(`${byNode.get(nodeId)!.label}: live stream dropped ${count} events; its tool calls are a lower bound`)
  }
  return { spans, nodes: read, unknowns }
}
