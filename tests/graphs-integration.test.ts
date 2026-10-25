/** Real native reader → public facts SDK, plus the built CLI's graph boundary. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectSessionSelection, computeSessionFacts, describeSessionRelationship, scanSessions } from '../src/index.js'
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
  it('keeps the default parent facts and emits exclusive child facts with the same token owner', async () => {
    const { session } = await sessionWithChild()
    const [parent] = computeSessionFacts(session.spans)
    const facts = computeSessionFacts(session.spans, { includeSubagents: true })
    expect(facts).toHaveLength(2)
    expect(facts.find((fact) => fact.sessionId === parent!.sessionId)).toEqual(parent)
    expect(parent!.tokens.input).toBe(3960)
    expect(parent!.tokens.output).toBe(75)
    const child = facts.find((fact) => fact.sessionId !== parent!.sessionId)!
    expect(child.parentSessionId).toBe(TOKEN_IDS.claude)
    expect(child.tokens.input).toBe(21)
    expect(child.tokens.output).toBe(5)
    expect(child.firstRecordAt.value).toBe('2026-10-14T11:00:04Z')
    expect(parent!.tokens.input! + child.tokens.input!).toBe(3981)
    expect(computeSessionFacts(session.spans)).toEqual([parent])
  })

  it('exports the real workflow reader and relationship projection to the Runtime consumer', async () => {
    const { fixture, session } = await sessionWithChild()
    const selection = await collectSessionSelection([{ adapter: session.adapter, refs: [session.ref] }], {
      workflow: true, parents: false, home: fixture.home,
    })
    expect(selection.workflow?.complete).toBe(true)
    expect(selection.rows).toHaveLength(1)
    expect(describeSessionRelationship(session.ref, selection.rows[0]!.spans).sessionId).toBe(TOKEN_IDS.claude)
    const metadata = computeSessionFacts(selection.rows[0]!.spans, { includeSubagents: true, includeContent: false })
    expect(metadata).toHaveLength(2)
    expect(metadata[0]!.humanTurns.value).toBeNull()
    expect(metadata.every((fact) => fact.typedTurnCounts.value !== null)).toBe(true)
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
