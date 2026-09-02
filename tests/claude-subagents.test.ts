import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import type { OtlpSpan } from '../src/otlp.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-claude-subagents-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function refFor(path: string): SessionRef {
  return {
    harness: 'claude-code',
    sessionId: 'fixture',
    path,
    cwd: null,
    mtimeMs: 0,
  }
}

function writeChild(input: {
  subDir: string
  id: string
  toolUseId: string
  timestamp: string
  content: string
}): void {
  mkdirSync(input.subDir, { recursive: true })
  writeFileSync(
    join(input.subDir, `agent-${input.id}.jsonl`),
    [
      {
        type: 'user',
        uuid: `${input.id}-user`,
        timestamp: input.timestamp,
        isSidechain: true,
        message: { role: 'user', content: `${input.content} TASK` },
      },
      {
        type: 'assistant',
        uuid: `${input.id}-assistant`,
        timestamp: new Date(Date.parse(input.timestamp) + 1_000).toISOString(),
        message: {
          id: `${input.id}-message`,
          role: 'assistant',
          content: `${input.content} ANSWER`,
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'),
  )
  writeFileSync(
    join(input.subDir, `agent-${input.id}.meta.json`),
    JSON.stringify({ agentType: 'worker', toolUseId: input.toolUseId }),
  )
}

function contentOrder(spans: readonly OtlpSpan[]): string[] {
  return spans.flatMap((item) =>
    typeof item.attributes.content === 'string' ? [item.attributes.content] : [])
}

describe('Claude subagent folding', () => {
  it('orders parallel children by event time instead of filename order', async () => {
    const path = join(dir, 'chronological.jsonl')
    writeFileSync(
      path,
      [
        {
          type: 'user',
          uuid: 'root-user',
          sessionId: 'chronological',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'ROOT TASK' },
        },
        {
          type: 'assistant',
          uuid: 'root-assistant',
          sessionId: 'chronological',
          timestamp: '2026-01-01T00:00:01Z',
          message: {
            id: 'root-message',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'late-call', name: 'Agent', input: {} },
              { type: 'tool_use', id: 'early-call', name: 'Agent', input: {} },
            ],
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    const subDir = join(dir, 'chronological', 'subagents')
    writeChild({
      subDir,
      id: 'a-late',
      toolUseId: 'late-call',
      timestamp: '2026-01-01T00:00:04Z',
      content: 'LATE',
    })
    writeChild({
      subDir,
      id: 'z-early',
      toolUseId: 'early-call',
      timestamp: '2026-01-01T00:00:02Z',
      content: 'EARLY',
    })

    const spans = await new ClaudeAdapter().parse(refFor(path))
    const nonRoot = spans.slice(1)
    const byId = new Map(spans.map((item, index) => [item.span_id, index]))

    expect(contentOrder(spans)).toEqual([
      'ROOT TASK',
      'EARLY TASK',
      'EARLY ANSWER',
      'LATE TASK',
      'LATE ANSWER',
    ])
    expect(nonRoot.map((item) => item.attributes.step)).toEqual(
      nonRoot.map((_, index) => index),
    )
    for (const [index, item] of spans.entries()) {
      if (!item.parent_span_id) continue
      expect(byId.get(item.parent_span_id)).toBeLessThan(index)
    }
  })

  it('keeps stale children visible in full output and excludes them from one task', async () => {
    const path = join(dir, 'stale-child.jsonl')
    writeFileSync(
      path,
      JSON.stringify({
        type: 'user',
        uuid: 'root-user',
        sessionId: 'stale-child',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'CURRENT TASK' },
      }),
    )
    const subDir = join(dir, 'stale-child', 'subagents')
    writeChild({
      subDir,
      id: 'stale',
      toolUseId: 'missing-call',
      timestamp: '2026-01-01T00:00:01Z',
      content: 'STALE',
    })

    const adapter = new ClaudeAdapter()
    const all = await adapter.parse(refFor(path))
    const latest = await adapter.parse(refFor(path), { taskScope: 'latest' })
    const stale = all.filter(
      (item) => item.attributes['agent.name'] === 'subagent:worker',
    )

    expect(stale).toHaveLength(2)
    expect(stale.every(
      (item) => item.attributes['traces.claude.source_parent_span_id'] === 'root:stale-child',
    )).toBe(true)
    expect(stale.every(
      (item) => item.attributes['traces.claude.parent_tool_missing'] === true,
    )).toBe(true)
    expect(stale.every(
      (item) => item.attributes['traces.claude.parent_tool_use_id'] === 'missing-call',
    )).toBe(true)
    expect(contentOrder(latest)).toEqual(['CURRENT TASK'])
    expect(latest[0]?.attributes).toMatchObject({
      'traces.claude.skipped_subagent_count': 1,
      'traces.claude.skipped_subagent_ids': '["stale"]',
      'traces.claude.skipped_subagent_ids_omitted': 0,
    })
  })
})

describe('duplicate subagent ids', () => {
  // `agentId` is a FILE BASENAME, so the same id legitimately reaches one parse from two
  // different directories — a subagent continued across sessions, or a workflow transcript dir
  // pulled in beside the session's own. Three such collisions exist on a single developer
  // machine, and this used to throw, taking `traces watch` down before it printed anything.
  //
  // An observability tool that crashes on the data it exists to read is worse than one that
  // resolves an ambiguity, so both files are still parsed and emitted.
  it('parses both files instead of throwing when two share an agent id', async () => {
    const path = join(dir, 'dup-ids.jsonl')
    writeFileSync(
      path,
      [
        {
          type: 'assistant',
          uuid: 'root-assistant',
          sessionId: 'dup-ids',
          timestamp: '2026-01-01T00:00:01Z',
          message: {
            id: 'root-message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-one', name: 'Agent', input: {} }],
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    const subDir = join(dir, 'dup-ids', 'subagents')
    writeChild({
      subDir,
      id: 'collides',
      toolUseId: 'call-one',
      timestamp: '2026-01-01T00:00:02Z',
      content: 'FIRST',
    })
    // Same basename, different directory — exactly the on-disk shape that crashed.
    writeChild({
      subDir: join(subDir, 'nested'),
      id: 'collides',
      toolUseId: 'call-one',
      timestamp: '2026-01-01T00:00:03Z',
      content: 'SECOND',
    })

    const spans = await new ClaudeAdapter().parse(refFor(path))
    const contents = contentOrder(spans)
    // Neither file is dropped: deduping the parent-lookup map must not drop a transcript.
    expect(contents.some((c) => c.startsWith('FIRST'))).toBe(true)
    expect(contents.some((c) => c.startsWith('SECOND'))).toBe(true)
  })
})
