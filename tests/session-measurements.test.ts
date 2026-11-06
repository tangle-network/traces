import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { buildSessionFactsReport, parseSession } from '../src/index.js'
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
  })
})

