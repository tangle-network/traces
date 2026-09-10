/**
 * The session-facts sheet over a Claude Code transcript.
 *
 * The sheet's logic was already harness-neutral, but every fact it read was
 * emitted by the Codex adapter alone, so the same sheet that answered a Codex
 * session exactly answered a Claude Code session with a tool count eight times
 * too high, no subagents, no final message and almost no changed files. The
 * cause was not the sheet: the Claude adapter folds every spawned agent's
 * transcript into the parent's trace and marked none of it, emitted no message
 * span, no file-change span and no spawn marker, and classified turns from the
 * text when the harness had already recorded who typed each one.
 *
 * These fixtures are written by hand so each fact can be checked by eye.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { computeSessionFacts } from '../src/session-facts.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-claude-session-facts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function refFor(path: string): SessionRef {
  return { harness: 'claude-code', sessionId: 'fixture', path, cwd: null, mtimeMs: 0 }
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

/** Parse a fixture and return the single session's facts. */
async function factsFor(path: string) {
  const spans = await new ClaudeAdapter().parse(refFor(path))
  const sessions = computeSessionFacts(spans)
  expect(sessions).toHaveLength(1)
  return sessions[0]!
}

/**
 * One session whose agent typed at the keyboard, ran two tools, wrote one file
 * and spawned one subagent that ran three tools and wrote two files of its own.
 */
function writeDelegatingSession(name: string): string {
  const path = join(dir, `${name}.jsonl`)
  writeJsonl(path, [
    // A record that produces no span, and the session's first: the window is
    // over records, not spans.
    {
      type: 'file-history-snapshot',
      messageId: 'snap-1',
      snapshot: { messageId: 'snap-1', trackedFileBackups: {}, timestamp: '2026-02-01T00:00:00Z' },
      timestamp: '2026-02-01T00:00:00Z',
    },
    {
      type: 'user',
      uuid: 'human-1',
      sessionId: name,
      timestamp: '2026-02-01T00:00:01Z',
      userType: 'external',
      origin: { kind: 'human' },
      message: { role: 'user', content: 'audit the release and delegate the review' },
    },
    {
      type: 'assistant',
      uuid: 'turn-1',
      sessionId: name,
      timestamp: '2026-02-01T00:00:02Z',
      message: {
        id: 'message-1',
        role: 'assistant',
        model: 'test-model',
        content: [
          { type: 'text', text: 'Checking the release, then delegating the review.' },
          { type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'git status' } },
          { type: 'tool_use', id: 'call-edit', name: 'Edit', input: { file_path: '/repo/NOTES.md' } },
          {
            type: 'tool_use',
            id: 'call-agent',
            name: 'Task',
            input: { description: 'Review the release notes', prompt: 'Review it.', subagent_type: 'general-purpose' },
          },
        ],
      },
    },
    {
      type: 'file-history-delta',
      messageId: 'delta-1',
      snapshotMessageId: 'snap-1',
      trackingPath: '/repo/NOTES.md',
      backup: { backupFileName: null, version: 1, backupTime: '2026-02-01T00:00:03Z' },
      timestamp: '2026-02-01T00:00:03Z',
    },
    {
      type: 'user',
      uuid: 'result-1',
      sessionId: name,
      timestamp: '2026-02-01T00:00:04Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-agent', content: 'review done' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'turn-2',
      sessionId: name,
      timestamp: '2026-02-01T00:00:05Z',
      message: {
        id: 'message-2',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'The release is clean and the review is in.' }],
      },
    },
    // The last record of the session, and it produces no span either.
    { type: 'continued-in', sessionId: name, timestamp: '2026-02-01T00:00:06Z' },
  ])

  const subDir = join(dir, name, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeJsonl(join(subDir, 'agent-reviewer.jsonl'), [
    {
      type: 'user',
      uuid: 'child-brief',
      timestamp: '2026-02-01T00:00:02.100Z',
      isSidechain: true,
      message: { role: 'user', content: 'Review it.' },
    },
    {
      type: 'assistant',
      uuid: 'child-turn',
      timestamp: '2026-02-01T00:00:02.200Z',
      message: {
        id: 'child-message',
        role: 'assistant',
        model: 'test-model',
        content: [
          { type: 'text', text: 'Read the notes; two nits.' },
          { type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: '/repo/NOTES.md' } },
          { type: 'tool_use', id: 'child-write', name: 'Write', input: { file_path: '/repo/child-a.md' } },
          { type: 'tool_use', id: 'child-edit', name: 'Edit', input: { file_path: '/repo/child-b.md' } },
        ],
      },
    },
    // The child outlives the parent's last record; the parent's window must not
    // stretch to cover it.
    {
      type: 'assistant',
      uuid: 'child-final',
      timestamp: '2026-02-01T00:09:00Z',
      message: {
        id: 'child-final-message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Two nits, both fixed.' }],
      },
    },
  ])
  writeFileSync(
    join(subDir, 'agent-reviewer.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Review the release notes', toolUseId: 'call-agent' }),
  )
  return path
}

describe('session facts from a Claude Code transcript', () => {
  it('counts the session agent\'s tool calls and never the subagent\'s', async () => {
    const facts = await factsFor(writeDelegatingSession('delegating'))

    // Bash, Edit and the Task call that spawned the subagent.
    expect(facts.toolCalls.value).toBe(3)
    expect(facts.toolCallsByName.value).toEqual({ Bash: 1, Edit: 1, Task: 1 })
    // Read, Write and Edit, all made by the child.
    expect(facts.subagentToolSpans.value).toBe(3)
    expect(facts.subagentToolSpans.spanIds).toHaveLength(3)
    // The exclusion is checkable: no excluded span is in the counted list.
    for (const id of facts.subagentToolSpans.spanIds) {
      expect(facts.toolCalls.spanIds).not.toContain(id)
    }
  })

  it('lists each spawned subagent with the task its call named', async () => {
    const facts = await factsFor(writeDelegatingSession('spawned'))

    expect(facts.subagents.value).toHaveLength(1)
    const spawn = facts.subagents.value![0]!
    expect(spawn.taskName).toBe('Review the release notes')
    expect(spawn.taskNameUnavailable).toBeNull()
    expect(spawn.status).toBe('OK')
    // The spawn call, plus the lifecycle span standing for the child transcript.
    expect(spawn.spanIds).toHaveLength(2)
  })

  it('separates the session agent\'s final message from each subagent\'s', async () => {
    const facts = await factsFor(writeDelegatingSession('final-messages'))

    const own = facts.finalMessages.value!.filter((entry) => entry.task === null)
    expect(own).toHaveLength(1)
    expect(own[0]!.text).toBe('The release is clean and the review is in.')

    const delegated = facts.finalMessages.value!.filter((entry) => entry.task !== null)
    expect(delegated).toHaveLength(1)
    expect(delegated[0]!.task).toBe('Review the release notes')
    expect(delegated[0]!.text).toBe('Two nits, both fixed.')
  })

  it('reports the files this session changed, from the harness\'s own record', async () => {
    const facts = await factsFor(writeDelegatingSession('changed-files'))

    expect(facts.changedFiles.value!.map((entry) => entry.path)).toEqual(['/repo/NOTES.md'])
    // Two spans state the same change: the harness's file-history record and
    // the Edit call whose argument named the same path.
    expect(facts.changedFiles.value![0]!.spanIds).toHaveLength(2)
  })

  it('bounds the session by its own records, not by a subagent that outlived it', async () => {
    const facts = await factsFor(writeDelegatingSession('record-window'))

    expect(facts.firstRecordAt.value).toBe('2026-02-01T00:00:00Z')
    expect(facts.lastRecordAt.value).toBe('2026-02-01T00:00:06Z')
  })

  it('excludes the subagent\'s turns from the human count and says why', async () => {
    const facts = await factsFor(writeDelegatingSession('subagent-turns'))

    expect(facts.humanTurns.value!.map((turn) => turn.text)).toEqual([
      'audit the release and delegate the review',
    ])
    const subagentExclusion = facts.excludedTurns.value!.find((entry) =>
      entry.reason.includes('subagent this session spawned'))
    expect(subagentExclusion?.turns).toBe(1)
  })

  it('counts the turns the harness attributed to a person, including a queued one', async () => {
    const path = join(dir, 'human-origin.jsonl')
    writeJsonl(path, [
      {
        type: 'user',
        uuid: 'slash',
        sessionId: 'human-origin',
        timestamp: '2026-02-02T00:00:00Z',
        userType: 'external',
        origin: { kind: 'human' },
        message: {
          role: 'user',
          content: '<command-message>audit</command-message>\n<command-name>/audit</command-name>',
        },
      },
      {
        type: 'assistant',
        uuid: 'answer-1',
        sessionId: 'human-origin',
        timestamp: '2026-02-02T00:00:01Z',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
      },
      // A message sent while the turn was running: the CLI surfaces it inside
      // the turn as an attachment and opens no conversation turn for it.
      {
        type: 'attachment',
        uuid: 'queued-1',
        sessionId: 'human-origin',
        timestamp: '2026-02-02T00:00:02Z',
        attachment: {
          type: 'queued_command',
          prompt: 'also check the changelog',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: '2026-02-02T00:00:02Z',
        },
      },
      // A notification the harness wrote, which reads like a user turn.
      {
        type: 'user',
        uuid: 'notified',
        sessionId: 'human-origin',
        timestamp: '2026-02-02T00:00:03Z',
        userType: 'external',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: '<task-notification>worker complete</task-notification>' },
      },
      // The CLI's own record of a session command and of an interruption. Both
      // pass every text heuristic; neither carries a human origin.
      {
        type: 'user',
        uuid: 'login',
        sessionId: 'human-origin',
        timestamp: '2026-02-02T00:00:04Z',
        userType: 'external',
        message: { role: 'user', content: '<command-name>/login</command-name>\n<command-args></command-args>' },
      },
      {
        type: 'user',
        uuid: 'interrupted',
        sessionId: 'human-origin',
        timestamp: '2026-02-02T00:00:05Z',
        userType: 'external',
        message: { role: 'user', content: '[Request interrupted by user]' },
      },
    ])

    const facts = await factsFor(path)

    expect(facts.humanTurns.value!.map((turn) => turn.text)).toEqual([
      // The wrapper is how the CLI stores the line; the line is what was typed.
      '/audit',
      'also check the changelog',
    ])
    expect(facts.turnsByActor.value).toEqual([
      { actor: 'human', turns: 2, spanIds: expect.any(Array) },
      { actor: 'injected', turns: 3, spanIds: expect.any(Array) },
    ])
  })

  it('falls back to the text heuristics when the transcript records no origin', async () => {
    const path = join(dir, 'no-origin.jsonl')
    writeJsonl(path, [
      {
        type: 'user',
        uuid: 'typed',
        sessionId: 'no-origin',
        timestamp: '2026-02-03T00:00:00Z',
        userType: 'external',
        message: { role: 'user', content: 'ship the release' },
      },
      {
        type: 'user',
        uuid: 'reminder',
        sessionId: 'no-origin',
        timestamp: '2026-02-03T00:00:01Z',
        userType: 'external',
        message: { role: 'user', content: '<system-reminder>budget is low</system-reminder>' },
      },
    ])

    const facts = await factsFor(path)

    expect(facts.humanTurns.value!.map((turn) => turn.text)).toEqual(['ship the release'])
    expect(facts.excludedTurns.value!.map((entry) => entry.turns)).toEqual([1])
  })

  it('states that the transcript carries no cumulative token total', async () => {
    const facts = await factsFor(writeDelegatingSession('token-total'))

    expect(facts.tokenTotal.value).toBeNull()
    expect(facts.tokenTotal.unavailable).toContain('traces.session.total_tokens')
  })
})
