import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    {
      name: 'truncated turn',
      events: [{ type: 'thread.started', thread_id: 'thread-truncated' }, { type: 'turn.started' }],
      error: 'stream ended before turn.completed',
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
