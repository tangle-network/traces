import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATTR,
  deriveHexId,
  llmSpan,
  loopSpan,
  steeredBy,
  toolSpan,
} from '@tangle-network/agent-trace-contract'
import {
  DURATION_UNMEASURABLE_ATTR,
  readOtlpInput,
  otlpRowToSpan,
  resolveOtlpInputFiles,
} from '../src/otlp-input.js'
import { serializeSpans, toOpenInferenceSpan } from '../src/otlp.js'
import { renderConformance, summarizeSpanStructure } from '../src/conformance.js'
import { exportTraceEvidenceText } from '../src/file-export.js'

// Wire ids are hex, as OTLP and W3C `traceparent` require; the readable name
// stays on the span. A fixture with human ids would be testing a trace no
// collector can join.
const TRACE = deriveHexId('trace-contract-1', 16)
const ROUND_1 = deriveHexId('round-1', 8)
const LLM_1 = deriveHexId('llm-1', 8)
const TOOL_1 = deriveHexId('tool-1', 8)
const ROUND_2 = deriveHexId('round-2', 8)

/** A conforming two-round loop: LLM + tool inside round 1, round 2 steered by it. */
function contractTrace() {
  const round1 = loopSpan({
    traceId: TRACE,
    spanId: ROUND_1,
    parentSpanId: null,
    name: 'round 1',
    loopId: 'loop-a',
    iteration: 1,
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:10.000Z',
  })
  const call = llmSpan({
    traceId: TRACE,
    spanId: LLM_1,
    parentSpanId: ROUND_1,
    name: 'coder turn',
    model: 'glm-5.2',
    inputTokens: 1200,
    outputTokens: 340,
    costUsd: 0.0042,
    startTime: '2026-01-01T00:00:01.000Z',
    endTime: '2026-01-01T00:00:06.000Z',
  })
  const tool = toolSpan({
    traceId: TRACE,
    spanId: TOOL_1,
    parentSpanId: ROUND_1,
    name: 'bash',
    toolName: 'bash',
    startTime: '2026-01-01T00:00:06.000Z',
    endTime: '2026-01-01T00:00:07.000Z',
  })
  const round2 = loopSpan({
    traceId: TRACE,
    spanId: ROUND_2,
    parentSpanId: null,
    name: 'round 2',
    loopId: 'loop-a',
    iteration: 2,
    resumed: true,
    startTime: '2026-01-01T00:00:10.000Z',
    endTime: '2026-01-01T00:00:20.000Z',
    links: [steeredBy(LLM_1, TRACE)],
  })
  return [round1, call, tool, round2]
}

async function writeTrace(rows: readonly unknown[], name = 'spans.otlp.jsonl'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-input-'))
  const path = join(dir, name)
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return path
}

describe('readOtlpInput', () => {
  it('ingests a conforming contract trace with no adapter and keeps every field the analysis reads', async () => {
    const path = await writeTrace(contractTrace())
    const input = await readOtlpInput(path)

    expect(input.spans).toHaveLength(4)
    expect(input.issues).toEqual([])
    expect(input.validation.ok).toBe(true)
    expect(input.validation.findings).toEqual([])
    const available = input.validation.capabilities.filter((capability) => capability.available)
    expect(available.map((capability) => capability.name).sort()).toEqual([
      'cost-attribution',
      'latency-analysis',
      'loop-convergence',
      'steering-chain',
      'token-accounting',
      'tool-usage',
    ])

    const llm = input.spans.find((span) => span.span_id === LLM_1)!
    expect(llm.attributes[ATTR.inputTokens]).toBe(1200)
    expect(llm.attributes[ATTR.model]).toBe('glm-5.2')
    // agent-eval's tool reader does not know the semconv key; ingest bridges it
    // so a conforming TOOL span is not analysed as an unnamed call.
    const tool = input.spans.find((span) => span.span_id === TOOL_1)!
    expect(tool.attributes[ATTR.toolName]).toBe('bash')
    expect(tool.attributes['tool.name']).toBe('bash')
  })

  it('preserves links through read AND write, so steering survives a round-trip', async () => {
    const path = await writeTrace(contractTrace())
    const input = await readOtlpInput(path)

    const round2 = input.spans.find((span) => span.span_id === ROUND_2)!
    expect(round2.links).toEqual([
      { trace_id: TRACE, span_id: LLM_1, attributes: { 'agent.link.kind': 'steered_by' } },
    ])

    const rewritten = await writeTrace(
      serializeSpans(input.spans).trim().split('\n').map((line) => JSON.parse(line) as unknown),
      'round-trip.jsonl',
    )
    const reread = await readOtlpInput(rewritten)
    expect(reread.spans.find((span) => span.span_id === ROUND_2)!.links).toEqual(round2.links)
    expect(reread.validation.capabilities.find((c) => c.name === 'steering-chain')?.available).toBe(true)
  })

  it('emits no links key when the producer recorded none, rather than an empty array', () => {
    const [round1] = contractTrace()
    const projected = toOpenInferenceSpan(otlpRowToSpan(round1, TRACE).span!)
    expect('links' in projected).toBe(false)
  })

  it('reports a malformed line instead of throwing, and analyses the rest', async () => {
    const rows = contractTrace().map((row) => JSON.stringify(row))
    rows.splice(2, 0, '{"trace_id": "broken", ')
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-broken-'))
    const path = join(dir, 'broken.jsonl')
    await writeFile(path, `${rows.join('\n')}\n`, 'utf8')

    const input = await readOtlpInput(path)
    expect(input.spans).toHaveLength(4)
    expect(input.issues).toHaveLength(1)
    expect(input.issues[0]!.kind).toBe('unparseable-line')
    expect(input.issues[0]!.line).toBe(3)
  })

  it('drops a row it cannot time at all, and names the reason', async () => {
    const path = await writeTrace([
      ...contractTrace(),
      { trace_id: TRACE, span_id: 'no-time', name: 'x', start_time: 'not-a-date', end_time: 'nope', status: {}, attributes: {} },
    ])
    const input = await readOtlpInput(path)

    expect(input.spans.map((span) => span.span_id)).not.toContain('no-time')
    expect(input.issues.map((issue) => issue.kind)).toEqual(['unreadable-timestamp'])
    expect(input.withheld).toEqual([])
  })

  it('keeps a span whose interval is backwards, withholding the interval rather than the span', async () => {
    // A tool call with a bad end_time is still a tool call. Dropping the whole
    // span deleted it from every count in the report — a silent missing row,
    // which is worse than a duration the report already marks unusable.
    const path = await writeTrace([
      ...contractTrace(),
      {
        trace_id: TRACE,
        span_id: 'backwards',
        name: 'y',
        kind: 'TOOL',
        start_time: '2026-01-01T00:00:05.000Z',
        end_time: '2026-01-01T00:00:04.000Z',
        status: {},
        attributes: { 'gen_ai.tool.name': 'bash' },
      },
    ])
    const input = await readOtlpInput(path)

    const kept = input.spans.find((span) => span.span_id === 'backwards')
    expect(kept).toBeDefined()
    expect(input.issues).toEqual([])
    expect(input.withheld.map((entry) => [entry.kind, entry.field])).toEqual([['negative-duration', 'end_time']])
    // Withheld, not repaired: the clamp exists so no consumer reads a negative
    // duration, and the value the producer wrote is kept verbatim beside it.
    expect(kept!.end_time).toBe(kept!.start_time)
    expect(kept!.attributes[DURATION_UNMEASURABLE_ATTR]).toBe(true)
    expect(kept!.attributes['traces.raw_attribute.end_time']).toBe('2026-01-01T00:00:04.000Z')

    // The SOURCE loses latency-analysis to the contract's own finding...
    expect(input.validation.capabilities.find((c) => c.name === 'latency-analysis')?.available).toBe(false)
    // ...and so must a re-export of it. Exporting the clamp would have made the
    // copy validate clean and claim a capability the original never had.
    const reexport = await writeTrace(input.spans.map(toOpenInferenceSpan))
    const reread = await readOtlpInput(reexport)
    expect(reread.spans.map((span) => span.span_id)).toContain('backwards')
    expect(reread.validation.capabilities.find((c) => c.name === 'latency-analysis')?.available).toBe(false)

    const rendered = renderConformance(input.validation, {
      subject: 'x',
      spans: input.spans,
      withheld: input.withheld,
    })
    expect(rendered).toContain('1 span(s) were analysed with one field withheld')
  })

  // The contract recognises ONLY the `STATUS_CODE_*` spelling, so both an
  // invented code and a bare `OK` are `invalid-status` against the source. This
  // package analyses them as UNSET and OK — and if the export then wrote the
  // ANALYSED code, the finding would vanish from a copy of a trace that never
  // conformed. Same rule, same mechanism as the unusable `end_time` above.
  it.each([
    ['an invented status code', 'WEIRD', 'UNSET'],
    ['the bare OpenInference spelling', 'OK', 'OK'],
  ])('re-exports %s exactly as the producer wrote it, so invalid-status survives', async (
    _label,
    declared,
    analysed,
  ) => {
    const rows: unknown[] = contractTrace()
    rows[2] = { ...contractTrace()[2]!, status: { code: declared, message: 'exit 2' } }
    const path = await writeTrace(rows)
    const input = await readOtlpInput(path)

    const tool = input.spans.find((span) => span.span_id === TOOL_1)!
    // Analysis uses the normalized code; the producer's word is kept beside it.
    expect(tool.status.code).toBe(analysed)
    expect(tool.attributes['traces.raw_attribute.status.code']).toBe(declared)
    expect(input.validation.findings.some((finding) => finding.code === 'invalid-status')).toBe(true)

    const reexport = await writeTrace(input.spans.map(toOpenInferenceSpan))
    const reread = await readOtlpInput(reexport)
    expect(reread.spans.find((span) => span.span_id === TOOL_1)!.status.code).toBe(analysed)
    const survived = reread.validation.findings.find((finding) => finding.code === 'invalid-status')
    expect(survived?.severity).toBe('warn')
    expect(survived?.spanIds).toContain(TOOL_1)
  })

  // A row that never became a span cannot be re-emitted: the export is also the
  // file this package's analysts read, so a non-span line in it is garbage fed
  // to the analysis and a repaired one is invented work. What the export CAN do
  // is refuse to pass itself off as the source, and that refusal has to survive
  // any number of further hops.
  it('declares on the export how many source rows it could not represent, and accumulates it across hops', async () => {
    const rows = contractTrace().map((row) => JSON.stringify(row))
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-launder-'))
    const path = join(dir, 'source.jsonl')
    await writeFile(path, `${['not json at all', rows[0]!, rows[1]!, JSON.stringify({ hello: 'world' })].join('\n')}\n`, 'utf8')

    const input = await readOtlpInput(path)
    expect(input.spans).toHaveLength(2)
    expect(input.unreadable).toEqual({
      rows: 2,
      kinds: ['missing-span-id', 'unparseable-line'],
      inherited: 0,
    })

    // Hop 1: the artifact is clean OTLP and says what it is missing.
    const hop1 = await writeTrace(input.spans.map(toOpenInferenceSpan))
    const reread = await readOtlpInput(hop1)
    expect(reread.issues).toEqual([])
    expect(reread.unreadable).toEqual({
      rows: 2,
      kinds: ['missing-span-id', 'unparseable-line'],
      inherited: 2,
    })
    expect(renderConformance(reread.validation, {
      subject: hop1,
      spans: reread.spans,
      unreadable: reread.unreadable,
    })).toContain('2 row(s) of the ORIGINAL source are not in this file')

    // Hop 2: re-exporting the artifact does not launder the count by length.
    const hop2 = await readOtlpInput(await writeTrace(reread.spans.map(toOpenInferenceSpan)))
    expect(hop2.unreadable.rows).toBe(2)
    expect(hop2.unreadable.inherited).toBe(2)
  })

  it('collapses an identical re-declaration to one span and counts it as a repeat, not a defect', async () => {
    const rows = contractTrace()
    const path = await writeTrace([...rows, { ...rows[1]! }])
    const input = await readOtlpInput(path)

    expect(input.spans.filter((span) => span.span_id === LLM_1)).toHaveLength(1)
    expect(input.issues).toEqual([])
    expect(input.files[0]!.repeats).toBe(1)
    expect(input.files[0]!.spans).toBe(4)
  })

  it('drops a CONFLICTING re-declaration and names it, because nothing can resolve it', async () => {
    const rows = contractTrace()
    const conflicting = { ...rows[1]!, name: 'a different call entirely' }
    const path = await writeTrace([...rows, conflicting])
    const input = await readOtlpInput(path)

    expect(input.spans.filter((span) => span.span_id === LLM_1)).toHaveLength(1)
    expect(input.spans.find((span) => span.span_id === LLM_1)!.name).toBe('coder turn')
    expect(input.issues).toHaveLength(1)
    expect(input.issues[0]!.kind).toBe('conflicting-span-id')
    expect(input.files[0]!.repeats).toBe(0)
    // The producer still hears about it, as a WARN: the other spans were read,
    // so the export IS a trace and analysis runs on it. What the conflict costs
    // is the number read off the ambiguous span, and the finding says so.
    expect(input.validation.ok).toBe(true)
    const conflict = input.validation.findings.find((finding) => finding.code === 'duplicate-span-id')
    expect(conflict?.severity).toBe('warn')
    expect(conflict?.spanIds).toContain(LLM_1)
  })

  it('reports the real line number of a bad row, not its index among the good ones', async () => {
    const rows = contractTrace().map((row) => JSON.stringify(row))
    // Blank lines and an unparseable line both push the row index away from the
    // line number; a span on line 7 must be reported as line 7.
    const text = ['', rows[0]!, '', 'not json at all', rows[1]!, '', '{"span_id":"x","name":"y"}', ''].join('\n')
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-lines-'))
    const path = join(dir, 'sparse.jsonl')
    await writeFile(path, `${text}\n`, 'utf8')

    const input = await readOtlpInput(path)
    expect(input.issues.map((issue) => [issue.kind, issue.line])).toEqual([
      ['unparseable-line', 4],
      ['unreadable-timestamp', 7],
    ])
  })

  it('says a null row is null, not that it is an object', async () => {
    const path = await writeTrace([null, 42, ['a']])
    const input = await readOtlpInput(path)

    expect(input.issues.map((issue) => issue.detail)).toEqual([
      'row is null',
      'row is number',
      'row is an array',
    ])
  })

  it('never throws on input that is not spans at all', async () => {
    const path = await writeTrace([{ hello: 'world' }, 42, ['a'], null])
    const input = await readOtlpInput(path)

    expect(input.spans).toEqual([])
    expect(input.validation.ok).toBe(false)
    expect(input.validation.findings.some((finding) => finding.code === 'invalid-span')).toBe(true)
    expect(input.issues.every((issue) => issue.kind === 'not-an-object' || issue.kind === 'missing-span-id')).toBe(true)
  })

  it('ingests every OTLP jsonl under a directory, recursively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-dir-'))
    await mkdir(join(dir, 'nested'), { recursive: true })
    const [round1, call, tool, round2] = contractTrace()
    await writeFile(join(dir, 'a.jsonl'), `${JSON.stringify(round1)}\n${JSON.stringify(call)}\n`, 'utf8')
    await writeFile(join(dir, 'nested', 'b.jsonl'), `${JSON.stringify(tool)}\n${JSON.stringify(round2)}\n`, 'utf8')
    await writeFile(join(dir, 'notes.txt'), 'ignored\n', 'utf8')

    expect(await resolveOtlpInputFiles(dir)).toEqual({
      files: [join(dir, 'a.jsonl'), join(dir, 'nested', 'b.jsonl')],
      skipped: [],
    })
    const input = await readOtlpInput(dir)
    expect(input.files).toHaveLength(2)
    expect(input.spans).toHaveLength(4)
  })

  it('skips the raw event/stream logs a run directory keeps beside its spans, and names them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-mixed-'))
    const [round1, call, tool, round2] = contractTrace()
    await writeFile(join(dir, 'spans.otlp.jsonl'), `${[round1, call, tool, round2].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    await writeFile(
      join(dir, 'stream-shot-1.jsonl'),
      `${['a', 'b', 'c'].map((id) => JSON.stringify({ type: 'assistant-delta', id, text: 'x' })).join('\n')}\n`,
      'utf8',
    )
    await writeFile(join(dir, 'sdk-event-shot-1.jsonl'), `${JSON.stringify({ event: 'tool-invocation', payload: {} })}\n`, 'utf8')

    const input = await readOtlpInput(dir)
    expect(input.files.map((file) => file.path)).toEqual([join(dir, 'spans.otlp.jsonl')])
    expect(input.spans).toHaveLength(4)
    // Their lines are not counted as rows, and produce no findings.
    expect(input.rows).toHaveLength(4)
    expect(input.issues).toEqual([])
    expect(input.skipped.map((file) => file.path).sort()).toEqual([
      join(dir, 'sdk-event-shot-1.jsonl'),
      join(dir, 'stream-shot-1.jsonl'),
    ])
    expect(input.skipped.every((file) => file.reason.includes('no span_id'))).toBe(true)
  })

  it('reads only the otlp/ subdirectory when the producer made one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-subdir-'))
    await mkdir(join(dir, 'otlp'), { recursive: true })
    const [round1, call, tool, round2] = contractTrace()
    await writeFile(join(dir, 'otlp', 'shot-1.jsonl'), `${[round1, call].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    await writeFile(join(dir, 'otlp', 'shot-2.jsonl'), `${[tool, round2].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    // A sibling file that IS span-shaped but was not put in otlp/ — the
    // producer's own separation decides, not our sniffing.
    await writeFile(join(dir, 'agent-eval-trace.jsonl'), `${JSON.stringify({ ...round1, span_id: deriveHexId('stray', 8) })}\n`, 'utf8')

    const resolved = await resolveOtlpInputFiles(dir)
    expect(resolved.files).toEqual([join(dir, 'otlp', 'shot-1.jsonl'), join(dir, 'otlp', 'shot-2.jsonl')])
    expect(resolved.skipped).toEqual([])
    expect((await readOtlpInput(dir)).spans).toHaveLength(4)
  })

  it('keeps a foreign span kind verbatim instead of discarding the span', async () => {
    const path = await writeTrace([
      {
        trace_id: TRACE,
        span_id: deriveHexId('guard-1', 8),
        parent_span_id: null,
        name: 'verification.result',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T00:00:00.000Z',
        status: { code: 'STATUS_CODE_ERROR', message: '3 verifier failure(s)' },
        attributes: { [ATTR.spanKind]: 'GUARDRAIL' },
      },
    ])
    const input = await readOtlpInput(path)

    const span = input.spans[0]!
    expect(span.attributes['traces.raw_attribute.openinference.span.kind']).toBe('GUARDRAIL')
    // UNKNOWN, not CHAIN: nothing about this span says it CONTAINS other work.
    expect(span.attributes[ATTR.spanKind]).toBe('UNKNOWN')
    expect(span.status).toEqual({ code: 'ERROR', message: '3 verifier failure(s)' })
    expect(input.validation.findings.some((finding) => finding.code === 'unknown-span-kind')).toBe(true)
  })

  it('keeps every kind the contract defines, including the EVALUATOR verdict spans', async () => {
    const kinds = ['AGENT', 'CHAIN', 'LLM', 'TOOL', 'EVALUATOR', 'RETRIEVER', 'UNKNOWN']
    const path = await writeTrace(kinds.map((kind, index) => ({
      trace_id: TRACE,
      span_id: deriveHexId(`kind-${kind}`, 8),
      parent_span_id: null,
      name: `span ${index}`,
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:00.000Z',
      status: { code: 'STATUS_CODE_UNSET' },
      kind,
      attributes: { [ATTR.spanKind]: kind, [ATTR.outcome]: 'fail' },
    })))
    const input = await readOtlpInput(path)

    expect(input.spans.map((span) => span.attributes[ATTR.spanKind])).toEqual(kinds)
    // Nothing was re-typed, so nothing is stamped as a repaired attribute.
    expect(input.spans.every((span) => span.attributes['traces.raw_attribute.openinference.span.kind'] === undefined)).toBe(true)
  })

  it('completes a link that names a target but no trace, and drops one that names no target', async () => {
    const path = await writeTrace([
      {
        ...contractTrace()[0],
        links: [{ span_id: LLM_1 }, { trace_id: TRACE }, 'not-a-link'],
      },
      ...contractTrace().slice(1, 3),
    ])
    const input = await readOtlpInput(path)

    expect(input.spans[0]!.links).toEqual([{ trace_id: TRACE, span_id: LLM_1 }])
  })
})

describe('detection of contract-shaped OTLP', () => {
  it('reads a contract span with no scope as openinference, not as a foreign format', () => {
    const text = contractTrace().map((row) => JSON.stringify(row)).join('\n')
    const result = exportTraceEvidenceText(text)

    expect(result.format).toBe('openinference')
    expect(result.spans).toHaveLength(4)
    expect(result.spans.find((span) => span.span_id === ROUND_2)!.links).toEqual([
      { trace_id: TRACE, span_id: LLM_1, attributes: { 'agent.link.kind': 'steered_by' } },
    ])
  })
})

describe('summarizeSpanStructure', () => {
  it('measures the degree of flatness the per-trace finding cannot express', async () => {
    const rows = [
      ...contractTrace(),
      ...Array.from({ length: 6 }, (_unused, index) => ({
        trace_id: TRACE,
        span_id: `loose-${index}`,
        parent_span_id: null,
        name: `loose ${index}`,
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T00:00:00.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: {},
      })),
    ]
    const input = await readOtlpInput(await writeTrace(rows))
    const structure = summarizeSpanStructure(input.spans)

    expect(structure).toEqual({
      spans: 10,
      traces: 1,
      rootless: 8,
      // One of the eight is the trace's legitimate root; the other seven are
      // the spans that genuinely attribute to nothing.
      extraRoots: 7,
      tracesWithoutRoot: 0,
      orphans: 0,
      links: 1,
    })
    // One parented span suppresses the contract's per-trace flat finding; the
    // report still has to say that 7 of 10 spans attach to nothing.
    expect(input.validation.findings.some((finding) => finding.code === 'flat-hierarchy')).toBe(false)
    const rendered = renderConformance(input.validation, { subject: 'x', spans: input.spans })
    expect(rendered).toContain('8/10 (80.0%) carry no parent edge')
    expect(rendered).toContain('7 span(s) attribute to nothing')
  })

  it('reads a textbook one-root trace as correct, not as broken', async () => {
    // Every span attaches under a single root — the shape the contract asks for.
    // The structure summary used to call the root itself unattributed and
    // narrate a conforming trace as a defect.
    const rows = contractTrace().map((span) =>
      span.span_id === ROUND_1
        ? span
        : span.parent_span_id === null
          ? { ...span, parent_span_id: ROUND_1 }
          : span,
    )
    const input = await readOtlpInput(await writeTrace(rows))
    const structure = summarizeSpanStructure(input.spans)

    expect(structure.traces).toBe(1)
    expect(structure.rootless).toBe(1)
    expect(structure.extraRoots).toBe(0)
    expect(structure.tracesWithoutRoot).toBe(0)
    const rendered = renderConformance(input.validation, { subject: 'x', spans: input.spans })
    expect(rendered).not.toContain('attribute to nothing')
    expect(rendered).not.toContain('Every span is its own root')
    expect(rendered).not.toContain('have no root at all')
  })

  it('does not hang on a span whose parent chain loops', () => {
    const spans = [
      { trace_id: 't', span_id: 'a', parent_span_id: 'b', name: 'a', start_time: '', end_time: '', status: { code: 'UNSET' as const }, attributes: {} },
      { trace_id: 't', span_id: 'b', parent_span_id: 'a', name: 'b', start_time: '', end_time: '', status: { code: 'UNSET' as const }, attributes: {} },
    ]
    expect(summarizeSpanStructure(spans).rootless).toBe(0)
  })
})

describe('renderConformance', () => {
  it('names the analysis each unavailable capability empties', async () => {
    const path = await writeTrace([
      {
        trace_id: TRACE,
        span_id: 'only',
        parent_span_id: null,
        name: 'event',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T00:00:00.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: {},
      },
    ])
    const input = await readOtlpInput(path)
    const rendered = renderConformance(input.validation, { subject: path, spans: input.spans })

    expect(rendered).toContain('analyses skipped, and why')
    expect(rendered).toContain('Direct model usage')
    expect(rendered).toContain('no spans carry gen_ai.usage.input_tokens')
    expect(rendered).toContain('`token-accounting`')
  })
})
