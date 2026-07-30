import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

export class ClaudeTaskScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeTaskScopeError'
  }
}

export interface WorkflowRunReference {
  runId: string
  transcriptDir: string
}

export interface WorkflowRunBinding extends WorkflowRunReference {
  toolUseId: string
  startedAt: string
}

export function validWorkflowRunReference(
  runId: unknown,
  transcriptDir: unknown,
): WorkflowRunReference | undefined {
  if (typeof runId !== 'string' || typeof transcriptDir !== 'string') return undefined
  const cleanRunId = runId.trim()
  const cleanTranscriptDir = transcriptDir.trim()
  const resolvedTranscriptDir = resolve(cleanTranscriptDir)
  if (
    !cleanRunId
    || cleanRunId === '.'
    || cleanRunId === '..'
    || cleanRunId.includes('/')
    || cleanRunId.includes('\\')
    || !isAbsolute(cleanTranscriptDir)
    || basename(resolvedTranscriptDir) !== cleanRunId
    || basename(dirname(resolvedTranscriptDir)) !== 'workflows'
    || basename(dirname(dirname(resolvedTranscriptDir))) !== 'subagents'
  ) {
    return undefined
  }
  return { runId: cleanRunId, transcriptDir: cleanTranscriptDir }
}

export function structuredWorkflowRunReference(
  value: { runId?: unknown; transcriptDir?: unknown } | undefined,
): WorkflowRunReference | undefined {
  if (!value || (value.runId === undefined && value.transcriptDir === undefined)) return undefined
  const reference = validWorkflowRunReference(value.runId, value.transcriptDir)
  if (!reference) {
    throw new ClaudeTaskScopeError(
      'Claude Workflow result has invalid structured run metadata',
    )
  }
  return reference
}

function workflowRunFromText(text: string): WorkflowRunReference | undefined {
  const lines = text.split(/\r?\n/)
  const runIds = lines
    .filter((line) => line.startsWith('Run ID: '))
    .map((line) => line.slice('Run ID: '.length))
  const transcriptDirs = lines
    .filter((line) => line.startsWith('Transcript dir: '))
    .map((line) => line.slice('Transcript dir: '.length))
  if (runIds.length !== 1 || transcriptDirs.length !== 1) return undefined
  return validWorkflowRunReference(runIds[0], transcriptDirs[0])
}

function sameWorkflowRun(left: WorkflowRunReference, right: WorkflowRunReference): boolean {
  return left.runId === right.runId && resolve(left.transcriptDir) === resolve(right.transcriptDir)
}

export function resolveWorkflowRunReference(
  toolUseId: string,
  outputText: string,
  structured?: WorkflowRunReference,
): WorkflowRunReference | undefined {
  const text = workflowRunFromText(outputText)
  if (structured && text && !sameWorkflowRun(structured, text)) {
    throw new ClaudeTaskScopeError(
      `Claude Workflow result ${toolUseId} has conflicting structured and text run metadata`,
    )
  }
  return structured ?? text
}

export interface WorkflowProjectionIndex {
  toolStartedAtByUseId: Map<string, string>
  resultByToolUseId: Map<string, WorkflowRunReference>
}

export function createWorkflowProjectionIndex(): WorkflowProjectionIndex {
  return {
    toolStartedAtByUseId: new Map(),
    resultByToolUseId: new Map(),
  }
}

export function indexWorkflowTools(
  index: WorkflowProjectionIndex,
  timestamp: string,
  tools: readonly { id: string | null; name: string }[],
): void {
  for (const tool of tools) {
    if (!tool.id || tool.name !== 'Workflow') continue
    const previous = index.toolStartedAtByUseId.get(tool.id)
    if (!previous || Date.parse(timestamp) < Date.parse(previous)) {
      index.toolStartedAtByUseId.set(tool.id, timestamp)
    }
  }
}

export function indexWorkflowResults(
  index: WorkflowProjectionIndex,
  results: readonly { toolUseId: string; workflowRun?: WorkflowRunReference }[],
): void {
  for (const result of results) {
    if (!result.workflowRun) continue
    const previous = index.resultByToolUseId.get(result.toolUseId)
    if (previous && !sameWorkflowRun(previous, result.workflowRun)) {
      throw new ClaudeTaskScopeError(
        `Claude Workflow call ${result.toolUseId} returned conflicting run metadata`,
      )
    }
    index.resultByToolUseId.set(result.toolUseId, result.workflowRun)
  }
}

export function bindWorkflowRuns(
  index: WorkflowProjectionIndex,
): Map<string, WorkflowRunBinding[]> {
  const bindings = new Map<string, WorkflowRunBinding[]>()
  for (const [toolUseId, reference] of index.resultByToolUseId) {
    const startedAt = index.toolStartedAtByUseId.get(toolUseId)
    if (!startedAt) continue
    const binding = { ...reference, toolUseId, startedAt }
    const previous = bindings.get(reference.runId) ?? []
    if (!previous.some((item) => item.toolUseId === toolUseId)) {
      previous.push(binding)
      previous.sort((left, right) =>
        Date.parse(left.startedAt) - Date.parse(right.startedAt)
        || left.toolUseId.localeCompare(right.toolUseId))
      bindings.set(reference.runId, previous)
    }
  }
  return bindings
}

export function workflowRunIdForSubagent(subDir: string, file: string): string | undefined {
  const parts = relative(subDir, file).split(/[\\/]/)
  if (parts[0] !== 'workflows') return undefined
  if (
    parts.length !== 3
    || !parts[1]
    || !/^agent-.*\.jsonl$/.test(parts[2] ?? '')
  ) {
    throw new ClaudeTaskScopeError(
      `Claude Workflow subagent has an unsupported path: ${file}`,
    )
  }
  return parts[1]
}

export function bindWorkflowSubagent(
  file: string,
  runId: string,
  transcriptDir: string,
  bindings: ReadonlyMap<string, readonly WorkflowRunBinding[]>,
): readonly WorkflowRunBinding[] {
  const runBindings = bindings.get(runId)
  if (!runBindings || runBindings.length === 0) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow subagent ${file}: parent result has no run ${runId}`,
    )
  }
  const expectedDir = resolve(transcriptDir)
  if (resolve(dirname(file)) !== expectedDir) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow run ${runId}: transcript directory does not match ${expectedDir}`,
    )
  }
  const localBindings = runBindings.filter(
    (binding) => resolve(binding.transcriptDir) === expectedDir,
  )
  if (localBindings.length === 0) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow run ${runId}: transcript directory does not match ${expectedDir}`,
    )
  }
  return localBindings
}

export function selectWorkflowBinding(
  file: string,
  bindings: readonly WorkflowRunBinding[],
  childStartedAt: string,
  explicitToolUseId?: string,
): WorkflowRunBinding {
  const childStartedMs = Date.parse(childStartedAt)
  if (!Number.isFinite(childStartedMs)) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow subagent ${file}: child start time is invalid`,
    )
  }
  const matching = explicitToolUseId
    ? bindings.filter((binding) => binding.toolUseId === explicitToolUseId)
    : bindings
  if (explicitToolUseId && matching.length === 0) {
    throw new ClaudeTaskScopeError(
      `Claude Workflow subagent ${file} names tool ${explicitToolUseId}, but the run belongs to another Workflow call`,
    )
  }
  const eligible = matching.filter((binding) => {
    const startedMs = Date.parse(binding.startedAt)
    if (!Number.isFinite(startedMs)) {
      throw new ClaudeTaskScopeError(
        `Cannot link Claude Workflow subagent ${file}: parent call time is invalid`,
      )
    }
    return startedMs <= childStartedMs
  })
  if (eligible.length === 0) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow subagent ${file}: it starts before its parent call`,
    )
  }
  let latestMs = Number.NEGATIVE_INFINITY
  for (const binding of eligible) {
    latestMs = Math.max(latestMs, Date.parse(binding.startedAt))
  }
  const latest = eligible.filter((binding) => Date.parse(binding.startedAt) === latestMs)
  if (latest.length !== 1) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow subagent ${file}: parent call is ambiguous`,
    )
  }
  return latest[0]!
}
