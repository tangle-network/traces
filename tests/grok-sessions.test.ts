import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const ID = '01a1d16b-fe5d-71e0-b881-4415a952a603'
const update = (timestamp: number, body: Record<string, unknown>) =>
  JSON.stringify({ timestamp, method: 'session/update', params: { sessionId: ID, update: body } })

/** A Grok Build session directory as `grok` 0.x writes it under ~/.grok/sessions/<cwd>/<id>/. */
async function grokHome(): Promise<{ home: string; dir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'traces-grok-'))
  const dir = join(home, '.grok', 'sessions', '%2Fwork', ID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'updates.jsonl'), [
    update(1794514878, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Inspect the repository' } }),
    update(1794514879, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Listing it.' } }),
    update(1794514880, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_cmd', kind: 'execute', rawInput: { command: 'ls' } }),
    update(1794514881, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: 'README.md' }),
    update(1794514882, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'One file.' } }),
  ].join('\n') + '\n')
  // The sibling event log has no session records; a ref naming it still means this session.
  await writeFile(join(dir, 'events.jsonl'), JSON.stringify({ ts: '2026-11-12T20:21:18.686Z', type: 'turn_started', session_id: ID }) + '\n')
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ current_model_id: 'grok-4.7' }))
  return { home, dir }
}

describe('Grok Build sessions', () => {
  it('answers facts for a Grok session named by id, by its directory files, and by its update log', async () => {
    const { home, dir } = await grokHome()
    for (const ref of [ID, dir, join(dir, 'events.jsonl'), join(dir, 'updates.jsonl')]) {
      const run = await runCli(['facts', ref, '--format', 'json'], { env: { HOME: home } })
      expect(run.code, `${ref}: ${run.stderr}${run.stdout}`).toBe(0)
      const report = JSON.parse(run.stdout) as { harness: string; spanCount: number; sessions: Array<{ sessionId: string }> }
      expect(report.harness).toBe('grok')
      expect(report.sessions.map((session) => session.sessionId)).toEqual([ID])
      expect(report.spanCount).toBeGreaterThanOrEqual(3)
      expect(run.stdout).toContain('run_terminal_cmd')
    }
  })

  it('retains the update log as the session source when a sibling file names the session', async () => {
    const { home, dir } = await grokHome()
    const out = join(home, 'bundle')
    const run = await runCli(['bundle', join(dir, 'events.jsonl'), '--out', out], { env: { HOME: home } })
    expect(run.code, run.stderr).toBe(0)
    expect(await readFile(join(out, 'session', 'transcript.jsonl'), 'utf8'))
      .toBe(await readFile(join(dir, 'updates.jsonl'), 'utf8'))
  })
})
