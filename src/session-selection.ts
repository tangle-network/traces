import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { OtlpSpan } from './otlp.js'
import {
  describeSessionRelationship,
  type SessionRelationship,
} from './session-relationship.js'
import { parseSession } from './session-source.js'
import {
  collectSessionWorkflow,
  type SessionWorkflowIssue,
  type SessionWorkflowSummary,
} from './session-workflow.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

export interface SessionSeedGroup {
  readonly adapter: HarnessTraceAdapter
  readonly refs: readonly SessionRef[]
}

export interface SessionSelectionRow {
  readonly adapter: HarnessTraceAdapter
  readonly ref: SessionRef
  readonly spans: readonly OtlpSpan[]
  readonly taskScope: 'all' | 'latest' | 'turn'
  readonly taskTurnId?: string
  readonly sourceSha256?: string
  readonly sourceFiles?: readonly SessionSourceFile[]
}

export interface SessionSourceFile {
  readonly path: string
  readonly sha256: string
}

export interface SessionSelection {
  readonly rows: readonly SessionSelectionRow[]
  readonly workflow?: SessionWorkflowSummary
}

export interface CollectSessionSelectionOptions {
  readonly workflow?: boolean
  readonly maxWorkflowSessions?: number
  readonly taskScope?: 'all' | 'latest' | 'turn'
  readonly taskTurnId?: string
  /** Hash and reparse every selected file so emitted evidence binds exact bytes. */
  readonly bindSources?: boolean
  readonly signal?: AbortSignal
}

interface SessionSourceSnapshot {
  readonly sha256: string
  readonly files: readonly SessionSourceFile[]
}

async function fileSha256(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      signal?.throwIfAborted()
      hash.update(chunk)
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    throw error
  }
  signal?.throwIfAborted()
  return hash.digest('hex')
}

async function sourceSnapshot(
  adapter: HarnessTraceAdapter,
  ref: SessionRef,
  signal?: AbortSignal,
): Promise<SessionSourceSnapshot> {
  signal?.throwIfAborted()
  const paths = [
    ...(adapter.sourcePaths ? await adapter.sourcePaths(ref, { signal }) : [ref.path]),
  ].sort()
  signal?.throwIfAborted()
  if (paths.length === 0) throw new Error(`adapter returned no source files for ${ref.path}`)
  if (new Set(paths).size !== paths.length) {
    throw new Error(`adapter returned duplicate source files for ${ref.path}`)
  }
  const files: SessionSourceFile[] = []
  for (const path of paths) {
    signal?.throwIfAborted()
    files.push({ path, sha256: await fileSha256(path, signal) })
  }
  const sha256 = files.length === 1
    ? files[0]!.sha256
    : createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { sha256, files }
}

function summarizeWorkflows(workflows: readonly SessionWorkflowSummary[]): SessionWorkflowSummary | undefined {
  if (workflows.length === 0) return undefined
  const issues = new Map<string, SessionWorkflowIssue>()
  for (const workflow of workflows) {
    for (const issue of workflow.issues) issues.set(JSON.stringify(issue), issue)
  }
  return {
    seedSessionIds: [...new Set(workflows.flatMap((workflow) => workflow.seedSessionIds))],
    complete: workflows.every((workflow) => workflow.complete),
    issues: [...issues.values()],
  }
}

async function boundSessionRow(
  adapter: HarnessTraceAdapter,
  ref: SessionRef,
  taskScope: 'all' | 'latest' | 'turn',
  taskTurnId?: string,
  expectedRelationship?: SessionRelationship,
  signal?: AbortSignal,
): Promise<SessionSelectionRow> {
  const before = await sourceSnapshot(adapter, ref, signal)
  const spans = await parseSession(adapter, ref, { taskScope, taskTurnId, signal })
  signal?.throwIfAborted()
  const after = await sourceSnapshot(adapter, ref, signal)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`session source changed while parsing; refusing unbound evidence: ${ref.path}`)
  }
  if (
    expectedRelationship
    && JSON.stringify(describeSessionRelationship(ref, spans)) !== JSON.stringify(expectedRelationship)
  ) {
    throw new Error(`session relationships changed during workflow selection: ${ref.path}`)
  }
  return {
    adapter,
    ref,
    spans,
    taskScope,
    ...(taskTurnId ? { taskTurnId } : {}),
    sourceSha256: after.sha256,
    sourceFiles: after.files,
  }
}

/** Parse selected seed groups, optionally expanding and byte-binding their session tree. */
export async function collectSessionSelection(
  groups: readonly SessionSeedGroup[],
  options: CollectSessionSelectionOptions = {},
): Promise<SessionSelection> {
  const rows: SessionSelectionRow[] = []
  const workflows: SessionWorkflowSummary[] = []
  const taskScope = options.taskScope ?? 'all'

  for (const { adapter, refs } of groups) {
    options.signal?.throwIfAborted()
    if (refs.length === 0) continue
    if (!options.workflow) {
      for (const ref of refs) {
        rows.push(options.bindSources
          ? await boundSessionRow(
              adapter,
              ref,
              taskScope,
              options.taskTurnId,
              undefined,
              options.signal,
            )
          : {
              adapter,
              ref,
              spans: await parseSession(adapter, ref, {
                taskScope,
                taskTurnId: options.taskTurnId,
                signal: options.signal,
              }),
              taskScope,
              ...(options.taskTurnId ? { taskTurnId: options.taskTurnId } : {}),
            })
      }
      continue
    }

    const workflow = await collectSessionWorkflow(adapter, refs, {
      maxSessions: options.maxWorkflowSessions,
      taskScope,
      taskTurnId: options.taskTurnId,
      signal: options.signal,
    })
    workflows.push(workflow)
    for (const session of workflow.sessions) {
      rows.push(options.bindSources
        ? await boundSessionRow(
            adapter,
            session.ref,
            session.taskScope,
            session.taskTurnId,
            session.relationship,
            options.signal,
          )
        : {
            adapter,
            ref: session.ref,
            spans: session.spans,
            taskScope: session.taskScope,
            ...(session.taskTurnId ? { taskTurnId: session.taskTurnId } : {}),
          })
    }
  }

  const workflow = summarizeWorkflows(workflows)
  return { rows, ...(workflow ? { workflow } : {}) }
}
