import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexExecAdapter, CodexExecStreamError } from '../src/adapters/codex-exec.js'
import { resolveAdapter } from '../src/registry.js'
import { buildPolicyEvidenceRecord } from '../src/evidence.js'
import { parseSession } from '../src/session-source.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-codex-exec-'))
const execFileAsync = promisify(execFile)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sourceMtime = Date.parse('2026-07-28T00:00:00.000Z')
// Excerpts of Discovery run terraform-dc-build-20261009g's Sandbox live streams:
// whole lines in their original order, with long strings cut to 240 characters.
const liveStreamFixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox-live-stream')

function source(events: readonly unknown[], name = 'codex-exec.jsonl'): string {
  const path = join(dir, name)
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''))
  return path
}

function ref(path: string): SessionRef {
  return {
    harness: 'codex-exec',
    sessionId: path,
    path,
    cwd: null,
    mtimeMs: sourceMtime,
  }
}

function kind(spans: Awaited<ReturnType<CodexExecAdapter['parse']>>, value: string) {
  return spans.filter((item) => item.attributes['openinference.span.kind'] === value)
}

describe('Codex exec JSONL adapter', () => {
  it('cryptographically binds explicit evidence to the stable source file', async () => {
    const path = source([
      { type: 'thread.started', thread_id: 'thread-bound' },
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ], 'bound.jsonl')
    const expected = createHash('sha256')
      .update([
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-bound' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ].join('\n') + '\n')
      .digest('hex')

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'evidence',
      '--harness',
      'codex-exec',
      '--session',
      path,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    const evidence = JSON.parse(stdout) as {
      provenance?: { sourceSha256?: string }
    }

    expect(evidence.provenance?.sourceSha256).toBe(expected)
    expect(evidence.provenance?.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('pairs command and file lifecycles and preserves terminal usage without invented timing', async () => {
    const path = source([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'printf ok',
          status: 'in_progress',
          aggregated_output: '',
          exit_code: null,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'printf ok',
          status: 'completed',
          aggregated_output: 'ok',
          exit_code: 0,
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'file-1',
          type: 'file_change',
          changes: [{ path: '/workspace/result.txt', kind: 'add' }],
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'file-1',
          type: 'file_change',
          changes: [{ path: '/workspace/result.txt', kind: 'add' }],
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: { id: 'error-1', type: 'error', message: 'recovered transient failure' },
      },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: 'Implemented and checked.' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 39_700,
          cached_input_tokens: 29_184,
          output_tokens: 68,
          reasoning_output_tokens: 23,
        },
      },
    ])
    const session = ref(path)
    const spans = await parseSession(new CodexExecAdapter(), session)
    const tools = kind(spans, 'TOOL')
    const llms = kind(spans, 'LLM')
    const root = kind(spans, 'AGENT')[0]!
    const command = tools.find((item) => item.attributes['tool.name'] === 'exec_command')!
    const file = tools.find((item) => item.attributes['tool.name'] === 'apply_patch')!
    const message = spans.find((item) => item.name === 'message.assistant')!
    const itemError = spans.find((item) => item.name === 'error.codex_item')!

    expect(session.sessionId).toBe('thread-1')
    expect(spans).toHaveLength(6)
    expect(tools).toHaveLength(2)
    expect(llms).toHaveLength(1)
    expect(command).toMatchObject({
      span_id: 'tool:0:command-1',
      parent_span_id: 'llm:0',
      status: { code: 'OK' },
      start_time: '2026-07-28T00:00:00.000Z',
      end_time: '2026-07-28T00:00:00.000Z',
    })
    expect(command.attributes).toMatchObject({
      'input.value': '{"cmd":"printf ok"}',
      'output.value': 'ok',
      'traces.codex.exec_exit_code': 0,
      'process.exit_code': 0,
      'traces.codex.exec_lifecycle': 'paired',
    })
    expect(file).toMatchObject({
      span_id: 'tool:0:file-1',
      parent_span_id: 'llm:0',
      status: { code: 'OK' },
    })
    expect(file.attributes['input.value']).toBe(
      '{"changes":[{"kind":"add","path":"/workspace/result.txt"}]}',
    )
    expect(message.attributes.content).toBe('Implemented and checked.')
    expect(itemError).toMatchObject({
      status: { code: 'ERROR', message: 'recovered transient failure' },
    })
    expect(llms[0]!.attributes).toMatchObject({
      'llm.token_count.prompt': 39_700,
      'llm.token_count.prompt_cache_hit': 29_184,
      'llm.token_count.completion': 68,
      'llm.token_count.reasoning': 23,
    })
    expect(root).toMatchObject({
      trace_id: 'thread-1',
      status: { code: 'OK' },
      start_time: '2026-07-28T00:00:00.000Z',
      end_time: '2026-07-28T00:00:00.000Z',
    })
    expect(root.attributes).toMatchObject({
      'traces.codex.exec_event_count': 9,
      'traces.codex.exec_ignored_event_count': 0,
      'traces.codex.exec_ignored_item_count': 0,
      'traces.codex.exec_event_timestamp_count': 0,
      'traces.codex.exec_time_source': 'file_mtime',
    })

    const evidence = await buildPolicyEvidenceRecord(session, spans)
    expect(evidence).toMatchObject({
      kind: 'traces.policy_evidence.session',
      session: { harness: 'codex-exec', sessionId: 'thread-1' },
      metrics: {
        spanCount: 6,
        llmTurnCount: 1,
        toolCallCount: 2,
        erroredToolCallCount: 0,
        inputTokens: 39_700,
        outputTokens: 68,
      },
      provenance: {
        notCampaignCell: true,
        evidenceKind: 'session-summary',
      },
    })
  })

  it('marks an unfinished command, its turn, and its session as failed', async () => {
    const path = source([
      { type: 'thread.started', thread_id: 'thread-failed' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'command-failed',
          type: 'command_execution',
          command: 'false',
          status: 'in_progress',
        },
      },
      { type: 'turn.failed', error: { message: 'command execution aborted the turn' } },
    ], 'failed.jsonl')
    const session = ref(path)
    const spans = await new CodexExecAdapter().parse(session)
    const tool = kind(spans, 'TOOL')[0]!
    const llm = kind(spans, 'LLM')[0]!
    const root = kind(spans, 'AGENT')[0]!

    expect(tool.status).toEqual({ code: 'ERROR', message: 'command execution aborted the turn' })
    expect(tool.attributes['traces.codex.exec_item_status']).toBe('interrupted')
    expect(llm.status).toEqual({ code: 'ERROR', message: 'command execution aborted the turn' })
    expect(root.status).toEqual({ code: 'ERROR', message: 'Codex exec stream failed' })
    const evidence = await buildPolicyEvidenceRecord(session, spans)
    expect(evidence.metrics).toMatchObject({
      llmTurnCount: 1,
      toolCallCount: 1,
      erroredToolCallCount: 1,
    })
  })

  it.each([
    {
      name: 'empty input',
      events: [],
      error: 'no supported events found',
    },
    {
      name: 'rollout JSONL passed to the exec adapter',
      events: [{ type: 'session_meta', payload: { id: 'rollout-1' } }],
      error: 'no supported events found',
    },
    {
      name: 'missing thread start',
      events: [{ type: 'turn.started' }],
      error: 'turn.started appeared before thread.started',
    },
  ])('rejects $name instead of emitting root-only evidence', async ({ name, events, error }) => {
    const path = source(events, `${name.replaceAll(' ', '-')}.jsonl`)
    await expect(new CodexExecAdapter().parse(ref(path))).rejects.toMatchObject({
      name: 'CodexExecStreamError',
      sourcePath: path,
      message: expect.stringContaining(error),
    })
  })

  it('is available through the public codex-exec and codex-json names', () => {
    expect(resolveAdapter('codex-exec')).toBeInstanceOf(CodexExecAdapter)
    expect(resolveAdapter('codex-json')).toBeInstanceOf(CodexExecAdapter)
    expect(new CodexExecStreamError('/tmp/source.jsonl', 'bad').message).not.toContain('undefined')
  })
})

describe('Codex exec events inside a Sandbox live stream', () => {
  it('reads Codex raw envelopes from a director that is still working', async () => {
    const path = join(liveStreamFixtures, 'codex-director-in-progress.jsonl')
    const session = ref(path)
    const spans = await parseSession(new CodexExecAdapter(), session)
    const root = kind(spans, 'AGENT')[0]!
    const turn = kind(spans, 'LLM')[0]!
    const tools = kind(spans, 'TOOL')
    const byName = (name: string) => tools.find((item) => item.attributes['tool.name'] === name)!

    expect(session.sessionId).toBe('01a11f47-635a-77c1-bc39-9f09d3898731')
    // Paths such as /home/agent/work name the sandbox, not this host.
    expect(session.environment).toEqual({ sandboxId: 'sandbox-944efaf3519a', cwd: null })
    expect(root.attributes['tangle.sandbox.id']).toBe('sandbox-944efaf3519a')
    expect(root.attributes['git.repository']).toBeUndefined()
    expect(root.attributes['traces.repo_resolution_source']).toBeUndefined()
    expect(tools.map((item) => item.attributes['tool.name'])).toEqual([
      'exec_command',
      'mcp__agent-runtime-coordination__read_journal',
      'exec_command',
      'apply_patch',
      'web_search',
      'exec_command',
    ])

    const journal = byName('mcp__agent-runtime-coordination__read_journal')
    expect(journal.status).toEqual({ code: 'OK' })
    expect(journal.start_time).toBe('2026-10-09T06:09:12.145Z')
    expect(JSON.parse(journal.attributes['input.value'] as string)).toEqual({
      server: 'agent-runtime-coordination',
      tool: 'read_journal',
      arguments: { limit: 100, maxBytes: 40000 },
    })
    expect(journal.attributes['output.value']).toContain('"entries":[]')

    // Source reads resolve to the Codex event inside the envelope, not the envelope.
    const located = await new CodexExecAdapter().parse(ref(path), { captureSources: true })
    const locatedJournal = located.find((item) => item.span_id === journal.span_id)!
    expect(locatedJournal.attributes['traces.source_record.input.value']).toContain('#/data/event/item/server')

    const search = byName('web_search')
    expect(search.status).toEqual({ code: 'OK' })
    expect(JSON.parse(search.attributes['input.value'] as string).query).toContain('site.cbre.com')
    expect(search.attributes['output.value']).toContain('Global Data Center Trends 2025')

    // Codex never completed the added file, and the last command is still running.
    const openItems = tools.filter((item) => item.attributes['traces.codex.exec_item_status'] === 'in_progress')
    expect(openItems.map((item) => item.attributes['traces.codex.exec_item_id'])).toEqual(['item_11', 'item_40'])
    for (const item of openItems) expect(item.status).toEqual({ code: 'UNSET' })

    expect(turn.status).toEqual({ code: 'UNSET' })
    expect(turn.attributes).toMatchObject({
      'traces.codex.exec_turn_status': 'in_progress',
      'traces.codex.exec_open_item_count': 2,
    })
    expect(turn.start_time).toBe('2026-10-09T06:08:56.753Z')
    expect(turn.end_time).toBe('2026-10-09T06:14:21.190Z')

    expect(root.status).toEqual({ code: 'UNSET' })
    expect(root.attributes).toMatchObject({
      'traces.codex.exec_stream_status': 'in_progress',
      'traces.codex.stream_envelope': 'sandbox-live-stream',
      'traces.codex.exec_event_count': 12,
      'traces.codex.exec_ignored_event_count': 11,
      'traces.codex.exec_event_timestamp_count': 0,
      'traces.codex.exec_envelope_timestamp_count': 12,
      'traces.codex.exec_time_source': 'envelope',
    })
  })

  it('keeps Codex configuration warnings issued before the first turn', async () => {
    const spans = await new CodexExecAdapter().parse(ref(join(liveStreamFixtures, 'codex-config-warnings.jsonl')))
    const root = kind(spans, 'AGENT')[0]!
    const warnings = spans.filter((item) => item.name === 'error.codex_item')

    expect(warnings.map((item) => item.span_id)).toEqual(['error:thread:item_0', 'error:thread:item_1'])
    for (const warning of warnings) {
      expect(warning.parent_span_id).toBe(root.span_id)
      expect(warning.status.message).toContain('Ignored unsupported project-local config keys')
    }
    expect(kind(spans, 'TOOL')).toHaveLength(1)
    expect(root.attributes['traces.codex.exec_stream_status']).toBe('in_progress')
  })

  it('fails the open turn when the Sandbox cancels the execution', async () => {
    const spans = await new CodexExecAdapter().parse(ref(join(liveStreamFixtures, 'codex-cancelled-by-sandbox.jsonl')))
    const root = kind(spans, 'AGENT')[0]!
    const turn = kind(spans, 'LLM')[0]!
    const streamError = spans.find((item) => item.name === 'error.codex_stream')!

    expect(kind(spans, 'TOOL').map((item) => item.attributes['tool.name'])).toEqual([
      'mcp__agent-runtime-coordination__knowledge_read',
      'mcp__agent-runtime-coordination__read_journal',
      'mcp__agent-runtime-coordination__submit_result',
    ])
    expect(streamError.status).toEqual({ code: 'ERROR', message: 'Execution cancelled by user' })
    expect(streamError.start_time).toBe('2026-10-09T06:34:15.145Z')
    expect(turn.status).toEqual({ code: 'ERROR', message: 'Execution cancelled by user' })
    expect(root.status.code).toBe('ERROR')
    expect(root.attributes['traces.codex.exec_stream_status']).toBe('failed')
  })

  it('names the Sandbox refusal when Codex never started', async () => {
    await expect(new CodexExecAdapter().parse(ref(join(liveStreamFixtures, 'sandbox-refused-before-codex.jsonl'))))
      .rejects.toThrow('the Sandbox execution ended before Codex started: Native credential continuation requires the previous backend lease to be released')
  })

  it('completes a turn whose added file never received item.completed', async () => {
    const path = source([
      { type: 'thread.started', thread_id: 'thread-unclosed' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'item_44',
          type: 'file_change',
          changes: [{ path: '/home/agent/work/market/technical-evidence.json', kind: 'add' }],
          status: 'in_progress',
        },
      },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ], 'unclosed.jsonl')
    const spans = await new CodexExecAdapter().parse(ref(path))
    const file = kind(spans, 'TOOL')[0]!
    const turn = kind(spans, 'LLM')[0]!

    expect(file.status).toEqual({ code: 'UNSET' })
    expect(file.attributes['traces.codex.exec_item_status']).toBe('no_completion_event')
    expect(turn.status).toEqual({ code: 'OK' })
    expect(turn.attributes['traces.codex.exec_unclosed_item_count']).toBe(1)
    expect(kind(spans, 'AGENT')[0]!.attributes['traces.codex.exec_stream_status']).toBe('completed')
  })

  it('answers through the CLI for a live-stream session', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'evidence',
      '--harness',
      'codex-exec',
      '--session',
      join(liveStreamFixtures, 'codex-director-in-progress.jsonl'),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    const evidence = JSON.parse(stdout) as { metrics?: { llmTurnCount?: number; toolCallCount?: number } }
    expect(evidence.metrics).toMatchObject({ llmTurnCount: 1, toolCallCount: 6 })
  })
})
