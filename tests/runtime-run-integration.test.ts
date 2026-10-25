/** Maintained file journal → shared contract spans → canonical tree and facts. */
import { appendFile, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { span, serializeSpans } from '../src/otlp.js'
import { runCli } from './run-cli.js'
import { readRefSpans } from '../src/refs.js'
import { buildSpanRunTree, computeSessionFacts } from '../src/index.js'

it('reads a Runtime run without traversing Git objects or summing journals with retained OTLP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-runtime-graph-'))
  const worktree = join(dir, 'worktree')
  const bare = join(dir, 'deliverables.git')
  const objectDirectories = [join(worktree, '.git', 'objects'), join(bare, 'objects')]
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`
  const root = 'runtime-fixture'
  const spawn = (id: string, parent?: string) => ({ kind: 'spawned', id, parent, label: 'PRIVATE_LABEL', budget: { maxTokens: 1000 }, runtime: 'pi', seq: 0, at: at(0) })
  const spend = (input: number, output: number) => ({ tokens: { input, output }, usd: 0, usdKnown: false, ms: 1 })
  try {
    const git = promisify(execFile)
    await git('git', ['init', '--quiet', worktree], { timeout: 5000 })
    await git('git', ['init', '--bare', '--quiet', bare], { timeout: 5000 })
    const explicit = join(bare, 'objects', 'explicit.otlp.jsonl')
    const explicitRoot = span({ traceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', spanId: 'ffffffffffffffff', name: 'explicit', kind: 'AGENT', startTime: at(0) })
    await writeFile(explicit, serializeSpans([explicitRoot,
      span({ traceId: explicitRoot.trace_id, spanId: 'eeeeeeeeeeeeeeee', parentSpanId: explicitRoot.span_id, name: 'explicit.call', kind: 'LLM', startTime: at(1), inputTokens: 99, outputTokens: 9 }),
    ]))
    for (const objects of objectDirectories) {
      await chmod(objects, 0)
      // The real filesystem must refuse traversal; a privileged test is not evidence.
      await expect(readdir(objects)).rejects.toMatchObject({ code: 'EACCES' })
    }
    const events = [spawn(root), spawn('child', root),
      { kind: 'metered', id: root, spend: spend(100, 10), seq: 0, at: at(1) },
      { kind: 'metered', id: 'child', spend: spend(20, 2), seq: 0, at: at(1) },
      { kind: 'settled', id: 'child', status: 'done', spent: spend(20, 2), seq: 0, at: at(2) },
      { kind: 'settled', id: root, status: 'done', spent: spend(120, 12), seq: 0, at: at(3) }]
    await writeFile(join(dir, 'spawn-journal.jsonl'), [
      { kind: 'begin', root, at: at(0) }, ...events.map((event) => ({ kind: 'event', root, event })),
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const spans = await readRefSpans(dir)
    const tree = buildSpanRunTree(spans, dir)
    expect(tree.nodes).toHaveLength(2)
    expect(tree.nodes.filter((node) => node.parentNodeId !== null)).toHaveLength(1)
    const facts = computeSessionFacts(spans, { includeSubagents: true })
    expect(facts).toHaveLength(2)
    expect(facts.reduce((total, fact) => total + (fact.tokens.input ?? 0), 0)).toBe(120)
    expect(facts.reduce((total, fact) => total + (fact.tokens.output ?? 0), 0)).toBe(12)
    expect(JSON.stringify(spans)).not.toContain('PRIVATE_LABEL')
    expect(facts.every((fact) => fact.humanTurns.value === null && fact.toolCalls.value === null)).toBe(true)
    expect(facts.every((fact) => fact.tokens.cacheRead === null && fact.tokens.cacheWrite === null)).toBe(true)
    const journal = await runCli(['facts', dir, '--format', 'json'], { timeoutMs: 15_000 })
    expect(journal.code, journal.stderr).toBe(0)
    expect(JSON.parse(journal.stdout).sessions[0]).toMatchObject({ tokens: { input: 100, output: 10 } })
    await appendFile(join(dir, 'spawn-journal.jsonl'), '{invalid}\n')
    const partial = computeSessionFacts(await readRefSpans(dir), { includeSubagents: true })
    expect(partial.reduce((sum, fact) => sum + (fact.unreadRecords.value ?? 0), 0)).toBe(1)
    const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const retainedRoot = span({ traceId, spanId: 'bbbbbbbbbbbbbbbb', name: 'retained', kind: 'AGENT', startTime: at(0) })
    const nested = join(worktree, 'evidence', 'nested')
    const similarlyNamed = join(dir, 'notes.git')
    await mkdir(nested, { recursive: true })
    await mkdir(similarlyNamed)
    await writeFile(join(dir, 'retained.otlp.jsonl'), serializeSpans([retainedRoot]))
    await writeFile(join(nested, 'calls.ndjson'), serializeSpans([
      span({ traceId, spanId: 'cccccccccccccccc', parentSpanId: retainedRoot.span_id, name: 'provider.call', kind: 'LLM', startTime: at(1), inputTokens: 7, outputTokens: 3 }),
    ]))
    // A suffix is not Git metadata: ordinary directories remain discoverable.
    await writeFile(join(similarlyNamed, 'tools.jsonl'), serializeSpans([
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
    for (const objects of objectDirectories) await chmod(objects, 0o700)
    const named = await runCli(['facts', explicit, '--format', 'json'], { timeoutMs: 15_000 })
    expect(named.code, named.stderr).toBe(0)
    expect(JSON.parse(named.stdout).sessions[0]).toMatchObject({ tokens: { input: 99, output: 9 } })
  } finally {
    for (const objects of objectDirectories) await chmod(objects, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})
