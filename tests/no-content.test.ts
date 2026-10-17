/**
 * Every `--no-content` output contains no content (spec §8.2 invariant, U4).
 *
 * A sentinel is planted in every place a session carries text a person or an
 * agent wrote: the prompt, thinking, replies, shell commands and their output,
 * an error, a subagent's brief, the recorded cwd and branch, and, in standard
 * OTLP/JSON, `gen_ai.input.messages`, `gen_ai.output.messages`,
 * `gen_ai.system_instructions`, `gen_ai.tool.call.arguments` and `.result` and
 * the status message. It must appear 0 times in what `facts`, `convert` and
 * `upload --dry-run` print or write with `--no-content`, and in the request
 * body a `--no-content` upload sends (an HTTP ingest peer is the one faked
 * boundary). The same commands without `--no-content` carry it, so the
 * sentinel is really there to leak.
 */
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CliRun, runCli } from './run-cli.js'

const SENTINEL = 'NOCONTENT_SENTINEL_5e1f'
const CLAUDE_ID = 'c0de5e1f-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CODEX_ID = '0199c0de-5e1f-7ccc-8ccc-cccccccccccc'
const RUN = '5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f'

const at = (second: number): string => `2026-10-14T10:00:${String(second).padStart(2, '0')}.000Z`
const nanos = (second: number): string => String(BigInt(Date.parse(at(second))) * 1_000_000n)
const jsonl = (rows: readonly unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

function claudeSession(): string {
  const base = { sessionId: CLAUDE_ID, cwd: `/w/${SENTINEL}-repo`, version: '2.1.0', gitBranch: `fix/${SENTINEL}` }
  const usage = { input_tokens: 10, output_tokens: 5 }
  return jsonl([
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), message: { role: 'user', content: `Fix ${SENTINEL} in the parser.` } },
    {
      ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(5),
      message: {
        id: 'msg-1', role: 'assistant', model: 'claude-opus-5-5', usage,
        content: [
          { type: 'thinking', thinking: `Look for ${SENTINEL} first.`, signature: 'sig' },
          { type: 'text', text: `I will grep for ${SENTINEL}.` },
          { type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: `grep -rn ${SENTINEL} src` } },
        ],
      },
    },
    {
      ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at(10),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-bash', is_error: true, content: `grep: ${SENTINEL}: No such file` }] },
    },
    {
      ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: at(15),
      message: {
        id: 'msg-2', role: 'assistant', model: 'claude-opus-5-5', usage,
        content: [{ type: 'tool_use', id: 'toolu-task', name: 'Task', input: { description: `Audit ${SENTINEL}`, prompt: `Find every use of ${SENTINEL}.`, subagent_type: 'general-purpose' } }],
      },
    },
    {
      ...base, type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: at(20),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-task', content: `${SENTINEL} is used twice.` }] },
    },
    {
      ...base, type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: at(25),
      message: { id: 'msg-3', role: 'assistant', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: `Fixed ${SENTINEL}.` }] },
    },
  ])
}

function codexSession(): string {
  return jsonl([
    {
      timestamp: at(0), type: 'session_meta',
      payload: {
        id: CODEX_ID, timestamp: at(0), cwd: `/w/${SENTINEL}-codex`, originator: 'codex_cli_rs', cli_version: '0.150.0',
        git: { branch: `fix/${SENTINEL}`, commit_hash: 'abc1234', repository_url: 'https://github.com/example/synthetic.git' },
      },
    },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Fix ${SENTINEL}.` }] } },
    { timestamp: at(3), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: `Thinking about ${SENTINEL}.` }] } },
    { timestamp: at(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call-1', arguments: JSON.stringify({ command: ['grep', SENTINEL, 'src'] }) } },
    {
      timestamp: at(8), type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ output: `${SENTINEL} not found`, metadata: { exit_code: 1 } }) },
    },
    { timestamp: at(9), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Fixed ${SENTINEL}.` }] } },
    { timestamp: at(10), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ])
}

/** Standard OTLP/JSON, as an OpenTelemetry GenAI exporter writes it. */
function otlpJson(): string {
  const str = (key: string, value: string) => ({ key, value: { stringValue: value } })
  const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } })
  const span = (spanId: string, parentSpanId: string, name: string, from: number, to: number, attributes: unknown[], status?: unknown) => ({
    traceId: RUN, spanId, parentSpanId, name, startTimeUnixNano: nanos(from), endTimeUnixNano: nanos(to), attributes, ...(status ? { status } : {}),
  })
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [str('service.name', 'synthetic-agent')] },
      scopeSpans: [{
        scope: { name: 'synthetic' },
        spans: [
          span('5e1f000000000001', '', 'invoke_agent coder', 0, 30, [str('gen_ai.operation.name', 'invoke_agent'), str('gen_ai.agent.name', 'coder')]),
          span('5e1f000000000002', '5e1f000000000001', 'chat glm-5.2', 1, 5, [
            str('gen_ai.operation.name', 'chat'), str('gen_ai.request.model', 'glm-5.2'),
            int('gen_ai.usage.input_tokens', 1200), int('gen_ai.usage.output_tokens', 40),
            str('gen_ai.system_instructions', JSON.stringify([{ type: 'text', content: `Never mention ${SENTINEL}.` }])),
            str('gen_ai.input.messages', JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: `Fix ${SENTINEL}.` }] }])),
            str('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: `Looking at ${SENTINEL}.` }] }])),
          ]),
          span('5e1f000000000003', '5e1f000000000001', 'execute_tool bash', 6, 9, [
            str('gen_ai.operation.name', 'execute_tool'), str('gen_ai.tool.name', 'bash'),
            str('gen_ai.tool.call.arguments', JSON.stringify({ command: `grep ${SENTINEL} src` })),
            str('gen_ai.tool.call.result', `${SENTINEL}: not found`),
          ], { code: 2, message: `grep failed on ${SENTINEL}` }),
        ],
      }],
    }],
  })
}

let root: string
let env: Record<string, string>
let otlp: string
let ingest: Server
let ingestUrl: string
const received: string[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'traces-no-content-'))
  const home = join(root, 'home')
  env = { HOME: home, XDG_STATE_HOME: join(root, 'state') }
  const claudeDir = join(home, '.claude', 'projects', '-w-synthetic')
  const codexDir = join(home, '.codex', 'sessions', '2026', '10', '14')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexDir, { recursive: true })
  await writeFile(join(claudeDir, `${CLAUDE_ID}.jsonl`), claudeSession())
  await writeFile(join(codexDir, `rollout-2026-10-14T10-00-00-${CODEX_ID}.jsonl`), codexSession())
  otlp = join(root, 'genai.otlp.json')
  await writeFile(otlp, otlpJson())
  // Tangle Intelligence's ingest endpoint: keeps each request body and accepts every span.
  ingest = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      received.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accepted: (JSON.parse(body) as { spans: unknown[] }).spans.length, rejected: [] }))
    })
  })
  ingest.listen(0, '127.0.0.1')
  await once(ingest, 'listening')
  ingestUrl = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`
})

afterAll(() => {
  ingest?.close()
})

const count = (text: string): number => text.split(SENTINEL).length - 1
const printed = (run: CliRun): string => `${run.stdout}${run.stderr}`

const REFS = [
  ['a Claude Code session', () => CLAUDE_ID],
  ['a Codex session', () => CODEX_ID],
  ['standard OTLP/JSON with gen_ai content attributes', () => otlp],
] as const

describe('--no-content: no output carries content', () => {
  for (const [what, refOf] of REFS) {
    it(`${what}: facts, convert and upload --dry-run`, async () => {
      const ref = refOf()
      const dir = await mkdtemp(join(root, 'out-'))
      const run = (argv: string[]) => runCli(argv, { env, timeoutMs: 120_000 })

      const plain = join(dir, 'plain.otlp.jsonl')
      expect((await run(['convert', ref, '--out', plain])).code).toBe(0)
      expect(count(await readFile(plain, 'utf8'))).toBeGreaterThan(2)

      const converted = join(dir, 'metadata.otlp.jsonl')
      const preview = join(dir, 'preview.otlp.jsonl')
      const runs = await Promise.all([
        run(['facts', ref, '--no-content', '--format', 'json']),
        run(['facts', ref, '--no-content']),
        run(['convert', ref, '--no-content']),
        run(['convert', ref, '--no-content', '--out', converted, '--format', 'json']),
        run(['upload', ref, '--no-content', '--dry-run', '--out', preview]),
      ])
      for (const result of runs) {
        expect(result.code, result.stderr).toBe(0)
        expect(count(printed(result)), printed(result)).toBe(0)
      }
      for (const file of [converted, preview]) {
        const text = await readFile(file, 'utf8')
        expect(text.trim()).not.toBe('')
        expect(count(text), text).toBe(0)
      }
      const summary = JSON.parse(runs[3]!.stdout) as { out: string; spans: number; droppedAttributes: string[] }
      expect(summary.out).toBe(converted)
      expect(summary.spans).toBe((await readFile(converted, 'utf8')).trim().split('\n').length)
      expect(summary.droppedAttributes.length).toBeGreaterThan(0)
    }, 180_000)
  }

  it('a sent --no-content upload carries no content, cwd or branch', async () => {
    const before = received.length
    const sent = await runCli(['upload', CLAUDE_ID, otlp, '--no-content', '--yes'], {
      env: { ...env, TANGLE_INGEST_URL: ingestUrl, TANGLE_INGEST_API_KEY: 'test-ingest-key', TANGLE_TENANT_ID: 'tenant-no-content' },
      timeoutMs: 120_000,
    })
    expect(sent.code, sent.stderr).toBe(0)
    expect(sent.stdout).toMatch(/Uploaded 2 session\(s\)/u)
    const bodies = received.slice(before).join('\n')
    expect(bodies).toContain('"tangle.harness"')
    expect(count(bodies)).toBe(0)
    expect(bodies).not.toContain('"tangle.cwd"')
    expect(bodies).not.toContain('"tangle.git_branch"')
  }, 180_000)
})
