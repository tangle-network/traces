/**
 * `traces facts` turns: who typed each one, the reply, the correction signals,
 * and `--format jsonl`, one row per typed turn. Spawned against the built CLI
 * on a synthetic home (`fixtures/conversation.ts`).
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CONVERSATION, makeConversationHome, TEXT, type ConversationHome } from './fixtures/conversation.js'
import { runCli } from './run-cli.js'

let fx: ConversationHome
beforeAll(async () => {
  fx = await makeConversationHome()
})

interface Turn {
  spanId: string
  author: string
  at: string
  text: string
  answered: string | null
  reply: string | null
  interrupted: boolean
  signals: string[]
}

interface Session {
  sessionId: string
  humanTurns: { value: Turn[] | null }
  excludedTurns: { value: Array<{ reason: string; author: string; turns: number; spanIds: string[] }> | null }
}

async function facts(argv: readonly string[]): Promise<Session[]> {
  const run = await runCli(['facts', ...argv, '--format', 'json'], { env: fx.env })
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Session[] }).sessions
}

describe('facts: who typed each turn', () => {
  it('counts only the turns a person typed to the agent', async () => {
    const [session] = await facts([fx.paths.claude])
    expect(session!.humanTurns.value!.map((turn) => turn.text)).toEqual([TEXT.ask, TEXT.correction, TEXT.stop])
    expect(session!.humanTurns.value!.every((turn) => turn.author === 'human')).toBe(true)
  })

  it('lists fleet messages, relays, notifications, interrupts and harness commands as excluded, with who wrote them', async () => {
    const [session] = await facts([fx.paths.claude])
    const excluded = session!.excludedTurns.value!
    const byAuthor = (author: string) => excluded.filter((entry) => entry.author === author).reduce((sum, entry) => sum + entry.turns, 0)
    // The fleet message and the session-to-session message.
    expect(byAuthor('fleet')).toBe(2)
    expect(byAuthor('relay')).toBe(1)
    // The task notification and the interrupt marker.
    expect(byAuthor('injected')).toBe(2)
    // `/model opus`: a person typed it, to the harness.
    const command = excluded.find((entry) => entry.reason.startsWith('a command the person gave the harness'))
    expect(command).toMatchObject({ author: 'human', turns: 1 })
    const excludedIds = new Set(excluded.flatMap((entry) => entry.spanIds))
    for (const turn of session!.humanTurns.value!) expect(excludedIds.has(turn.spanId)).toBe(false)
  })
})

describe('facts: replies and correction signals', () => {
  it('pairs each turn with the agent message it answered and the first one after it', async () => {
    const [ask, correction, stop] = (await facts([fx.paths.claude]))[0]!.humanTurns.value!
    expect(ask).toMatchObject({ answered: null, reply: TEXT.claim })
    expect(correction).toMatchObject({ answered: TEXT.claim, reply: TEXT.understood })
    expect(stop).toMatchObject({ answered: TEXT.claim, reply: TEXT.understood })
  })

  it('marks a turn after a completion claim, after an interrupt and after a rejected tool', async () => {
    const [ask, correction, stop] = (await facts([fx.paths.claude]))[0]!.humanTurns.value!
    expect(ask!.signals).toEqual([])
    // The claim came after the first ask; the fleet turns in between do not reset it.
    expect(correction!.signals).toEqual(['after-claim'])
    // The person rejected `rm -rf build` and interrupted; no agent message since the last turn.
    expect(stop!.signals).toEqual(['interrupt', 'rejected-tool'])
    expect([ask!.interrupted, correction!.interrupted, stop!.interrupted]).toEqual([false, true, false])
  })
})

describe('facts --format jsonl', () => {
  it('writes one row per typed turn, with its host, session and author', async () => {
    const run = await runCli(['facts', fx.paths.claude, '--format', 'jsonl'], { env: fx.env })
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    const rows = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    for (const row of rows) {
      for (const key of ['host', 'harness', 'session', 'cwd', 'at', 'author', 'text', 'answered', 'reply', 'interrupted', 'signals', 'spanId']) {
        expect(row).toHaveProperty(key)
      }
      expect(row).toMatchObject({ harness: 'claude-code', session: CONVERSATION.claude, cwd: fx.cwd })
      expect(typeof row.host).toBe('string')
    }
    expect(rows.map((row) => row.author)).toEqual(['human', 'fleet', 'fleet', 'human', 'human', 'relay'])
    expect(rows.map((row) => row.at)).toEqual([...rows.map((row) => row.at as string)].sort())
    expect(rows[5]).toMatchObject({ reply: TEXT.relayReply, signals: [] })
    // A fleet message is another agent talking: it carries no correction signal.
    expect(rows.filter((row) => row.author === 'fleet').map((row) => row.signals)).toEqual([[], []])
  })

  it("names the archived host when it reads a trace archive's <host>/home store root", async () => {
    const storeRoot = join(fx.root, 'archive', 'host-b', 'home')
    const copy = join(storeRoot, '.claude', 'projects', '-home-drew-w-app', `${CONVERSATION.claude}.jsonl`)
    await mkdir(dirname(copy), { recursive: true })
    await copyFile(fx.paths.claude, copy)
    const run = await runCli(
      ['facts', storeRoot, '--since', '2026-10-14T00:00:00Z', '--until', '2026-10-15T00:00:00Z', '--harness', 'claude-code', '--format', 'jsonl'],
      { env: fx.env },
    )
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    const rows = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { host: string; session: string })
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map((row) => `${row.host} ${row.session}`))).toEqual(new Set([`host-b ${CONVERSATION.claude}`]))
  })

  it('refuses --no-content, whose rows would carry no text', async () => {
    const run = await runCli(['facts', fx.paths.claude, '--format', 'jsonl', '--no-content'], { env: fx.env })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    expect(JSON.parse(run.stderr)).toMatchObject({ code: 'usage' })
  })
})

describe('facts: a Codex fork the person made', () => {
  it('counts the turns typed into the fork', async () => {
    const [session] = await facts([fx.paths.fork])
    expect(session!.sessionId).toBe(CONVERSATION.fork)
    expect(session!.humanTurns.value!.map((turn) => turn.text)).toEqual(['Try the other approach in this fork.'])
    expect(session!.humanTurns.value![0]!.reply).toBe('Trying it.')
  })
})
