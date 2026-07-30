import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-claude-task-scope-'))
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

describe('Claude task selection', () => {
  it('selects an automated top-level task without relabeling it as human', async () => {
    const path = join(dir, 'headless.jsonl')
    writeFileSync(
      path,
      [
        {
          type: 'user',
          uuid: 'headless-task',
          sessionId: 'headless',
          timestamp: '2026-01-01T00:00:00Z',
          promptSource: 'sdk',
          userType: 'external',
          message: {
            role: 'user',
            content: '## Current Skill\nExtract the transaction as strict JSON.\nReturn ONLY JSON.',
          },
        },
        {
          type: 'assistant',
          uuid: 'headless-answer',
          sessionId: 'headless',
          timestamp: '2026-01-01T00:00:01Z',
          message: {
            id: 'headless-message',
            role: 'assistant',
            content: '{"merchant":"Acme"}',
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n'),
    )

    const spans = await new ClaudeAdapter().parse(refFor(path), {
      taskScope: 'latest',
    })
    const prompt = spans.find((item) => item.name === 'user.prompt')

    expect(prompt?.attributes['tangle.actor']).toBe('injected')
    expect(prompt?.attributes.content).toContain('## Current Skill')
    expect(spans.some((item) => item.attributes.content === '{"merchant":"Acme"}')).toBe(true)
  })
})
