import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter, CodexAdapter, PiAdapter, buildSessionFactsReport, parseSession, span } from '../src/index.js'
import { computeAdoption, analyzeAdoption } from '../src/adoption.js'
import { toolIoAttributes } from '../src/adapters/tool-io.js'
import type { HarnessTraceAdapter } from '../src/types.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function parse(adapter: HarnessTraceAdapter, rows: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'session-measurements-')); dirs.push(dir)
  const path = join(dir, 'sample.jsonl')
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return parseSession(adapter, { harness: adapter.harness, sessionId: 'sample', path, cwd: null, mtimeMs: 0 })
}
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString()

describe('standard session measurements', () => {
  it('preserves native Claude compaction measurements and does not convert a point event into zero latency', async () => {
    const spans = await parse(new ClaudeAdapter(), [
      { type: 'user', uuid: 'u', sessionId: 'sample', timestamp: at(0), message: { content: 'private commission' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(10), compactMetadata: { preTokens: 100, postTokens: 20, durationMs: 4200 } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'c2', timestamp: at(30), compactMetadata: { preTokens: 110 } },
    ])
    const facts = buildSessionFactsReport(spans).sessions[0]!
    const events = facts.measurements.compactions.value!
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ latencyMs: 4200, tokensBefore: 100, tokensAfter: 20, sincePreviousMs: null })
    expect(events[1]).toMatchObject({ latencyMs: null, tokensBefore: 110, tokensAfter: null, sincePreviousMs: 20000 })
  })
  it('keeps Pi boundary context size and leaves unrecorded latency and post-context unknown', async () => {
    const spans = await parse(new PiAdapter(), [
      { type: 'session', id: 'sample', timestamp: at(0) },
      { type: 'compaction', id: 'c1', timestamp: at(20), tokensBefore: 92000, summary: 'private summary', firstKeptEntryId: 'entry' },
    ])
    expect(buildSessionFactsReport(spans).sessions[0]!.measurements.compactions.value?.[0]).toMatchObject({
      tokensBefore: 92000, tokensAfter: null, latencyMs: null,
    })
  })
  it('keeps Codex boundaries when the source records no summary', async () => {
    const spans = await parse(new CodexAdapter(), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'sample' } },
      { type: 'compacted', timestamp: at(20), payload: { message: '', window_number: 1 } },
    ])
    expect(buildSessionFactsReport(spans).sessions[0]!.measurements.compactions.value).toHaveLength(1)
  })
  it('counts bytes from size receipts rather than truncated strings, separates unknown outcomes and timing', () => {
    const root = span({ traceId: 'a', spanId: 'root', name: 'session', kind: 'AGENT', startTime: at(0) })
    const tools = [
      span({ traceId: 'a', spanId: '1', parentSpanId: 'root', name: 'tool.Read', tool: 'Read', kind: 'TOOL', startTime: at(1), endTime: at(3),
        extra: toolIoAttributes({ input: 'é', output: 'x'.repeat(20000) }) }),
      span({ traceId: 'a', spanId: '2', parentSpanId: 'root', name: 'tool.Read', tool: 'Read', kind: 'TOOL', startTime: at(4), status: 'UNSET' }),
    ]
    const item = buildSessionFactsReport([root, ...tools]).sessions[0]!.measurements.tools[0]!
    expect(item.outcomes).toEqual({ ok: 1, error: 0, unset: 1 })
    expect(item.inputBytes).toMatchObject({ total: 2, measured: 1, eligible: 2 })
    expect(item.outputBytes).toMatchObject({ total: 20000, measured: 1, eligible: 2 })
    expect(item.callToResultMs).toMatchObject({ total: 2000, measured: 1, eligible: 2 })
  })
  it('withholds private text, marks missing compaction evidence, and invalidates reports when a source value changes', async () => {
    const spans = await parse(new ClaudeAdapter(), [
      { type: 'user', uuid: 'u', sessionId: 'sample', timestamp: at(0), message: { content: 'NEVER_EXPOSE_COMMISSION' } },
      { type: 'assistant', uuid: 'a', timestamp: at(1), message: { id: 'm', content: [{ type: 'text', text: 'NEVER_EXPOSE_ANSWER' }] } },
    ])
    const report = buildSessionFactsReport(spans, { includeContent: false, generatedAt: at(50) })
    expect(JSON.stringify(report)).not.toContain('NEVER_EXPOSE')
    expect(report.contentIncluded).toBe(false)
    expect(report.evidenceThrough).toBe(at(1))
    expect(report.sessions[0]!.measurements.compactions.value).toBeNull()
    expect(report.sourceDigest).toBe(buildSessionFactsReport([...spans].reverse()).sourceDigest)
    const changed = structuredClone(spans)
    changed[1]!.attributes.content = 'changed'
    expect(report.sourceDigest).not.toBe(buildSessionFactsReport(changed).sourceDigest)
    expect(computeAdoption(spans)).toEqual(await analyzeAdoption(spans))
  })
  it('keeps child observations out of the parent tool and compaction measurements', () => {
    const spans = [
      span({ traceId: 'a', spanId: 'root', name: 'session', kind: 'AGENT', startTime: at(0) }),
      span({ traceId: 'a', spanId: 'child', parentSpanId: 'root', name: 'session.compacted', kind: 'CHAIN', startTime: at(3), extra: { 'traces.span.subagent': true } }),
      span({ traceId: 'a', spanId: 'tool', parentSpanId: 'child', name: 'tool.Read', kind: 'TOOL', startTime: at(3), extra: { 'traces.span.subagent': true } }),
    ]
    const facts = buildSessionFactsReport(spans).sessions[0]!
    expect(facts.measurements.compactions.value).toBeNull()
    expect(facts.measurements.tools).toEqual([])
    expect(facts.subagentToolSpans.value).toBe(1)
  })
})

