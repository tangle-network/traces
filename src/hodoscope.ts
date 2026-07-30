import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { endianness, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  ExternalAnalysisResult,
  ExternalAnalyzer,
  ExternalDiscoveryCandidate,
} from './external.js'
import { runCommand } from './external.js'
import { readJsonl } from './jsonl.js'

const HODOSCOPE_VERSION = '0.2.4'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface OpenInferenceRow {
  trace_id: string
  span_id: string
  parent_span_id?: string | null
  name: string
  kind?: string
  start_time: string
  status: { code?: string; message?: string }
  attributes: Record<string, unknown>
}

export interface HodoscopeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  source?: string
  tool_calls?: Array<{ function: string; arguments: Json }>
}

export interface HodoscopeTrajectory {
  id: string
  model?: string
  metadata: Record<string, Json>
  messages: HodoscopeMessage[]
}

export interface HodoscopeSourceMapEntry {
  trajectoryId: string
  turnId: number
  traceId: string
  spanId: string
  evidenceUri: string
}

export interface HodoscopeInput {
  directory: string
  trajectoryCount: number
  actionCount: number
  sourceMap: readonly HodoscopeSourceMapEntry[]
}

export interface HodoscopeAnalyzerOptions {
  command?: string
  commandArgs?: readonly string[]
  /** Hodoscope 0.2.4 currently resolves on Python 3.11, not Python 3.13. */
  pythonVersion?: string
  /** Parent directory for isolated per-run artifacts. */
  outputDir?: string
  summarizeModel?: string
  embeddingModel?: string
  embeddingDimensions?: number
  maxWorkers?: number
  groupByAttribute?: string
  samplesPerGroup?: number
  projection?: 'pca' | 'tsne' | 'umap' | 'trimap' | 'pacmap'
  timeoutMs?: number
}

interface HodoscopeAnalysis {
  version: number
  created_at: string
  source: string
  fields: Record<string, Json>
  embedding_model: string
  embedding_dimensionality: number
  summaries: HodoscopeSummary[]
}

interface HodoscopeSummary {
  trajectory_id: string
  turn_id: number
  summary: string
  action_text: string
  task_context: string
  embedding: string
  metadata: Record<string, Json>
}

interface HodoscopeSamples {
  group_by: string
  method: string
  n_per_group: number
  groups: Record<string, {
    total: number
    samples: Array<{
      rank: number
      trajectory_id: string
      turn_id: number
      summary: string
      action_text: string
      metadata: Record<string, Json>
    }>
  }>
}

/** Convert OpenInference JSONL into Hodoscope's trajectory directory. */
export async function writeHodoscopeInput(
  otlpPath: string,
  options: { directory?: string; groupByAttribute?: string } = {},
): Promise<HodoscopeInput> {
  const explicitDirectory = options.directory ? resolve(options.directory) : undefined
  const directory = explicitDirectory
    ?? await mkdtemp(join(tmpdir(), 'traces-hodoscope-input-'))
  if (explicitDirectory) {
    await mkdir(directory, { recursive: true })
    if ((await readdir(directory)).length > 0) {
      throw new Error(`Hodoscope explicit directory must be empty: ${directory}`)
    }
  }
  const samples = join(directory, 'samples')
  await mkdir(samples)
  const rows: OpenInferenceRow[] = []
  for await (const value of readJsonl<unknown>(otlpPath)) rows.push(parseOpenInferenceRow(value))
  if (rows.length === 0) throw new Error('Hodoscope input contains no spans')

  const byTrace = new Map<string, OpenInferenceRow[]>()
  for (const row of rows) {
    const trace = byTrace.get(row.trace_id) ?? []
    trace.push(row)
    byTrace.set(row.trace_id, trace)
  }

  const sourceMap: HodoscopeSourceMapEntry[] = []
  let actionCount = 0
  for (const [traceId, traceRows] of byTrace) {
    const trajectory = toHodoscopeTrajectory(
      traceId,
      traceRows,
      options.groupByAttribute ?? 'comparison_group',
      sourceMap,
    )
    const actions = trajectory.messages.filter((message) => message.role === 'assistant').length
    if (actions === 0) {
      throw new Error(`Hodoscope trace '${traceId}' contains no assistant actions`)
    }
    actionCount += actions
    const file = `${createHash('sha256').update(traceId).digest('hex').slice(0, 24)}.json`
    await writeFile(join(samples, file), `${JSON.stringify(trajectory, null, 2)}\n`, 'utf8')
  }
  return {
    directory,
    trajectoryCount: byTrace.size,
    actionCount,
    sourceMap,
  }
}

/** Run Hodoscope as a behavior-discovery engine. Its output requires review. */
export function hodoscopeAnalyzer(options: HodoscopeAnalyzerOptions = {}): ExternalAnalyzer {
  const summarizeModel = options.summarizeModel ?? 'gpt-5-mini'
  const embeddingModel = options.embeddingModel ?? 'text-embedding-3-small'
  const embeddingDimensions = options.embeddingDimensions ?? 768
  const maxWorkers = options.maxWorkers ?? 1
  const samplesPerGroup = options.samplesPerGroup ?? 20
  assertPositiveInteger('embeddingDimensions', embeddingDimensions)
  assertPositiveInteger('maxWorkers', maxWorkers)
  assertPositiveInteger('samplesPerGroup', samplesPerGroup)

  return {
    name: 'hodoscope',
    async analyze(otlpPath, runOptions = {}): Promise<ExternalAnalysisResult> {
      const outputRoot = options.outputDir ? resolve(options.outputDir) : tmpdir()
      await mkdir(outputRoot, { recursive: true })
      const directory = await mkdtemp(join(outputRoot, 'traces-hodoscope-'))
      const input = join(directory, 'input')
      const analysisFile = join(directory, 'analysis.hodoscope.json')
      const samplesFile = join(directory, 'samples.json')
      try {
        const prepared = await writeHodoscopeInput(otlpPath, {
          directory: input,
          groupByAttribute: options.groupByAttribute,
        })
        if (prepared.actionCount < 2) {
          throw new Error('Hodoscope requires at least two assistant actions for behavior discovery')
        }
        const command = options.command ?? 'uvx'
        const prefix = options.commandArgs ?? [
          '--python',
          options.pythonVersion ?? '3.11',
          '--from',
          `hodoscope==${HODOSCOPE_VERSION}`,
          'hodoscope',
        ]
        const analyze = await runCommand(
          command,
          [
            ...prefix,
            'analyze',
            input,
            '--output',
            analysisFile,
            '--no-sample',
            '--no-resume',
            '--summarize-model',
            summarizeModel,
            '--embedding-model',
            embeddingModel,
            '--embed-dim',
            String(embeddingDimensions),
            '--max-workers',
            String(maxWorkers),
          ],
          { signal: runOptions.signal, timeoutMs: options.timeoutMs ?? 600_000 },
        )
        if (analyze.code !== 0) {
          throw new Error(
            analyze.stderr.trim() || analyze.stdout.trim() || `Hodoscope analyze exited ${analyze.code}`,
          )
        }
        const sourceByAction = indexSourceActions(prepared.sourceMap)
        const analysis = await readHodoscopeAnalysis(analysisFile, {
          source: input,
          embeddingModel,
          embeddingDimensions,
          sourceByAction,
        })
        const sample = await runCommand(
          command,
          [
            ...prefix,
            'sample',
            analysisFile,
            '--group-by',
            'comparison_group',
            '--samples-per-group',
            String(samplesPerGroup),
            '--proj',
            options.projection ?? 'pca',
            '--output',
            samplesFile,
          ],
          { signal: runOptions.signal, timeoutMs: options.timeoutMs ?? 600_000 },
        )
        if (sample.code !== 0) {
          throw new Error(
            sample.stderr.trim() || sample.stdout.trim() || `Hodoscope sample exited ${sample.code}`,
          )
        }
        const sampled = parseHodoscopeSamples(await readJson(samplesFile), {
          groupBy: 'comparison_group',
          method: options.projection ?? 'pca',
          samplesPerGroup,
          summaries: analysis.summaries,
          sourceByAction,
        })
        const candidates = candidatesFromSamples(sampled, sourceByAction)
        return {
          analyzer: 'hodoscope',
          kind: 'discovery',
          ok: true,
          output: JSON.stringify({
            version: HODOSCOPE_VERSION,
            directory,
            trajectories: prepared.trajectoryCount,
            actions: analysis.summaries.length,
            candidates: candidates.length,
          }),
          candidates,
        }
      } catch (error) {
        return {
          analyzer: 'hodoscope',
          kind: 'discovery',
          ok: false,
          output: JSON.stringify({ version: HODOSCOPE_VERSION, directory }),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

function toHodoscopeTrajectory(
  traceId: string,
  rows: readonly OpenInferenceRow[],
  groupByAttribute: string,
  sourceMap: HodoscopeSourceMapEntry[],
): HodoscopeTrajectory {
  const sorted = [...rows].sort(
    (left, right) =>
      numericAttribute(left.attributes.step) - numericAttribute(right.attributes.step) ||
      Date.parse(left.start_time) - Date.parse(right.start_time) ||
      left.span_id.localeCompare(right.span_id),
  )
  const duplicateLlmRows = duplicateLlmAssistantRows(sorted)
  const messages: HodoscopeMessage[] = []
  for (const row of sorted) {
    const kind = openInferenceKind(row)
    const content = stringAttribute(row.attributes.content)
    if (row.name === 'user.prompt' && content) {
      messages.push({ role: 'user', content })
      continue
    }
    if (kind === 'TOOL') {
      const tool = stringAttribute(row.attributes['tool.name']) ?? row.name
      const args = jsonValue(row.attributes['input.value'])
      const turnId = messages.length
      messages.push({
        role: 'assistant',
        source: 'tool',
        content: `TOOL_CALL: ${tool} ${stringifyCompact(args)}`,
        tool_calls: [{ function: tool, arguments: args }],
      })
      sourceMap.push(sourceMapEntry(traceId, row.span_id, turnId))
      const status = row.status.code === 'STATUS_CODE_ERROR' || row.status.code === 'ERROR'
        ? 'error'
        : 'ok'
      const output = stringAttribute(row.attributes['output.value']) ?? row.status.message ?? ''
      messages.push({ role: 'tool', content: `STATUS: ${status}${output ? `\n${output}` : ''}` })
      continue
    }
    const isAssistantMessage = kind === 'CHAIN' && row.name === 'message.assistant'
    if (
      (
        isAssistantMessage ||
        row.name.startsWith('message.agent.') ||
        (kind === 'LLM' && !duplicateLlmRows.has(row))
      ) &&
      content
    ) {
      const turnId = messages.length
      messages.push({ role: 'assistant', content })
      sourceMap.push(sourceMapEntry(traceId, row.span_id, turnId))
    }
  }
  const root = sorted.find((row) => !row.parent_span_id) ?? sorted[0]!
  const group = firstAttribute(sorted, groupByAttribute) ?? 'all'
  const model = firstAttribute(sorted, 'llm.model_name')
  return {
    id: traceId,
    ...(model ? { model } : {}),
    metadata: {
      comparison_group: group,
      trace_id: traceId,
      source_service: firstAttribute(sorted, 'service.name') ?? stringAttribute(root.attributes['service.name']) ?? 'unknown',
    },
    messages,
  }
}

function duplicateLlmAssistantRows(
  rows: readonly OpenInferenceRow[],
): ReadonlySet<OpenInferenceRow> {
  const assistantMessageCounts = new Map<string, number>()
  for (const row of rows) {
    if (openInferenceKind(row) !== 'CHAIN' || row.name !== 'message.assistant') continue
    const content = stringAttribute(row.attributes.content)
    if (content) {
      assistantMessageCounts.set(content, (assistantMessageCounts.get(content) ?? 0) + 1)
    }
  }

  const duplicates = new Set<OpenInferenceRow>()
  for (const row of rows) {
    if (openInferenceKind(row) !== 'LLM') continue
    const content = stringAttribute(row.attributes.content)
    if (!content) continue
    const remaining = assistantMessageCounts.get(content) ?? 0
    if (remaining === 0) continue
    duplicates.add(row)
    assistantMessageCounts.set(content, remaining - 1)
  }
  return duplicates
}

function openInferenceKind(row: OpenInferenceRow): string {
  return row.kind ?? stringAttribute(row.attributes['openinference.span.kind']) ?? 'SPAN'
}

function sourceMapEntry(traceId: string, spanId: string, turnId: number): HodoscopeSourceMapEntry {
  return {
    trajectoryId: traceId,
    turnId,
    traceId,
    spanId,
    evidenceUri: `trace://${encodeURIComponent(traceId)}/span/${encodeURIComponent(spanId)}`,
  }
}

interface HodoscopeAnalysisExpectations {
  source: string
  embeddingModel: string
  embeddingDimensions: number
  sourceByAction: ReadonlyMap<string, HodoscopeSourceMapEntry>
}

interface HodoscopeSampleExpectations {
  groupBy: string
  method: string
  samplesPerGroup: number
  summaries: readonly HodoscopeSummary[]
  sourceByAction: ReadonlyMap<string, HodoscopeSourceMapEntry>
}

async function readHodoscopeAnalysis(
  path: string,
  expected: HodoscopeAnalysisExpectations,
): Promise<HodoscopeAnalysis> {
  const value = await readJson(path)
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.summaries)) {
    throw new Error('Hodoscope analysis has an unsupported shape')
  }

  const createdAt = requiredString(value.created_at, 'analysis.created_at')
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Hodoscope analysis.created_at must be a valid date-time')
  }
  const source = requiredString(value.source, 'analysis.source')
  if (resolve(source) !== resolve(expected.source)) {
    throw new Error(
      `Hodoscope analysis.source '${source}' does not match requested input '${expected.source}'`,
    )
  }
  const embeddingModel = requiredString(value.embedding_model, 'analysis.embedding_model')
  if (embeddingModel !== expected.embeddingModel) {
    throw new Error(
      `Hodoscope analysis.embedding_model '${embeddingModel}' does not match requested model '${expected.embeddingModel}'`,
    )
  }
  const embeddingDimensions = nonNegativeSafeInteger(
    value.embedding_dimensionality,
    'analysis.embedding_dimensionality',
  )
  if (embeddingDimensions !== expected.embeddingDimensions) {
    throw new Error(
      `Hodoscope analysis embedding dimensionality ${embeddingDimensions} does not match requested ${expected.embeddingDimensions}`,
    )
  }

  if (value.summaries.length !== expected.sourceByAction.size) {
    throw new Error(
      `Hodoscope summarized ${value.summaries.length}/${expected.sourceByAction.size} assistant actions`,
    )
  }
  const summaries = value.summaries.map((row, index) =>
    parseHodoscopeSummary(row, index, embeddingDimensions),
  )

  const seen = new Set<string>()
  for (const [index, summary] of summaries.entries()) {
    const key = actionKey(summary.trajectory_id, summary.turn_id)
    if (!expected.sourceByAction.has(key)) {
      throw new Error(
        `Hodoscope analysis.summaries[${index}] references unknown source action ${formatAction(summary.trajectory_id, summary.turn_id)}`,
      )
    }
    if (seen.has(key)) {
      throw new Error(
        `Hodoscope analysis contains duplicate source action ${formatAction(summary.trajectory_id, summary.turn_id)}`,
      )
    }
    seen.add(key)
  }
  const missing = [...expected.sourceByAction.keys()].find((key) => !seen.has(key))
  if (missing) {
    const sourceEntry = expected.sourceByAction.get(missing)!
    throw new Error(
      `Hodoscope analysis is missing source action ${formatAction(sourceEntry.trajectoryId, sourceEntry.turnId)}`,
    )
  }

  return {
    version: 1,
    created_at: createdAt,
    source,
    fields: jsonRecord(value.fields, 'analysis.fields'),
    embedding_model: embeddingModel,
    embedding_dimensionality: embeddingDimensions,
    summaries,
  }
}

function parseHodoscopeSummary(
  value: unknown,
  index: number,
  embeddingDimensions: number,
): HodoscopeSummary {
  const path = `analysis.summaries[${index}]`
  if (!isObject(value)) throw new Error(`Hodoscope ${path} must be an object`)
  const trajectoryId = requiredString(value.trajectory_id, `${path}.trajectory_id`)
  const turnId = nonNegativeSafeInteger(value.turn_id, `${path}.turn_id`)
  const summary = requiredString(value.summary, `${path}.summary`)
  if (summary.trimStart().toLowerCase().startsWith('[error:')) {
    throw new Error(`Hodoscope failed to summarize ${formatAction(trajectoryId, turnId)}`)
  }
  const actionText = requiredString(value.action_text, `${path}.action_text`)
  const embedding = requiredString(value.embedding, `${path}.embedding`)
  validateEmbedding(embedding, embeddingDimensions, `${path}.embedding`)
  const taskContext = value.task_context
  if (typeof taskContext !== 'string') {
    throw new Error(`Hodoscope ${path}.task_context must be a string`)
  }
  return {
    trajectory_id: trajectoryId,
    turn_id: turnId,
    summary,
    action_text: actionText,
    task_context: taskContext,
    embedding,
    metadata: jsonRecord(value.metadata, `${path}.metadata`),
  }
}

function parseHodoscopeSamples(
  value: unknown,
  expected: HodoscopeSampleExpectations,
): HodoscopeSamples {
  if (!isObject(value) || !isObject(value.groups)) {
    throw new Error('Hodoscope samples have an unsupported shape')
  }
  const groupBy = requiredString(value.group_by, 'samples.group_by')
  if (groupBy !== expected.groupBy) {
    throw new Error(
      `Hodoscope samples.group_by '${groupBy}' does not match requested '${expected.groupBy}'`,
    )
  }
  const method = requiredString(value.method, 'samples.method')
  if (method !== expected.method) {
    throw new Error(
      `Hodoscope samples.method '${method}' does not match requested '${expected.method}'`,
    )
  }
  const nPerGroup = nonNegativeSafeInteger(value.n_per_group, 'samples.n_per_group')
  if (nPerGroup < 1 || nPerGroup !== expected.samplesPerGroup) {
    throw new Error(
      `Hodoscope samples.n_per_group ${nPerGroup} does not match requested ${expected.samplesPerGroup}`,
    )
  }

  const summaryByAction = new Map(
    expected.summaries.map((summary) => [
      actionKey(summary.trajectory_id, summary.turn_id),
      summary,
    ]),
  )
  const expectedGroupTotals = new Map<string, number>()
  for (const [index, summary] of expected.summaries.entries()) {
    const group = requiredString(
      summary.metadata[groupBy],
      `analysis.summaries[${index}].metadata.${groupBy}`,
    )
    expectedGroupTotals.set(group, (expectedGroupTotals.get(group) ?? 0) + 1)
  }

  const parsedGroups = Object.create(null) as HodoscopeSamples['groups']
  const sampledActions = new Set<string>()
  let reportedTotal = 0
  let reportedSamples = 0
  for (const [group, groupValue] of Object.entries(value.groups)) {
    if (!group.trim()) throw new Error('Hodoscope sample group names must be non-empty')
    if (!isObject(groupValue) || !Array.isArray(groupValue.samples)) {
      throw new Error(`Hodoscope sample group '${group}' has an unsupported shape`)
    }
    const total = nonNegativeSafeInteger(groupValue.total, `samples.groups.${group}.total`)
    const expectedTotal = expectedGroupTotals.get(group)
    if (expectedTotal === undefined) {
      throw new Error(`Hodoscope samples contain unexpected group '${group}'`)
    }
    if (total !== expectedTotal) {
      throw new Error(
        `Hodoscope sample group '${group}' reports ${total}/${expectedTotal} source actions`,
      )
    }
    const expectedSampleCount = Math.min(total, nPerGroup)
    if (groupValue.samples.length !== expectedSampleCount) {
      throw new Error(
        `Hodoscope sample group '${group}' contains ${groupValue.samples.length}/${expectedSampleCount} requested samples`,
      )
    }

    const parsedSamples = groupValue.samples.map((row, index) => {
      const path = `samples.groups.${group}.samples[${index}]`
      if (!isObject(row)) throw new Error(`Hodoscope ${path} must be an object`)
      const rank = nonNegativeSafeInteger(row.rank, `${path}.rank`)
      if (rank !== index) {
        throw new Error(`Hodoscope ${path}.rank must be ${index}, received ${rank}`)
      }
      const trajectoryId = requiredString(row.trajectory_id, `${path}.trajectory_id`)
      const turnId = nonNegativeSafeInteger(row.turn_id, `${path}.turn_id`)
      const key = actionKey(trajectoryId, turnId)
      if (!expected.sourceByAction.has(key)) {
        throw new Error(
          `Hodoscope ${path} references unknown source action ${formatAction(trajectoryId, turnId)}`,
        )
      }
      if (sampledActions.has(key)) {
        throw new Error(
          `Hodoscope samples contain duplicate source action ${formatAction(trajectoryId, turnId)}`,
        )
      }
      const sourceSummary = summaryByAction.get(key)
      if (!sourceSummary) {
        throw new Error(
          `Hodoscope ${path} has no matching analysis row for ${formatAction(trajectoryId, turnId)}`,
        )
      }
      const summary = requiredString(row.summary, `${path}.summary`)
      const actionText = requiredString(row.action_text, `${path}.action_text`)
      const metadata = jsonRecord(row.metadata, `${path}.metadata`)
      if (summary !== sourceSummary.summary || actionText !== sourceSummary.action_text) {
        throw new Error(
          `Hodoscope ${path} text does not match its analysis row ${formatAction(trajectoryId, turnId)}`,
        )
      }
      if (!jsonEquals(metadata, sourceSummary.metadata)) {
        throw new Error(
          `Hodoscope ${path}.metadata does not match its analysis row ${formatAction(trajectoryId, turnId)}`,
        )
      }
      if (metadata[groupBy] !== group) {
        throw new Error(
          `Hodoscope ${path}.metadata.${groupBy} does not match group '${group}'`,
        )
      }
      sampledActions.add(key)
      return {
        rank,
        trajectory_id: trajectoryId,
        turn_id: turnId,
        summary,
        action_text: actionText,
        metadata,
      }
    })
    parsedGroups[group] = { total, samples: parsedSamples }
    reportedTotal += total
    reportedSamples += parsedSamples.length
  }

  const missingGroup = [...expectedGroupTotals.keys()].find(
    (group) => !Object.hasOwn(parsedGroups, group),
  )
  if (missingGroup) throw new Error(`Hodoscope samples are missing group '${missingGroup}'`)
  if (reportedTotal !== expected.summaries.length) {
    throw new Error(
      `Hodoscope sample groups account for ${reportedTotal}/${expected.summaries.length} analysis rows`,
    )
  }
  const expectedSamples = [...expectedGroupTotals.values()].reduce(
    (total, groupTotal) => total + Math.min(groupTotal, nPerGroup),
    0,
  )
  if (reportedSamples !== expectedSamples) {
    throw new Error(
      `Hodoscope samples contain ${reportedSamples}/${expectedSamples} requested rows`,
    )
  }
  return { group_by: groupBy, method, n_per_group: nPerGroup, groups: parsedGroups }
}

function candidatesFromSamples(
  samples: HodoscopeSamples,
  sourceByAction: ReadonlyMap<string, HodoscopeSourceMapEntry>,
): ExternalDiscoveryCandidate[] {
  const candidates: ExternalDiscoveryCandidate[] = []
  for (const [group, value] of Object.entries(samples.groups)) {
    if (!isObject(value) || !Array.isArray(value.samples) || !Number.isInteger(value.total)) {
      throw new Error(`Hodoscope sample group '${group}' has an unsupported shape`)
    }
    for (const row of value.samples as HodoscopeSamples['groups'][string]['samples']) {
      const source = sourceByAction.get(actionKey(row.trajectory_id, row.turn_id))
      if (!source) {
        throw new Error(
          `Hodoscope sample ${row.trajectory_id}:${row.turn_id} has no source span mapping`,
        )
      }
      candidates.push({
        engine: 'hodoscope',
        engineVersion: HODOSCOPE_VERSION,
        status: 'needs_review',
        group,
        rank: row.rank,
        groupSize: value.total,
        traceId: source.traceId,
        spanId: source.spanId,
        evidenceUri: source.evidenceUri,
        summary: row.summary,
        actionText: row.action_text,
      })
    }
  }
  return candidates.sort(
    (left, right) => left.group.localeCompare(right.group) || left.rank - right.rank,
  )
}

function indexSourceActions(
  sourceMap: readonly HodoscopeSourceMapEntry[],
): Map<string, HodoscopeSourceMapEntry> {
  const byAction = new Map<string, HodoscopeSourceMapEntry>()
  for (const source of sourceMap) {
    const key = actionKey(source.trajectoryId, source.turnId)
    if (byAction.has(key)) {
      throw new Error(
        `Hodoscope input contains duplicate source action ${formatAction(source.trajectoryId, source.turnId)}`,
      )
    }
    byAction.set(key, source)
  }
  return byAction
}

function actionKey(trajectoryId: string, turnId: number): string {
  return JSON.stringify([trajectoryId, turnId])
}

function formatAction(trajectoryId: string, turnId: number): string {
  return `${JSON.stringify(trajectoryId)} turn ${turnId}`
}

const BASE85_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~'
const BASE85_DIGITS = new Map([...BASE85_ALPHABET].map((character, index) => [character, index]))

function validateEmbedding(encoded: string, dimensions: number, path: string): void {
  const expectedLength = dimensions * 5
  if (encoded.length !== expectedLength) {
    throw new Error(
      `Hodoscope ${path} encodes ${encoded.length} characters; expected ${expectedLength} for ${dimensions} float32 values`,
    )
  }
  const bytes = new Uint8Array(dimensions * 4)
  for (let group = 0; group < dimensions; group += 1) {
    let value = 0
    const encodedOffset = group * 5
    for (let index = encodedOffset; index < encodedOffset + 5; index += 1) {
      const character = encoded[index]
      const digit = character === undefined ? undefined : BASE85_DIGITS.get(character)
      if (digit === undefined) {
        throw new Error(`Hodoscope ${path} contains invalid RFC 1924 base85 at offset ${index}`)
      }
      value = value * 85 + digit
    }
    if (value > 0xffff_ffff) {
      throw new Error(`Hodoscope ${path} contains an overflowing base85 block at index ${group}`)
    }
    const byteOffset = group * 4
    bytes[byteOffset] = Math.floor(value / 0x1_00_00_00) & 0xff
    bytes[byteOffset + 1] = Math.floor(value / 0x1_00_00) & 0xff
    bytes[byteOffset + 2] = Math.floor(value / 0x1_00) & 0xff
    bytes[byteOffset + 3] = value & 0xff
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const littleEndian = endianness() === 'LE'
  for (let index = 0; index < dimensions; index += 1) {
    if (!Number.isFinite(view.getFloat32(index * 4, littleEndian))) {
      throw new Error(`Hodoscope ${path} contains a non-finite float32 at index ${index}`)
    }
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Hodoscope ${path} must be a non-empty string`)
  }
  return value
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Hodoscope ${path} must be a non-negative safe integer`)
  }
  return value as number
}

function jsonRecord(value: unknown, path: string): Record<string, Json> {
  if (!isObject(value)) throw new Error(`Hodoscope ${path} must be a JSON object`)
  assertJsonValue(value, path)
  return value as Record<string, Json>
}

function assertJsonValue(value: unknown, path: string, depth = 0): asserts value is Json {
  if (depth > 64) throw new Error(`Hodoscope ${path} exceeds the maximum JSON depth of 64`)
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertJsonValue(child, `${path}[${index}]`, depth + 1)
    }
    return
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`, depth + 1)
    }
    return
  }
  throw new Error(`Hodoscope ${path} must contain only finite JSON values`)
}

function jsonEquals(left: Json, right: Json): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEquals(value, right[index]!))
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          jsonEquals(left[key] as Json, right[key] as Json),
      )
    )
  }
  return false
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function parseOpenInferenceRow(value: unknown): OpenInferenceRow {
  if (
    !isObject(value) ||
    typeof value.trace_id !== 'string' ||
    !value.trace_id ||
    typeof value.span_id !== 'string' ||
    !value.span_id ||
    typeof value.name !== 'string' ||
    typeof value.start_time !== 'string' ||
    !isObject(value.status) ||
    !isObject(value.attributes) ||
    (value.parent_span_id !== undefined &&
      value.parent_span_id !== null &&
      typeof value.parent_span_id !== 'string')
  ) {
    throw new TypeError('Hodoscope input must contain complete OpenInference spans')
  }
  return value as unknown as OpenInferenceRow
}

function firstAttribute(rows: readonly OpenInferenceRow[], key: string): string | undefined {
  for (const row of rows) {
    const raw = row.attributes[key]
    const value =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : undefined
    if (value) return value
  }
  return undefined
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numericAttribute(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function jsonValue(value: unknown): Json {
  if (typeof value === 'string') {
    try {
      return toJson(JSON.parse(value))
    } catch {
      return value
    }
  }
  return toJson(value)
}

function toJson(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJson(child)]))
  }
  return String(value ?? '')
}

function stringifyCompact(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}
