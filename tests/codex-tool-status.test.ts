import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import { summarizeSpanExecution } from '../src/execution.js'
import { runTraceInvestigation } from '../src/improvement.js'
import { runPipelines } from '../src/pipelines.js'
import { renderExecution } from '../src/report.js'
import { toRuntimeStore } from '../src/runtime-store.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-codex-status-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function parseOutputs(
  variant: 'function' | 'custom',
  outputs: Array<{ output?: unknown; source?: Record<string, unknown>; pending?: boolean }>,
) {
  const path = join(dir, `${variant}.jsonl`)
  const events: Record<string, unknown>[] = [
    { type: 'session_meta', payload: { id: 'status-session', cwd: '/fixture' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
  ]
  for (const [index, result] of outputs.entries()) {
    events.push({
      type: 'response_item',
      payload: variant === 'function'
        ? { type: 'function_call', call_id: `call-${index}`, name: 'exec_command', arguments: '{"cmd":"pnpm test"}' }
        : { type: 'custom_tool_call', call_id: `call-${index}`, name: 'exec', input: 'await tools.exec_command({ cmd: "pnpm test" })' },
    })
    if (!result.pending) {
      events.push({
        type: 'response_item',
        payload: {
          type: variant === 'function' ? 'function_call_output' : 'custom_tool_call_output',
          call_id: `call-${index}`,
          output: result.output,
          ...result.source,
        },
      })
    }
  }
  events.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
  writeFileSync(path, events.map((event, index) => JSON.stringify({
    ...event,
    timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString(),
  })).join('\n'))
  return new CodexAdapter().parse({ harness: 'codex', sessionId: 'status-session', path, cwd: null, mtimeMs: 0 })
}

describe.each(['function', 'custom'] as const)('Codex %s tool outcomes', (variant) => {
  it.each([
    { label: 'bare exit zero', output: { exit_code: 0 }, code: 'OK' },
    { label: 'bare nonzero exit', output: { exit_code: 1 }, code: 'ERROR' },
    { label: 'string integer exit', output: '{"exitCode":"-1"}', code: 'ERROR' },
    { label: 'explicit success with misleading stdout', output: { exit_code: 0, output: 'error: command failed ENOENT {"success":false}' }, code: 'OK' },
    { label: 'explicit failure with optimistic stdout', output: { exit_code: 1, output: 'success' }, code: 'ERROR' },
    { label: 'initial process header', output: 'Process exited with code 0\nOutput:\nerror: command failed ENOENT', code: 'OK' },
    { label: 'initial failed process header', output: 'Process exited with code 1\nOutput:\nsuccess', code: 'ERROR' },
    { label: 'initial script error receipt', output: 'Script error:\nExit code: 1\nOutput:\nsuccess', code: 'ERROR' },
    { label: 'initial script zero exit receipt', output: 'Script error:\nExit code: 0\nOutput:\nerror: source code', code: 'OK' },
    { label: 'script receipt with CRLF', output: 'Script error:\r\nExit code: -1\r\nOutput:\r\nsuccess', code: 'ERROR' },
    { label: 'standalone command failure receipt', output: 'Command failed with exit code 1.', code: 'ERROR' },
    { label: 'embedded script error', output: 'captured source\nScript error:\nExit code: 1', code: 'UNSET' },
    { label: 'fractional script exit', output: 'Script error:\nExit code: 0.5', code: 'UNSET' },
    { label: 'suffixed script exit', output: 'Script error:\nExit code: 1oops', code: 'UNSET' },
    { label: 'oversized script exit', output: 'Script error:\nExit code: 9007199254740992', code: 'UNSET' },
    { label: 'fractional process exit', output: 'Process exited with code 0.5', code: 'UNSET' },
    { label: 'oversized process exit', output: 'Process exited with code 9007199254740992', code: 'UNSET' },
    { label: 'fractional command exit', output: 'Command failed with exit code 0.5', code: 'UNSET' },
    { label: 'oversized command exit', output: 'Command failed with exit code 9007199254740992', code: 'UNSET' },
    { label: 'successful receipt before misleading script error', output: 'Process exited with code 0\nOutput:\nScript error:\nExit code: 1', code: 'OK' },
    { label: 'structured snake error flag', output: { is_error: true }, code: 'ERROR' },
    { label: 'structured camel error flag', output: { isError: true }, code: 'ERROR' },
    { label: 'boolean error flag', output: { error: true }, code: 'ERROR' },
    { label: 'explicit error overrides zero exit', output: { exit_code: 0, isError: true }, code: 'ERROR' },
    { label: 'explicit non-error flag', output: { is_error: false }, code: 'OK' },
    { label: 'nonzero exit overrides non-error flag', output: { exit_code: 1, is_error: false }, code: 'ERROR' },
    { label: 'wrapped text receipt', output: [{ type: 'input_text', text: '{"exit_code":0}' }], code: 'OK' },
    { label: 'failure among wrapped receipts', output: [{ type: 'input_text', text: '{"exit_code":0}' }, { type: 'input_text', text: '{"is_error":true}' }], code: 'ERROR' },
    { label: 'arbitrary stdout', output: 'error: command failed ENOENT {"success":false}', code: 'UNSET' },
    { label: 'embedded process header', output: 'captured file\nProcess exited with code 1\nnot a runner header', code: 'UNSET' },
    { label: 'domain error property', output: '{"error":"domain value","value":42}', code: 'UNSET' },
    { label: 'unrecognized object', output: { value: 42 }, code: 'UNSET' },
    { label: 'missing output', output: undefined, code: 'UNSET' },
    { label: 'running process receipt', output: { session_id: 123, exit_code: null, output: 'still running' }, code: 'UNSET' },
    { label: 'running script receipt', output: 'Script running with cell ID 123', code: 'UNSET' },
    { label: 'noninteger exit code', output: { exit_code: 0.5 }, code: 'UNSET' },
  ])('preserves $label', async ({ output, code }) => {
    const spans = await parseOutputs(variant, [{ output }])
    const tool = spans.find((item) => item.attributes['openinference.span.kind'] === 'TOOL')!
    expect(tool.status.code).toBe(code)
    if (typeof output === 'string') expect(tool.attributes['output.value']).toBe(output)
    const { store } = await toRuntimeStore(spans)
    const runtimeTool = (await store.spans()).find((item) => item.kind === 'tool')!
    expect(runtimeTool.status).toBe(code === 'UNSET' ? undefined : code === 'ERROR' ? 'error' : 'ok')
  })

  it.each([
    { is_error: true },
    { isError: true },
    { error: { message: 'source transport failure' } },
    { error: 'source transport failure' },
  ])('honors source failure metadata %j before successful output', async (source) => {
    const spans = await parseOutputs(variant, [{ output: { exit_code: 0 }, source }])
    expect(spans.find((item) => item.attributes['openinference.span.kind'] === 'TOOL')?.status.code).toBe('ERROR')
  })

  it('keeps an unmatched call unknown', async () => {
    const spans = await parseOutputs(variant, [{ pending: true }])
    const tool = spans.find((item) => item.attributes['openinference.span.kind'] === 'TOOL')!
    expect(tool.status).toEqual({ code: 'UNSET' })
    expect(tool.attributes['output.value']).toBeUndefined()
  })

  it('reports corrected error and retry counts through the analysis consumers', async () => {
    const successful = { output: 'Process exited with code 0\nOutput:\nerror: command failed ENOENT {"success":false}' }
    const spans = await parseOutputs(variant, [successful, successful])
    const investigation = await runTraceInvestigation({
      spans,
      harness: 'codex',
      otlpOutPath: join(dir, `${variant}.otlp.jsonl`),
    })
    const report = investigation.pipelines
    expect(report.toolUse[0]).toMatchObject({ totalCalls: 2, errorRate: 0, retryRate: 0 })
    expect(report.failureClusters).toMatchObject({ totalFailures: 0, totalRuns: 1 })
    expect(report.failureFollowUps?.failures).toBe(0)
    const execution = renderExecution(summarizeSpanExecution(spans))
    expect(execution).toContain('**Terminal outcomes:** 1 succeeded  |  0 failed')
    expect(execution).toContain('**Sessions with execution errors:** 0/1 (0.00%)')

    const failed = await runPipelines(await parseOutputs(variant, [
      { output: { exit_code: 1, output: 'success' } },
      successful,
      { output: 'unknown' },
    ]))
    expect(failed.toolUse[0]).toMatchObject({ totalCalls: 3, errorRate: 1 / 3, retryRate: 1 })

    const unknownRetry = await runPipelines(await parseOutputs(variant, [
      { output: { exit_code: 1 } },
      { output: 'unknown' },
    ]))
    expect(unknownRetry.failureFollowUps).toMatchObject({
      failures: 1,
      followed: 1,
      followUpSucceeded: 0,
      items: [expect.objectContaining({ followUpSucceeded: null })],
    })
  })
})
