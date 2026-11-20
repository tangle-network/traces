/**
 * What `traces analyze` hands a program, through the built CLI: `--format
 * json` (the facts sheet, the finding packet, the measures, conformance and
 * every question the trace cannot answer) and `--out DIR` (exactly
 * `report.md`, with every cannot-answer reason, and `findings.json`, the
 * packet). No span copy is written, and no model is called.
 *
 * The same report through the public SDK entry (`runTraceInvestigation`), over
 * one trace two sessions share: its folded worker scope is reported as its own
 * sheet, and no finding, citation, tool error or count is charged per sheet of
 * the same trace.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SessionFactsReportOptions } from '../src/session-facts.js'
import { runTraceInvestigation } from '../src/index.js'
import { createTraceInvestigation } from '../src/improvement.js'
import type { OtlpSpan } from '../src/otlp.js'
import { parseSession } from '../src/session-source.js'
import { resolveAdapter } from '../src/registry.js'
import { makeAnalyzeHome, jsonl, SHARED_TRACE_SESSION_ID, sharedTraceSession, type AnalyzeHome } from './fixtures/analyze.js'
import { runCli } from './run-cli.js'

interface Analysis {
  schemaVersion: number
  kind: string
  facts: { kind: string; sessions: Array<{ cost: { usd: number | null; unavailable: string | null } }> }
  packet: { kind: string; schemaVersion: number; source: string; findings: Array<{ finding_id: string; severity: string }> }
  measures: { stuckLoops: unknown; failureClusters: unknown; toolUse: unknown[]; failureFollowUps: unknown; toolErrors: unknown[]; operating: unknown }
  conformance: { capabilities: unknown[] }
  cannotAnswer: Array<{ analysis: string; reason: string }>
}

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

let fx: AnalyzeHome
beforeAll(async () => {
  fx = await makeAnalyzeHome()
})

async function json(path: string): Promise<Analysis> {
  const run = await runCli(['analyze', path, '--format', 'json'], { env: fx.env })
  expect(run.code, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Analysis
}

/** The spans of the shared-trace fixture, written once and parsed once. */
let sharedTracePromise: Promise<OtlpSpan[]> | undefined
function sharedTraceSpans(): Promise<OtlpSpan[]> {
  sharedTracePromise ??= (async () => {
    const sessionDir = join(fx.dir, 'shared-trace')
    const workflowDir = join(sessionDir, 'subagents', 'workflows', 'wf-shared')
    await mkdir(workflowDir, { recursive: true })
    const { parent, worker } = sharedTraceSession(workflowDir)
    const parentPath = join(sessionDir, `${SHARED_TRACE_SESSION_ID}.jsonl`)
    await Promise.all([
      writeFile(parentPath, jsonl(parent)),
      writeFile(join(workflowDir, 'agent-shared.jsonl'), jsonl(worker)),
      writeFile(join(workflowDir, 'agent-shared.meta.json'), `${JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 })}\n`),
    ])
    return parseSession(resolveAdapter('claude-code')!, { harness: 'claude-code', sessionId: SHARED_TRACE_SESSION_ID, path: parentPath, cwd: null, mtimeMs: 0 })
  })()
  return sharedTracePromise
}

describe('analyze --format json', () => {
  it('carries the facts, the packet, the measures, conformance and every cannot-answer reason, and nothing else', async () => {
    const result = await json(fx.worker)
    expect(Object.keys(result)).toEqual(['schemaVersion', 'kind', 'generatedAt', 'harness', 'facts', 'packet', 'measures', 'conformance', 'cannotAnswer'])
    expect(result).toMatchObject({ schemaVersion: 1, kind: 'traces.analysis' })
    expect(result.facts.kind).toBe('traces.session_facts_report')
    expect(result.packet).toMatchObject({ schemaVersion: 1, kind: 'traces.finding_packet', source: 'traces analyze' })
    expect(Object.keys(result.measures).sort()).toEqual(['causality', 'failureClusters', 'failureFollowUps', 'operating', 'stuckLoops', 'toolErrors', 'toolUse'])
    expect(result.conformance.capabilities.length).toBeGreaterThan(0)
    expect(result.cannotAnswer.length).toBeGreaterThanOrEqual(1)
    // claude-opus-5-5 is priced: a number, never 0 for unknown.
    expect(result.facts.sessions[0]!.cost.usd).toBeGreaterThan(0)
    const ranks = result.packet.findings.map((finding) => RANK[finding.severity]!)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('on a trace with no tool arguments, names the argument comparisons it cannot make, and prints no failing command', async () => {
    const converted = join(fx.dir, 'worker.otlp.jsonl')
    expect((await runCli(['convert', fx.worker, '--out', converted], { env: fx.env })).code).toBe(0)
    const stripped = join(fx.dir, 'metadata-only.otlp.jsonl')
    const rows = (await readFile(converted, 'utf8')).trim().split('\n').map((line) => {
      const row = JSON.parse(line) as { attributes: Record<string, unknown> }
      for (const key of ['input.value', 'output.value', 'content']) delete row.attributes[key]
      return JSON.stringify(row)
    })
    await writeFile(stripped, `${rows.join('\n')}\n`)

    const result = await json(stripped)
    const asked = result.cannotAnswer.map((entry) => entry.analysis)
    expect(asked.some((entry) => entry.startsWith('argument comparisons'))).toBe(true)
    expect(asked).toContain('facts.measurements.waste')
    const text = (await runCli(['analyze', stripped], { env: fx.env })).stdout
    expect(text).not.toContain('failing commands')
    expect(text).toContain(`cannot answer ${result.cannotAnswer.length} questions`)
  })
})

describe('analyze --out DIR', () => {
  it('writes exactly report.md and findings.json, prints one line, and report.md holds every cannot-answer reason', async () => {
    const out = join(fx.dir, 'analysis')
    const run = await runCli(['analyze', fx.worker, '--out', out], { env: fx.env })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(run.stdout).toContain(`analysis → ${out}  (report.md, findings.json: `)
    expect((await readdir(out)).sort()).toEqual(['findings.json', 'report.md'])

    const result = await json(fx.worker)
    const packet = JSON.parse(await readFile(join(out, 'findings.json'), 'utf8')) as Analysis['packet']
    expect(packet).toMatchObject({ schemaVersion: 1, kind: 'traces.finding_packet' })
    expect(packet.findings.map((finding) => finding.finding_id)).toEqual(result.packet.findings.map((finding) => finding.finding_id))

    const report = await readFile(join(out, 'report.md'), 'utf8')
    expect(report).toContain('# traces analyze')
    expect(report).toContain('## Findings')
    expect(report).toContain(`## What these traces cannot answer (${result.cannotAnswer.length})`)
    for (const entry of result.cannotAnswer) expect(report).toContain(entry.reason)
  })
})

describe('runTraceInvestigation over one trace two sessions share', () => {
  // A parent that delegates everything to one Workflow worker folded into the
  // parent's trace: one trace id, two sessions, four real tool calls by the
  // worker (three failing) and one by the parent.
  let spans: OtlpSpan[]
  let traceId: string

  beforeAll(async () => {
    spans = await sharedTraceSpans()
    traceId = spans[0]!.trace_id
    expect(new Set(spans.map((span) => span.trace_id))).toEqual(new Set([traceId]))
    expect(spans.filter((span) => span.attributes['traces.span.subagent'] === true).length).toBeGreaterThan(0)
  })

  it('reports each session scope once: findings, citations, tool errors and counts are never charged per sheet', async () => {
    const facts: SessionFactsReportOptions = { includeSubagents: true }
    const scoped = await runTraceInvestigation({ spans, harness: 'claude-code', facts })
    const whole = await runTraceInvestigation({ spans, harness: 'claude-code' })
    expect(scoped.facts.spanCount).toBe(spans.length)
    expect(scoped.facts.sourceDigest).toBe(whole.facts.sourceDigest)
    const sheetIds = scoped.facts.sessions.map((session) => session.sessionId ?? session.traceId)
    expect(sheetIds[0]).toBe(SHARED_TRACE_SESSION_ID)
    expect(new Set(sheetIds)).toHaveLength(2)
    expect(scoped.facts.sessions.every((session) => session.traceId === traceId)).toBe(true)
    const workerSessionId = sheetIds[1]!

    const ids = scoped.packet.findings.map((finding) => finding.finding_id)
    expect(new Set(ids).size).toBe(ids.length)
    // The worker's failing streak is one claim about the trace, cited once —
    // not repeated for every sheet the trace emitted.
    const failing = scoped.packet.findings.filter((finding) => finding.subject === 'same-failing-command')
    expect(failing).toHaveLength(1)
    expect(failing[0]!.evidence_refs.filter((ref) => ref.kind === 'span')).toHaveLength(3)
    expect(failing[0]!.evidence_refs.filter((ref) => ref.kind === 'metric')).toHaveLength(2)
    expect(failing[0]!.metadata).toMatchObject({ sessionId: workerSessionId })

    // One tool-error sheet per session: the worker's own errors are kept, and
    // the parent is not charged for them nor the worker for the parent's call.
    expect(scoped.measures.toolErrors).toEqual([
      expect.objectContaining({ sessionId: SHARED_TRACE_SESSION_ID, calls: 1, errors: 0 }),
      expect.objectContaining({ sessionId: workerSessionId, calls: 4, errors: 3 }),
    ])
    // The operating counts pool every scope exactly once: the trace's five
    // actual tool calls, not the last sheet's four.
    expect(scoped.measures.operating.guardRefusals.toolCalls).toBe(5)
  })

  it('is deterministic: the same spans give the same scoped report twice', async () => {
    const facts: SessionFactsReportOptions = { includeSubagents: true }
    const first = await runTraceInvestigation({ spans, harness: 'claude-code', facts })
    const second = await runTraceInvestigation({ spans, harness: 'claude-code', facts })
    // `produced_at` is each finding's own clock; everything else is the spans.
    const stable = (findings: typeof first.packet.findings) => findings.map(({ produced_at, ...rest }) => rest)
    expect(stable(second.packet.findings)).toEqual(stable(first.packet.findings))
    expect(second.measures.toolErrors).toEqual(first.measures.toolErrors)
  })

  it('keeps the ordinary one-batch report of the same spans unchanged', async () => {
    const plain = await runTraceInvestigation({ spans, harness: 'claude-code' })
    expect(plain.facts.sessions).toHaveLength(1)
    expect(plain.facts.sessions[0]!.sessionId ?? plain.facts.sessions[0]!.traceId).toBe(SHARED_TRACE_SESSION_ID)
    expect(plain.measures.toolErrors).toEqual([expect.objectContaining({ sessionId: SHARED_TRACE_SESSION_ID, calls: 1, errors: 0 })])
    expect(plain.packet.findings.filter((finding) => finding.subject === 'same-failing-command')).toHaveLength(0)
  })

  it('counts a batch of repeated identical spans once', async () => {
    const plain = await runTraceInvestigation({ spans, harness: 'claude-code' })
    const repeated = await runTraceInvestigation({ spans: [...spans, ...spans], harness: 'claude-code' })
    expect(repeated.facts.sourceDigest).toBe(plain.facts.sourceDigest)
    expect(repeated.facts.sessions).toEqual(plain.facts.sessions)
    expect(repeated.packet.findings.map((finding) => finding.finding_id)).toEqual(plain.packet.findings.map((finding) => finding.finding_id))
    expect(repeated.measures.toolErrors).toEqual(plain.measures.toolErrors)
    expect(repeated.measures.operating.guardRefusals.toolCalls).toBe(plain.measures.operating.guardRefusals.toolCalls)
  })

  it('refuses one span identity with two different bodies', async () => {
    const conflicting: OtlpSpan[] = [...spans, { ...spans[0]!, name: 'a different span' }]
    await expect(runTraceInvestigation({ spans: conflicting, harness: 'claude-code' })).rejects.toThrow(/conflicting bodies for span/)
  })
})

describe('createTraceInvestigation batches', () => {
  let shared: OtlpSpan[]
  let sharedTraceId: string
  let worker: OtlpSpan[]

  beforeAll(async () => {
    shared = await sharedTraceSpans()
    sharedTraceId = shared[0]!.trace_id
    worker = await parseSession(resolveAdapter('claude-code')!, { harness: 'claude-code', sessionId: 'a11a1a11-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: fx.worker, cwd: null, mtimeMs: 0 })
    expect(new Set(worker.map((span) => span.trace_id))).toEqual(new Set([worker[0]!.trace_id]))
    expect(worker[0]!.trace_id).not.toBe(sharedTraceId)
  })

  it('equals one pass over every span for disjoint whole-session batches', async () => {
    const streamed = createTraceInvestigation({ harness: 'claude-code' })
    await streamed.add(shared)
    await streamed.add(worker)
    const result = await streamed.finish()
    const oneBatch = await runTraceInvestigation({ spans: [...shared, ...worker], harness: 'claude-code' })
    expect(result.facts.sessions).toEqual(oneBatch.facts.sessions)
    expect(result.packet.findings.map((finding) => finding.finding_id)).toEqual(oneBatch.packet.findings.map((finding) => finding.finding_id))
    expect(result.measures.toolErrors).toEqual(oneBatch.measures.toolErrors)
    expect(result.measures.operating.guardRefusals.toolCalls).toBe(oneBatch.measures.operating.guardRefusals.toolCalls)
    expect(result.facts.sourceDigest).toBe(oneBatch.facts.sourceDigest)
  })

  it('refuses a trace split across two add() calls, naming the trace', async () => {
    const investigation = createTraceInvestigation({ harness: 'claude-code' })
    await investigation.add(shared.slice(0, Math.floor(shared.length / 2)))
    await expect(investigation.add(shared.slice(Math.floor(shared.length / 2)))).rejects.toThrow(
      `trace ${sharedTraceId} arrives in two add() calls`,
    )
  })
})
