/**
 * `traces facts` says who acted in each session: the profile, model, harness,
 * skill set and directive variant, from the root span's `agent.*` attributes,
 * else the Claude Code session identity record, else the directives log, else
 * null with the reason. Spawned against the built CLI on a synthetic home.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CONVERSATION, IDENTITY, makeConversationHome, type ConversationHome } from './fixtures/conversation.js'
import { runCli } from './run-cli.js'

let fx: ConversationHome
beforeAll(async () => {
  fx = await makeConversationHome()
})

interface AgentFact {
  value: Record<string, string> | null
  spanIds: string[]
  unavailable: string | null
}

async function agentOf(ref: string): Promise<AgentFact> {
  const run = await runCli(['facts', ref, '--format', 'json'], { env: fx.env })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Array<{ agent: AgentFact }> }).sessions[0]!.agent
}

describe('facts: who acted', () => {
  it('reads the session identity record the SessionStart hook wrote', async () => {
    expect(await agentOf(fx.paths.claude)).toEqual({
      value: {
        profileDigest: IDENTITY['agent.profile.digest'],
        profileName: 'dotfiles',
        model: 'claude-opus-5-5[1m]',
        harness: 'claude-code',
        skillsDigest: IDENTITY['agent.skills.digest'],
        directiveVariant: 'evidence-lead-v1',
        source: 'session-identity',
      },
      spanIds: [],
      unavailable: null,
    })
  })

  it('falls back to the first variant the directives log pinned for a session with no record', async () => {
    const agent = await agentOf(fx.paths.logged)
    expect(agent.value).toEqual({ directiveVariant: 'evidence-lead-rhythm-v1', source: 'directives-log' })
  })

  it('is null with the reason when no source names anyone', async () => {
    const agent = await agentOf(fx.paths.unknown)
    expect(agent.value).toBeNull()
    expect(agent.unavailable).toContain('agent.profile.digest')
    expect(agent.unavailable).toContain(join('.local', 'state', 'session-identity', 'claude-code', `${CONVERSATION.unknown}.json`))
    const codex = await agentOf(fx.paths.fork)
    expect(codex.value).toBeNull()
    expect(codex.unavailable).toContain('no hook records who acted in codex sessions')
  })

  it("prefers the root span's agent attributes, citing the root span", async () => {
    const spansFile = join(fx.root, 'with-identity.otlp.jsonl')
    const convert = await runCli(['convert', fx.paths.unknown, '--out', spansFile], { env: fx.env })
    expect(convert.code).toBe(0)
    const lines = (await readFile(spansFile, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const root = lines.find((line) => line.parent_span_id === null || line.parent_span_id === undefined)!
    root.attributes = { ...(root.attributes as object), 'agent.profile.name': 'coder', 'agent.model': 'gpt-6', 'agent.harness': 'codex' }
    await writeFile(spansFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    const agent = await agentOf(spansFile)
    expect(agent.value).toEqual({ profileName: 'coder', model: 'gpt-6', harness: 'codex', source: 'spans' })
    expect(agent.spanIds).toEqual([root.span_id])
  })

  it('prints who acted on the text sheet', async () => {
    const run = await runCli(['facts', fx.paths.claude, '--format', 'text'], { env: fx.env })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('who: dotfiles sha256:5843…ca56 · claude-opus-5-5[1m] · evidence-lead-v1 (from session-identity)')
  })
})
