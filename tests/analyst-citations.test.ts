import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AnalystFinding,
  createTraceAnalyst,
  FAILURE_MODE_KIND_SPEC,
  type RawAnalystEvidence,
  type RawAnalystFinding,
  type TraceAnalysisEngine,
  type TraceAnalysisEngineRequest,
  type TraceAnalystDefinition,
} from '@tangle-network/agent-eval/analyst'
import { OtlpFileTraceStore } from '@tangle-network/agent-eval/traces'
import { CodexAdapter } from '../src/adapters/codex.js'
import { CITATION_NORMALIZATION_VERSION, normalizeAnalystCitations } from '../src/analyst-citations.js'
import { runTraceInvestigation } from '../src/improvement.js'
import { type OtlpSpan, writeOtlpFile } from '../src/otlp.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-citations-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SESSION = 'citation-session'
const LINT_OUTPUT = 'Process exited with code 1\nOutput:\nerror: "fixture.lock" is stale\nrun the setup step again'
const DECODED_EXCERPT = 'Output:\nerror: "fixture.lock" is stale'
// What a model copies from a searchTrace hit: the raw OTLP-JSONL text, escapes included.
const ESCAPED_EXCERPT = 'Output:\\nerror: \\"fixture.lock\\" is stale'

function codexSession(sessionId: string): Promise<OtlpSpan[]> {
  const path = join(dir, `${sessionId}.jsonl`)
  const events: Record<string, unknown>[] = [
    { type: 'session_meta', payload: { id: sessionId, cwd: '/fixture' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-lint', name: 'exec_command', arguments: '{"cmd":"pnpm lint"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-lint', output: LINT_OUTPUT } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-setup', name: 'exec_command', arguments: '{"cmd":"pnpm setup"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-setup', output: 'Process exited with code 0\nOutput:\nsetup complete: 3 packages linked' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ]
  writeFileSync(path, events.map((event, index) => JSON.stringify({
    ...event,
    timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString(),
  })).join('\n'))
  return new CodexAdapter().parse({ harness: 'codex', sessionId, path, cwd: null, mtimeMs: 0 })
}

async function traceStore(spans: readonly OtlpSpan[], name: string): Promise<OtlpFileTraceStore> {
  const store = new OtlpFileTraceStore({ path: await writeOtlpFile(spans, join(dir, `${name}.otlp.jsonl`)) })
  await store.ensureIndexed()
  return store
}

/** What the stub engine learned from the real trace tools, as a model would. */
interface Citations {
  readonly traceId: string
  readonly lint: string
  readonly setup: string
  readonly readableLint: string
  readonly readableSetup: string
  readonly searchText: string
}

type Tools = TraceAnalysisEngineRequest['tools']

async function callTool<T>(tools: Tools, name: string, args: unknown): Promise<T> {
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`tool ${name} was not supplied`)
  return await tool.handler(args) as T
}

interface SearchResult {
  hits: Array<{ span_id: string; matched_text: string; context_before: string; context_after: string }>
}

async function readCitations(tools: Tools): Promise<Citations> {
  const overview = await callTool<{ sample_trace_ids: string[] }>(tools, 'getDatasetOverview', {})
  const traceId = overview.sample_trace_ids[0]!
  const lintHit = (await callTool<SearchResult>(tools, 'searchTrace', { trace_id: traceId, regex_pattern: 'is stale' })).hits[0]!
  const setupHit = (await callTool<SearchResult>(tools, 'searchTrace', { trace_id: traceId, regex_pattern: 'setup complete' })).hits[0]!
  const viewed = await callTool<{ spans: Array<{ span_id: string; attributes: Record<string, unknown> }> }>(
    tools,
    'viewSpans',
    { trace_id: traceId, span_ids: [lintHit.span_id, setupHit.span_id] },
  )
  const readable = (spanId: string) => String(
    viewed.spans.find((span) => span.span_id === spanId)?.attributes['traces.codex.source_span_id'],
  )
  return {
    traceId,
    lint: lintHit.span_id,
    setup: setupHit.span_id,
    readableLint: readable(lintHit.span_id),
    readableSetup: readable(setupHit.span_id),
    searchText: lintHit.context_before + lintHit.matched_text + lintHit.context_after,
  }
}

type FindingBuilder = (citations: Citations) => Record<string, unknown>

/** Submits fixed findings built from real tool reads; no model is called. */
function stubEngine(build: FindingBuilder, seen: Citations[] = []): TraceAnalysisEngine {
  return {
    id: 'citation-stub',
    description: 'Submits fixed findings built from real trace-tool reads.',
    model: 'stub-model',
    version: '1.0.0',
    executionConfig: {},
    async analyze(request) {
      if (request.analystId !== FAILURE_MODE_KIND_SPEC.id) {
        return { answer: 'no findings', findings: [], trajectory: [], modelCalls: 0, toolCalls: 0, runtime: {} }
      }
      const citations = await readCitations(request.tools)
      seen.push(citations)
      return {
        answer: 'stub answer',
        findings: [build(citations) as RawAnalystFinding],
        trajectory: [],
        modelCalls: 0,
        toolCalls: 4,
        runtime: {},
      }
    },
  }
}

function spanUri(traceId: string, spanId: string): string {
  return `trace://${encodeURIComponent(traceId)}/span/${encodeURIComponent(spanId)}`
}

function finding(claim: string, evidence: RawAnalystEvidence[], extra: Record<string, unknown> = {}) {
  return { severity: 'high', claim, confidence: 0.9, evidence, ...extra }
}

interface GateOutcome {
  readonly accepted: readonly AnalystFinding[]
  readonly rejections: readonly string[]
  readonly citations: Citations
}

async function gate(
  definition: TraceAnalystDefinition,
  store: OtlpFileTraceStore,
  build: FindingBuilder,
): Promise<GateOutcome> {
  const rejections: string[] = []
  const seen: Citations[] = []
  const analyst = createTraceAnalyst(definition, { engine: stubEngine(build, seen) })
  const accepted = await analyst.analyze(store, {
    runId: 'citations',
    correlationId: 'citations',
    log: (message, fields) => {
      if (message.startsWith('finding rejected')) rejections.push(String(fields?.reason ?? message))
    },
  })
  return { accepted, rejections, citations: seen[0]! }
}

describe('analyst citation normalization', () => {
  let spans: OtlpSpan[]
  let store: OtlpFileTraceStore
  let normalized: TraceAnalystDefinition

  beforeAll(async () => {
    spans = await codexSession(SESSION)
    store = await traceStore(spans, 'single')
    normalized = normalizeAnalystCitations([FAILURE_MODE_KIND_SPEC], spans)[0]!
  })

  // Each shape cites two real spans: failure-mode needs the error span and the
  // span where work resumed. Only the citation form differs from the gate's.
  const realEvidence: Array<{ shape: string; before: string; build: FindingBuilder }> = [
    {
      shape: 'escaped excerpt copied from a search hit',
      before: 'excerpt is not present in the cited span content',
      build: (c) => finding('escaped excerpt', [
        { uri: spanUri(c.traceId, c.lint), excerpt: ESCAPED_EXCERPT },
        { uri: spanUri(c.traceId, c.setup) },
      ]),
    },
    {
      shape: 'readable span id in the hex trace',
      before: 'trace span does not exist',
      build: (c) => finding('readable span id', [
        { uri: spanUri(c.traceId, c.lint) },
        { uri: spanUri(c.traceId, c.readableSetup) },
      ]),
    },
    {
      shape: 'readable trace and span ids',
      before: 'trace span does not exist',
      build: (c) => finding('readable trace and span ids', [
        { uri: `trace://${SESSION}/span/${c.readableLint}`, excerpt: DECODED_EXCERPT },
        { uri: spanUri(c.traceId, c.setup) },
      ]),
    },
    {
      shape: 'bare readable id',
      before: 'citation is not a supplied finding or trace span',
      build: (c) => finding('bare readable id', [
        { uri: c.readableLint },
        { uri: spanUri(c.traceId, c.setup) },
      ]),
    },
    {
      shape: 'subject from another kind',
      before: 'finding rejected: subject is not valid for analyst',
      build: (c) => finding('subject from another kind', [
        { uri: spanUri(c.traceId, c.lint) },
        { uri: spanUri(c.traceId, c.setup) },
      ], { subject: 'tool-doc:exec_command' }),
    },
  ]

  it('reads the escaped excerpt from a real search hit, and the readable ids from the spans', async () => {
    const { citations } = await gate(normalized, store, realEvidence[0]!.build)
    expect(citations.searchText).toContain(ESCAPED_EXCERPT)
    expect(citations.searchText).not.toContain(DECODED_EXCERPT)
    expect(citations.readableLint).toBe('tool:call-lint')
    expect(citations.readableSetup).toBe('tool:call-setup')
  })

  it.each(realEvidence)('gate rejects the unnormalized $shape', async ({ before, build }) => {
    const outcome = await gate(FAILURE_MODE_KIND_SPEC, store, build)
    expect(outcome.accepted).toEqual([])
    expect(outcome.rejections).toEqual([before])
  })

  it.each(realEvidence)('gate accepts the normalized $shape', async ({ build }) => {
    const outcome = await gate(normalized, store, build)
    expect(outcome.rejections).toEqual([])
    expect(outcome.accepted).toHaveLength(1)
    const [accepted] = outcome.accepted
    const { citations: c } = outcome
    expect(accepted!.evidence_refs.map((ref) => ref.uri).sort())
      .toEqual([spanUri(c.traceId, c.lint), spanUri(c.traceId, c.setup)].sort())
    expect(accepted!.subject).toBeUndefined()
    expect(accepted!.metadata?.definition_version)
      .toBe(`${FAILURE_MODE_KIND_SPEC.version}+${CITATION_NORMALIZATION_VERSION}`)
  })

  it('rewrites an escaped excerpt to the decoded text present in the cited span', async () => {
    const { accepted } = await gate(normalized, store, realEvidence[0]!.build)
    expect(accepted[0]!.evidence_refs.find((ref) => ref.excerpt !== undefined)?.excerpt).toBe(DECODED_EXCERPT)
  })

  const stillRejected: Array<{ shape: string; reason: string; build: FindingBuilder }> = [
    {
      shape: 'fabricated escaped excerpt',
      reason: 'excerpt is not present in the cited span content',
      build: (c) => finding('fabricated excerpt', [
        { uri: spanUri(c.traceId, c.lint), excerpt: 'Output:\\nerror: \\"fixture.lock\\" is fresh' },
        { uri: spanUri(c.traceId, c.setup) },
      ]),
    },
    {
      shape: 'real excerpt cited on a span that does not contain it',
      reason: 'excerpt is not present in the cited span content',
      build: (c) => finding('excerpt on the wrong span', [
        { uri: spanUri(c.traceId, c.setup), excerpt: ESCAPED_EXCERPT },
        { uri: spanUri(c.traceId, c.lint) },
      ]),
    },
    {
      shape: 'fabricated readable id',
      reason: 'trace span does not exist',
      build: (c) => finding('fabricated readable id', [
        { uri: spanUri(c.traceId, c.lint) },
        { uri: spanUri(c.traceId, 'tool:call-missing') },
      ]),
    },
    {
      // failure-mode requires the error span and the recovery span.
      shape: 'single citation',
      reason: 'finding rejected: insufficient evidence citations',
      build: (c) => finding('single citation', [{ uri: spanUri(c.traceId, c.lint) }]),
    },
    {
      // Normalization collapses an alias onto its span; it cannot add a citation.
      shape: 'readable alias of a span already cited',
      reason: 'finding rejected: insufficient evidence citations',
      build: (c) => finding('alias of a cited span', [
        { uri: spanUri(c.traceId, c.lint) },
        { uri: c.readableLint },
      ]),
    },
    {
      // The schema rejects this before postProcess runs; see the agent-eval gate issue.
      shape: 'subject outside the grammar',
      reason: 'finding rejected: schema failure',
      build: (c) => finding('subject outside the grammar', [
        { uri: spanUri(c.traceId, c.lint) },
        { uri: spanUri(c.traceId, c.setup) },
      ], { subject: 'Probe Upper' }),
    },
  ]

  it.each(stillRejected)('gate still rejects a normalized $shape', async ({ reason, build }) => {
    const outcome = await gate(normalized, store, build)
    expect(outcome.accepted).toEqual([])
    expect(outcome.rejections).toEqual([reason])
  })

  it('leaves a readable id untouched when it names spans in two traces', async () => {
    const both = [...await codexSession('citation-a'), ...await codexSession('citation-b')]
    const twoTraces = await traceStore(both, 'two-traces')
    const definition = normalizeAnalystCitations([FAILURE_MODE_KIND_SPEC], both)[0]!
    const setupOf = (sessionId: string) => both.find((span) =>
      span.attributes['traces.codex.source_trace_id'] === sessionId
      && span.attributes['traces.codex.source_span_id'] === 'tool:call-setup')!

    const ambiguous = await gate(definition, twoTraces, () => {
      const setup = setupOf('citation-a')
      return finding('ambiguous bare id', [{ uri: 'tool:call-lint' }, { uri: spanUri(setup.trace_id, setup.span_id) }])
    })
    expect(ambiguous.accepted).toEqual([])
    expect(ambiguous.rejections).toEqual(['citation is not a supplied finding or trace span'])

    const scoped = await gate(definition, twoTraces, () => {
      const setup = setupOf('citation-a')
      return finding('scoped readable id', [
        { uri: 'trace://citation-a/span/tool:call-lint' },
        { uri: spanUri(setup.trace_id, setup.span_id) },
      ])
    })
    expect(scoped.rejections).toEqual([])
    const lint = both.find((span) =>
      span.attributes['traces.codex.source_trace_id'] === 'citation-a'
      && span.attributes['traces.codex.source_span_id'] === 'tool:call-lint')!
    expect(scoped.accepted[0]!.evidence_refs[0]!.uri).toBe(spanUri(lint.trace_id, lint.span_id))
  })

  it('normalizes the built-in kinds that trace investigations run', async () => {
    const result = await runTraceInvestigation({
      spans,
      harness: 'codex',
      engine: stubEngine((c) => finding('investigation citation', [
        { uri: spanUri(c.traceId, c.lint), excerpt: ESCAPED_EXCERPT },
        { uri: spanUri(c.traceId, c.readableSetup) },
      ])),
      generatedAt: '2026-09-08T00:00:00.000Z',
    })
    const accepted = result.analystResult.findings.filter((entry) => entry.analyst_id === FAILURE_MODE_KIND_SPEC.id)
    expect(accepted.map((entry) => entry.claim)).toEqual(['investigation citation'])
    expect(accepted[0]!.evidence_refs.map((ref) => ref.excerpt)).toEqual([DECODED_EXCERPT, undefined])
  })
})
