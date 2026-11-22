import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ATTR } from '@tangle-network/agent-trace-contract'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import type { OtlpSpan } from '../src/otlp.js'
import { runCli } from './run-cli.js'

/**
 * Two session shapes the Claude reader refused whole, rebuilt from real
 * transcripts with their text redacted and their record structure kept. Each
 * session also holds a Workflow run with a journal, as the real ones do, which
 * is what sends a session through traces' own Claude reader.
 *
 * - A resumed subagent writes an earlier assistant event again: the same uuid,
 *   message and time, a new `parentUuid`, and every usage count zeroed. It is
 *   one event, and the first copy's billing stands.
 * - A Workflow run's transcripts sit under the session, but no Workflow call in
 *   the session returned its run id: the one Workflow call before it was
 *   refused by a hook. Its child cannot be placed under a call, so it hangs off
 *   the session root with unknown parentage, like any child whose parent call
 *   is missing, and the rest of the session still reads.
 */

const home = mkdtempSync(join(tmpdir(), 'traces-claude-recovery-'))
const project = join(home, '.claude', 'projects', '-work')
afterAll(() => rmSync(home, { recursive: true, force: true }))

const USAGE_SESSION = '0a1d4e55-0000-4000-8000-0000000000a1'
const WORKFLOW_SESSION = '0a1d4e55-0000-4000-8000-0000000000b2'

type Row = Record<string, unknown>

function writeJsonl(path: string, rows: readonly Row[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function assistant(session: string, uuid: string, at: string, content: unknown[], extra: Row = {}): Row {
  return {
    type: 'assistant', uuid, sessionId: session, timestamp: at, ...extra,
    message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-opus-4-8', content },
  }
}

function toolResult(session: string, uuid: string, at: string, toolUseId: string, content: string, extra: Row = {}): Row {
  return {
    type: 'user', uuid, sessionId: session, timestamp: at, ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  }
}

/** A Workflow call that returned its run, the run's journal and one child that read a file. */
function boundWorkflow(session: string, runId: string, minute: string): Row[] {
  const transcriptDir = join(project, session, 'subagents', 'workflows', runId)
  writeWorkflowChild(session, transcriptDir, `${runId}-child`, minute)
  writeJsonl(join(transcriptDir, 'journal.jsonl'), [
    { type: 'started', key: 'worker', agentId: `${runId}-child`, phase: 'run', timestamp: `2026-01-02T00:${minute}:03Z` },
    { type: 'result', key: 'worker', agentId: `${runId}-child`, phase: 'run', timestamp: `2026-01-02T00:${minute}:06Z` },
  ])
  return [
    assistant(session, `call-${runId}`, `2026-01-02T00:${minute}:01Z`, [
      { type: 'tool_use', id: `use-${runId}`, name: 'Workflow', input: { script: 'REDACTED' } },
    ]),
    toolResult(session, `result-${runId}`, `2026-01-02T00:${minute}:02Z`, `use-${runId}`,
      `Workflow launched\nTranscript dir: ${transcriptDir}\nRun ID: ${runId}`,
      { toolUseResult: { runId, transcriptDir } }),
  ]
}

function writeWorkflowChild(session: string, transcriptDir: string, agentId: string, minute: string): void {
  mkdirSync(transcriptDir, { recursive: true })
  const child = { isSidechain: true, agentId, sessionId: session }
  writeJsonl(join(transcriptDir, `agent-${agentId}.jsonl`), [
    { type: 'user', uuid: `${agentId}-task`, timestamp: `2026-01-02T00:${minute}:03Z`, ...child, message: { role: 'user', content: 'REDACTED WORKFLOW TASK' } },
    { ...assistant(session, `${agentId}-read`, `2026-01-02T00:${minute}:04Z`, [
      { type: 'tool_use', id: `${agentId}-use-read`, name: 'Read', input: { file_path: '/redacted' } },
    ]), ...child },
    { ...toolResult(session, `${agentId}-read-result`, `2026-01-02T00:${minute}:05Z`, `${agentId}-use-read`, 'REDACTED'), ...child },
    { ...assistant(session, `${agentId}-answer`, `2026-01-02T00:${minute}:06Z`, [{ type: 'text', text: 'REDACTED ANSWER' }]), ...child },
  ])
  writeFileSync(join(transcriptDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }))
}

function writeUsageSession(): string {
  const path = join(project, `${USAGE_SESSION}.jsonl`)
  mkdirSync(project, { recursive: true })
  writeJsonl(path, [
    { type: 'user', uuid: 'prompt', sessionId: USAGE_SESSION, timestamp: '2026-01-02T00:00:00Z', message: { role: 'user', content: 'REDACTED TASK' } },
    assistant(USAGE_SESSION, 'spawn', '2026-01-02T00:00:01Z', [
      { type: 'tool_use', id: 'use-agent', name: 'Agent', input: { description: 'REDACTED', prompt: 'REDACTED', subagent_type: 'general-purpose' } },
    ]),
    toolResult(USAGE_SESSION, 'spawn-result', '2026-01-02T00:05:00Z', 'use-agent', 'REDACTED RESULT'),
    ...boundWorkflow(USAGE_SESSION, 'wf-journalled', '06'),
  ])
  const subagents = join(project, USAGE_SESSION, 'subagents')
  mkdirSync(subagents, { recursive: true })
  const worker = { isSidechain: true, agentId: 'worker', sessionId: USAGE_SESSION }
  const answer = [{ type: 'text', text: 'REDACTED WORKER ANSWER' }]
  const billed = { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 964714, cache_creation_input_tokens: 431 }
  const zeroed = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const first = assistant(USAGE_SESSION, 'worker-answer', '2026-01-02T00:00:03Z', answer, { ...worker, parentUuid: 'worker-task' })
  writeJsonl(join(subagents, 'agent-worker.jsonl'), [
    { type: 'user', uuid: 'worker-task', parentUuid: null, timestamp: '2026-01-02T00:00:02Z', ...worker, message: { role: 'user', content: 'REDACTED WORKER TASK' } },
    { ...first, message: { ...(first.message as Row), usage: billed } },
    { type: 'user', uuid: 'worker-followup', parentUuid: 'worker-answer', timestamp: '2026-01-02T00:01:00Z', ...worker, message: { role: 'user', content: 'REDACTED FOLLOW-UP' } },
    { ...first, parentUuid: 'worker-followup', message: { ...(first.message as Row), usage: zeroed } },
  ])
  writeFileSync(join(subagents, 'agent-worker.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'use-agent' }))
  return path
}

function writeWorkflowSession(): string {
  const path = join(project, `${WORKFLOW_SESSION}.jsonl`)
  mkdirSync(project, { recursive: true })
  writeJsonl(path, [
    { type: 'user', uuid: 'prompt', sessionId: WORKFLOW_SESSION, timestamp: '2026-01-02T00:00:00Z', message: { role: 'user', content: 'REDACTED TASK' } },
    assistant(WORKFLOW_SESSION, 'refused-call', '2026-01-02T00:00:01Z', [
      { type: 'tool_use', id: 'use-refused', name: 'Workflow', input: { script: 'REDACTED' } },
    ]),
    toolResult(WORKFLOW_SESSION, 'refused-result', '2026-01-02T00:00:02Z', 'use-refused', 'PreToolUse:Workflow hook error: REDACTED',
      { toolUseResult: 'Error: REDACTED' }),
    assistant(WORKFLOW_SESSION, 'bash-call', '2026-01-02T00:00:10Z', [
      { type: 'tool_use', id: 'use-bash', name: 'Bash', input: { command: 'REDACTED' } },
    ]),
    toolResult(WORKFLOW_SESSION, 'bash-result', '2026-01-02T00:00:20Z', 'use-bash', 'REDACTED'),
    ...boundWorkflow(WORKFLOW_SESSION, 'wf-journalled', '30'),
  ])
  // The orphan run: transcripts on disk, no call in the session returned `wf-orphan`.
  writeWorkflowChild(WORKFLOW_SESSION, join(project, WORKFLOW_SESSION, 'subagents', 'workflows', 'wf-orphan'), 'orphan', '10')
  return path
}

interface Facts {
  sessions: Array<{
    toolCallsByName: { value: Record<string, number> }
    subagentTools: { value: Array<{ name: string; calls: number }> }
  }>
}

async function facts(path: string): Promise<Facts> {
  const run = await runCli(['facts', path, '--format', 'json', '--no-content'], { env: { HOME: home } })
  expect(run.code, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Facts
}

function parse(path: string, sessionId: string): Promise<OtlpSpan[]> {
  return new ClaudeAdapter().parse({ harness: 'claude-code', sessionId, path, cwd: null, mtimeMs: 0 })
}

describe('Claude sessions the reader used to refuse whole', () => {
  const usage = writeUsageSession()
  const workflow = writeWorkflowSession()

  it('counts a subagent event that a resumed transcript re-emits with its usage zeroed once, with its first billing', async () => {
    await facts(usage)
    const spans = await parse(usage, USAGE_SESSION)
    const turns = spans.filter((item) => item.name === 'llm.turn'
      && String(item.attributes['traces.claude.source_span_id']).includes('worker-answer'))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.attributes['llm.token_count.prompt']).toBe(2)
    expect(turns[0]!.attributes['llm.token_count.completion']).toBe(3)
    expect(turns[0]!.attributes['llm.token_count.prompt_cache_hit']).toBe(964714)
  })

  it('reads a Workflow run no call in the session returned, its child under the root with unknown parentage', async () => {
    const sheet = await facts(workflow)
    // The parent's own calls stay its own; both runs' reads are the children's.
    expect(sheet.sessions[0]!.toolCallsByName.value).toEqual({ Bash: 1, Workflow: 2 })
    expect(sheet.sessions[0]!.subagentTools.value).toEqual([{ name: 'Read', calls: 2, failed: 0 }])

    const spans = await parse(workflow, WORKFLOW_SESSION)
    const orphan = spans.filter((item) => String(item.attributes['traces.claude.source_span_id']).startsWith('workflows:wf-orphan:'))
    expect(orphan.length).toBeGreaterThan(0)
    expect(orphan.every((item) => item.attributes['traces.claude.workflow_run_unlinked'] === 'wf-orphan')).toBe(true)
    const ids = new Set(orphan.map((item) => item.span_id))
    const top = orphan.filter((item) => !ids.has(item.parent_span_id ?? ''))
    expect(top.length).toBeGreaterThan(0)
    expect(top.every((item) => item.attributes[ATTR.parentConfidence] === 'unknown')).toBe(true)
    expect(top.every((item) => item.attributes['traces.claude.source_parent_span_id'] === `root:${WORKFLOW_SESSION}`)).toBe(true)

    // The run a call did return still hangs under that call.
    const bound = spans.filter((item) => String(item.attributes['traces.claude.source_span_id']).startsWith('workflows:wf-journalled:'))
    const call = spans.find((item) => item.attributes['tool.name'] === 'Workflow' && item.status.code !== 'ERROR')
    expect(bound.some((item) => item.parent_span_id === call?.span_id)).toBe(true)
    expect(bound.every((item) => item.attributes['traces.claude.workflow_run_unlinked'] === undefined)).toBe(true)
  })
})
