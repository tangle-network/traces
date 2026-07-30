import { sessionJsonlOptions } from '../integrity.js'
import { readJsonl } from '../jsonl.js'
import type {
  ParentTaskResolution,
  ParseOptions,
  SessionRef,
} from '../types.js'
import {
  type CodexLine,
  multiAgentOperation,
  spawnedSessionIds,
  targetedSessionIds,
  timestampFromEpochMs,
  validTimestamp,
} from './codex-format.js'

export interface CodexTaskBoundary {
  readonly turnId?: string
  readonly startedAt?: number
  readonly timestamp: string
}

export function currentTaskStartedAt(meta: CodexLine | undefined): number | undefined {
  if (typeof meta?.payload?.started_at === 'number' && Number.isFinite(meta.payload.started_at)) {
    return Math.floor(meta.payload.started_at)
  }
  const timestamp = Date.parse(meta?.payload?.timestamp ?? meta?.timestamp ?? '')
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : undefined
}

export function codexTaskBoundary(line: CodexLine): CodexTaskBoundary | undefined {
  if (line.type !== 'event_msg' || line.payload?.type !== 'task_started') return undefined
  const startedAt = typeof line.payload.started_at === 'number' ? line.payload.started_at : undefined
  const timestamp = validTimestamp(line.timestamp)
    ?? timestampFromEpochMs(startedAt === undefined ? undefined : startedAt * 1_000)
  if (!timestamp) return undefined
  return {
    ...(line.payload.turn_id ? { turnId: line.payload.turn_id } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    timestamp,
  }
}

export function isCodexTaskBoundary(
  line: CodexLine,
  boundary: CodexTaskBoundary,
): boolean {
  const candidate = codexTaskBoundary(line)
  if (!candidate) return false
  if (boundary.turnId && candidate.turnId) return boundary.turnId === candidate.turnId
  if (boundary.startedAt !== undefined && candidate.startedAt !== undefined) {
    return Math.abs(boundary.startedAt - candidate.startedAt) <= 2
  }
  return boundary.timestamp === candidate.timestamp
}

export class CodexTaskScopeError extends Error {
  readonly code:
    | 'CODEX_CHILD_TASK_AMBIGUOUS'
    | 'CODEX_CHILD_TASK_NOT_FOUND'
    | 'CODEX_LATEST_TURN_NOT_FOUND'
    | 'CODEX_TURN_NOT_FOUND'
    | 'CODEX_TURN_ID_REQUIRED'

  constructor(
    code: CodexTaskScopeError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'CodexTaskScopeError'
    this.code = code
  }
}

const UUID_V7 =
  /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function uuidV7TimestampMs(value: string | undefined): number | undefined {
  const match = value?.match(UUID_V7)
  if (!match) return undefined
  const timestamp = Number.parseInt(`${match[1]}${match[2]}`, 16)
  return Number.isSafeInteger(timestamp) ? timestamp : undefined
}

function uniqueTaskBoundaries(
  candidates: readonly CodexTaskBoundary[],
): CodexTaskBoundary[] {
  const unique = new Map<string, CodexTaskBoundary>()
  for (const candidate of candidates) {
    const key = candidate.turnId
      ? `turn:${candidate.turnId}`
      : candidate.startedAt !== undefined
        ? `started:${candidate.startedAt}:${candidate.timestamp}`
        : `timestamp:${candidate.timestamp}`
    unique.set(key, candidate)
  }
  return [...unique.values()]
}

function ambiguousChildTask(
  path: string,
  childSessionId: string,
  candidates: readonly CodexTaskBoundary[],
): never {
  const identities = candidates
    .map((candidate) => candidate.turnId ?? candidate.timestamp)
    .map((identity) => JSON.stringify(identity))
    .join(', ')
  throw new CodexTaskScopeError(
    'CODEX_CHILD_TASK_AMBIGUOUS',
    `cannot isolate Codex child session ${JSON.stringify(childSessionId)} in ${path}: `
      + `${candidates.length} task_started events match (${identities}); `
      + 'parse an explicit turn with { taskScope: "turn", taskTurnId: "<turn id>" }',
  )
}

/** Forked sessions prepend parent rows with rewritten timestamps.
 * Prefer UUIDv7 session and turn identity. Older formats fall back to one
 * unambiguous task start within two seconds of the child metadata. */
export async function findForkTaskBoundary(
  path: string,
  options: ReturnType<typeof sessionJsonlOptions>,
  childSessionId: string,
  startedAt: number | undefined,
): Promise<CodexTaskBoundary> {
  const candidates: CodexTaskBoundary[] = []
  for await (const line of readJsonl<CodexLine>(path, options)) {
    const candidate = codexTaskBoundary(line)
    if (candidate) candidates.push(candidate)
  }

  const exact = uniqueTaskBoundaries(
    candidates.filter((candidate) => candidate.turnId === childSessionId),
  )
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) ambiguousChildTask(path, childSessionId, exact)

  const childCreatedAt = uuidV7TimestampMs(childSessionId)
  if (childCreatedAt !== undefined) {
    const structural = uniqueTaskBoundaries(
      candidates.filter((candidate) => {
        const taskCreatedAt = uuidV7TimestampMs(candidate.turnId)
        return taskCreatedAt !== undefined && taskCreatedAt >= childCreatedAt
      }),
    ).sort(
      (left, right) =>
        uuidV7TimestampMs(left.turnId)! - uuidV7TimestampMs(right.turnId)!,
    )
    if (structural.length > 0) {
      const earliest = uuidV7TimestampMs(structural[0]!.turnId)!
      const earliestCandidates = structural.filter(
        (candidate) => uuidV7TimestampMs(candidate.turnId) === earliest,
      )
      if (earliestCandidates.length === 1) return earliestCandidates[0]!
      ambiguousChildTask(path, childSessionId, earliestCandidates)
    }
  }

  const temporal = startedAt === undefined
    ? []
    : uniqueTaskBoundaries(
        candidates.filter(
          (candidate) => {
            const candidateStartedAt =
              candidate.startedAt ?? Math.floor(Date.parse(candidate.timestamp) / 1_000)
            return Math.abs(candidateStartedAt - startedAt) <= 2
          },
        ),
      )
  if (temporal.length === 1) return temporal[0]!
  if (temporal.length > 1) ambiguousChildTask(path, childSessionId, temporal)

  throw new CodexTaskScopeError(
    'CODEX_CHILD_TASK_NOT_FOUND',
    `cannot isolate Codex child session ${JSON.stringify(childSessionId)} in ${path}: `
      + 'no task_started event matches its session identity or metadata start; '
      + 'parse an explicit turn with { taskScope: "turn", taskTurnId: "<turn id>" }',
  )
}

export async function findLatestTaskBoundary(
  path: string,
  options: ReturnType<typeof sessionJsonlOptions>,
): Promise<CodexTaskBoundary | undefined> {
  let latest: CodexTaskBoundary | undefined
  for await (const line of readJsonl<CodexLine>(path, options)) {
    latest = codexTaskBoundary(line) ?? latest
  }
  return latest
}

export async function resolveCodexParentTask(
  ref: SessionRef,
  childSessionId: string,
  options: Pick<ParseOptions, 'corruptionMode'> = {},
): Promise<ParentTaskResolution> {
  const jsonl = sessionJsonlOptions(ref, options)
  const callTurns = new Map<string, string>()
  const callOperations = new Map<string, string>()
  let activeTurnId: string | undefined
  let latestReferenceTurnId: string | null | undefined

  const record = (turnId: string | undefined): void => {
    latestReferenceTurnId = turnId ?? null
  }

  for await (const line of readJsonl<CodexLine>(ref.path, jsonl)) {
    if (line.type === 'event_msg' && line.payload?.type === 'task_started') {
      activeTurnId = line.payload.turn_id
      continue
    }
    if (
      line.type === 'event_msg'
      && line.payload?.type === 'task_complete'
      && (!line.payload.turn_id || line.payload.turn_id === activeTurnId)
    ) {
      activeTurnId = undefined
      continue
    }
    const explicitTurnId = line.payload?.internal_chat_message_metadata_passthrough?.turn_id
    if (
      line.type === 'response_item'
      && (line.payload?.type === 'function_call' || line.payload?.type === 'custom_tool_call')
    ) {
      const callId = line.payload.call_id
      const operation = multiAgentOperation(line.payload.name ?? '')
      const turnId = explicitTurnId ?? activeTurnId
      if (callId && turnId) callTurns.set(callId, turnId)
      if (callId && operation) callOperations.set(callId, operation)
      if (
        operation
        && operation !== 'spawn_agent'
        && targetedSessionIds(
          operation,
          line.payload.type === 'custom_tool_call' ? line.payload.input : line.payload.arguments,
        )
          .includes(childSessionId)
      ) {
        record(turnId)
      }
      continue
    }
    if (
      line.type === 'response_item'
      && (line.payload?.type === 'function_call_output' || line.payload?.type === 'custom_tool_call_output')
    ) {
      const callId = line.payload.call_id
      if (
        callId
        && callOperations.get(callId) === 'spawn_agent'
        && spawnedSessionIds(line.payload.output).includes(childSessionId)
      ) {
        record(explicitTurnId ?? callTurns.get(callId) ?? activeTurnId)
      }
      continue
    }
    if (
      line.type === 'event_msg'
      && line.payload?.type === 'sub_agent_activity'
      && line.payload.agent_thread_id === childSessionId
    ) {
      record(explicitTurnId ?? callTurns.get(line.payload.event_id ?? '') ?? activeTurnId)
    }
  }

  if (latestReferenceTurnId) return { kind: 'resolved', turnId: latestReferenceTurnId }
  if (latestReferenceTurnId === null) {
    return { kind: 'unavailable', reason: 'parent-turn-metadata-missing' }
  }
  return { kind: 'unavailable', reason: 'child-reference-not-found' }
}
