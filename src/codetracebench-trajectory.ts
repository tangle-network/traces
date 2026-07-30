import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chatTrajectoryToSpans,
  type ChatTrajectoryMessage,
} from './chat-trajectory.js'
import {
  atomicWriteFile,
  containedFile,
  isObject,
  optionalContainedFile,
  sha256,
} from './codetracebench-files.js'
import type {
  CodeTraceBenchFileRef,
  CodeTraceBenchImportedTrace,
  CodeTraceBenchStep,
} from './codetracebench.js'
import { serializeSpans, type OtlpSpan } from './otlp.js'

interface CodeTraceBenchRow {
  readonly trajId: string
  readonly agent: string
  readonly model: string
  readonly taskName: string
  readonly stepCount: number
  readonly annotationRelpath?: string
  readonly incorrectStages?: unknown
}

const TRAJECTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const LABEL_KEY =
  /\\?["'](?:incorrect_stages|incorrect_step_ids|unuseful_step_ids|annotation_relpath|incorrect_error_stage_count)\\?["']\s*:/i
const LABEL_ARRAY =
  /\\?["']labels\\?["']\s*:\s*\[[^\]]*\\?["'](?:incorrect|unuseful)\\?["']/i
const ANNOTATION_PATH =
  /(?:agent_failure_analysis|step_annotations(?:_all)?|merged_cleaned_step\d*)[\\/]/i

export async function importTrajectory(input: {
  index: number
  row: CodeTraceBenchRow
  trajectoryDirectory: string
  stagingDirectory: string
  signal: AbortSignal
}): Promise<CodeTraceBenchImportedTrace> {
  const { index, row, trajectoryDirectory, stagingDirectory, signal } = input
  const caseDirectory = join(trajectoryDirectory, row.trajId)
  const stepsPath = await containedFile(
    trajectoryDirectory,
    join(caseDirectory, 'steps.json'),
    `${row.trajId}: steps.json`,
  )
  signal.throwIfAborted()
  const stepsBytes = await readFile(stepsPath, { signal })
  const steps = parseSteps(stepsBytes.toString('utf8'), row)
  const task = await readOptionalTask(trajectoryDirectory, caseDirectory, row, signal)
  const messages = trajectoryMessages(row, steps, task.content)
  const spans: OtlpSpan[] = chatTrajectoryToSpans(messages, {
    traceId: row.trajId,
    service: 'codetracebench',
    sourcePath: `${row.trajId}/steps.json`,
  }).map((item): OtlpSpan => ({
    ...item,
    attributes: {
      ...item.attributes,
      'benchmark.name': 'CodeTraceBench',
      'trajectory.id': row.trajId,
      ...(item.attributes['openinference.span.kind'] === 'LLM'
        ? { 'agent.name': row.agent }
        : {}),
    },
  }))
  const actionSpans = spans.filter(
    (item) => item.attributes['openinference.span.kind'] === 'LLM',
  )
  if (actionSpans.length !== row.stepCount) {
    throw new Error(
      `${row.trajId}: generated ${actionSpans.length} action spans for ${row.stepCount} steps`,
    )
  }
  for (const [stepIndex, item] of actionSpans.entries()) {
    const expectedSpanId = `step-${stepIndex + 1}`
    if (item.span_id !== expectedSpanId) {
      throw new Error(
        `${row.trajId}: generated action span '${item.span_id}', expected '${expectedSpanId}'`,
      )
    }
  }

  assertNoLabelLeak(spans, row)
  const serialized = serializeSpans(spans)
  assertNoLabelLeakInText(serialized, row, `${row.trajId}: serialized OTLP`)
  const outputFile = `${row.trajId}.otlp.jsonl`
  await atomicWriteFile(join(stagingDirectory, outputFile), serialized, signal)

  return {
    index,
    traceId: row.trajId,
    stepCount: row.stepCount,
    spanCount: spans.length,
    taskSource: task.source,
    input: {
      stepsPath: `${row.trajId}/steps.json`,
      stepsSha256: sha256(stepsBytes),
      stepsBytes: stepsBytes.byteLength,
      ...(task.path
        ? {
            taskPath: `${row.trajId}/task.md`,
            taskSha256: sha256(task.bytes!),
            taskBytes: task.bytes!.byteLength,
          }
        : {}),
    },
    output: {
      path: outputFile,
      sha256: sha256(serialized),
      bytes: Buffer.byteLength(serialized),
    },
  }
}

function trajectoryMessages(
  row: CodeTraceBenchRow,
  steps: readonly CodeTraceBenchStep[],
  task: string,
): ChatTrajectoryMessage[] {
  return [
    { role: 'user', content: task },
    ...steps.flatMap((step) => {
      const action: ChatTrajectoryMessage = {
        role: 'assistant',
        content: [step.thinking, step.action].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ).join('\n'),
        extra: { response: { model: row.model } },
      }
      if (step.observation === null) return [action]
      return [
        action,
        {
          role: 'observation',
          content: step.observation,
          ...(step.tool_type ? { name: step.tool_type } : {}),
        },
      ]
    }),
  ]
}

export function parseRows(text: string, path: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(`CodeTraceBench rows file is empty: ${path}`)
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (isObject(parsed)) return [parsed]
    throw new TypeError('JSON must be an object or array')
  } catch (error) {
    if (!/\r?\n/.test(trimmed)) {
      throw new Error(`${path}: invalid JSON: ${errorMessage(error)}`)
    }
  }

  return trimmed.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as unknown]
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${errorMessage(error)}`)
    }
  })
}

export function validateRows(rows: readonly unknown[], path: string): CodeTraceBenchRow[] {
  if (rows.length === 0) throw new Error(`CodeTraceBench rows file is empty: ${path}`)
  const ids = new Set<string>()
  return rows.map((value, index) => {
    if (!isObject(value)) {
      throw new TypeError(`${path}:${index + 1}: CodeTraceBench row must be an object`)
    }
    const trajId = requiredString(value.traj_id, `${path}:${index + 1} traj_id`)
    if (!TRAJECTORY_ID.test(trajId)) {
      throw new TypeError(
        `${path}:${index + 1}: traj_id must contain only letters, digits, dot, underscore, or hyphen`,
      )
    }
    if (ids.has(trajId)) {
      throw new TypeError(`${path}:${index + 1}: duplicate traj_id '${trajId}'`)
    }
    ids.add(trajId)
    const stepCount = positiveInteger(
      value.step_count,
      `${path}:${index + 1} step_count`,
    )
    const annotationRelpath =
      value.annotation_relpath === undefined || value.annotation_relpath === null
        ? undefined
        : requiredString(
            value.annotation_relpath,
            `${path}:${index + 1} annotation_relpath`,
          )
    return {
      trajId,
      agent: requiredString(value.agent, `${path}:${index + 1} agent`),
      model: requiredString(value.model, `${path}:${index + 1} model`),
      taskName: requiredString(value.task_name, `${path}:${index + 1} task_name`),
      stepCount,
      ...(annotationRelpath ? { annotationRelpath } : {}),
      ...(value.incorrect_stages === undefined
        ? {}
        : { incorrectStages: value.incorrect_stages }),
    }
  })
}

function parseSteps(text: string, row: CodeTraceBenchRow): CodeTraceBenchStep[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${row.trajId}/steps.json: invalid JSON: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError(`${row.trajId}/steps.json must contain a non-empty array`)
  }
  if (parsed.length !== row.stepCount) {
    throw new Error(
      `${row.trajId}: steps.json contains ${parsed.length} steps, row declares ${row.stepCount}`,
    )
  }
  return parsed.map((value, index) => {
    const label = `${row.trajId}/steps.json[${index}]`
    if (!isObject(value)) throw new TypeError(`${label} must be an object`)
    const stepId = positiveInteger(value.step_id, `${label}.step_id`)
    if (stepId !== index + 1) {
      throw new Error(`${label}.step_id is ${stepId}; expected ${index + 1}`)
    }
    if (!Object.hasOwn(value, 'observation')) {
      throw new TypeError(`${label}.observation is required and may be null`)
    }
    const observation = value.observation
    if (observation !== null && typeof observation !== 'string') {
      throw new TypeError(`${label}.observation must be a string or null`)
    }
    return {
      step_id: stepId,
      action: requiredString(value.action, `${label}.action`),
      observation,
      ...(value.thinking === undefined
        ? {}
        : { thinking: requiredString(value.thinking, `${label}.thinking`) }),
      ...(value.parallel_group === undefined
        ? {}
        : {
            parallel_group: nonNegativeInteger(
              value.parallel_group,
              `${label}.parallel_group`,
            ),
          }),
      ...(value.tool_type === undefined
        ? {}
        : { tool_type: requiredString(value.tool_type, `${label}.tool_type`) }),
      action_ref: fileRef(value.action_ref, `${label}.action_ref`),
      observation_ref: fileRef(value.observation_ref, `${label}.observation_ref`),
    }
  })
}

function fileRef(value: unknown, label: string): CodeTraceBenchFileRef | null {
  if (value === null) return null
  if (!isObject(value)) throw new TypeError(`${label} must be an object or null`)
  const lineStart = positiveInteger(value.line_start, `${label}.line_start`)
  const lineEnd = positiveInteger(value.line_end, `${label}.line_end`)
  if (lineEnd < lineStart) {
    throw new RangeError(`${label}.line_end must not precede line_start`)
  }
  return {
    path: requiredString(value.path, `${label}.path`),
    line_start: lineStart,
    line_end: lineEnd,
    content: stringField(value.content, `${label}.content`),
  }
}

async function readOptionalTask(
  trajectoryDirectory: string,
  caseDirectory: string,
  row: CodeTraceBenchRow,
  signal: AbortSignal,
): Promise<{
  source: 'task.md' | 'task_name'
  content: string
  path?: string
  bytes?: Buffer
}> {
  const candidate = join(caseDirectory, 'task.md')
  const path = await optionalContainedFile(trajectoryDirectory, candidate)
  if (!path) {
    return {
      source: 'task_name',
      content: `Task: ${row.taskName}`,
    }
  }
  const bytes = await readFile(path, { signal })
  const content = bytes.toString('utf8').trim()
  if (!content) throw new Error(`${row.trajId}/task.md is empty`)
  return { source: 'task.md', content, path, bytes }
}

function assertNoLabelLeak(
  spans: readonly { span_id: string; attributes: Record<string, unknown> }[],
  row: CodeTraceBenchRow,
): void {
  for (const item of spans) {
    const content = item.attributes.content
    if (typeof content === 'string') {
      assertNoLabelLeakInText(content, row, `${row.trajId}/${item.span_id} content`)
    }
  }
}

function assertNoLabelLeakInText(
  text: string,
  row: CodeTraceBenchRow,
  context: string,
): void {
  if (LABEL_KEY.test(text) || LABEL_ARRAY.test(text) || ANNOTATION_PATH.test(text)) {
    throw new Error(`${context}: generated trace contains CodeTraceBench annotation data`)
  }
  const annotationPath = row.annotationRelpath?.replaceAll('\\', '/').toLowerCase()
  if (
    annotationPath &&
    text.replaceAll('\\', '/').toLowerCase().includes(annotationPath)
  ) {
    throw new Error(`${context}: generated trace contains annotation path`)
  }
  const labels = normalizedLabels(row.incorrectStages)
  if (labels && compact(text).includes(labels)) {
    throw new Error(`${context}: generated trace contains serialized CodeTraceBench labels`)
  }
}

function normalizedLabels(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  let parsed = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === '[]') return undefined
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      parsed = trimmed
    }
  }
  const serialized = JSON.stringify(parsed)
  if (!serialized || serialized === '[]' || serialized === '""') return undefined
  return compact(serialized)
}

function compact(value: string): string {
  return value.replace(/\s+/g, '')
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
