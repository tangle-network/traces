import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveAdapter } from '../src/registry.js'
import { parseSession } from '../src/session-source.js'
import { buildSpanRunTree, collectSessionSelection, computeSessionFacts } from '../src/index.js'
import { runCli } from './run-cli.js'

const row = (timestamp: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, message: { type, payload } })

describe('shared native-session bridge', () => {
  it.runIf(process.env.TRACES_KIMI_CAPTURE_HOME && process.env.TRACES_RUNTIME_MODULE)('reads the SDK-owned real parent and child wires through selection, canonical spans, facts and the built CLI', async () => {
    // The sole retained/redacted capture is owned by agent-sdk's Kimi fixture;
    // qualification supplies its HOME layout instead of copying it into Traces.
    const home = process.env.TRACES_KIMI_CAPTURE_HOME!
    const runtimeModule = process.env.TRACES_RUNTIME_MODULE!
    const adapter = resolveAdapter('kimi')!
    const parent = await adapter.locateBySessionId!('parent', { home })
    expect(parent).toHaveLength(1)
    expect(parent[0]!.sessionId).toBe('parent')
    const selection = await collectSessionSelection([{ adapter, refs: parent }], { workflow: true, home, parents: true })
    expect(selection.workflow).toMatchObject({ complete: true, issues: [] })
    expect(selection.rows.map((row) => row.ref.sessionId).sort()).toEqual(['id-011afd997439', 'id-4fb3cf18797e', 'parent'])
    const spans = selection.rows.flatMap((row) => [...row.spans])
    const tree = buildSpanRunTree(spans, 'SDK-owned Kimi capture')
    expect(tree.nodes).toHaveLength(3)
    expect(tree.traceIds).toHaveLength(3)
    expect(tree.nodes.filter((node) => node.parentNodeId !== null)).toHaveLength(0)
    const facts = computeSessionFacts(spans, { includeSubagents: true, includeContent: false })
    expect(facts).toHaveLength(3)
    expect(facts.filter((fact) => fact.parentSessionId === 'parent')).toHaveLength(2)
    expect(facts.reduce((sum, fact) => sum + fact.tokens.modelCalls, 0)).toBe(48)
    expect(facts.reduce((sum, fact) => sum + (fact.toolCalls.value ?? 0), 0)).toBe(112)
    // Facts input owns the whole prompt: reported fresh183251 + cache2654720.
    expect(facts.reduce((sum, fact) => sum + (fact.tokens.input ?? 0), 0)).toBe(2_837_971)
    expect(facts.reduce((sum, fact) => sum + (fact.tokens.output ?? 0), 0)).toBe(19_511)
    const state = await mkdtemp(join(tmpdir(), 'traces-kimi-capture-state-'))
    const cli = await runCli(['facts', 'parent', '--harness', 'kimi', '--no-content', '--format', 'json'], {
      env: { HOME: home, XDG_STATE_HOME: state },
    })
    expect(cli.code, cli.stderr).toBe(0)
    const report = JSON.parse(cli.stdout)
    expect(report.sessions).toHaveLength(3)
    expect(report.sessions.filter((fact: { parentSessionId: string | null }) => fact.parentSessionId === 'parent')).toHaveLength(2)
    expect(report.sessions.reduce((sum: number, fact: { tokens: { modelCalls: number } }) => sum + fact.tokens.modelCalls, 0)).toBe(48)
    expect(report.sessions.reduce((sum: number, fact: { toolCalls: { value: number | null } }) => sum + (fact.toolCalls.value ?? 0), 0)).toBe(112)
    const registryRoot = join(state, 'registry')
    const observed = await runCli(['graphs', 'parent', '--harness', 'kimi', '--out', registryRoot,
      '--runtime-module', runtimeModule, '--format', 'json'], { env: { HOME: home, XDG_STATE_HOME: state } })
    expect(observed.code, observed.stderr).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({ recordCount: 1, ingested: 1 })
    const owner = await import(runtimeModule.startsWith('file:') ? runtimeModule : pathToFileURL(runtimeModule).href)
    const registry = owner.graphRegistry(registryRoot)
    const records = await owner.listGraphRuns(registry)
    expect(records).toHaveLength(1)
    const graph = await owner.loadGraph(registry, records[0].graphDigest)
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toHaveLength(0)
    expect(records[0].unknowns.join(' ')).toContain('parent/child topology may be incomplete')
  })
  it('analyzes Kimi with a real human prompt, model usage, and a tool result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-kimi-bridge-'))
    const path = join(dir, 'wire.jsonl')
    await writeFile(path, [
      row(1791331200, 'TurnBegin', { user_input: 'Inspect the repository' }),
      row(1791331201, 'StepBegin', {}),
      row(1791331202, 'ToolCall', { id: 'call-1', function: { name: 'Shell', arguments: '{"command":"pwd"}' } }),
      row(1791331203, 'ToolResult', { tool_call_id: 'call-1', return_value: { output: '/work', is_error: false } }),
      row(1791331204, 'StatusUpdate', { token_usage: { input_other: 3, output: 5, input_cache_read: 7 } }),
      row(1791331205, 'TurnEnd', {}),
    ].join('\n') + '\n')

    const adapter = resolveAdapter('kimi')!
    const spans = await parseSession(adapter, {
      harness: 'kimi', sessionId: 'test-kimi', path, cwd: null, mtimeMs: 0,
    })
    expect(spans.find((span) => span.name === 'user.prompt')?.attributes).toMatchObject({
      'tangle.actor': 'human', content: 'Inspect the repository',
    })
    expect(spans.find((span) => span.name === 'llm.call')?.attributes).toMatchObject({
      'llm.token_count.prompt': 3,
      'llm.token_count.completion': 5,
      'llm.token_count.prompt_cache_hit': 7,
    })
    expect(spans.find((span) => span.name === 'tool.Shell')?.attributes['tool.name']).toBe('Shell')
    expect(spans.every((span) => ['OK', 'ERROR', 'UNSET'].includes(span.status.code))).toBe(true)
  })

  it('refuses a timestamp-free native session rather than inventing epoch work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-kimi-no-time-'))
    const path = join(dir, 'wire.jsonl')
    await writeFile(path, JSON.stringify({ message: { type: 'TurnBegin', payload: { user_input: 'hello' } } }) + '\n')
    const adapter = resolveAdapter('kimi')!
    await expect(parseSession(adapter, {
      harness: 'kimi', sessionId: 'missing-time', path, cwd: null, mtimeMs: 0,
    })).rejects.toThrow(/produced no spans/)
  })
})
