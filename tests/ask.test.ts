import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  TraceAnalysisEngine,
  TraceAnalysisEngineRequest,
  TraceAnalysisEngineResult,
} from '@tangle-network/agent-eval/analyst'
import { describe, expect, it } from 'vitest'
import {
  loadTraceQuestionsFile,
  MAX_TRACE_QUESTION_CHARS,
  normalizeTraceQuestions,
  renderTraceQuestionInstructions,
  runTraceQuestions,
  TRACE_QUESTION_PREVIEW_HEAD_CHARS,
  traceCitationsInText,
  writeTraceQuestionsArtifacts,
} from '../src/ask.js'
import { answerSchemaErrors, assertAnswerSchema, parseJsonAnswer } from '../src/answer-schema.js'
import { type OtlpSpan, span } from '../src/otlp.js'

const TRACE = 'trace-ask'
const COMMAND = 'git status --short && pnpm test'

/** A small synthetic session: one prompt, one shell command, one reply. */
function fixtureSpans(): OtlpSpan[] {
  const base = Date.parse('2026-02-01T10:00:00.000Z')
  const at = (seconds: number) => new Date(base + seconds * 1000).toISOString()
  return [
    span({
      traceId: TRACE,
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: at(0),
      endTime: at(30),
      service: 'synthetic',
      extra: { 'session.id': 'session-ask' },
    }),
    span({
      traceId: TRACE,
      spanId: 'prompt-1',
      parentSpanId: 'root',
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: at(1),
      service: 'synthetic',
      content: 'Run the unit tests and tell me whether they pass.',
    }),
    span({
      traceId: TRACE,
      spanId: 'tool-1',
      parentSpanId: 'root',
      name: 'tool.exec_command',
      kind: 'TOOL',
      startTime: at(5),
      endTime: at(9),
      service: 'synthetic',
      tool: 'exec_command',
      extra: { 'input.value': JSON.stringify({ cmd: COMMAND }), 'output.value': '12 passed' },
    }),
    span({
      traceId: TRACE,
      spanId: 'reply-1',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: at(10),
      service: 'synthetic',
      content: 'All 12 unit tests passed.',
    }),
  ]
}

type Script = (request: TraceAnalysisEngineRequest) => Promise<Partial<TraceAnalysisEngineResult>>

/** A fake engine that runs a script per request and records every request. */
function scriptedEngine(script: Script, executionConfig: Record<string, unknown> = {}) {
  const requests: TraceAnalysisEngineRequest[] = []
  const engine: TraceAnalysisEngine = {
    id: 'scripted-test-engine',
    description: 'Runs a test script instead of a model.',
    model: 'test-model',
    version: '1.0.0',
    executionConfig,
    async analyze(request) {
      requests.push(request)
      const result = await script(request)
      return {
        answer: '',
        findings: [],
        trajectory: [],
        modelCalls: 1,
        toolCalls: 0,
        runtime: {},
        ...result,
      }
    },
  }
  return { engine, requests }
}

function tool(request: TraceAnalysisEngineRequest, name: string) {
  const found = request.tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`tool ${name} was not offered`)
  return found
}

function questionId(request: TraceAnalysisEngineRequest): string {
  return request.analystId.replace(/^ask\./, '')
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await sleep(5)
  }
}

describe('runTraceQuestions', () => {
  it('keeps each answer verbatim, verifies its citations, and writes both artifacts', async () => {
    const { engine } = scriptedEngine(async (request) => {
      // The engine reads through the real tool handler it was given.
      const viewed = await tool(request, 'viewSpans').handler({ trace_id: TRACE, span_ids: ['tool-1'] }) as {
        spans: Array<{ span_id: string }>
      }
      expect(viewed.spans.map((entry) => entry.span_id)).toEqual(['tool-1'])
      return {
        answer: `The session ran \`${COMMAND}\` once (trace://${TRACE}/span/tool-1).`,
        findings: [{
          severity: 'info',
          claim: 'The unit tests ran once.',
          confidence: 0.9,
          evidence: [{ uri: `trace://${TRACE}/span/tool-1`, excerpt: 'git status --short' }],
        }],
        toolCalls: 1,
      }
    })
    const dir = await mkdtemp(join(tmpdir(), 'traces-ask-test-'))
    const result = await runTraceQuestions({
      questions: [{ id: 'commands', question: 'Which shell commands ran?' }],
      spans: fixtureSpans(),
      engine,
      harness: 'synthetic',
      otlpOutPath: join(dir, 'traces.otlp.jsonl'),
    })

    expect(result.ok).toBe(true)
    const [answer] = result.questions
    expect(answer!.status).toBe('answered')
    expect(answer!.answer).toBe(`The session ran \`${COMMAND}\` once (trace://${TRACE}/span/tool-1).`)
    expect(answer!.citations).toEqual([{ uri: `trace://${TRACE}/span/tool-1`, traceId: TRACE, spanId: 'tool-1', resolved: true }])
    expect(answer!.findings).toHaveLength(1)
    expect(answer!.modelCalls).toBe(1)
    expect(answer!.toolCalls).toBe(1)
    expect(answer!.model).toBe('test-model')
    expect(result.traces).toEqual([expect.objectContaining({ traceId: TRACE, sessionId: 'session-ask', spanCount: 4 })])

    const artifacts = await writeTraceQuestionsArtifacts(result, dir)
    const saved = JSON.parse(await readFile(artifacts.result, 'utf8')) as typeof result
    expect(saved.questions[0]!.answer).toBe(answer!.answer)
    expect(saved).not.toHaveProperty('report')
    expect(await readFile(artifacts.report, 'utf8')).toContain(answer!.answer!)
  })

  it('never runs more questions at once than the concurrency limit', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>()
    const started: string[] = []
    let running = 0
    let peak = 0
    const { engine } = scriptedEngine(async (request) => {
      const id = questionId(request)
      started.push(id)
      running += 1
      peak = Math.max(peak, running)
      const gate = deferred()
      gates.set(id, gate)
      await gate.promise
      running -= 1
      return { answer: `answer ${id}` }
    })
    const run = runTraceQuestions({
      questions: ['one', 'two', 'three', 'four', 'five'].map((question) => ({ question: `Question ${question}?` })),
      spans: fixtureSpans(),
      engine,
      concurrency: 3,
    })

    await until(() => started.length === 3)
    await sleep(50)
    // Two questions wait until a running one finishes.
    expect(started).toEqual(['q1', 'q2', 'q3'])
    gates.get('q2')!.resolve()
    await until(() => started.length === 4)
    await sleep(50)
    expect(started).toHaveLength(4)
    for (const id of ['q1', 'q3']) gates.get(id)!.resolve()
    await until(() => started.length === 5)
    for (const id of ['q4', 'q5']) gates.get(id)!.resolve()

    const result = await run
    expect(peak).toBe(3)
    expect(result.totals.peakConcurrency).toBe(3)
    expect(result.questions.map((answer) => answer.answer)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => `answer ${id}`))
  })

  it('overlaps questions, so wall time stays well below the sum of question times', async () => {
    const { engine } = scriptedEngine(async (request) => {
      await sleep(200)
      return { answer: `answer ${questionId(request)}` }
    })
    const result = await runTraceQuestions({
      questions: Array.from({ length: 6 }, (_, index) => ({ question: `Question ${index + 1}?` })),
      spans: fixtureSpans(),
      engine,
      concurrency: 6,
    })
    expect(result.ok).toBe(true)
    // Six 200 ms questions: serial would take 1.2 s or more.
    expect(result.totals.questionTimeMs).toBeGreaterThanOrEqual(1_200)
    expect(result.totals.wallTimeMs).toBeLessThan(result.totals.questionTimeMs / 2)
    expect(result.totals.peakConcurrency).toBe(6)
    expect(result.report).toMatch(/Wall time \d+\.\d s against \d+\.\d s of question time \(peak 6 at once\)/)
  })

  it('reports questions the shared ledger refused while the others keep their answers', async () => {
    const { engine } = scriptedEngine(async (request) => {
      // One metered call per question: reserve $0.40, settle at $0.30.
      const paid = await request.costLedger.runPaidCall({
        channel: 'analyst',
        phase: request.costPhase,
        actor: request.analystId,
        ...(request.costTags ? { tags: request.costTags } : {}),
        maximumCharge: { externallyEnforcedMaximumUsd: 0.4 },
        execute: async () => {
          await sleep(20)
          return 'ok'
        },
        receipt: () => ({ model: 'test-model', inputTokens: 100, outputTokens: 50, actualCostUsd: 0.3 }),
      })
      if (!paid.succeeded) throw paid.error
      return { answer: `answer ${questionId(request)}` }
    })
    const result = await runTraceQuestions({
      questions: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index + 1}?` })),
      spans: fixtureSpans(),
      engine,
      concurrency: 5,
      budgetUsd: 1,
    })

    // $1 admits three $0.30 calls; after them, $0.10 is left and a $0.40 reservation is refused.
    const answered = result.questions.filter((answer) => answer.status === 'answered')
    const refused = result.questions.filter((answer) => answer.failure?.kind === 'budget-refused')
    expect(answered).toHaveLength(3)
    expect(refused).toHaveLength(2)
    for (const answer of refused) {
      expect(answer.failure!.message).toContain('would exceed ceiling 1')
      expect(answer.answer).toBeNull()
    }
    for (const answer of answered) expect(answer.usage?.cost).toEqual({ kind: 'observed', usd: 0.3 })
    expect(result.ok).toBe(false)
    expect(result.totals.cost.usd).toBeCloseTo(0.9, 10)
    expect(result.totals.cost.usd!).toBeLessThanOrEqual(1)
    expect(result.report).toContain('failed: budget-refused')
  })

  it('refuses to start when the budget cannot cover one model call', async () => {
    const { engine, requests } = scriptedEngine(async () => ({ answer: 'never' }), {
      pricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
      max_output_tokens: 8_192,
      max_reasoning_tokens: 32_768,
    })
    await expect(runTraceQuestions({
      questions: [{ question: 'Anything?' }],
      spans: fixtureSpans(),
      engine,
      budgetUsd: 0.1,
    })).rejects.toThrow(/below one model call's reservation of at least \$0\.41/)
    expect(requests).toHaveLength(0)
  })

  it('warns when the budget serializes concurrent questions', async () => {
    const { engine } = scriptedEngine(async () => ({ answer: 'fine' }), {
      pricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
      max_output_tokens: 8_192,
      max_reasoning_tokens: 32_768,
    })
    const result = await runTraceQuestions({
      questions: Array.from({ length: 4 }, (_, index) => ({ question: `Question ${index + 1}?` })),
      spans: fixtureSpans(),
      engine,
      concurrency: 4,
      budgetUsd: 1,
    })
    expect(result.warnings).toEqual([expect.stringContaining('covers at most 2 concurrent model call(s)')])
    expect(result.report).toContain('> Warning: budget $1.00 covers at most 2')
  })

  it('keeps the other answers when one engine call throws, and marks the run failed', async () => {
    const { engine } = scriptedEngine(async (request) => {
      if (questionId(request) === 'q3') throw new Error('synthetic engine failure')
      return { answer: `answer ${questionId(request)}` }
    })
    const result = await runTraceQuestions({
      questions: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index + 1}?` })),
      spans: fixtureSpans(),
      engine,
      concurrency: 2,
    })
    expect(result.ok).toBe(false)
    expect(result.totals).toMatchObject({ answered: 4, failed: 1, modelCalls: null })
    const failed = result.questions.find((answer) => answer.id === 'q3')!
    expect(failed.failure).toEqual({ kind: 'error', message: 'Error: synthetic engine failure' })
    expect(failed.modelCalls).toBeNull()
    expect(result.questions.filter((answer) => answer.id !== 'q3').map((answer) => answer.answer))
      .toEqual(['answer q1', 'answer q2', 'answer q4', 'answer q5'])
  })

  it('fails an answer that cites a span the trace does not hold', async () => {
    const { engine } = scriptedEngine(async () => ({
      answer: `Tests ran at trace://${TRACE}/span/tool-1 and trace://${TRACE}/span/invented-span.`,
    }))
    const result = await runTraceQuestions({
      questions: [{ question: 'When did the tests run?' }],
      spans: fixtureSpans(),
      engine,
    })
    const [answer] = result.questions
    expect(answer!.status).toBe('failed')
    expect(answer!.failure?.kind).toBe('unresolved-citations')
    expect(answer!.answer).toContain('invented-span')
    expect(answer!.citations.map((citation) => [citation.spanId, citation.resolved])).toEqual([
      ['tool-1', true],
      ['invented-span', false],
    ])
    expect(result.report).toContain(`**Unresolved:** trace://${TRACE}/span/invented-span`)
  })

  it('fails an empty answer', async () => {
    const { engine } = scriptedEngine(async () => ({ answer: '   ' }))
    const result = await runTraceQuestions({ questions: [{ question: 'Anything?' }], spans: fixtureSpans(), engine })
    expect(result.questions[0]!.failure?.kind).toBe('no-answer')
    expect(result.questions[0]!.answer).toBeNull()
  })

  it('shows the evidence gate\'s rejection reasons for each question', async () => {
    const { engine } = scriptedEngine(async () => ({
      answer: `One command ran (trace://${TRACE}/span/tool-1).`,
      findings: [{
        severity: 'low',
        claim: 'The session deleted the build directory.',
        confidence: 0.8,
        evidence: [{ uri: `trace://${TRACE}/span/tool-1`, excerpt: 'rm -rf build directory' }],
      }],
    }))
    const result = await runTraceQuestions({ questions: [{ question: 'What ran?' }], spans: fixtureSpans(), engine })
    const [answer] = result.questions
    expect(answer!.status).toBe('answered')
    expect(answer!.findings).toHaveLength(0)
    expect(answer!.rejectedFindings).toEqual({ 'excerpt is not present in the cited span content': 1 })
    expect(result.report).toContain(
      '**Rejected by the evidence gate:** 1 finding(s) rejected: excerpt is not present in the cited span content ×1',
    )
  })

  it('parses a schema-bound answer and fails one that breaks the schema', async () => {
    const schema = {
      type: 'object',
      properties: { commands: { type: 'integer' }, first: { type: 'string' } },
      required: ['commands', 'first'],
      additionalProperties: false,
    }
    const { engine } = scriptedEngine(async (request) => ({
      answer: questionId(request) === 'good'
        ? '```json\n{"commands": 1, "first": "git status --short"}\n```'
        : '{"commands": "one"}',
    }))
    const result = await runTraceQuestions({
      questions: [
        { id: 'good', question: 'How many commands ran, and which was first?', answerSchema: schema },
        { id: 'bad', question: 'How many commands ran, and which was first?', answerSchema: schema },
      ],
      spans: fixtureSpans(),
      engine,
    })
    const [good, bad] = result.questions
    expect(good!.status).toBe('answered')
    expect(good!.parsedAnswer).toEqual({ commands: 1, first: 'git status --short' })
    expect(bad!.failure?.kind).toBe('invalid-answer')
    expect(bad!.failure?.message).toBe('$.first: required property is missing; $.commands: expected integer, got string')
  })
})

describe('question layout for the DSPy preview', () => {
  it('keeps the question whole and the rules inside the first 500 characters of the instructions', async () => {
    const longest = 'x'.repeat(MAX_TRACE_QUESTION_CHARS)
    const { engine, requests } = scriptedEngine(async () => ({ answer: 'noted' }))
    await runTraceQuestions({
      questions: [
        { id: 'plain', question: longest },
        {
          id: 'typed',
          question: 'How many commands ran?',
          instructions: 'Count only shell commands.',
          answerSchema: { type: 'object', properties: { count: { type: 'integer' } } },
        },
      ],
      spans: fixtureSpans(),
      engine,
    })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.question.length).toBeLessThanOrEqual(1_000)
      const head = request.instructions.slice(0, TRACE_QUESTION_PREVIEW_HEAD_CHARS)
      expect(head).toContain('TRACES ASK RULES')
      expect(head).toContain('5. If the trace does not record a fact, say "not in trace".')
      // The trace list reaches the model after the rules, as parseable JSON.
      const context = request.instructions.split('PREPARED CONTEXT:\n')[1]!.split('\n\n')[0]!
      expect(JSON.parse(context)).toMatchObject({ traces: [{ trace_id: TRACE, session_id: 'session-ask', spans: 4 }], omitted_traces: 0 })
    }
    const plain = requests.find((request) => request.analystId === 'ask.plain')!
    expect(plain.question.endsWith(`QUESTION: ${longest}`)).toBe(true)
    const typed = requests.find((request) => request.analystId === 'ask.typed')!
    expect(typed.instructions.slice(0, TRACE_QUESTION_PREVIEW_HEAD_CHARS)).toContain('6. The answer is one JSON value matching ANSWER SCHEMA')
    expect(typed.instructions).toContain('QUESTION GUIDANCE:\nCount only shell commands.')
    expect(renderTraceQuestionInstructions({})).not.toContain('ANSWER SCHEMA')
  })

  it('rejects a question the preview would cut, before any engine call', () => {
    expect(() => normalizeTraceQuestions([{ question: 'y'.repeat(MAX_TRACE_QUESTION_CHARS + 1) }]))
      .toThrow(/the limit is \d+ so the model sees it whole/)
  })
})

describe('question input', () => {
  it('reads strings and objects from a questions file and rejects unknown keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-ask-questions-'))
    const good = join(dir, 'questions.json')
    await writeFile(good, JSON.stringify({
      questions: [
        'Which commands failed?',
        { id: 'last-turn', question: 'What was the last human turn?', answerSchema: { type: 'string' } },
      ],
    }), 'utf8')
    expect(await loadTraceQuestionsFile(good)).toEqual([
      { question: 'Which commands failed?' },
      { id: 'last-turn', question: 'What was the last human turn?', answerSchema: { type: 'string' } },
    ])

    const typo = join(dir, 'typo.json')
    await writeFile(typo, JSON.stringify([{ question: 'Anything?', schema: { type: 'string' } }]), 'utf8')
    await expect(loadTraceQuestionsFile(typo)).rejects.toThrow('entry 1 has unknown key "schema"')
  })

  it('assigns default IDs and rejects duplicates', () => {
    expect(normalizeTraceQuestions([{ question: ' a? ' }, { question: 'b?' }]).map((entry) => [entry.id, entry.question]))
      .toEqual([['q1', 'a?'], ['q2', 'b?']])
    expect(() => normalizeTraceQuestions([{ id: 'x', question: 'a?' }, { id: 'x', question: 'b?' }]))
      .toThrow('duplicate question ID "x"')
    expect(() => normalizeTraceQuestions([])).toThrow('at least one question')
  })

  it('extracts trace citations without trailing punctuation', () => {
    expect(traceCitationsInText('See trace://t%2F1/span/abc. Also (trace://t2/span/def), trace://t2/span/def.'))
      .toEqual([
        { uri: 'trace://t%2F1/span/abc', traceId: 't/1', spanId: 'abc' },
        { uri: 'trace://t2/span/def', traceId: 't2', spanId: 'def' },
      ])
  })
})

describe('answer schemas', () => {
  it('rejects keywords it cannot check instead of ignoring them', () => {
    expect(() => assertAnswerSchema({ type: 'string', pattern: '^PR' })).toThrow('unsupported JSON Schema keyword "pattern"')
    expect(() => assertAnswerSchema({ type: 'object', properties: { n: { minimum: 1 } } }))
      .toThrow('answerSchema.properties.n: unsupported JSON Schema keyword "minimum"')
  })

  it('checks types, required properties, enums, and array items', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { pr: { type: 'integer' }, state: { enum: ['merged', 'closed'] } },
        required: ['pr'],
      },
    }
    expect(answerSchemaErrors([{ pr: 3, state: 'merged' }], schema)).toEqual([])
    expect(answerSchemaErrors([{ pr: 3.5 }, { state: 'open' }], schema)).toEqual([
      '$[0].pr: expected integer, got number',
      '$[1].pr: required property is missing',
      '$[1].state: expected one of "merged", "closed"',
    ])
    expect(parseJsonAnswer('The answer is 3')).toEqual({ ok: false, error: 'answer is not one JSON value' })
  })
})
