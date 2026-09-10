/**
 * `traces ask`: free-form questions over trace sessions, answered by a
 * recursive trace-analysis engine.
 *
 * Each question runs through agent-eval's `runTraceAnalyst` directly instead
 * of the analyst registry. The registry keeps only findings, so it discards
 * the engine's prose answer, and it runs analysts one at a time. Here the
 * questions run concurrently under one shared cost ledger, so a single budget
 * bounds all of them, and every `trace://` citation in an answer is checked
 * against the store before the answer counts as answered.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CostCeilingReachedError, CostLedger, type CostProvenance } from '@tangle-network/agent-eval'
import {
  type AnalystUsageReceipt,
  defineTraceAnalyst,
  type RawAnalystFinding,
  runTraceAnalyst,
  type TraceAnalysisEngine,
  type TraceAnalysisEngineResult,
  type TraceAnalystDefinition,
  type TraceAnalystLimits,
} from '@tangle-network/agent-eval/analyst'
import type { TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { openAgenticTraceStore, writeAnalysisTraceFile } from './analysis-store.js'
import { type AnswerSchema, answerSchemaErrors, assertAnswerSchema, parseJsonAnswer } from './answer-schema.js'
import { indexSessionIdsByTrace } from './attributes.js'
import {
  createFindingRejectionTally,
  type FindingRejectionReasons,
  formatFindingRejections,
  totalFindingRejections,
} from './finding-rejections.js'
import type { OtlpSpan } from './otlp.js'

/** One question to ask of the selected traces. */
export interface TraceQuestion {
  /** Stable ID for the report, the JSON result, and cost attribution. Default: `q<n>`. */
  readonly id?: string
  readonly question: string
  /** Extra guidance for this question only, placed after the shared rules. */
  readonly instructions?: string
  /**
   * JSON Schema the answer must satisfy (see `answer-schema.ts` for the
   * supported subset). With a schema the answer must be one JSON value.
   */
  readonly answerSchema?: AnswerSchema
}

/** Why a question did not produce a checked answer. */
export type TraceQuestionFailureKind =
  | 'error'
  | 'aborted'
  | 'budget-refused'
  | 'no-answer'
  | 'invalid-answer'
  | 'unresolved-citations'

export interface TraceQuestionCitation {
  readonly uri: string
  readonly traceId: string | null
  readonly spanId: string | null
  /** True only when the store holds the cited span. */
  readonly resolved: boolean
}

export interface TraceQuestionAnswer {
  readonly id: string
  readonly question: string
  readonly status: 'answered' | 'failed'
  readonly failure?: { readonly kind: TraceQuestionFailureKind; readonly message: string }
  /** The engine's prose answer, verbatim. Null when the engine returned none. */
  readonly answer: string | null
  /** The answer parsed as JSON, present when the question had an answer schema and it parsed. */
  readonly parsedAnswer?: unknown
  /** Every `trace://` URI in the answer text, with whether it resolved. */
  readonly citations: readonly TraceQuestionCitation[]
  /** Findings the evidence gate accepted. */
  readonly findings: readonly RawAnalystFinding[]
  /** Findings the evidence gate refused, by reason. */
  readonly rejectedFindings: FindingRejectionReasons
  readonly model: string | null
  /** Successful model completions the engine reported; null when the engine failed. */
  readonly modelCalls: number | null
  /** Trace-tool requests the engine reported; null when the engine failed. */
  readonly toolCalls: number | null
  /** Provider usage and cost for this question alone, from the shared ledger. */
  readonly usage: AnalystUsageReceipt | null
  readonly startedAt: string
  readonly endedAt: string
  readonly latencyMs: number
  /** Engine-native steps, retained for audit. */
  readonly trajectory?: readonly unknown[]
}

/** One trace the questions could read. */
export interface TraceQuestionTrace {
  readonly traceId: string
  readonly sessionId: string | null
  readonly spanCount: number
  readonly startTime: string | null
  readonly endTime: string | null
  readonly rootSpan: string | null
}

export interface TraceQuestionsTotals {
  readonly questions: number
  readonly answered: number
  readonly failed: number
  /** Null when at least one question's count is unknown. */
  readonly modelCalls: number | null
  /** Null when at least one question's count is unknown. */
  readonly toolCalls: number | null
  /** Paid provider calls the shared ledger recorded, including failed ones. */
  readonly providerCalls: number
  /** Total spend with its provenance; `uncaptured` carries a null amount, never 0. */
  readonly cost: CostProvenance
  /** Wall time of the whole run. */
  readonly wallTimeMs: number
  /** Sum of the questions' own latencies; above `wallTimeMs` when questions overlapped. */
  readonly questionTimeMs: number
  /** Most questions observed running at the same time. */
  readonly peakConcurrency: number
}

export interface TraceQuestionsResult {
  readonly schemaVersion: 1
  readonly kind: 'traces.ask'
  readonly generatedAt: string
  readonly harness: string
  readonly engine: { readonly id: string; readonly version: string; readonly model: string | null }
  readonly concurrency: number
  /** Shared ceiling across every question; null when uncapped. */
  readonly budgetUsd: number | null
  /** The engine's own ceiling for one question, when it declares one. */
  readonly questionBudgetUsd: number | null
  readonly spanCount: number
  readonly otlpPath: string
  readonly traces: readonly TraceQuestionTrace[]
  readonly questions: readonly TraceQuestionAnswer[]
  readonly totals: TraceQuestionsTotals
  readonly warnings: readonly string[]
  /** True when every question produced an answer whose citations all resolved. */
  readonly ok: boolean
  readonly report: string
}

export interface TraceQuestionsOptions {
  readonly questions: readonly TraceQuestion[]
  readonly spans: readonly OtlpSpan[]
  readonly engine: TraceAnalysisEngine
  readonly harness?: string
  /** Questions running at once. Default 4. */
  readonly concurrency?: number
  /** Shared USD ceiling across every question. Omit for no shared ceiling. */
  readonly budgetUsd?: number
  readonly limits?: Partial<TraceAnalystLimits>
  /** Explicit full-bundle source access for `readSpanSource`. */
  readonly sourceBundle?: { path: string; maxRecordBytes?: number }
  /** Where to write the OpenInference file the engine reads. Default: a temp file. */
  readonly otlpOutPath?: string
  readonly generatedAt?: string
  readonly signal?: AbortSignal
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface TraceQuestionsArtifacts {
  readonly directory: string
  readonly result: string
  readonly report: string
  readonly traces: string
}

export const DEFAULT_ASK_CONCURRENCY = 4

/** Bumped whenever the question layout or rules change. */
const ASK_DEFINITION_VERSION = '1.0.0'

/**
 * DSPy's RLM shows the model a preview of each input: a value longer than
 * 1,000 characters appears as its first and last 500 only. The question
 * therefore stays short and whole, and the rules sit in the first 500
 * characters of the instructions, which is all of them the preview keeps.
 */
const DSPY_PREVIEW_HEAD_CHARS = 500
const QUESTION_FIELD_MAX_CHARS = 900

const ASK_QUESTION_HEADER =
  'Answer QUESTION with the trace tools and follow TRACES ASK RULES in analyst_instructions. ' +
  'The trace list is JSON after PREPARED CONTEXT: there. Cite trace://<trace_id>/span/<span_id>.'

const QUESTION_LABEL = '\n\nQUESTION: '

/** Longest question that keeps the whole question field inside the preview. */
export const MAX_TRACE_QUESTION_CHARS = QUESTION_FIELD_MAX_CHARS - ASK_QUESTION_HEADER.length - QUESTION_LABEL.length

const ASK_RULES = [
  'TRACES ASK RULES',
  '1. Answer QUESTION only from trace tool results retrieved in this run.',
  '2. PREPARED CONTEXT: near the end of analyst_instructions holds JSON listing every trace. Parse it; copy IDs from it or from tool output.',
  '3. Cite each fact as trace://<trace_id>/span/<span_id>. Every cited span must exist.',
  '4. Quote excerpts from viewSpans output, never from searchTrace hits.',
  '5. If the trace does not record a fact, say "not in trace".',
].join('\n')

const ANSWER_SCHEMA_RULE = '6. The answer is one JSON value matching ANSWER SCHEMA below, with no other text.'

/** Traces listed in the prepared context; the rest are counted, not dropped silently. */
const MAX_CONTEXT_TRACES = 200

const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const QUESTION_KEYS = new Set(['id', 'question', 'instructions', 'answerSchema'])

/**
 * Validate questions and assign default IDs. Throws on an empty list, a
 * duplicate or malformed ID, a question too long for the preview, or an answer
 * schema outside the supported subset.
 */
export function normalizeTraceQuestions(questions: readonly TraceQuestion[]): Array<TraceQuestion & { id: string }> {
  if (questions.length === 0) throw new Error('ask needs at least one question')
  const seen = new Set<string>()
  return questions.map((entry, index) => {
    const id = entry.id ?? `q${index + 1}`
    if (!QUESTION_ID.test(id)) {
      throw new Error(`question ID "${id}" must match ${QUESTION_ID} (letters, digits, dot, underscore, hyphen)`)
    }
    if (seen.has(id)) throw new Error(`duplicate question ID "${id}"`)
    seen.add(id)
    const question = typeof entry.question === 'string' ? entry.question.trim() : ''
    if (!question) throw new Error(`question ${id} is empty`)
    if (question.length > MAX_TRACE_QUESTION_CHARS) {
      throw new Error(
        `question ${id} has ${question.length} characters; the limit is ${MAX_TRACE_QUESTION_CHARS} so the ` +
          'model sees it whole. Move detail into the entry\'s "instructions" field.',
      )
    }
    if (entry.instructions !== undefined && typeof entry.instructions !== 'string') {
      throw new Error(`question ${id}: instructions must be a string`)
    }
    if (entry.answerSchema !== undefined) assertAnswerSchema(entry.answerSchema, `question ${id} answerSchema`)
    return {
      id,
      question,
      ...(entry.instructions?.trim() ? { instructions: entry.instructions.trim() } : {}),
      ...(entry.answerSchema !== undefined ? { answerSchema: entry.answerSchema } : {}),
    }
  })
}

/**
 * Read questions from a JSON file: an array, or an object with a `questions`
 * array. Each entry is a question string or an object with `question` and
 * optional `id`, `instructions`, and `answerSchema`. Unknown keys are
 * rejected so a misspelled field cannot be ignored silently.
 */
export async function loadTraceQuestionsFile(path: string): Promise<TraceQuestion[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`questions file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : undefined
  if (!list) throw new Error(`questions file ${path} must hold a JSON array or an object with a "questions" array`)
  return list.map((entry, index) => {
    if (typeof entry === 'string') return { question: entry }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`questions file ${path}: entry ${index + 1} must be a string or an object`)
    }
    for (const key of Object.keys(entry)) {
      if (!QUESTION_KEYS.has(key)) {
        throw new Error(`questions file ${path}: entry ${index + 1} has unknown key "${key}"`)
      }
    }
    const record = entry as Record<string, unknown>
    if (typeof record.question !== 'string') {
      throw new Error(`questions file ${path}: entry ${index + 1} needs a "question" string`)
    }
    if (record.id !== undefined && typeof record.id !== 'string') {
      throw new Error(`questions file ${path}: entry ${index + 1} "id" must be a string`)
    }
    return {
      question: record.question,
      ...(record.id !== undefined ? { id: record.id as string } : {}),
      ...(record.instructions !== undefined ? { instructions: record.instructions as string } : {}),
      ...(record.answerSchema !== undefined ? { answerSchema: record.answerSchema as AnswerSchema } : {}),
    }
  })
}

/** The engine's `question` input: a short header, then the question, whole. */
export function renderTraceQuestionPrompt(question: string): string {
  return `${ASK_QUESTION_HEADER}${QUESTION_LABEL}${question}`
}

/** The definition's instructions: rules first, so the preview keeps them. */
export function renderTraceQuestionInstructions(question: Pick<TraceQuestion, 'instructions' | 'answerSchema'>): string {
  const rules = question.answerSchema ? `${ASK_RULES}\n${ANSWER_SCHEMA_RULE}` : ASK_RULES
  return [
    rules,
    question.instructions ? `QUESTION GUIDANCE:\n${question.instructions}` : '',
    question.answerSchema ? `ANSWER SCHEMA:\n${JSON.stringify(question.answerSchema)}` : '',
  ].filter(Boolean).join('\n\n')
}

/** Characters of the instructions the DSPy preview keeps from the start; the rules must fit. */
export const TRACE_QUESTION_PREVIEW_HEAD_CHARS = DSPY_PREVIEW_HEAD_CHARS

function describeTraces(spans: readonly OtlpSpan[]): TraceQuestionTrace[] {
  const { sessionByTrace } = indexSessionIdsByTrace(spans)
  const byTrace = new Map<string, { count: number; start: number; end: number; root: string | null }>()
  for (const span of spans) {
    const entry = byTrace.get(span.trace_id) ?? { count: 0, start: Infinity, end: -Infinity, root: null }
    entry.count += 1
    const start = Date.parse(span.start_time)
    const end = Date.parse(span.end_time)
    if (Number.isFinite(start)) entry.start = Math.min(entry.start, start)
    if (Number.isFinite(end)) entry.end = Math.max(entry.end, end)
    if (span.parent_span_id === null && entry.root === null) entry.root = span.name
    byTrace.set(span.trace_id, entry)
  }
  return [...byTrace].map(([traceId, entry]) => ({
    traceId,
    sessionId: sessionByTrace.get(traceId) ?? null,
    spanCount: entry.count,
    startTime: Number.isFinite(entry.start) ? new Date(entry.start).toISOString() : null,
    endTime: Number.isFinite(entry.end) ? new Date(entry.end).toISOString() : null,
    rootSpan: entry.root,
  }))
}

function preparedContext(traces: readonly TraceQuestionTrace[]): string {
  return JSON.stringify({
    traces: traces.slice(0, MAX_CONTEXT_TRACES).map((trace) => ({
      trace_id: trace.traceId,
      session_id: trace.sessionId,
      spans: trace.spanCount,
      start: trace.startTime,
      end: trace.endTime,
      root: trace.rootSpan,
    })),
    omitted_traces: Math.max(0, traces.length - MAX_CONTEXT_TRACES),
  })
}

const TRACE_URI = /trace:\/\/[^\s/"'`<>()[\]{}]+\/span\/[^\s/"'`<>()[\]{},;]+/g

/** Every distinct `trace://<trace>/span/<span>` URI in the text, in order. */
export function traceCitationsInText(text: string): Array<{ uri: string; traceId: string | null; spanId: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ uri: string; traceId: string | null; spanId: string | null }> = []
  for (const match of text.matchAll(TRACE_URI)) {
    // Sentence punctuation after a URI is prose, not part of the ID.
    const uri = match[0].replace(/[.:!?]+$/, '')
    if (seen.has(uri)) continue
    seen.add(uri)
    const parts = /^trace:\/\/([^/]+)\/span\/([^/]+)$/.exec(uri)
    let traceId: string | null = null
    let spanId: string | null = null
    if (parts) {
      try {
        traceId = decodeURIComponent(parts[1]!)
        spanId = decodeURIComponent(parts[2]!)
      } catch {
        traceId = null
        spanId = null
      }
    }
    out.push({ uri, traceId, spanId })
  }
  return out
}

async function verifyCitations(
  text: string,
  store: TraceAnalysisStore,
  signal: AbortSignal | undefined,
): Promise<TraceQuestionCitation[]> {
  const citations = traceCitationsInText(text)
  const wanted = new Map<string, Set<string>>()
  for (const citation of citations) {
    if (!citation.traceId || !citation.spanId) continue
    const spans = wanted.get(citation.traceId) ?? new Set<string>()
    spans.add(citation.spanId)
    wanted.set(citation.traceId, spans)
  }
  const found = new Map<string, Set<string>>()
  for (const [traceId, spanIds] of wanted) {
    const existing = await store.hasSpans({ trace_id: traceId, span_ids: [...spanIds] }, signal ? { signal } : undefined)
    found.set(traceId, new Set(existing))
  }
  return citations.map((citation) => ({
    ...citation,
    resolved: Boolean(citation.traceId && citation.spanId && found.get(citation.traceId)?.has(citation.spanId)),
  }))
}

function isBudgetRefusal(error: unknown): boolean {
  if (error instanceof CostCeilingReachedError) return true
  const message = error instanceof Error ? error.message : String(error)
  // The DSPy engine crosses a process boundary, so the class does not survive;
  // these are the ledger's and the model proxy's own refusal texts.
  return /would exceed ceiling|model cost limit reached/.test(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)
}

/**
 * Smallest reservation one model call makes before it runs: its full output and
 * reasoning allowance at the output rate, before any input tokens. Undefined
 * when the engine does not describe its pricing and token caps.
 */
export function engineCallReservationFloorUsd(engine: TraceAnalysisEngine): number | undefined {
  const config = engine.executionConfig
  const pricing = config.pricing as { outputUsdPerMillion?: unknown } | undefined
  const outputRate = pricing?.outputUsdPerMillion
  const maxOutput = config.max_output_tokens
  const maxReasoning = config.max_reasoning_tokens ?? 0
  if (typeof outputRate !== 'number' || typeof maxOutput !== 'number' || typeof maxReasoning !== 'number') {
    return undefined
  }
  return ((maxOutput + maxReasoning) * outputRate) / 1_000_000
}

function formatUsd(value: number): string {
  return `$${value < 0.01 && value > 0 ? value.toPrecision(2) : value.toFixed(2)}`
}

function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

/**
 * Ask every question of the spans, concurrently, under one shared cost
 * ledger. Never throws for a failed question: each failure is recorded on its
 * answer and `ok` turns false. Throws before any model call for invalid
 * questions, options, or a budget below one call's reservation.
 */
export async function runTraceQuestions(opts: TraceQuestionsOptions): Promise<TraceQuestionsResult> {
  if (opts.spans.length === 0) throw new Error('runTraceQuestions: no spans to ask about')
  const questions = normalizeTraceQuestions(opts.questions)
  const concurrency = opts.concurrency ?? DEFAULT_ASK_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be an integer >= 1')
  const budgetUsd = opts.budgetUsd
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    throw new RangeError('budgetUsd must be a positive number')
  }
  const warnings: string[] = []
  const floor = engineCallReservationFloorUsd(opts.engine)
  const effectiveConcurrency = Math.min(concurrency, questions.length)
  if (budgetUsd !== undefined && floor !== undefined) {
    if (budgetUsd < floor) {
      throw new RangeError(
        `budget ${formatUsd(budgetUsd)} is below one model call's reservation of at least ${formatUsd(floor)} ` +
          `for ${opts.engine.model ?? opts.engine.id}; every question would be refused before it ran`,
      )
    }
    if (budgetUsd < floor * effectiveConcurrency) {
      warnings.push(
        `budget ${formatUsd(budgetUsd)} covers at most ${Math.floor(budgetUsd / floor)} concurrent model call(s) ` +
          `at ${formatUsd(floor)} reserved each; questions wait for reservations, and later calls are refused ` +
          'once settled spend leaves less than one reservation',
      )
    }
  }
  opts.signal?.throwIfAborted()

  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const traceFile = await writeAnalysisTraceFile(opts.spans, {
    sourceBundle: opts.sourceBundle,
    otlpOutPath: opts.otlpOutPath,
    signal: opts.signal,
  })
  const store = await openAgenticTraceStore(traceFile)
  const traces = describeTraces(opts.spans)
  const context = preparedContext(traces)
  const runId = `traces-ask-${Date.parse(generatedAt) || Date.now()}`
  const ledger = new CostLedger(budgetUsd)

  let active = 0
  let peakConcurrency = 0
  const askOne = async (question: TraceQuestion & { id: string }): Promise<TraceQuestionAnswer> => {
    const startedAt = new Date()
    const started = performance.now()
    const rejections = createFindingRejectionTally(question.id)
    let usage: AnalystUsageReceipt | null = null
    let completed: TraceAnalysisEngineResult | undefined
    let failure: TraceQuestionAnswer['failure']
    const log = (msg: string, fields?: Record<string, unknown>): void => {
      rejections.record(msg, fields)
      opts.log?.(`[${question.id}] ${msg}`, fields)
    }
    const definition: TraceAnalystDefinition = defineTraceAnalyst({
      // Namespaced so a question ID can never select a built-in kind's subject rules.
      id: `ask.${question.id}`,
      description: `traces ask question ${question.id}`,
      area: 'question',
      version: ASK_DEFINITION_VERSION,
      question: renderTraceQuestionPrompt(question.question),
      instructions: renderTraceQuestionInstructions(question),
      toolGroup: 'all',
      prepareContext: () => context,
      ...(opts.limits ? { limits: opts.limits } : {}),
    })
    if (opts.signal?.aborted) {
      failure = { kind: 'aborted', message: 'run aborted before the question started' }
    } else {
      active += 1
      peakConcurrency = Math.max(peakConcurrency, active)
      try {
        completed = await runTraceAnalyst({
          definition,
          engine: opts.engine,
          store,
          context: {
            runId,
            correlationId: `${runId}:${question.id}`,
            costLedger: ledger,
            costPhase: 'trace-question',
            log,
            recordUsage: (receipt) => {
              usage = receipt
            },
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
        })
      } catch (error) {
        failure = {
          kind: opts.signal?.aborted ? 'aborted' : isBudgetRefusal(error) ? 'budget-refused' : 'error',
          message: errorMessage(error),
        }
      } finally {
        active -= 1
      }
    }

    const answer = completed && completed.answer.trim() ? completed.answer : null
    let parsedAnswer: unknown
    let hasParsedAnswer = false
    let citations: TraceQuestionCitation[] = []
    if (answer !== null) {
      citations = await verifyCitations(answer, store, opts.signal)
      if (question.answerSchema) {
        const parsed = parseJsonAnswer(answer)
        const problems = parsed.ok ? answerSchemaErrors(parsed.value, question.answerSchema) : [parsed.error]
        if (parsed.ok) {
          parsedAnswer = parsed.value
          hasParsedAnswer = true
        }
        if (problems.length > 0 && !failure) {
          failure = { kind: 'invalid-answer', message: problems.slice(0, 5).join('; ') }
        }
      }
      const unresolved = citations.filter((citation) => !citation.resolved)
      if (unresolved.length > 0 && !failure) {
        failure = {
          kind: 'unresolved-citations',
          message: `${unresolved.length} cited span(s) do not exist: ${unresolved.slice(0, 3).map((c) => c.uri).join(', ')}`,
        }
      }
    } else if (completed && !failure) {
      failure = { kind: 'no-answer', message: 'the engine returned an empty answer' }
    }
    const endedAt = new Date()
    return {
      id: question.id,
      question: question.question,
      status: failure ? 'failed' : 'answered',
      ...(failure ? { failure } : {}),
      answer,
      ...(hasParsedAnswer ? { parsedAnswer } : {}),
      citations,
      findings: completed?.findings ?? [],
      rejectedFindings: rejections.counts()[question.id] ?? {},
      model: opts.engine.model ?? null,
      modelCalls: completed?.modelCalls ?? null,
      toolCalls: completed?.toolCalls ?? null,
      usage,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      latencyMs: Math.round(performance.now() - started),
      ...(completed ? { trajectory: completed.trajectory } : {}),
    }
  }

  // A worker pool, not Promise.all: at most `concurrency` engines (each a
  // Python process and a model proxy) exist at once. Unlike the import pool,
  // one failed question never stops the others; its failure is its answer.
  const answers = new Array<TraceQuestionAnswer>(questions.length)
  let next = 0
  const runStarted = performance.now()
  await Promise.all(Array.from({ length: effectiveConcurrency }, async () => {
    while (next < questions.length) {
      const index = next
      next += 1
      answers[index] = await askOne(questions[index]!)
    }
  }))
  const wallTimeMs = Math.round(performance.now() - runStarted)

  const summary = ledger.summary({ channel: 'analyst' })
  const answered = answers.filter((answer) => answer.status === 'answered').length
  const totals: TraceQuestionsTotals = {
    questions: answers.length,
    answered,
    failed: answers.length - answered,
    modelCalls: sumOrNull(answers.map((answer) => answer.modelCalls)),
    toolCalls: sumOrNull(answers.map((answer) => answer.toolCalls)),
    providerCalls: summary.totalCalls + summary.pendingCalls,
    cost: summary.costProvenance,
    wallTimeMs,
    questionTimeMs: answers.reduce((sum, answer) => sum + answer.latencyMs, 0),
    peakConcurrency,
  }
  const partial: Omit<TraceQuestionsResult, 'report'> = {
    schemaVersion: 1,
    kind: 'traces.ask',
    generatedAt,
    harness: opts.harness ?? 'unknown',
    engine: { id: opts.engine.id, version: opts.engine.version, model: opts.engine.model ?? null },
    concurrency,
    budgetUsd: budgetUsd ?? null,
    questionBudgetUsd: typeof opts.engine.executionConfig.max_cost_usd === 'number'
      ? opts.engine.executionConfig.max_cost_usd
      : null,
    spanCount: opts.spans.length,
    otlpPath: traceFile.otlpPath,
    traces,
    questions: answers,
    totals,
    warnings,
    ok: answered === answers.length,
  }
  return { ...partial, report: renderTraceQuestionsReport(partial) }
}

function costText(cost: CostProvenance | undefined | null): string {
  if (!cost) return 'not captured'
  return cost.kind === 'uncaptured' ? 'uncaptured' : `${formatUsd(cost.usd)} ${cost.kind}`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function countText(value: number | null): string {
  return value === null ? 'unknown' : String(value)
}

/** Readable Markdown for a result; the JSON result carries every field. */
export function renderTraceQuestionsReport(result: Omit<TraceQuestionsResult, 'report'>): string {
  const { totals } = result
  const lines = ['# traces ask', '']
  lines.push(
    `${totals.questions} question(s) over ${result.traces.length} trace(s) (${result.spanCount} spans, ${result.harness}). ` +
      `Engine \`${result.engine.id}\`${result.engine.model ? `, model \`${result.engine.model}\`` : ''}; ` +
      `concurrency ${result.concurrency}; budget ${result.budgetUsd === null ? 'uncapped' : `${formatUsd(result.budgetUsd)} shared`}` +
      `${result.questionBudgetUsd === null ? '' : `, ${formatUsd(result.questionBudgetUsd)} per question`}.`,
  )
  lines.push('')
  lines.push(
    `**${totals.answered} answered, ${totals.failed} failed.** Wall time ${seconds(totals.wallTimeMs)} ` +
      `against ${seconds(totals.questionTimeMs)} of question time (peak ${totals.peakConcurrency} at once). ` +
      `Cost ${costText(totals.cost)} over ${totals.providerCalls} provider call(s); ` +
      `${countText(totals.modelCalls)} model call(s), ${countText(totals.toolCalls)} tool call(s).`,
  )
  lines.push('')
  for (const warning of result.warnings) {
    lines.push(`> Warning: ${warning}`)
    lines.push('')
  }
  lines.push('| ID | Status | Citations | Rejected findings | Model calls | Tool calls | Cost | Time |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const answer of result.questions) {
    const resolved = answer.citations.filter((citation) => citation.resolved).length
    lines.push(
      `| \`${cell(answer.id)}\` | ${answer.status === 'answered' ? 'answered' : `failed: ${answer.failure?.kind}`} | ` +
        `${resolved}/${answer.citations.length} resolved | ${totalFindingRejections(answer.rejectedFindings)} | ` +
        `${countText(answer.modelCalls)} | ${countText(answer.toolCalls)} | ${costText(answer.usage?.cost)} | ` +
        `${seconds(answer.latencyMs)} |`,
    )
  }
  lines.push('')
  for (const answer of result.questions) {
    lines.push(`## ${answer.id}: ${answer.question}`)
    lines.push('')
    if (answer.failure) {
      lines.push(`**Failed (${answer.failure.kind}):** ${answer.failure.message.trim()}`)
      lines.push('')
    }
    if (answer.answer !== null) {
      lines.push(answer.answer.trim())
      lines.push('')
    }
    const notes: string[] = []
    const unresolved = answer.citations.filter((citation) => !citation.resolved)
    if (answer.citations.length > 0) {
      notes.push(
        `- **Citations:** ${answer.citations.length - unresolved.length} of ${answer.citations.length} resolve to a span in the trace.`,
      )
      for (const citation of unresolved) notes.push(`- **Unresolved:** ${citation.uri}`)
    } else if (answer.answer !== null) {
      notes.push('- **Citations:** none in the answer text.')
    }
    if (answer.findings.length > 0) {
      notes.push(`- **Accepted findings:** ${answer.findings.length}`)
      for (const finding of answer.findings.slice(0, 5)) notes.push(`  - ${finding.severity}: ${finding.claim}`)
    }
    const rejected = formatFindingRejections(answer.rejectedFindings)
    if (rejected) notes.push(`- **Rejected by the evidence gate:** ${rejected}`)
    if (notes.length > 0) lines.push(...notes, '')
  }
  return lines.join('\n')
}

/** Write `answers.json` and `report.md` next to the trace file the engine read. */
export async function writeTraceQuestionsArtifacts(
  result: TraceQuestionsResult,
  outDir: string,
): Promise<TraceQuestionsArtifacts> {
  const directory = resolve(outDir)
  await mkdir(directory, { recursive: true })
  const paths: TraceQuestionsArtifacts = {
    directory,
    result: join(directory, 'answers.json'),
    report: join(directory, 'report.md'),
    traces: result.otlpPath,
  }
  const { report, ...machine } = result
  await Promise.all([
    writeFile(paths.result, `${JSON.stringify(machine, null, 2)}\n`, 'utf8'),
    writeFile(paths.report, report, 'utf8'),
  ])
  return paths
}
