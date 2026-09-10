/**
 * The deterministic session-facts sheet, checked against a fixture whose gold
 * is written by hand.
 *
 * The measured failure this replaces: over twelve private audit sessions, the
 * model-backed analyst scored a deterministic mean of 0.389 while the same
 * facts, extracted mechanically from the spans the run already wrote, scored
 * 0.858. Nothing was missing from the spans — no tool returned an exact count,
 * so the model added up a capped name histogram and guessed. These tests hold
 * the extraction to exactness on a session it can be checked against by eye.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRACE_ANALYST_KINDS,
  defineTraceAnalyst,
  type TraceAnalysisEngine,
  type TraceAnalysisEngineRequest,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval/analyst'
import type { TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import {
  buildSessionFactsReport,
  computeSessionFacts,
  PREPARED_CONTEXT_BYTE_CEILING,
  renderSessionFacts,
  renderSessionFactsContext,
  SESSION_FACTS_VERSION_SUFFIX,
  SESSION_TOKEN_TOTAL_ATTR,
  sessionFactsContext,
  withSessionFactsContext,
} from '../src/session-facts.js'
import { SYNTHESIZED_SPAN_ATTR } from '../src/adapters/provenance.js'
import { analyzeSpans } from '../src/analyze.js'
import { serializeSpans } from '../src/otlp.js'
import {
  FIXTURE_AGENT_PATH,
  FIXTURE_CHANGED_FILES,
  FIXTURE_FINAL_ASSISTANT,
  FIXTURE_FINAL_SUBAGENT_TEXT,
  FIXTURE_FIRST_RECORD_AT,
  FIXTURE_HUMAN_TURNS,
  FIXTURE_LAST_RECORD_AT,
  FIXTURE_SESSION_ID,
  FIXTURE_TOKEN_TOTAL,
  fixtureRecords,
  fixtureSpans,
} from './session-facts-fixture.js'

const execFileAsync = promisify(execFile)

/** The trace-tool byte ceiling every benchmark session exceeded. */
const VIEW_TRACE_BYTE_CEILING = 150_000

describe('session facts', () => {
  it('states every field exactly, against a hand-written gold', async () => {
    const spans = await fixtureSpans()
    const [facts, ...rest] = computeSessionFacts(spans)
    expect(rest).toEqual([])
    expect(facts!.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(facts!.harness).toBe('codex')

    // Four calls the agent made: two shells, one patch, one spawn.
    expect(facts!.toolCalls.value).toBe(4)
    expect(facts!.toolCalls.unavailable).toBeNull()
    expect(facts!.toolCallsByName.value).toEqual({
      'apply_patch': 1,
      'exec_command': 1,
      'exec_command.verify': 1,
      'spawn_agent': 1,
    })

    expect(facts!.subagents.value).toHaveLength(1)
    expect(facts!.subagents.value?.[0]?.taskName).toBe(FIXTURE_AGENT_PATH)
    expect(facts!.subagents.value?.[0]?.taskNameUnavailable).toBeNull()

    expect(facts!.humanTurns.value?.map((turn) => turn.text)).toEqual([...FIXTURE_HUMAN_TURNS])
    expect(facts!.humanTurns.value?.map((turn) => turn.actor)).toEqual(['human', 'human'])
    expect(facts!.humanTurns.value?.map((turn) => turn.at)).toEqual([
      '2026-09-09T12:00:02.000Z',
      '2026-09-09T12:00:16.000Z',
    ])
    expect(facts!.turnsByActor.value).toEqual([
      { actor: 'human', turns: 2, spanIds: facts!.humanTurns.value!.map((turn) => turn.spanId) },
    ])

    // The session's own last word, and the subagent's, kept apart: both stream
    // under one root, and picking "the last message" across both is how the
    // measured run returned a subagent's report as the session's answer.
    expect(facts!.finalMessages.value).toEqual([
      expect.objectContaining({ task: null, text: FIXTURE_FINAL_ASSISTANT }),
      expect.objectContaining({ task: FIXTURE_AGENT_PATH, text: FIXTURE_FINAL_SUBAGENT_TEXT }),
    ])

    expect(facts!.changedFiles.value?.map((file) => ({ path: file.path, operations: file.operations })))
      .toEqual(FIXTURE_CHANGED_FILES.map((file) => ({ path: file.path, operations: [...file.operations] })))

    expect(facts!.firstRecordAt.value).toBe(FIXTURE_FIRST_RECORD_AT)
    expect(facts!.lastRecordAt.value).toBe(FIXTURE_LAST_RECORD_AT)
  })

  it('names a real span for every fact it states', async () => {
    const spans = await fixtureSpans()
    const known = new Set(spans.map((span) => span.span_id))
    const [facts] = computeSessionFacts(spans)
    const cited = [
      ...facts!.toolCalls.spanIds,
      ...facts!.subagents.spanIds,
      ...facts!.humanTurns.spanIds,
      ...facts!.finalMessages.spanIds,
      ...facts!.changedFiles.spanIds,
      ...facts!.firstRecordAt.spanIds,
      ...facts!.lastRecordAt.spanIds,
    ]
    expect(cited.length).toBeGreaterThan(0)
    for (const spanId of cited) expect(known.has(spanId)).toBe(true)
  })

  it('says why a fact the spans cannot support is null, instead of guessing', async () => {
    const spans = await fixtureSpans()
    // A trace from an adapter that does not record the harness's cumulative
    // total. Summing the per-turn deltas would answer a different question, so
    // the sheet says so rather than reporting the smaller number.
    for (const span of spans) delete span.attributes[SESSION_TOKEN_TOTAL_ATTR]
    const [facts] = computeSessionFacts(spans)
    expect(facts!.tokenTotal.value).toBeNull()
    expect(facts!.tokenTotal.unavailable).toContain(SESSION_TOKEN_TOTAL_ATTR)
    expect(facts!.tokenTotal.spanIds).toEqual([])
  })

  it('reports the harness token total the adapter recorded', async () => {
    const spans = await fixtureSpans()
    const [facts] = computeSessionFacts(spans)
    expect(facts!.tokenTotal.value).toBe(FIXTURE_TOKEN_TOTAL)
    expect(facts!.tokenTotal.unavailable).toBeNull()
    expect(facts!.tokenTotal.spanIds).toHaveLength(1)
  })

  it('reports the harness token total once a span carries it', async () => {
    const spans = await fixtureSpans()
    const root = spans.find((span) => span.parent_span_id === null)!
    root.attributes[SESSION_TOKEN_TOTAL_ATTR] = 17_025_686
    const [facts] = computeSessionFacts(spans)
    expect(facts!.tokenTotal.value).toBe(17_025_686)
    expect(facts!.tokenTotal.unavailable).toBeNull()
    expect(facts!.tokenTotal.spanIds).toEqual([root.span_id])
  })

  it('does not let a synthesized subagent span inflate the tool count', async () => {
    const spans = await fixtureSpans()
    // The adapter now marks a subagent's lifecycle span as synthesized and
    // keeps it out of the TOOL kind, so a plain span-kind count is already
    // right here: four calls, four TOOL spans.
    const toolSpans = spans.filter((span) => span.attributes['openinference.span.kind'] === 'TOOL')
    expect(toolSpans).toHaveLength(4)
    const lifecycle = spans.find((span) => span.attributes[SYNTHESIZED_SPAN_ATTR] === true)!
    expect(lifecycle.attributes['openinference.span.kind']).not.toBe('TOOL')

    const [facts] = computeSessionFacts(spans)
    expect(facts!.toolCalls.value).toBe(4)
    expect(facts!.synthesizedToolSpans.value).toBe(0)

    // A trace exported before that fix still carries the lifecycle span as a
    // TOOL call named `Agent`. The sheet must keep counting it out, which is
    // the whole reason the exclusion is a field rather than an adapter detail.
    const legacy = [
      ...spans,
      { ...lifecycle, span_id: `${lifecycle.span_id}-legacy`, name: 'tool.Agent',
        attributes: { ...lifecycle.attributes, 'openinference.span.kind': 'TOOL', 'tool.name': 'Agent' } },
    ]
    const [legacyFacts] = computeSessionFacts(legacy)
    expect(legacyFacts!.toolCalls.value).toBe(4)
    expect(legacyFacts!.synthesizedToolSpans.value).toBe(1)
    expect(legacyFacts!.toolCallsByName.value).not.toHaveProperty('Agent')
    expect(legacyFacts!.toolCalls.spanIds).not.toContain(legacyFacts!.synthesizedToolSpans.spanIds[0])
  })

  it('stays exact on a session larger than the trace tools can return', async () => {
    const spans = await fixtureSpans(400)
    // `viewTrace` degrades to a ≤20-entry name histogram above this many bytes,
    // which is the surface the measured analyst had to count from.
    expect(Buffer.byteLength(serializeSpans(spans))).toBeGreaterThan(VIEW_TRACE_BYTE_CEILING)

    const [facts] = computeSessionFacts(spans)
    expect(facts!.toolCalls.value).toBe(404)
    expect(facts!.synthesizedToolSpans.value).toBe(0)
    expect(facts!.toolCallsByName.value).toEqual({
      'apply_patch': 1,
      'exec_command': 401,
      'exec_command.verify': 1,
      'spawn_agent': 1,
    })
    expect(facts!.humanTurns.value).toHaveLength(2)
    expect(facts!.finalMessages.value?.[0]?.text).toBe(FIXTURE_FINAL_ASSISTANT)
    expect(facts!.changedFiles.value?.map((file) => file.path))
      .toEqual(FIXTURE_CHANGED_FILES.map((file) => file.path))
  })

  it('renders a short readable form and a machine-readable report', async () => {
    const spans = await fixtureSpans()
    const report = buildSessionFactsReport(spans, { harness: 'codex', generatedAt: '2026-09-09T12:30:00.000Z' })
    expect(report.kind).toBe('traces.session_facts_report')
    expect(report.sessions).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({ schemaVersion: 1, harness: 'codex' })

    const text = renderSessionFacts(report)
    expect(text).toContain('tool calls: 4 (0 synthesized span(s) excluded)')
    expect(text).toContain(`subagents: 1: ${FIXTURE_AGENT_PATH}`)
    expect(text).toContain('human turns: 2')
    expect(text).toContain(`token total: ${FIXTURE_TOKEN_TOTAL}`)
    expect(text).toContain('pull requests: 0 created, 0 merged')
  })
})

describe('session facts as prepared context', () => {
  it('stays inside its byte bound and keeps the counts when it must shed', async () => {
    const spans = await fixtureSpans(400)
    const context = sessionFactsContext(spans)!
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(PREPARED_CONTEXT_BYTE_CEILING)
    // Under the documented per-call ceiling the analyst tools work to.
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(VIEW_TRACE_BYTE_CEILING)
    const body = JSON.parse(context.slice(context.indexOf('\n') + 1)) as {
      sessions: Array<{ tool_calls: { count: number; synthesized_excluded: number } }>
      omitted_fields?: string[]
    }
    expect(body.sessions[0]!.tool_calls.count).toBe(404)
    expect(body.sessions[0]!.tool_calls.synthesized_excluded).toBe(0)
  })

  it('holds an arbitrarily tight ceiling, and reports every shed', async () => {
    const spans = await fixtureSpans(400)
    const report = buildSessionFactsReport(spans)
    let previous = Number.POSITIVE_INFINITY
    for (const ceiling of [30_000, 8_000, 2_000, 900, 400, 100]) {
      const context = renderSessionFactsContext(report, { byteCeiling: ceiling })
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(ceiling)
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(previous)
      previous = Buffer.byteLength(context)
      if (context === '') continue
      const body = JSON.parse(context.slice(context.indexOf('\n') + 1)) as {
        sessions: Array<{ tool_calls?: { count: number } }>
        omitted_fields?: string[]
      }
      // Whatever it shed, it says so, and the tool-call count is the last fact
      // to go: it answers the question the bounded tools cannot.
      if (ceiling < 8_000) expect(body.omitted_fields?.length).toBeGreaterThan(0)
      if (body.sessions.length > 0) expect(body.sessions[0]!.tool_calls?.count).toBe(404)
    }
  })

  it('tells the reader the sheet is not citable', async () => {
    const spans = await fixtureSpans()
    const context = sessionFactsContext(spans)!
    expect(context).toContain('cite those spans, never this sheet')
    expect(context).toContain('no model call')
  })

  it('supplies the sheet to a built-in kind without dropping its own context', async () => {
    const spans = await fixtureSpans()
    const base: TraceAnalystDefinition = defineTraceAnalyst({
      id: 'fixture-kind',
      description: 'a kind that already prepares context',
      area: 'fixture',
      version: '2.0.0',
      instructions: 'Investigate.',
      toolGroup: 'all',
      prepareContext: () => 'OWN CONTEXT',
    })
    const [wrapped] = withSessionFactsContext([base], spans)
    expect(wrapped!.version).toBe(`2.0.0+${SESSION_FACTS_VERSION_SUFFIX}`)
    const prepared = await wrapped!.prepareContext!({} as TraceAnalysisStore, { runId: 'r', correlationId: 'r:1' })
    expect(prepared!.startsWith('OWN CONTEXT\n\n')).toBe(true)
    expect(prepared).toContain('SESSION FACTS')
    expect(Buffer.byteLength(prepared!)).toBeLessThanOrEqual(
      PREPARED_CONTEXT_BYTE_CEILING + Buffer.byteLength('OWN CONTEXT\n\n'),
    )
  })

  it('prepares nothing when there are no spans', () => {
    expect(sessionFactsContext([])).toBeUndefined()
  })
})

describe('analyzeSpans', () => {
  it('hands the sheet to the built-in kinds, and can be run without it', async () => {
    const spans = await fixtureSpans()
    const requests: TraceAnalysisEngineRequest[] = []
    const engine: TraceAnalysisEngine = {
      id: 'session-facts-test-engine',
      description: 'records the instructions it is given instead of calling a model',
      model: 'test-model',
      version: '1.0.0',
      executionConfig: {},
      async analyze(request) {
        requests.push(request)
        return { answer: 'noted', findings: [], trajectory: [], modelCalls: 1, toolCalls: 0, runtime: {} }
      },
    }

    await analyzeSpans(spans, { engine, agenticKinds: DEFAULT_TRACE_ANALYST_KINDS.slice(0, 1) })
    expect(requests).toHaveLength(1)
    const prepared = requests[0]!.instructions.split('PREPARED CONTEXT:\n')[1]!
    expect(prepared).toContain('SESSION FACTS')
    expect(JSON.parse(prepared.slice(prepared.indexOf('\n') + 1).split('\n\n')[0]!))
      .toMatchObject({ sessions: [{ tool_calls: { count: 4, synthesized_excluded: 0 } }] })

    requests.length = 0
    await analyzeSpans(spans, {
      engine,
      agenticKinds: DEFAULT_TRACE_ANALYST_KINDS.slice(0, 1),
      sessionFactsContext: false,
    })
    expect(requests[0]!.instructions).not.toContain('SESSION FACTS')
  })
})

describe('traces facts', () => {
  const cli = (args: string[]) =>
    execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd() })

  it('prints the sheet as JSON with no model call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-facts-cli-'))
    const otlp = join(dir, 'spans.otlp.jsonl')
    await writeFile(otlp, serializeSpans(await fixtureSpans()), 'utf8')

    const { stdout } = await cli(['facts', '--otlp', otlp])
    const report = JSON.parse(stdout) as {
      kind: string
      sessions: Array<{ toolCalls: { value: number }; subagents: { value: Array<{ taskName: string }> } }>
    }
    expect(report.kind).toBe('traces.session_facts_report')
    expect(report.sessions[0]!.toolCalls.value).toBe(4)
    expect(report.sessions[0]!.subagents.value[0]!.taskName).toBe(FIXTURE_AGENT_PATH)

    const readable = await cli(['facts', '--otlp', otlp, '--format', 'text'])
    expect(readable.stdout).toContain('tool calls: 4')
    expect(readable.stdout).toContain('deterministic, $0')
  })

  it('exits non-zero when a session cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-facts-unreadable-'))
    // A file that is not a session, and a path that does not exist. Neither may
    // be reported as a session with no facts.
    const garbage = join(dir, 'not-a-session.jsonl')
    await writeFile(garbage, 'this is not a rollout\n', 'utf8')
    await expect(cli(['facts', '--harness', 'codex', '--session', garbage]))
      .rejects.toMatchObject({ code: 1 })
    await expect(cli(['facts', '--otlp', join(dir, 'absent.otlp.jsonl')]))
      .rejects.toMatchObject({ code: 1 })
  })

  it('keeps the facts and names the unread records when part of a session is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-facts-corrupt-'))
    const session = join(dir, `${FIXTURE_SESSION_ID}.jsonl`)
    const records = fixtureRecords().map((record) => JSON.stringify(record))
    // One unparseable line among readable ones: the facts still hold, and the
    // sheet says how many records it could not read.
    records.splice(3, 0, '{ not json')
    await writeFile(session, `${records.join('\n')}\n`, 'utf8')

    const { stdout } = await cli(['facts', '--harness', 'codex', '--session', session])
    const report = JSON.parse(stdout) as {
      sessions: Array<{ toolCalls: { value: number }; unreadRecords: { value: number } }>
    }
    expect(report.sessions[0]!.toolCalls.value).toBe(4)
    expect(report.sessions[0]!.unreadRecords.value).toBe(1)

    const readable = await cli(['facts', '--harness', 'codex', '--session', session, '--format', 'text'])
    expect(readable.stdout).toContain('unread records: 1')
  })

  it('rejects an unknown output format before reading anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-facts-format-'))
    await expect(cli(['facts', '--otlp', join(dir, 'unused.otlp.jsonl'), '--format', 'yaml']))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unknown facts format') })
  })
})
