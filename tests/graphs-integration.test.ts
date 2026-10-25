/** Real native reader → public facts SDK, plus the built CLI's graph boundary. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { span, serializeSpans } from '../src/otlp.js'
import { readOtlpInput } from '../src/otlp-input.js'
import { describe, expect, it } from 'vitest'
import { buildSpanRunTree, collectSessionSelection, computeSessionFacts, describeSessionRelationship, parseSession, scanSessions } from '../src/index.js'
import { makeTokenHome, TOKEN_IDS } from './fixtures/tokens.js'
import { runCli } from './run-cli.js'

async function sessionWithChild() {
  const fixture = await makeTokenHome()
  const directory = join(dirname(fixture.claude), TOKEN_IDS.claude, 'subagents')
  await mkdir(directory, { recursive: true })
  const child = 'graph-child'
  const base = { sessionId: TOKEN_IDS.claude, agentId: child, isSidechain: true, cwd: '/tmp/widgets' }
  await writeFile(join(directory, `agent-${child}.jsonl`), [
    { ...base, type: 'user', uuid: 'child-prompt', timestamp: '2026-10-14T11:00:04Z',
      message: { role: 'user', content: 'List the packages.' } },
    { ...base, type: 'assistant', uuid: 'child-answer', timestamp: '2026-10-14T11:00:08Z',
      message: { id: 'child-message', role: 'assistant', model: 'fixture-child', content: [{ type: 'text', text: 'Three packages.' }],
        usage: { input_tokens: 7, output_tokens: 5, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 } } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(join(directory, `agent-${child}.meta.json`), JSON.stringify({ toolUseId: 'toolu_agent', agentType: 'Explore' }))
  const sessions = []
  for await (const row of scanSessions({ harnesses: ['claude-code'], home: fixture.home })) sessions.push(row)
  return { fixture, session: sessions.find((row) => row.ref.sessionId === TOKEN_IDS.claude)! }
}

describe('graph observations through maintained readers', () => {
  it('preserves recorded anonymous CHAIN phases through file ingestion and exclusive facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-phase-'))
    const path = join(dir, 'phases.jsonl')
    const traceId = '11111111111111111111111111111111'
    const startTime = '2026-01-01T00:00:00Z'
    const root = span({ traceId, spanId: '2222222222222222', name: 'run', kind: 'AGENT', startTime })
    const phase = span({ traceId, spanId: '3333333333333333', parentSpanId: root.span_id, name: 'workflow.phase', kind: 'CHAIN', startTime })
    const call = span({ traceId, spanId: '4444444444444444', parentSpanId: phase.span_id, name: 'provider.call', kind: 'LLM', startTime, inputTokens: 31, outputTokens: 7 })
    try {
      await writeFile(path, serializeSpans([root, phase, call]))
      const spans = (await readOtlpInput(path)).spans
      const tree = buildSpanRunTree(spans, path)
      expect(tree.nodes.map((node) => node.kind)).toEqual(['AGENT', 'CHAIN'])
      const facts = computeSessionFacts(spans, { includeSubagents: true })
      expect(facts).toHaveLength(2)
      expect(facts.every((fact) => fact.sessionId === null)).toBe(true)
      expect(facts.find((fact) => fact.rootSpanId.value === phase.span_id)?.tokens.input).toBe(31)
      expect(facts.reduce((sum, fact) => sum + (fact.tokens.input ?? 0), 0)).toBe(31)
      expect(facts.every((fact) => fact.traceId === traceId)).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it.runIf(process.env.TRACES_RUNTIME_MODULE)('ingests native and Pi workflow sources through the built CLI and real Runtime registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-graphs-cli-'))
    const { fixture } = await sessionWithChild()
    const module = process.env.TRACES_RUNTIME_MODULE!
    const pi = fileURLToPath(new URL('./fixtures/pi-workflow/run.json', import.meta.url))
    try {
      const first = await runCli(['graphs', fixture.claude, '--out', dir, '--runtime-module', module, '--format', 'json'], { env: fixture.env })
      expect(first.code, first.stderr).toBe(0)
      expect(JSON.parse(first.stdout)).toMatchObject({ recordCount: 1, ingested: 1, factScope: 'whole-session', accountingCutoffApplied: false })
      const second = await runCli(['graphs', fixture.claude, '--out', dir, '--runtime-module', module, '--format', 'json'], { env: fixture.env })
      expect(second.code, second.stderr).toBe(0)
      expect(JSON.parse(second.stdout)).toMatchObject({ recordCount: 1, ingested: 0, cached: 1 })
      const workflow = await runCli(['graphs', pi, '--out', dir, '--runtime-module', module, '--format', 'json'])
      expect(workflow.code, workflow.stderr).toBe(0)
      const report = JSON.parse(workflow.stdout)
      expect(report.recordCount).toBe(2)
      expect(report.groups.every((group: { deliveredRate: unknown }) => group.deliveredRate === null)).toBe(true)
      const query = await runCli(['graphs', '--registry', dir, '--runtime-module', module, '--format', 'json'])
      expect(query.code, query.stderr).toBe(0)
      expect(JSON.parse(query.stdout).recordCount).toBe(2)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps the default parent facts and emits exclusive child facts with the same token owner', async () => {
    const { session } = await sessionWithChild()
    const [parent] = computeSessionFacts(session.spans)
    const facts = computeSessionFacts(session.spans, { includeSubagents: true })
    expect(facts).toHaveLength(2)
    const tree = buildSpanRunTree(session.spans, session.ref.path)
    expect(tree.nodes).toHaveLength(2)
    expect(tree.nodes.filter((node) => node.parentNodeId !== null)).toHaveLength(1)
    expect(facts.find((fact) => fact.sessionId === parent!.sessionId)).toEqual(parent)
    expect(parent!.tokens.input).toBe(3960)
    expect(parent!.tokens.output).toBe(75)
    const child = facts.find((fact) => fact.sessionId !== parent!.sessionId)!
    expect(child.parentSessionId).toBe(TOKEN_IDS.claude)
    expect(child.tokens.input).toBe(21)
    expect(child.tokens.output).toBe(5)
    expect(Date.parse(child.firstRecordAt.value!)).toBe(Date.parse('2026-10-14T11:00:04Z'))
    expect(parent!.tokens.input! + child.tokens.input!).toBe(3981)
    expect(computeSessionFacts(session.spans)).toEqual([parent])
  })

  it('exports the real workflow reader and relationship projection to the Runtime consumer', async () => {
    const { fixture, session } = await sessionWithChild()
    const selection = await collectSessionSelection([{ adapter: session.adapter, refs: [session.ref] }], {
      workflow: true, parents: false, home: fixture.home, bindSources: true,
    })
    expect(selection.workflow?.complete).toBe(true)
    expect(selection.rows).toHaveLength(1)
    expect(selection.rows[0]!.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(selection.rows[0]!.sourceFiles!.length).toBeGreaterThanOrEqual(2)
    expect(describeSessionRelationship(session.ref, selection.rows[0]!.spans).sessionId).toBe(TOKEN_IDS.claude)
    const metadata = computeSessionFacts(selection.rows[0]!.spans, { includeSubagents: true, includeContent: false })
    expect(metadata).toHaveLength(2)
    expect(metadata[0]!.humanTurns.value).toBeNull()
    expect(metadata.every((fact) => fact.typedTurnCounts.value !== null)).toBe(true)
  })


  it('keeps explicit PR repository and URL provenance without using the session repository', async () => {
    const { session } = await sessionWithChild()
    const [facts] = computeSessionFacts(session.spans)
    const created = facts!.pullRequests.value!.created[0]!
    expect(created.repository).toBe('acme/widgets')
    expect(created.url).toBe('https://github.com/acme/widgets/pull/12')
    expect(created.repositoryUnavailable).toBeNull()
  })

  it('keeps cross-repository PR identity explicit and refuses conflicting repository evidence', async () => {
    const { fixture, session } = await sessionWithChild()
    const original = await readFile(fixture.claude, 'utf8')
    for (const [command, output, action, repository] of [
      ['gh pr create -Racme/other --title Survey --body Done', 'https://github.com/acme/other/pull/12', 'created', 'acme/other'],
      ['gh-drew pr merge 12 --repo acme/other --merge', 'Merged pull request #12.', 'merged', 'acme/other'],
      ['gh pr create --repo acme/other --title Survey --body Done', 'https://github.com/acme/widgets/pull/12', 'created', null],
    ] as const) {
      await writeFile(fixture.claude, original.replace('gh pr create --title Survey --body Done', command).replace('https://github.com/acme/widgets/pull/12', output))
      const [facts] = computeSessionFacts(await parseSession(session.adapter, session.ref))
      const reference = facts!.pullRequests.value![action][0]!
      expect(reference.number).toBe('12')
      expect(reference.repository).toBe(repository)
      expect(reference.url).toBe(repository ? 'https://github.com/acme/other/pull/12' : null)
      if (!repository) expect(reference.repositoryUnavailable).toContain('disagree')
    }
  })

  it('fails closed with an actionable setup error against the installed Runtime before reading a session', async () => {
    const run = await runCli(['graphs', '--last', '1', '--format', 'json'], { env: { HOME: '/no-session-store' } })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    const error = JSON.parse(run.stderr)
    expect(error.code).toBe('setup')
    expect(error.error).toContain('--runtime-module')
  })
})
