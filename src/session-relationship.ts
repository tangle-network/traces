import { sessionIdFromAttributes } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import type { SessionRef } from './types.js'

export type SessionRole = 'operator' | 'child' | 'unknown'

export interface SessionRelationship {
  readonly sessionId: string
  readonly role: SessionRole
  readonly parentSessionId?: string
  readonly childSessionIds: readonly string[]
  /** Existing child sessions resumed or steered in this task. */
  readonly resumedChildSessionIds: readonly string[]
  readonly depth?: number
  readonly agentNickname?: string
  readonly agentRole?: string
  readonly agentPath?: string
  readonly taskScope?: 'all' | 'latest' | 'turn' | 'fork-current'
  readonly turnId?: string
}

export type SessionWorkflowErrorCode =
  | 'SESSION_WORKFLOW_EMPTY_SELECTION'
  | 'SESSION_WORKFLOW_INVALID_LIMIT'
  | 'SESSION_WORKFLOW_LIMIT_EXCEEDED'
  | 'SESSION_WORKFLOW_INVALID_RELATION'
  | 'SESSION_WORKFLOW_DUPLICATE_ID'
  | 'SESSION_WORKFLOW_TASK_CONFLICT'

export class SessionWorkflowError extends Error {
  readonly code: SessionWorkflowErrorCode

  constructor(code: SessionWorkflowErrorCode, message: string) {
    super(message)
    this.name = 'SessionWorkflowError'
    this.code = code
  }
}

function stringAttribute(span: OtlpSpan | undefined, key: string): string | undefined {
  const value = span?.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberAttribute(span: OtlpSpan | undefined, key: string): number | undefined {
  const value = span?.attributes[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseSessionIds(value: unknown, key: string): string[] {
  if (value === undefined) return []
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new SessionWorkflowError(
        'SESSION_WORKFLOW_INVALID_RELATION',
        `${key} must be a JSON array of non-empty session IDs`,
      )
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new SessionWorkflowError(
      'SESSION_WORKFLOW_INVALID_RELATION',
      `${key} must be a JSON array of non-empty session IDs`,
    )
  }
  return parsed as string[]
}

function sessionRoot(ref: SessionRef, spans: readonly OtlpSpan[]): OtlpSpan | undefined {
  const roots = spans.filter((span) => span.parent_span_id === null)
  return roots.find((span) => sessionIdFromAttributes(span.attributes) === ref.sessionId)
    ?? roots.find((span) => span.trace_id === ref.sessionId)
    ?? roots[0]
    ?? spans[0]
}

/** Read stable parent/child identity from normalized spans.
 * Worker labels and timestamps are intentionally not used as identity. */
export function describeSessionRelationship(
  ref: SessionRef,
  spans: readonly OtlpSpan[],
): SessionRelationship {
  const root = sessionRoot(ref, spans)
  const childSessionIds = new Set<string>()
  const resumedChildSessionIds = new Set<string>()
  for (const span of spans) {
    const direct = parseSessionIds(span.attributes['traces.child_session_ids'], 'traces.child_session_ids')
    for (const id of direct) childSessionIds.add(id)
    const operation = span.attributes['traces.codex.agent_operation']
    const agentSessionIds = parseSessionIds(
      span.attributes['traces.codex.agent_session_ids'],
      'traces.codex.agent_session_ids',
    )
    if (
      ['spawn_agent', 'send_input', 'send_message', 'followup_task'].includes(String(operation))
      && direct.length === 0
    ) {
      for (const id of agentSessionIds) childSessionIds.add(id)
    }
    if (['send_input', 'send_message', 'followup_task'].includes(String(operation))) {
      for (const id of agentSessionIds) resumedChildSessionIds.add(id)
    }
    const lifecycleChild = stringAttribute(span, 'traces.codex.subagent_thread_id')
    if (lifecycleChild) childSessionIds.add(lifecycleChild)
  }

  const role = stringAttribute(root, 'traces.session.role')
  const parentSessionId = stringAttribute(root, 'traces.parent_session_id')
  const depth = numberAttribute(root, 'traces.codex.agent_depth')
  const agentNickname = stringAttribute(root, 'traces.codex.agent_nickname')
  const agentRole = stringAttribute(root, 'traces.codex.agent_role')
  const agentPath = stringAttribute(root, 'traces.codex.agent_path')
  const rawTaskScope = stringAttribute(root, 'traces.codex.task_scope')
  const taskScope = rawTaskScope === 'all'
    || rawTaskScope === 'latest'
    || rawTaskScope === 'turn'
    || rawTaskScope === 'fork-current'
    ? rawTaskScope
    : undefined
  const turnId = stringAttribute(root, 'traces.codex.turn_id')
  return {
    sessionId: sessionIdFromAttributes(root?.attributes ?? {}) ?? root?.trace_id ?? ref.sessionId,
    role: role === 'operator' || role === 'child' ? role : 'unknown',
    ...(parentSessionId ? { parentSessionId } : {}),
    childSessionIds: [...childSessionIds].sort(),
    resumedChildSessionIds: [...resumedChildSessionIds].sort(),
    ...(depth !== undefined ? { depth } : {}),
    ...(agentNickname ? { agentNickname } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(agentPath ? { agentPath } : {}),
    ...(taskScope ? { taskScope } : {}),
    ...(turnId ? { turnId } : {}),
  }
}
