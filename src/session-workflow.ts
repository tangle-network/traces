import type { OtlpSpan } from './otlp.js'
import {
  describeSessionRelationship,
  type SessionRelationship,
  SessionWorkflowError,
} from './session-relationship.js'
import { locateSessions, parseSession } from './session-source.js'
import type { HarnessTraceAdapter, ParseOptions, SessionRef } from './types.js'

export type SessionWorkflowIssue =
  | {
      readonly kind: 'missing-session'
      readonly sessionId: string
      readonly referencedBySessionId: string
      readonly relation: 'parent' | 'child'
    }
  | {
      readonly kind: 'ambiguous-session'
      readonly sessionId: string
      readonly referencedBySessionId: string
      readonly relation: 'parent' | 'child'
      readonly paths: readonly string[]
    }
  | {
      readonly kind: 'parent-conflict'
      readonly sessionId: string
      readonly declaredParentSessionId?: string
      readonly referencedParentSessionIds: readonly string[]
    }
  | {
      readonly kind: 'cycle'
      readonly sessionIds: readonly string[]
    }
  | {
      readonly kind: 'unresolved-parent-task'
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly reason: 'unsupported' | 'child-reference-not-found' | 'parent-turn-metadata-missing' | 'ambiguous'
      readonly turnIds?: readonly string[]
    }

export interface SessionWorkflowSession {
  readonly adapter: HarnessTraceAdapter
  readonly ref: SessionRef
  readonly spans: readonly OtlpSpan[]
  readonly relationship: SessionRelationship
  readonly taskScope: 'all' | 'latest' | 'turn'
  readonly taskTurnId?: string
}

export interface SessionWorkflowSummary {
  readonly seedSessionIds: readonly string[]
  readonly complete: boolean
  readonly issues: readonly SessionWorkflowIssue[]
}

export interface SessionWorkflow extends SessionWorkflowSummary {
  readonly sessions: readonly SessionWorkflowSession[]
}

export interface CollectSessionWorkflowOptions extends ParseOptions {
  /** Maximum number of source files parsed for one workflow selection. */
  readonly maxSessions?: number
}

interface SessionReference {
  readonly sessionId: string
  readonly referencedBySessionId: string
  readonly relation: 'parent' | 'child'
  readonly taskScope?: 'all' | 'latest'
}

interface QueuedSession {
  readonly ref: SessionRef
  taskScope: 'all' | 'latest' | 'turn'
  taskTurnId?: string
  explicitExactTurn: boolean
}

function refPathKey(ref: SessionRef): string {
  return `${ref.harness}\0${ref.path}`
}

function referencesFor(relationship: SessionRelationship): SessionReference[] {
  return [
    ...(relationship.parentSessionId
      ? [{
          sessionId: relationship.parentSessionId,
          referencedBySessionId: relationship.sessionId,
          relation: 'parent' as const,
        }]
      : []),
    ...relationship.childSessionIds.map((sessionId) => ({
      sessionId,
      referencedBySessionId: relationship.sessionId,
      relation: 'child' as const,
      taskScope: relationship.spawnedChildSessionIds.includes(sessionId)
        ? 'all' as const
        : relationship.resumedChildSessionIds.includes(sessionId)
          ? 'latest' as const
          : 'all' as const,
    })),
  ]
}

function issueKey(issue: SessionWorkflowIssue): string {
  return JSON.stringify(issue)
}

function referenceKey(reference: SessionReference): string {
  return JSON.stringify(reference)
}

function findParentCycles(sessions: readonly SessionWorkflowSession[]): SessionWorkflowIssue[] {
  const parentBySession = new Map(
    sessions
      .filter((session) => session.relationship.parentSessionId)
      .map((session) => [session.relationship.sessionId, session.relationship.parentSessionId!]),
  )
  const cycles = new Map<string, readonly string[]>()
  for (const start of parentBySession.keys()) {
    const path: string[] = []
    const indexById = new Map<string, number>()
    let current: string | undefined = start
    while (current && parentBySession.has(current)) {
      const seenAt = indexById.get(current)
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt)
        const canonicalStart = cycle.reduce(
          (best, id, index) => id.localeCompare(cycle[best]!) < 0 ? index : best,
          0,
        )
        const canonical = [...cycle.slice(canonicalStart), ...cycle.slice(0, canonicalStart)]
        cycles.set(canonical.join('\0'), canonical)
        break
      }
      indexById.set(current, path.length)
      path.push(current)
      current = parentBySession.get(current)
    }
  }
  return [...cycles.values()].map((sessionIds) => ({ kind: 'cycle', sessionIds }))
}

function relationshipIssues(sessions: readonly SessionWorkflowSession[]): SessionWorkflowIssue[] {
  const byId = new Map(sessions.map((session) => [session.relationship.sessionId, session]))
  const referencedParents = new Map<string, Set<string>>()
  for (const parent of sessions) {
    for (const childId of parent.relationship.childSessionIds) {
      if (!byId.has(childId)) continue
      const parents = referencedParents.get(childId) ?? new Set<string>()
      parents.add(parent.relationship.sessionId)
      referencedParents.set(childId, parents)
    }
  }
  const issues: SessionWorkflowIssue[] = []
  for (const session of sessions) {
    const referenced = [...(referencedParents.get(session.relationship.sessionId) ?? [])].sort()
    const declared = session.relationship.parentSessionId
    const mismatched = referenced.filter((parent) => parent !== declared)
    const missingReverseLink = Boolean(declared && byId.has(declared) && !referenced.includes(declared))
    if (referenced.length > 1 || mismatched.length > 0 || missingReverseLink) {
      issues.push({
        kind: 'parent-conflict',
        sessionId: session.relationship.sessionId,
        ...(declared ? { declaredParentSessionId: declared } : {}),
        referencedParentSessionIds: referenced,
      })
    }
  }
  return [...issues, ...findParentCycles(sessions)]
}

function orderSessions(sessions: readonly SessionWorkflowSession[]): SessionWorkflowSession[] {
  const byId = new Map(sessions.map((session) => [session.relationship.sessionId, session]))
  const children = new Map<string, Set<string>>()
  for (const session of sessions) {
    const parentId = session.relationship.parentSessionId
    if (parentId && byId.has(parentId)) {
      const childIds = children.get(parentId) ?? new Set<string>()
      childIds.add(session.relationship.sessionId)
      children.set(parentId, childIds)
    }
    for (const childId of session.relationship.childSessionIds) {
      if (!byId.has(childId)) continue
      const childIds = children.get(session.relationship.sessionId) ?? new Set<string>()
      childIds.add(childId)
      children.set(session.relationship.sessionId, childIds)
    }
  }

  const ordered: SessionWorkflowSession[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const session = byId.get(id)
    if (!session) return
    ordered.push(session)
    for (const childId of [...(children.get(id) ?? [])].sort()) visit(childId)
  }
  const roots = sessions
    .filter((session) => !session.relationship.parentSessionId || !byId.has(session.relationship.parentSessionId))
    .map((session) => session.relationship.sessionId)
    .sort()
  for (const id of roots) visit(id)
  for (const id of [...byId.keys()].sort()) visit(id)
  return ordered
}

/** Expand one or more selected source files into their connected session tree.
 * Missing or ambiguous files are returned as issues; no path is guessed. */
export async function collectSessionWorkflow(
  adapter: HarnessTraceAdapter,
  seeds: readonly SessionRef[],
  options: CollectSessionWorkflowOptions = {},
): Promise<SessionWorkflow> {
  if (seeds.length === 0) {
    throw new SessionWorkflowError(
      'SESSION_WORKFLOW_EMPTY_SELECTION',
      'session workflow needs at least one seed session',
    )
  }
  const maxSessions = options.maxSessions ?? 100
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new SessionWorkflowError(
      'SESSION_WORKFLOW_INVALID_LIMIT',
      'maxSessions must be a positive integer',
    )
  }
  options.signal?.throwIfAborted()

  const refsById = new Map<string, SessionRef[]>()
  const addRef = (ref: SessionRef): void => {
    const refs = refsById.get(ref.sessionId) ?? []
    if (!refs.some((candidate) => refPathKey(candidate) === refPathKey(ref))) refs.push(ref)
    refsById.set(ref.sessionId, refs)
  }
  for (const ref of seeds) addRef(ref)
  let fallbackLocated: readonly SessionRef[] | undefined
  const resolvedIds = new Set<string>()
  const refsForId = async (sessionId: string): Promise<readonly SessionRef[]> => {
    if (resolvedIds.has(sessionId)) return refsById.get(sessionId) ?? []
    if (adapter.locateBySessionId) {
      for (const ref of await adapter.locateBySessionId(sessionId)) addRef(ref)
    } else {
      fallbackLocated ??= await locateSessions(adapter)
      for (const ref of fallbackLocated) addRef(ref)
    }
    resolvedIds.add(sessionId)
    options.signal?.throwIfAborted()
    return refsById.get(sessionId) ?? []
  }

  const queue: QueuedSession[] = []
  const queuedByPath = new Map<string, QueuedSession>()
  const enqueue = (
    ref: SessionRef,
    taskScope: QueuedSession['taskScope'],
    taskTurnId?: string,
    explicit = false,
  ): void => {
    const key = refPathKey(ref)
    const existing = queuedByPath.get(key)
    if (existing) {
      const conflictingExplicitTurns =
        existing.taskScope === 'turn'
        && taskScope === 'turn'
        && existing.taskTurnId !== taskTurnId
        && existing.explicitExactTurn
        && explicit
      if (conflictingExplicitTurns) {
        throw new SessionWorkflowError(
          'SESSION_WORKFLOW_TASK_CONFLICT',
          `session ${ref.sessionId} was explicitly selected at two different exact turns`,
        )
      }
      if (existing.taskScope === taskScope && existing.taskTurnId === taskTurnId) {
        if (taskScope === 'turn' && explicit) existing.explicitExactTurn = true
        return
      }
      existing.taskScope = 'all'
      delete existing.taskTurnId
      existing.explicitExactTurn = false
      return
    }
    const queued = {
      ref,
      taskScope,
      ...(taskTurnId ? { taskTurnId } : {}),
      explicitExactTurn: explicit && taskScope === 'turn',
    }
    queuedByPath.set(key, queued)
    queue.push(queued)
  }
  const seedTaskScope = options.taskScope ?? 'all'
  for (const seed of seeds) enqueue(seed, seedTaskScope, options.taskTurnId, true)

  const sessions: SessionWorkflowSession[] = []
  const parsedById = new Map<string, SessionWorkflowSession>()
  const references: SessionReference[] = []
  const issues: SessionWorkflowIssue[] = []
  const unresolvedReferences = new Set<string>()
  const seedPaths = new Set(seeds.map(refPathKey))
  const seedSessionIds: string[] = []

  for (let index = 0; index < queue.length; index += 1) {
    options.signal?.throwIfAborted()
    if (sessions.length >= maxSessions) {
      throw new SessionWorkflowError(
        'SESSION_WORKFLOW_LIMIT_EXCEEDED',
        `session workflow exceeds maxSessions=${maxSessions}; raise the limit only after checking the selected tree`,
      )
    }
    const selected = queue[index]!
    const { ref, taskScope, taskTurnId } = selected
    const spans = await parseSession(adapter, ref, {
      corruptionMode: options.corruptionMode,
      taskScope,
      taskTurnId,
      signal: options.signal,
    })
    options.signal?.throwIfAborted()
    const relationship = describeSessionRelationship(ref, spans)
    const discoveredPaths = (await refsForId(relationship.sessionId))
      .map((candidate) => candidate.path)
      .filter((path, pathIndex, paths) => paths.indexOf(path) === pathIndex)
    if (discoveredPaths.length > 1) {
      throw new SessionWorkflowError(
        'SESSION_WORKFLOW_DUPLICATE_ID',
        `session ID "${relationship.sessionId}" resolves to ${discoveredPaths.join(', ')}`,
      )
    }
    const previous = parsedById.get(relationship.sessionId)
    if (previous && refPathKey(previous.ref) !== refPathKey(ref)) {
      throw new SessionWorkflowError(
        'SESSION_WORKFLOW_DUPLICATE_ID',
        `session ID "${relationship.sessionId}" resolves to both ${previous.ref.path} and ${ref.path}`,
      )
    }
    if (previous) continue

    const session = {
      adapter,
      ref,
      spans,
      relationship,
      taskScope,
      ...(taskTurnId ? { taskTurnId } : {}),
    }
    sessions.push(session)
    parsedById.set(relationship.sessionId, session)
    if (seedPaths.has(refPathKey(ref))) seedSessionIds.push(relationship.sessionId)

    const discovered = referencesFor(relationship)
    references.push(...discovered)
    for (const reference of discovered) {
      if (parsedById.has(reference.sessionId)) continue
      const candidates = await refsForId(reference.sessionId)
      if (candidates.length !== 1) continue
      if (reference.relation !== 'parent' || taskScope !== 'latest') {
        enqueue(candidates[0]!, reference.taskScope ?? 'all')
        continue
      }

      const resolution = adapter.resolveParentTask
        ? await adapter.resolveParentTask(candidates[0]!, relationship.sessionId, {
            corruptionMode: options.corruptionMode,
            signal: options.signal,
          })
        : { kind: 'unavailable' as const, reason: 'unsupported' as const }
      options.signal?.throwIfAborted()
      if (resolution.kind === 'resolved') {
        enqueue(candidates[0]!, 'turn', resolution.turnId)
        continue
      }
      unresolvedReferences.add(referenceKey(reference))
      issues.push({
        kind: 'unresolved-parent-task',
        parentSessionId: reference.sessionId,
        childSessionId: relationship.sessionId,
        reason: resolution.reason,
        ...('turnIds' in resolution && resolution.turnIds
          ? { turnIds: resolution.turnIds }
          : {}),
      })
    }
  }

  for (const reference of references) {
    if (parsedById.has(reference.sessionId)) continue
    if (unresolvedReferences.has(referenceKey(reference))) continue
    const {
      taskScope: _taskScope,
      ...publicReference
    } = reference
    const paths = (refsById.get(reference.sessionId) ?? []).map((ref) => ref.path).sort()
    issues.push(paths.length > 1
      ? { kind: 'ambiguous-session', ...publicReference, paths }
      : { kind: 'missing-session', ...publicReference })
  }
  issues.push(...relationshipIssues(sessions))
  const uniqueIssues = [...new Map(issues.map((issue) => [issueKey(issue), issue])).values()]
  const ordered = orderSessions(sessions)
  return {
    sessions: ordered,
    seedSessionIds: [...new Set(seedSessionIds)],
    complete: uniqueIssues.length === 0,
    issues: uniqueIssues,
  }
}
