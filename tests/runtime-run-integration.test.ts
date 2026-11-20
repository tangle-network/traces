/** Maintained file journal → shared contract spans → canonical tree and facts. */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { span, serializeSpans } from '../src/otlp.js'
import { runCli } from './run-cli.js'
import { readRefSpans } from '../src/refs.js'
import { buildSpanRunTree, computeSessionFacts } from '../src/index.js'

it('reads a named Runtime run through its owner without summing child-inclusive settlements', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-runtime-graph-'))
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`
  const root = 'runtime-fixture'
  const spawn = (id: string, parent?: string, budget: object = parent ? { maxTokens: 1000 } : {}) => ({ kind: 'spawned', id, parent, label: 'PRIVATE_LABEL', budget, runtime: 'pi', seq: 0, at: at(0) })
  const spend = (input: number, output: number) => ({ tokens: { input, output }, usd: 0, usdKnown: false, ms: 1 })
  try {
    const events = [spawn(root), spawn('child', root), spawn('resource-cap', root, { resources: { gpu: { unit: 'ms', limit: 5000 } } }),
      { kind: 'metered', id: root, spend: spend(100, 10), seq: 0, at: at(1) },
      { kind: 'metered', id: 'child', spend: spend(20, 2), seq: 0, at: at(1) },
      { kind: 'settled', id: 'child', status: 'done', spent: spend(20, 2), seq: 0, at: at(2) },
      { kind: 'settled', id: 'resource-cap', status: 'done', spent: spend(0, 0), seq: 0, at: at(2) },
      { kind: 'settled', id: root, status: 'done', spent: spend(120, 12), seq: 0, at: at(3) }]
    await writeFile(join(dir, 'spawn-journal.jsonl'), [
      { kind: 'begin', root, at: at(0) },
      { kind: 'events', root, events: events.slice(0, 2) }, // Runtime batches spawns.
      ...events.slice(2).map((event) => ({ kind: 'event', root, event })),
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const watched = await runCli(['watch', dir, '--once'], { timeoutMs: 15_000 })
    expect(watched.code, watched.stderr).toBe(0)
    expect(watched.stdout).toContain('budget unbounded')
    expect(watched.stdout).toContain('budget 1,000tok')
    expect(watched.stdout).toContain('budget gpu 5,000ms')
    expect(watched.stdout).not.toMatch(/NaN|Infinity|% it/)
    const spans = await readRefSpans(dir)
    const tree = buildSpanRunTree(spans, dir)
    expect(tree.nodes).toHaveLength(3)
    expect(tree.nodes.filter((node) => node.parentNodeId !== null)).toHaveLength(2)
    const facts = computeSessionFacts(spans, { includeSubagents: true })
    expect(facts).toHaveLength(3)
    expect(facts.reduce((total, fact) => total + (fact.tokens.input ?? 0), 0)).toBe(120)
    expect(facts.reduce((total, fact) => total + (fact.tokens.output ?? 0), 0)).toBe(12)
    expect(JSON.stringify(spans)).not.toContain('PRIVATE_LABEL')
    expect(facts.every((fact) => fact.humanTurns.value === null && fact.toolCalls.value === null)).toBe(true)
    expect(facts.every((fact) => fact.tokens.cacheRead === null && fact.tokens.cacheWrite === null)).toBe(true)
    await appendFile(join(dir, 'spawn-journal.jsonl'), '{invalid}\n')
    const partial = computeSessionFacts(await readRefSpans(dir), { includeSubagents: true })
    expect(partial.reduce((sum, fact) => sum + (fact.unreadRecords.value ?? 0), 0)).toBe(1)
    const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const retainedRoot = span({ traceId, spanId: 'bbbbbbbbbbbbbbbb', name: 'retained', kind: 'AGENT', startTime: at(0) })
    await writeFile(join(dir, 'retained.otlp.jsonl'), serializeSpans([
      retainedRoot,
      span({ traceId, spanId: 'cccccccccccccccc', parentSpanId: retainedRoot.span_id, name: 'provider.call', kind: 'LLM', startTime: at(1), inputTokens: 7, outputTokens: 3 }),
      span({ traceId, spanId: 'dddddddddddddddd', parentSpanId: retainedRoot.span_id, name: 'tool.read', kind: 'TOOL', tool: 'read', startTime: at(1) }),
    ]))
    const retained = await readRefSpans(dir)
    expect(retained).toHaveLength(3)
    expect(new Set(retained.map((item) => item.trace_id))).toEqual(new Set([traceId]))
    const result = await runCli(['facts', dir, '--format', 'json'], { timeoutMs: 15_000 })
    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]).toMatchObject({ tokens: { input: 7, output: 3 }, toolCalls: { value: 1 } })

  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('reads legacy lifecycle rows independently of missing and partial driver spend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-legacy-meter-'))
  const at = (second: number) => `2026-11-01T16:38:${String(second).padStart(2, '0')}.000Z`
  const spawn = (id: string, parent?: string) => ({ kind: 'spawned', id, parent, label: id, at: at(0) })
  const meter = (id: string, spend?: object) => ({ kind: 'metered', id, spend, at: at(1) })
  const settle = (id: string, status: string) => ({ kind: 'settled', id, status, at: at(9) })
  const events = [
    spawn('root'), spawn('partial', 'root'), spawn('zero', 'root'), spawn('one-channel', 'root'), spawn('idle', 'root'),
    meter('partial', { tokens: { input: 11, output: 2 }, usd: 0.25, iterations: 1 }), meter('partial'),
    meter('one-channel', { tokens: { input: 17 } }), meter('zero', { tokens: { input: 0, output: 0 }, usd: 0 }),
    settle('partial', 'done'), settle('zero', 'done'), settle('one-channel', 'done'), settle('idle', 'down'),
  ]
  try {
    await writeFile(join(dir, 'spawn-journal.jsonl'), events.map((event) => JSON.stringify({ kind: 'event', root: 'root', event })).join('\n') + '\n')
    const spans = await readRefSpans(dir)
    const idle = spans.find((item) => item.attributes['traces.runtime.node_id'] === 'idle')
    expect(idle).toMatchObject({ start_time: at(0), end_time: at(9), status: { code: 'ERROR' }, attributes: { 'tangle.node.state': 'failed' } })
    const [facts, watch, behavior] = await Promise.all([
      runCli(['facts', dir, '--format', 'json']), runCli(['watch', dir, '--once']), runCli(['behavior', dir, '--format', 'json']),
    ])
    expect(facts.code, facts.stderr).toBe(0)
    const tokenSheets = JSON.parse(facts.stdout).sessions.map((sheet: { tokens: object }) => sheet.tokens)
    expect(tokenSheets).toEqual(expect.arrayContaining([
      expect.objectContaining({ input: 0, output: 0, unavailable: null }),
      expect.objectContaining({ input: 17, output: null, unavailable: expect.stringContaining('output tokens unknown') }),
      expect.objectContaining({ input: null, output: null, unavailable: expect.stringContaining('at least 11 input tokens, at least 2 output tokens') }),
    ]))
    expect(watch.code, watch.stderr).toBe(0)
    expect(watch.stdout).toContain('budget unknown')
    expect(watch.stdout).toContain('wall 9.0s')
    expect(watch.stdout).toContain('in at least 11 · out at least 2 · $0.2500 + 1 unpriced')
    expect(watch.stdout).toContain('in 0 · out 0 · $0.0000')
    expect(watch.stdout).toContain('in 17 · out unknown · cost unknown')
    expect(behavior.code).toBe(2)
    expect(JSON.parse(behavior.stderr)).toMatchObject({ code: 'no-outcome', error: expect.stringContaining('no tool spans') })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
