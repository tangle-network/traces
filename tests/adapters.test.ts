import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeAdoption } from '../src/adoption.js'
import { AmpAdapter } from '../src/adapters/amp.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { capText, CONTENT_CAP } from '../src/adapters/conversation.js'
import { CodexAdapter } from '../src/adapters/codex.js'
import { CopilotAdapter } from '../src/adapters/copilot.js'
import { FactoryAdapter } from '../src/adapters/factory.js'
import { ForgeAdapter } from '../src/adapters/forge.js'
import { GeminiAdapter } from '../src/adapters/gemini.js'
import { OpencodeAdapter } from '../src/adapters/opencode.js'
import { PiAdapter } from '../src/adapters/pi.js'
import { QwenAdapter } from '../src/adapters/qwen.js'
import { TOOL_IO_VALUE_MAX_BYTES, toolIoAttributes } from '../src/adapters/tool-io.js'
import { JsonSourceError, type JsonSourceErrorKind } from '../src/json.js'
import { stampSessionIntegrity } from '../src/integrity.js'
import { JsonlParseError } from '../src/jsonl.js'
import type { OtlpSpan } from '../src/otlp.js'
import { parseSession } from '../src/session-source.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'tt-adapters-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function refFor(path: string, harness: string): SessionRef {
  return { harness, sessionId: 'fixture', path, cwd: null, mtimeMs: 0 }
}
const llm = (s: OtlpSpan[]) => s.find((x) => x.attributes['openinference.span.kind'] === 'LLM')
const tool = (s: OtlpSpan[]) => s.find((x) => x.attributes['openinference.span.kind'] === 'TOOL')
const userPrompt = (s: OtlpSpan[]) => s.find((x) => x.name === 'user.prompt')

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  )
}

function spanDigest(spans: OtlpSpan[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(spans))).digest('hex')
}

function traceShapeDigest(spans: OtlpSpan[]): string {
  return spanDigest(
    spans.map((item) => {
      const attributes = Object.fromEntries(
        Object.entries(item.attributes).filter(
          ([key]) => !/^(?:input|output)\.|^traces\.(?:input|output)\./.test(key),
        ),
      )
      if (item.attributes['openinference.span.kind'] === 'TOOL') delete attributes.content
      return { ...item, attributes }
    }),
  )
}

async function expectJsonlParseFailure(
  parse: Promise<unknown>,
  sourcePath: string,
  lineNumber: number,
  rawSecret: string,
): Promise<void> {
  const error = await parse.then(
    () => undefined,
    (cause: unknown) => cause,
  )

  expect(error).toBeInstanceOf(JsonlParseError)
  expect(error).toMatchObject({
    name: 'JsonlParseError',
    message: `Invalid JSONL at ${sourcePath}:${lineNumber}`,
    sourcePath,
    lineNumber,
  })
  expect(String(error)).not.toContain(rawSecret)
  expect(JSON.stringify(error)).not.toContain(rawSecret)
  expect((error as Error).stack).not.toContain(rawSecret)
}

async function expectJsonSourceFailure(
  parse: Promise<unknown>,
  sourcePath: string,
  kind: JsonSourceErrorKind,
  rawSecret?: string,
  code?: string,
): Promise<void> {
  const error = await parse.then(
    () => undefined,
    (cause: unknown) => cause,
  )

  expect(error).toBeInstanceOf(JsonSourceError)
  expect(error).toMatchObject({
    name: 'JsonSourceError',
    message: kind === 'parse' ? `Invalid JSON at ${sourcePath}` : `Unable to read JSON source at ${sourcePath}`,
    sourcePath,
    kind,
    ...(code ? { code } : {}),
  })
  expect((error as Error).cause).toBeInstanceOf(Error)
  if (code) expect((error as Error).cause).toMatchObject({ code })
  if (rawSecret) {
    expect(String(error)).not.toContain(rawSecret)
    expect(JSON.stringify(error)).not.toContain(rawSecret)
    expect((error as Error).stack).not.toContain(rawSecret)
    expect(String((error as Error).cause)).not.toContain(rawSecret)
    expect(((error as Error).cause as Error).stack).not.toContain(rawSecret)
    expect(inspect(error)).not.toContain(rawSecret)
  }
}

async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('JSONL adapter streaming', () => {
  const adapters = [
    { harness: 'claude-code', make: () => new ClaudeAdapter() },
    { harness: 'github-copilot', make: () => new CopilotAdapter() },
    { harness: 'factory', make: () => new FactoryAdapter() },
    { harness: 'pi', make: () => new PiAdapter() },
    { harness: 'qwen', make: () => new QwenAdapter() },
  ]

  it.each(adapters)('$harness propagates a missing session file', async ({ harness, make }) => {
    await expect(make().parse(refFor(join(dir, 'missing-session.jsonl'), harness))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it.each(adapters)('$harness recovers malformed records by default and preserves strict mode', async ({ harness, make }) => {
    const path = join(dir, `${harness}-malformed-session.jsonl`)
    const rawSecret = `secret-${harness}-session-row`
    writeFileSync(path, `{}\n${rawSecret}\n{}\n`)

    const recoveredRef = refFor(path, harness)
    await expect(make().parse(recoveredRef)).resolves.not.toHaveLength(0)
    expect(recoveredRef.integrity).toMatchObject({
      status: 'degraded_not_lossless',
      corruptions: [{
        sourcePath: path,
        lineNumber: 2,
        sha256: createHash('sha256').update(rawSecret).digest('hex'),
      }],
    })
    expect(JSON.stringify(recoveredRef.integrity)).not.toContain(rawSecret)
    await expectJsonlParseFailure(
      make().parse(refFor(path, harness), { corruptionMode: 'strict' }),
      path,
      2,
      rawSecret,
    )
  })

  it('recovers malformed Claude subagent records by default and preserves strict mode', async () => {
    const path = join(dir, 'claude-malformed-subagent.jsonl')
    writeFileSync(path, '{}\n')
    const subDir = join(dir, 'claude-malformed-subagent', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const subagentPath = join(subDir, 'agent-secret.jsonl')
    const rawSecret = 'secret-claude-subagent-row'
    writeFileSync(subagentPath, `{}\n${rawSecret}\n{}\n`)

    const recoveredRef = refFor(path, 'claude-code')
    await expect(new ClaudeAdapter().parse(recoveredRef)).resolves.not.toHaveLength(0)
    expect(recoveredRef.integrity).toMatchObject({
      status: 'degraded_not_lossless',
      corruptions: [{ sourcePath: subagentPath, lineNumber: 2 }],
    })
    await expectJsonlParseFailure(
      new ClaudeAdapter().parse(refFor(path, 'claude-code'), { corruptionMode: 'strict' }),
      subagentPath,
      2,
      rawSecret,
    )
  })

  it('recovers corruption while parsing a 100 MB file below 128 MB peak RSS', () => {
    const path = join(dir, 'large-tool-inputs.jsonl')
    const suffix = 'x'.repeat(1024 * 1024)
    const file = openSync(path, 'w')
    try {
      for (let index = 0; index < 101; index += 1) {
        writeSync(
          file,
          `${JSON.stringify({
            type: 'assistant',
            uuid: `large-${index}`,
            sessionId: 'large',
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: `tool-${index}`,
                  name: 'bash',
                  input: { payload: `${index}:${suffix}` },
                },
              ],
            },
          })}\n`,
        )
        if (index === 50) writeSync(file, 'secret-large-middle-record\n')
      }
      writeSync(file, 'secret-large-final-record')
    } finally {
      closeSync(file)
    }
    expect(statSync(path).size).toBeGreaterThan(100 * 1024 * 1024)

    const adapterUrl = pathToFileURL(join(process.cwd(), 'src/adapters/claude.ts')).href
    const childSource = `
      import { ClaudeAdapter } from ${JSON.stringify(adapterUrl)}
      const ref = {
        harness: 'claude-code',
        sessionId: 'large',
        path: ${JSON.stringify(path)},
        cwd: null,
        mtimeMs: 0,
      }
      const spans = await new ClaudeAdapter().parse(ref)
      const tools = spans.filter((span) => span.attributes['openinference.span.kind'] === 'TOOL')
      process.stdout.write(JSON.stringify({
        spanCount: spans.length,
        toolCount: tools.length,
        maxRssKb: process.resourceUsage().maxRSS,
        bounded: tools.every((span) =>
          span.attributes.content === undefined &&
          span.attributes['traces.input.truncated'] === true &&
          Buffer.byteLength(String(span.attributes['input.value'])) <= 16 * 1024
        ),
        integrity: ref.integrity,
      }))
    `
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' }
    delete env.NODE_OPTIONS
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=40', '--max-semi-space-size=1', '--import', 'tsx', '--input-type=module', '--eval', childSource],
      { cwd: process.cwd(), encoding: 'utf8', env, timeout: 30_000 },
    )

    expect(child.status, child.stderr || child.error?.message).toBe(0)
    const result = JSON.parse(child.stdout) as {
      spanCount: number
      toolCount: number
      maxRssKb: number
      bounded: boolean
      integrity: SessionRef['integrity']
    }
    expect(result).toMatchObject({
      spanCount: 203,
      toolCount: 101,
      bounded: true,
      integrity: { status: 'degraded_not_lossless' },
    })
    expect(result.integrity?.corruptions).toHaveLength(2)
    expect(result.maxRssKb).toBeLessThan(128 * 1024)
  })

  it('customer session parsing retains valid Codex records and stamps a degraded receipt', async () => {
    const path = join(dir, 'codex-recovered-session.jsonl')
    const rawSecret = 'secret-corrupt-codex-record'
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-13T00:00:00.000Z',
        payload: { id: 'recovered-codex', cwd: '/tmp/recovered' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-13T00:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before corruption' }] },
      }),
      rawSecret,
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-13T00:00:02.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after corruption' }] },
      }),
    ]
    writeFileSync(path, `${lines.join('\n')}\n`)
    const ref = refFor(path, 'codex')

    const spans = await parseSession(new CodexAdapter(), ref)
    const root = spans.find((item) => item.parent_span_id === null)!

    expect(spans.filter((item) => item.name === 'user.prompt').map((item) => item.attributes.content)).toEqual([
      'before corruption',
      'after corruption',
    ])
    expect(ref.integrity).toMatchObject({
      status: 'degraded_not_lossless',
      corruptions: [{
        sessionId: 'recovered-codex',
        sourcePath: path,
        lineNumber: 3,
        sha256: createHash('sha256').update(rawSecret).digest('hex'),
        rawBytes: 'local_source_only',
      }],
    })
    expect(root.attributes['traces.session.integrity']).toBe('degraded_not_lossless')
    expect(root.attributes['traces.session.corruption_count']).toBe(1)
    expect(root.attributes['traces.session.corruption_digest']).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(root.attributes['traces.session.corruption_receipts']).toBeUndefined()
    const receiptSpan = spans.find((item) => item.name === 'source.corruption.receipt')!
    expect(receiptSpan.parent_span_id).toBe(root.span_id)
    expect(receiptSpan.attributes).toMatchObject({
      'traces.session.corruption.source_path': path,
      'traces.session.corruption.line_number': 3,
      'traces.session.corruption.sha256': createHash('sha256').update(rawSecret).digest('hex'),
    })
    expect(JSON.stringify(receiptSpan.attributes)).not.toContain(rawSecret)
    await expectJsonlParseFailure(
      parseSession(new CodexAdapter(), refFor(path, 'codex'), { corruptionMode: 'strict' }),
      path,
      3,
      rawSecret,
    )
  })

  it('retains later valid records and receipts after more than 128 corruptions', async () => {
    const path = join(dir, `codex-many-corruptions-${'x'.repeat(160)}.jsonl`)
    const malformed = Array.from(
      { length: 130 },
      (_, index) => `secret-noisy-record-${index}`,
    )
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-13T00:00:00.000Z',
        payload: { id: 'noisy-codex', cwd: '/tmp/noisy' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-13T00:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before noise' }] },
      }),
      ...malformed,
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-13T00:00:02.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after noise' }] },
      }),
    ]
    writeFileSync(path, `${lines.join('\n')}\n`)
    const ref = refFor(path, 'codex')

    const spans = await parseSession(new CodexAdapter(), ref)
    const root = spans.find((item) => item.parent_span_id === null)!
    const receiptSpans = spans.filter((item) => item.name === 'source.corruption.receipt')

    expect(spans.filter((item) => item.name === 'user.prompt').map((item) => item.attributes.content)).toEqual([
      'before noise',
      'after noise',
    ])
    expect(ref.integrity?.corruptions).toHaveLength(malformed.length)
    expect(root.attributes).toMatchObject({
      'traces.session.integrity': 'degraded_not_lossless',
      'traces.session.corruption_count': malformed.length,
    })
    expect(root.attributes['traces.session.corruption_digest']).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(root.attributes['traces.session.corruption_receipts']).toBeUndefined()
    const rootCorruptionAttributes = Object.fromEntries(
      Object.entries(root.attributes).filter(([key]) => key.startsWith('traces.session.corruption_')),
    )
    expect(Buffer.byteLength(JSON.stringify(rootCorruptionAttributes))).toBeLessThan(256)
    expect(receiptSpans).toHaveLength(malformed.length)
    expect(new Set(receiptSpans.map((item) => item.span_id))).toHaveLength(malformed.length)
    expect(receiptSpans.every((item) =>
      Buffer.byteLength(JSON.stringify(item.attributes)) < 16 * 1024,
    )).toBe(true)
    let byteOffset = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`)
    for (const [index, receiptSpan] of receiptSpans.entries()) {
      expect(receiptSpan).toMatchObject({
        trace_id: 'noisy-codex',
        parent_span_id: root.span_id,
        attributes: {
          'traces.session.integrity': 'degraded_not_lossless',
          'traces.session.corruption.receipt_version': 1,
          'traces.session.corruption.kind': 'jsonl_corruption',
          'traces.session.corruption.source_path': path,
          'traces.session.corruption.line_number': index + 3,
          'traces.session.corruption.byte_offset': byteOffset,
          'traces.session.corruption.byte_length': Buffer.byteLength(malformed[index]!),
          'traces.session.corruption.sha256': createHash('sha256').update(malformed[index]!).digest('hex'),
          'traces.session.raw_source_retention': 'local_source_only',
        },
      })
      byteOffset += Buffer.byteLength(malformed[index]!) + 1
    }
    expect(JSON.stringify(receiptSpans)).not.toContain('secret-noisy-record')
    const spanIds = spans.map((item) => item.span_id)
    stampSessionIntegrity(ref, spans)
    expect(spans.map((item) => item.span_id)).toEqual(spanIds)
    await expectJsonlParseFailure(
      parseSession(new CodexAdapter(), refFor(path, 'codex'), { corruptionMode: 'strict' }),
      path,
      3,
      malformed[0]!,
    )
  })
})

describe('single-JSON adapter failures', () => {
  const adapters = [
    { harness: 'amp', make: () => new AmpAdapter() },
    { harness: 'gemini', make: () => new GeminiAdapter() },
    { harness: 'forge', make: () => new ForgeAdapter() },
  ]

  it.each(adapters)('$harness rejects an unreadable discovered session', async ({ harness, make }) => {
    const path = join(dir, `${harness}-missing-session.json`)
    await expectJsonSourceFailure(make().parse(refFor(path, harness)), path, 'read', undefined, 'ENOENT')
  })

  it.each(adapters)('$harness rejects malformed session JSON without exposing its contents', async ({ harness, make }) => {
    const path = join(dir, `${harness}-malformed-session.json`)
    const rawSecret = `secret-${harness}-session-json`
    writeFileSync(path, rawSecret)

    await expectJsonSourceFailure(make().parse(refFor(path, harness)), path, 'parse', rawSecret)
  })

  it('rejects malformed Factory settings instead of dropping their metadata', async () => {
    const path = join(dir, 'factory-malformed-settings.jsonl')
    const settingsPath = path.replace(/\.jsonl$/, '.settings.json')
    const rawSecret = 'secret-factory-settings-json'
    writeFileSync(path, '{}\n')
    writeFileSync(settingsPath, rawSecret)

    await expectJsonSourceFailure(
      new FactoryAdapter().parse(refFor(path, 'factory')),
      settingsPath,
      'parse',
      rawSecret,
    )
  })

  it('rejects malformed Claude subagent metadata without exposing its contents', async () => {
    const path = join(dir, 'claude-malformed-meta.jsonl')
    writeFileSync(path, '{}\n')
    const subDir = join(dir, 'claude-malformed-meta', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'agent-meta.jsonl'), '{}\n')
    const metaPath = join(subDir, 'agent-meta.meta.json')
    const rawSecret = 'secret-claude-subagent-metadata'
    writeFileSync(metaPath, rawSecret)

    await expectJsonSourceFailure(
      new ClaudeAdapter().parse(refFor(path, 'claude-code')),
      metaPath,
      'parse',
      rawSecret,
    )
  })
})

describe('tool I/O capture', () => {
  it('canonicalizes structured values before hashing them', () => {
    const first = toolIoAttributes({ input: { z: 1, nested: { b: 2, a: 1 } } })
    const second = toolIoAttributes({ input: { nested: { a: 1, b: 2 }, z: 1 } })
    const encoded = toolIoAttributes({ input: '{"z":1,"nested":{"b":2,"a":1}}' })
    const canonical = '{"nested":{"a":1,"b":2},"z":1}'

    expect(first['input.value']).toBe(canonical)
    expect(second['input.value']).toBe(canonical)
    expect(encoded['input.value']).toBe(canonical)
    expect(encoded['input.mime_type']).toBe('application/json')
    expect(first['traces.input.sha256']).toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(second['traces.input.sha256']).toBe(first['traces.input.sha256'])
    expect(encoded['traces.input.sha256']).toBe(first['traces.input.sha256'])
  })

  it('stores a bounded value with byte length, digest, and a visible truncation marker', () => {
    const output = 'x'.repeat(TOOL_IO_VALUE_MAX_BYTES + 123)
    const digest = createHash('sha256').update(output).digest('hex')
    const attributes = toolIoAttributes({ output })
    const captured = String(attributes['output.value'])

    expect(attributes['output.mime_type']).toBe('text/plain')
    expect(attributes['traces.output.bytes']).toBe(TOOL_IO_VALUE_MAX_BYTES + 123)
    expect(attributes['traces.output.sha256']).toBe(digest)
    expect(attributes['traces.output.truncated']).toBe(true)
    expect(captured).toMatch(/\[truncated \d+ bytes\]$/)
    expect(captured).not.toContain(digest)
    expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(TOOL_IO_VALUE_MAX_BYTES)
  })
})

describe('amp adapter (thread JSON, camelCase usage)', () => {
  it('keeps fresh, cache-read, and cache-write tokens separate and flags tool errors', async () => {
    const path = join(dir, 'T-x.json')
    writeFileSync(
      path,
      JSON.stringify({
        id: 'T-x',
        created: 1000,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'please run ls' }] },
          {
            role: 'assistant',
            messageId: 1,
            usage: { model: 'claude', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 25 },
            content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'permission denied' }] },
        ],
      }),
    )
    const spans = await new AmpAdapter().parse(refFor(path, 'amp'))
    expect(llm(spans)?.attributes['llm.token_count.prompt']).toBe(100)
    expect(llm(spans)?.attributes['llm.token_count.prompt_cache_hit']).toBe(50)
    expect(llm(spans)?.attributes['llm.token_count.prompt_cache_write']).toBe(25)
    expect(llm(spans)?.attributes['llm.token_count.completion']).toBe(10)
    expect(tool(spans)?.status.code).toBe('ERROR')
    expect(tool(spans)?.attributes.content).toBeUndefined()
    expect(tool(spans)?.attributes['input.value']).toBe('{"cmd":"ls"}')
    expect(tool(spans)?.attributes['output.value']).toBe('permission denied')
    // The human's prompt is captured; the tool-result-only user turn is not.
    expect(userPrompt(spans)?.attributes['content']).toContain('please run ls')
    expect(spans.filter((x) => x.name === 'user.prompt')).toHaveLength(1)
  })
})

describe('copilot adapter (event envelope, toolCallId join)', () => {
  it('carries ephemeral input tokens onto the LLM span and joins tool errors by id', async () => {
    const path = join(dir, 'copilot-events.jsonl')
    writeFileSync(
      path,
      [
        { type: 'assistant.usage', data: { inputTokens: 900, model: 'gpt-5' } },
        { type: 'assistant.message', timestamp: '2026-01-01T00:00:00Z', data: { messageId: 'm1', content: 'hi', outputTokens: 30 } },
        { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'shell', arguments: { cmd: 'x' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 't1', success: false, output: 'shell failed', error: { message: 'boom' } } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    const spans = await new CopilotAdapter().parse(refFor(path, 'github-copilot'))
    expect(traceShapeDigest(spans)).toBe('40b451bb5b5584126e8e7f1f7f3c3e349a44fbfc30b3032de703e414a1e20a9e')
    expect(llm(spans)?.attributes['llm.token_count.prompt']).toBe(900)
    expect(llm(spans)?.attributes['llm.token_count.completion']).toBe(30)
    expect(tool(spans)?.status.code).toBe('ERROR')
    expect(tool(spans)?.status.message).toContain('boom')
    expect(tool(spans)?.attributes.content).toBeUndefined()
    expect(tool(spans)?.attributes['input.value']).toBe('{"cmd":"x"}')
    expect(tool(spans)?.attributes['output.value']).toBe('shell failed')
    // Assistant text is captured; Copilot's log format carries no user prompt.
    expect(llm(spans)?.attributes['content']).toBe('hi')
    expect(userPrompt(spans)).toBeUndefined()
  })
})

describe('qwen adapter (flat ChatRecord, genai parts)', () => {
  it('reads Gemini-API token names and functionCall/functionResponse', async () => {
    const path = join(dir, 'qwen.jsonl')
    writeFileSync(
      path,
      [
        { type: 'user', sessionId: 's', message: { role: 'user', parts: [{ text: 'go' }] } },
        {
          type: 'assistant',
          sessionId: 's',
          model: 'qwen3',
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40 },
          message: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { p: 'a' } } }] },
        },
        { type: 'tool_result', sessionId: 's', toolCallResult: { status: 'error' }, message: { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { error: 'not found' } } }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    const spans = await new QwenAdapter().parse(refFor(path, 'qwen'))
    expect(traceShapeDigest(spans)).toBe('0d1fad0c2e55e211946360ddab009276834fae3d9e1f9667b2425b975e01b0d7')
    expect(llm(spans)?.attributes['llm.token_count.prompt']).toBe(500)
    expect(llm(spans)?.attributes['llm.token_count.completion']).toBe(40)
    expect(tool(spans)?.attributes['tool.name']).toBe('read_file')
    expect(tool(spans)?.status.code).toBe('ERROR')
    expect(tool(spans)?.attributes.content).toBeUndefined()
    expect(tool(spans)?.attributes['output.value']).toBe('{"error":"not found"}')
    // The user turn becomes a user.prompt span; the functionResponse (role:user) turn does not.
    expect(userPrompt(spans)?.attributes['content']).toBe('go')
    expect(spans.filter((x) => x.name === 'user.prompt')).toHaveLength(1)
  })
})

describe('factory adapter (Anthropic blocks + settings sidecar)', () => {
  it('pulls model from sidecar and maps tool_use/tool_result blocks', async () => {
    const base = join(dir, 'fac-sess')
    writeFileSync(
      `${base}.jsonl`,
      [
        { type: 'session_start', id: 'sess', cwd: '/x' },
        { type: 'message', id: 'a1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'edit', input: {} }] } },
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'edit failed' }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    writeFileSync(`${base}.settings.json`, JSON.stringify({ model: 'claude-opus-4-5', tokenUsage: { inputTokens: 1234, outputTokens: 56 } }))
    const spans = await new FactoryAdapter().parse(refFor(`${base}.jsonl`, 'factory'))
    expect(traceShapeDigest(spans)).toBe('42b7c5de678ebd16f99dd2f7e9cee292c0beea2f301f1e5de7440e6cb35ca0b5')
    expect(llm(spans)?.attributes['llm.model_name']).toBe('claude-opus-4-5')
    expect(tool(spans)?.attributes['tool.name']).toBe('edit')
    expect(tool(spans)?.status.code).toBe('ERROR')
    expect(tool(spans)?.attributes['output.value']).toBe('edit failed')
    const root = spans.find((s) => s.attributes['openinference.span.kind'] === 'AGENT')
    expect(root?.attributes['session.input_tokens']).toBe(1234)
  })
})

describe('claude adapter (conversation capture)', () => {
  it('preserves complete output while folding subagents under their Agent call', async () => {
    const path = join(dir, 'claude.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          sessionId: 'claude-trace',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'assistant', model: 'opus', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { task: 'inspect' } }] },
        }),
        JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', is_error: false, content: 'done' }] } }),
      ].join('\n'),
    )
    const subDir = join(dir, 'claude', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-a.jsonl'),
      [
        { type: 'user', uuid: 'su1', timestamp: '2026-01-01T00:00:01.100Z', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'inspect' }] } },
        {
          type: 'assistant',
          uuid: 'sa1',
          timestamp: '2026-01-01T00:00:01.200Z',
          message: { role: 'assistant', model: 'haiku', usage: { input_tokens: 2, output_tokens: 1 }, content: [{ type: 'text', text: 'found it' }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    writeFileSync(join(subDir, 'agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'agent-call' }))

    const spans = await new ClaudeAdapter().parse(refFor(path, 'claude-code'))
    expect(traceShapeDigest(spans)).toBe('2c4db02efac123b97015db82dd79a91df220abbcb700773735bb0ec660272694')
    expect(spans.map((item) => item.name)).toEqual(['session', 'user.prompt', 'llm.turn', 'tool.Agent', 'user.prompt', 'llm.turn'])
    expect(spans.every((item) => item.trace_id === 'claude-trace')).toBe(true)
    expect(spans[0]).toMatchObject({ start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:00:02Z' })
    const mainTurn = llm(spans)
    expect(mainTurn?.attributes['llm.token_count.prompt']).toBe(10)
    expect(mainTurn?.attributes['llm.token_count.prompt_cache_hit']).toBe(5)
    expect(mainTurn?.attributes['llm.token_count.completion']).toBe(3)
    const agentCall = tool(spans)
    expect(agentCall).toMatchObject({ end_time: '2026-01-01T00:00:02Z', status: { code: 'OK' } })
    expect(agentCall?.attributes.content).toBeUndefined()
    expect(agentCall?.attributes['output.value']).toBe('done')
    expect(spans.filter((item) => item.attributes['agent.name'] === 'subagent:Explore').every((item) => item.parent_span_id === agentCall?.span_id)).toBe(true)
  })
})

// Conversation capture across every adapter: the user's prompt becomes a
// `user.prompt` span, the assistant's prose lands as `content` somewhere, and a
// tool call is recorded. (content lives in attributes['content'], any span kind.)
const hasContent = (s: OtlpSpan[], text: string) => s.some((x) => x.attributes['content'] === text)

describe('conversation capture — JSONL adapters', () => {
  const cases: Array<{ name: string; file: string; make: () => { parse(r: SessionRef): Promise<OtlpSpan[]> }; lines: unknown[]; toolName: string }> = [
    {
      name: 'codex', file: 'rollout-x.jsonl', make: () => new CodexAdapter(), toolName: 'test_tool',
      lines: [
        { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 's1', cwd: '/x' } },
        { type: 'turn_context', timestamp: '2026-06-20T00:00:01Z', payload: { model: 'gpt-4' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:02Z', payload: { type: 'message', role: 'user', content: 'hello world' } },
        { type: 'event_msg', timestamp: '2026-06-20T00:00:03Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:04Z', payload: { type: 'function_call', call_id: 'c1', name: 'test_tool', arguments: '{"a":1}' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:06Z', payload: { type: 'message', role: 'assistant', content: 'on it' } },
      ],
    },
    {
      name: 'pi', file: 'pi.jsonl', make: () => new PiAdapter(), toolName: 'test_tool',
      lines: [
        { type: 'session', id: 'trace-123', timestamp: '2026-06-20T10:00:00Z' },
        { type: 'message', id: 'm0', timestamp: '2026-06-20T10:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } },
        { type: 'message', id: 'm1', timestamp: '2026-06-20T10:00:02Z', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'on it' }, { type: 'tool_call', id: 'tc1', toolName: 'test_tool', input: { p: 1 } }] } },
      ],
    },
    {
      name: 'factory', file: 'fac.jsonl', make: () => new FactoryAdapter(), toolName: 'example_tool',
      lines: [
        { type: 'session_start', id: 'trace123', timestamp: '2026-06-20T00:00:00Z' },
        { type: 'message', id: 'msg1', timestamp: '2026-06-20T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } },
        { type: 'message', id: 'msg2', timestamp: '2026-06-20T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'tool1', name: 'example_tool', input: { k: 'v' } }] } },
      ],
    },
  ]
  for (const c of cases) {
    it(`${c.name} captures user.prompt + assistant text + a tool call`, async () => {
      const path = join(dir, c.file)
      writeFileSync(path, c.lines.map((l) => JSON.stringify(l)).join('\n'))
      const spans = await c.make().parse(refFor(path, c.name))
      if (c.name === 'pi') {
        expect(traceShapeDigest(spans)).toBe('3c39c063421a2a4952f72cb1f6b0b7ba6a434cb5ee18475daac2a5208366f632')
      }
      expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
      expect(hasContent(spans, 'on it')).toBe(true)
      const toolCall = tool(spans)
      expect(toolCall?.attributes['tool.name']).toBe(c.toolName)
      expect(toolCall?.attributes.content).toBeUndefined()
      expect(toolCall?.attributes['input.value']).toBeDefined()
    })
  }
})

describe('pi tool results', () => {
  it('joins a successful result to its tool call without dropping the output', async () => {
    const path = join(dir, 'pi-tool-result.jsonl')
    writeFileSync(
      path,
      [
        { type: 'session', id: 'pi-result', timestamp: '2026-06-20T10:00:00Z' },
        { type: 'message', id: 'm1', timestamp: '2026-06-20T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'tc1', toolName: 'read', input: { path: 'a' } }] } },
        { type: 'message', id: 'm2', timestamp: '2026-06-20T10:00:02Z', message: { role: 'toolResult', content: [{ type: 'tool_result', toolCallId: 'tc1', output: 'pi result' }] } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    )

    const result = tool(await new PiAdapter().parse(refFor(path, 'pi')))
    expect(result?.status.code).toBe('OK')
    expect(result?.attributes['input.value']).toBe('{"path":"a"}')
    expect(result?.attributes['output.value']).toBe('pi result')
  })
})

describe('codex current tool and subagent events', () => {
  it('captures custom tool calls, joins their outputs, and tracks subagent lifecycles', async () => {
    const path = join(dir, 'rollout-codex-current.jsonl')
    const startedAt = Date.parse('2026-07-11T09:00:05.000Z')
    writeFileSync(
      path,
      [
        { type: 'session_meta', timestamp: '2026-07-11T09:00:00.000Z', payload: { id: 'codex-current', cwd: '/x' } },
        { type: 'turn_context', timestamp: '2026-07-11T09:00:01.000Z', payload: { model: 'gpt-5' } },
        { type: 'event_msg', timestamp: '2026-07-11T09:00:02.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 4 } } } },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:03.000Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-1',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'pnpm test' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.000Z',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'custom-1',
            output: [{ type: 'input_text', text: 'Command failed with exit code 1' }],
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.100Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-2',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'rm -rf build' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.200Z',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-2', output: 'Script completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.300Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-3',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'curl -X POST https://example.test/release' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.400Z',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-3', output: 'Script completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.500Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-4',
            name: 'exec',
            input: "const r = await tools.exec_command({ cmd: 'curl https://example.test/health' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.600Z',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-4', output: 'Script completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.700Z',
          payload: {
            type: 'function_call',
            call_id: 'blocking-1',
            name: 'wait',
            arguments: '{"cell_id":"running-1"}',
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.800Z',
          payload: { type: 'function_call_output', call_id: 'blocking-1', output: 'Completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:04.900Z',
          payload: {
            type: 'function_call',
            call_id: 'domain-wait-1',
            name: 'wait',
            arguments: '{"job_id":"domain-1"}',
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.000Z',
          payload: { type: 'function_call_output', call_id: 'domain-wait-1', output: 'Completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.100Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'malformed-input-1',
            name: 'exec',
            input: { cmd: 'ls' },
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.200Z',
          payload: { type: 'custom_tool_call_output', call_id: 'malformed-input-1', output: 'Completed' },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.300Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'write-stdin-1',
            name: 'exec',
            input: "const r = await tools.write_stdin({ session_id: 7, chars: '' })",
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:05.400Z',
          payload: { type: 'custom_tool_call_output', call_id: 'write-stdin-1', output: 'Completed' },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:05.500Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'spawn-1',
            occurred_at_ms: startedAt,
            agent_thread_id: 'thread-1',
            agent_path: '/root/paper_audit',
            kind: 'started',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:06.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'message-1',
            occurred_at_ms: startedAt + 1_000,
            agent_thread_id: 'thread-1',
            agent_path: '/root/paper_audit',
            kind: 'interacted',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:07.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'interrupt-1',
            occurred_at_ms: startedAt + 2_000,
            agent_thread_id: 'thread-1',
            agent_path: '/root/paper_audit',
            kind: 'interrupted',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:08.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'spawn-2',
            occurred_at_ms: startedAt + 3_000,
            agent_thread_id: 'thread-2',
            agent_path: '/root/runtime_audit',
            kind: 'started',
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-07-11T09:00:09.000Z',
          payload: {
            type: 'sub_agent_activity',
            event_id: 'complete-2',
            occurred_at_ms: startedAt + 4_000,
            agent_thread_id: 'thread-2',
            agent_path: '/root/runtime_audit',
            kind: 'completed',
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    )

    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))
    const tools = spans.filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    expect(tools).toHaveLength(10)
    const verifications = tools.filter((item) => item.attributes['tool.name'] === 'exec_command.verify')
    expect(verifications).toHaveLength(2)
    const failedVerification = verifications.find((item) => item.status.code === 'ERROR')
    expect(failedVerification?.attributes.content).toBeUndefined()
    expect(failedVerification?.attributes['input.value']).toContain('tools.exec_command')
    expect(failedVerification?.attributes['traces.codex.call_type']).toBe('custom_tool_call')
    expect(failedVerification?.attributes['traces.codex.outer_tool_name']).toBe('exec')
    expect(failedVerification?.attributes['traces.codex.nested_tool_name']).toBe('exec_command')
    expect(failedVerification?.status.message).toContain('Command failed')
    expect(failedVerification?.attributes['output.value']).toContain('Command failed with exit code 1')
    const successfulVerification = verifications.find((item) => item.status.code === 'OK')
    expect(successfulVerification?.attributes['input.value']).toContain('/health')
    expect(successfulVerification?.attributes['output.value']).toBe('Script completed')
    const mutations = tools.filter((item) => item.attributes['tool.name'] === 'exec_command')
    expect(mutations).toHaveLength(2)
    expect(mutations.map((item) => item.attributes['input.value'])).toEqual([
      expect.stringContaining('rm -rf build'),
      expect.stringContaining('curl -X POST'),
    ])
    expect(mutations.every((item) => item.status.code === 'OK')).toBe(true)

    const waits = tools.filter((item) => item.attributes['tool.name'] === 'wait')
    expect(waits).toHaveLength(2)
    expect(waits.find((item) => String(item.attributes['input.value']).includes('cell_id'))?.attributes['traces.expected_blocking']).toBe(true)
    expect(waits.find((item) => String(item.attributes['input.value']).includes('job_id'))?.attributes['traces.expected_blocking']).toBeUndefined()
    expect(waits.every((item) => item.status.code === 'OK')).toBe(true)

    const malformed = tools.find((item) => item.attributes['tool.name'] === 'exec')
    expect(malformed?.attributes['input.value']).toBe('{"cmd":"ls"}')
    expect(malformed?.status.code).toBe('OK')

    const writeStdin = tools.find((item) => item.attributes['tool.name'] === 'write_stdin')
    expect(writeStdin?.attributes['traces.expected_blocking']).toBe(true)
    expect(writeStdin?.status.code).toBe('OK')

    const agents = tools.filter((item) => item.attributes['tool.name'] === 'Agent')
    expect(agents).toHaveLength(2)
    const agent = agents.find((item) => String(item.attributes['input.value']).includes('paper_audit'))
    expect(JSON.parse(String(agent?.attributes['input.value']))).toEqual({
      subagent_type: 'paper_audit',
      agent_path: '/root/paper_audit',
      agent_thread_id: 'thread-1',
    })
    expect(agent?.start_time).toBe('2026-07-11T09:00:05.000Z')
    expect(agent?.end_time).toBe('2026-07-11T09:00:07.000Z')
    expect(agent?.status).toEqual({ code: 'ERROR', message: 'subagent interrupted' })

    const completed = agents.find((item) => String(item.attributes['input.value']).includes('runtime_audit'))
    expect(completed?.start_time).toBe('2026-07-11T09:00:08.000Z')
    expect(completed?.end_time).toBe('2026-07-11T09:00:09.000Z')
    expect(completed?.status).toEqual({ code: 'OK' })
  })

  it('links multi-agent calls to native child-session metadata', async () => {
    const parentId = '019f24d6-b5ec-7173-acc1-f957de216ee5'
    const childId = '019f5aea-d6b4-7451-a3eb-60289875a357'
    const parentPath = join(dir, 'rollout-codex-multi-agent-parent.jsonl')
    const childPath = join(dir, 'rollout-codex-multi-agent-child.jsonl')
    writeFileSync(
      parentPath,
      [
        {
          timestamp: '2026-07-13T09:59:20.000Z',
          type: 'session_meta',
          payload: { id: parentId, cwd: '/home/drew/code/agent-dev-container' },
        },
        {
          timestamp: '2026-07-13T09:59:27.617Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'spawn-call',
            name: 'exec',
            input: 'const r = await tools.multi_agent_v1__spawn_agent({agent_type:"worker",message:"Audit traces"}); text(r)',
          },
        },
        {
          timestamp: '2026-07-13T09:59:27.783Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'spawn-call',
            output: [
              { type: 'input_text', text: 'Script completed\nOutput:\n' },
              { type: 'input_text', text: JSON.stringify({ agent_id: childId, nickname: 'Einstein' }) },
            ],
          },
        },
        {
          timestamp: '2026-07-13T10:16:55.056Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'send-call',
            name: 'exec',
            input: `await tools.multi_agent_v1__send_input({target:"${childId}",message:"Finish"})`,
          },
        },
        {
          timestamp: '2026-07-13T10:16:55.100Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'send-call', output: '{"submission_id":"submission-1"}' },
        },
        {
          timestamp: '2026-07-13T10:24:33.912Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'wait-call',
            name: 'exec',
            input: `await tools.multi_agent_v1__wait_agent({targets:["${childId}"],timeout_ms:10000})`,
          },
        },
        {
          timestamp: '2026-07-13T10:24:34.000Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'wait-call', output: '{"timed_out":true}' },
        },
      ].map((event) => JSON.stringify(event)).join('\n'),
    )
    writeFileSync(
      childPath,
      [
        {
          timestamp: '2026-07-13T09:59:27.791Z',
          type: 'session_meta',
          payload: {
            id: childId,
            parent_thread_id: parentId,
            cwd: '/home/drew/code/agent-dev-container',
            thread_source: 'subagent',
            agent_nickname: 'Einstein',
            agent_role: 'worker',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parentId,
                  depth: 1,
                  agent_nickname: 'Einstein',
                  agent_role: 'worker',
                },
              },
            },
          },
        },
        {
          timestamp: '2026-07-13T09:59:28.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: 'Own direct-streaming conversion for the remaining JSONL adapters.' },
        },
      ].map((event) => JSON.stringify(event)).join('\n'),
    )

    const parentSpans = await new CodexAdapter().parse(refFor(parentPath, 'codex'))
    const childSpans = await new CodexAdapter().parse(refFor(childPath, 'codex'))
    const parentRoot = parentSpans[0]!
    expect(parentRoot.attributes['traces.session.role']).toBe('operator')

    const collaboration = parentSpans.filter((item) => item.attributes['traces.codex.agent_operation'])
    expect(collaboration.map((item) => item.attributes['traces.codex.agent_operation'])).toEqual([
      'spawn_agent',
      'send_input',
      'wait_agent',
    ])
    expect(collaboration.every((item) => item.attributes['traces.codex.agent_session_ids'] === JSON.stringify([childId]))).toBe(true)
    expect(collaboration[0]!.attributes['traces.child_session_ids']).toBe(JSON.stringify([childId]))
    expect((await analyzeAdoption(parentSpans)).totalSubagentSpawns).toBe(1)

    const childRoot = childSpans[0]!
    expect(childRoot.trace_id).toBe(childId)
    expect(childRoot.attributes).toMatchObject({
      'traces.session.role': 'child',
      'traces.parent_session_id': parentId,
      'traces.codex.agent_depth': 1,
      'traces.codex.agent_nickname': 'Einstein',
      'traces.codex.agent_role': 'worker',
    })
  })

  it.each([
    ['curl https://example.test/health', 'exec_command.verify'],
    ['curl -X HEAD https://example.test/health', 'exec_command.verify'],
    ['curl -F file=@x https://example.test/upload', 'exec_command'],
    ["curl --json '{\"ok\":true}' https://example.test", 'exec_command'],
    ['curl -T ./x https://example.test/upload', 'exec_command'],
    ['curl -d@payload.json https://example.test', 'exec_command'],
    ['curl -X PURGE https://example.test/cache', 'exec_command'],
  ])('classifies curl command %s as %s', async (command, expectedTool) => {
    const path = join(dir, `rollout-codex-curl-${expectedTool}-${command.length}.jsonl`)
    writeFileSync(
      path,
      [
        { type: 'session_meta', timestamp: '2026-07-11T09:00:00.000Z', payload: { id: `curl-${command}`, cwd: '/x' } },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:01.000Z',
          payload: {
            type: 'custom_tool_call',
            call_id: 'curl-1',
            name: 'exec',
            input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} })`,
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-07-11T09:00:02.000Z',
          payload: { type: 'custom_tool_call_output', call_id: 'curl-1', output: 'Completed' },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    )
    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))
    const tool = spans.find((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    expect(tool?.attributes['tool.name']).toBe(expectedTool)
  })
})

describe('conversation capture — single-JSON adapters', () => {
  it('gemini captures user.prompt + assistant text + a tool call', async () => {
    const path = join(dir, 'gem.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: 'g1',
        startTime: '2026-06-20T00:00:00Z',
        messages: [
          { id: 'm0', type: 'user', content: 'hello world', timestamp: '2026-06-20T00:00:00Z' },
          { id: 'm1', type: 'assistant', content: 'on it', timestamp: '2026-06-20T00:00:01Z', model: 'gemini', tokens: { input: 2, output: 2 }, toolCalls: [{ id: 'tc0', name: 'test-tool', args: { k: 'v' }, status: 'ok', result: { value: 1 } }] },
        ],
      }),
    )
    const spans = await new GeminiAdapter().parse(refFor(path, 'gemini'))
    expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
    expect(hasContent(spans, 'on it')).toBe(true)
    expect(tool(spans)?.attributes['tool.name']).toBe('test-tool')
    expect(tool(spans)?.attributes.content).toBeUndefined()
    expect(tool(spans)?.attributes['output.value']).toBe('{"value":1}')
  })

  it('forge captures user.prompt + assistant text + a tool call', async () => {
    const path = join(dir, 'x-dump.json')
    writeFileSync(
      path,
      JSON.stringify({
        conversation_id: 'c1',
        messages: [
          { text: { role: 'user', content: 'hello world' }, usage: {} },
          { text: { role: 'assistant', content: 'on it', model: 'claude-opus', tool_calls: [{ name: 'test_tool', call_id: 'c1', arguments: { k: 'v' } }] }, usage: { prompt_tokens: { actual: 100 }, completion_tokens: { actual: 50 } } },
          { tool: { name: 'test_tool', call_id: 'c1', output: { is_error: false, values: ['ok'] } }, usage: {} },
        ],
      }),
    )
    const spans = await new ForgeAdapter().parse(refFor(path, 'forge'))
    expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
    expect(hasContent(spans, 'on it')).toBe(true)
    expect(tool(spans)?.attributes['tool.name']).toBe('test_tool')
    expect(tool(spans)?.attributes.content).toBeUndefined()
    expect(tool(spans)?.attributes['output.value']).toBe('["ok"]')
  })
})

describe('opencode adapter (split-dir conversation capture)', () => {
  it('reads message text parts as user.prompt + assistant content', async () => {
    // opencode resolves `part/` from XDG_DATA_HOME/opencode/storage, not relative
    // to the message dir, so point XDG_DATA_HOME at the fixture root.
    const base = mkdtempSync(join(tmpdir(), 'tt-oc-'))
    const storage = join(base, 'opencode', 'storage')
    const w = (rel: string, body: unknown) => {
      const p = join(storage, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(body))
    }
    w('message/session-001/msg-001.json', { id: 'msg-001', role: 'user', modelID: null, tokens: { input: 10, output: 0 }, time: { created: 1_000_000, completed: 1_000_100 } })
    w('message/session-001/msg-002.json', { id: 'msg-002', role: 'assistant', modelID: 'claude', tokens: { input: 10, output: 20 }, time: { created: 1_000_100, completed: 1_000_500 } })
    w('part/msg-001/part-001.json', { type: 'text', text: 'hello world' })
    w('part/msg-002/part-001.json', { type: 'text', text: 'on it' })
    w('part/msg-002/part-002.json', { type: 'tool', tool: 'bash', callID: 'call-001', state: { status: 'ok', input: { command: 'ls' }, output: 'files' } })
    await withEnv('XDG_DATA_HOME', base, async () => {
      const spans = await new OpencodeAdapter().parse(refFor(join(storage, 'message', 'session-001'), 'opencode'))
      expect(userPrompt(spans)?.attributes['content']).toBe('hello world')
      expect(spans.filter((item) => item.name === 'message.user')).toHaveLength(0)
      expect(spans.filter((item) => item.name === 'user.prompt')).toHaveLength(1)
      expect(hasContent(spans, 'on it')).toBe(true)
      expect(tool(spans)?.attributes['tool.name']).toBe('bash')
      expect(tool(spans)?.attributes.content).toBeUndefined()
      expect(tool(spans)?.attributes['output.value']).toBe('files')
    })
  })

  it('accepts a message whose optional parts directory is absent', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-oc-no-parts-'))
    const path = join(base, 'opencode', 'storage', 'message', 'session-no-parts')
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'message.json'),
      JSON.stringify({ id: 'message-1', role: 'assistant', time: { created: 1_000 } }),
    )

    await withEnv('XDG_DATA_HOME', base, async () => {
      const spans = await new OpencodeAdapter().parse(refFor(path, 'opencode'))
      expect(spans.map((item) => item.name)).toEqual(['session', 'message.assistant'])
    })
  })

  it('rejects an unreadable message directory for a discovered session', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-oc-missing-'))
    const path = join(base, 'opencode', 'storage', 'message', 'session-missing')

    await withEnv('XDG_DATA_HOME', base, () =>
      expectJsonSourceFailure(new OpencodeAdapter().parse(refFor(path, 'opencode')), path, 'read', undefined, 'ENOENT'),
    )
  })

  it('rejects malformed message JSON without exposing its contents', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-oc-message-'))
    const path = join(base, 'opencode', 'storage', 'message', 'session-bad-message')
    const messagePath = join(path, 'message.json')
    const rawSecret = 'secret-opencode-message-json'
    mkdirSync(path, { recursive: true })
    writeFileSync(messagePath, rawSecret)

    await withEnv('XDG_DATA_HOME', base, () =>
      expectJsonSourceFailure(
        new OpencodeAdapter().parse(refFor(path, 'opencode')),
        messagePath,
        'parse',
        rawSecret,
      ),
    )
  })

  it('rejects malformed part JSON without returning a partial session', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-oc-part-'))
    const storage = join(base, 'opencode', 'storage')
    const path = join(storage, 'message', 'session-bad-part')
    const partDir = join(storage, 'part', 'message-1')
    const partPath = join(partDir, 'part.json')
    const rawSecret = 'secret-opencode-part-json'
    mkdirSync(path, { recursive: true })
    mkdirSync(partDir, { recursive: true })
    writeFileSync(join(path, 'message.json'), JSON.stringify({ id: 'message-1', role: 'assistant' }))
    writeFileSync(partPath, rawSecret)

    await withEnv('XDG_DATA_HOME', base, () =>
      expectJsonSourceFailure(
        new OpencodeAdapter().parse(refFor(path, 'opencode')),
        partPath,
        'parse',
        rawSecret,
      ),
    )
  })
})

describe('capText', () => {
  it('trims short text and marks truncation with the dropped count', () => {
    expect(capText('  hi  ')).toBe('hi')
    const long = 'x'.repeat(CONTENT_CAP + 50)
    const out = capText(long)
    expect(out.startsWith('x'.repeat(CONTENT_CAP))).toBe(true)
    expect(out).toContain('[+50 chars]')
    expect(out.length).toBeLessThan(long.length)
  })
})

// A codex *continuation* session leads with a session_meta that has no cwd (or a
// turn_context); cwd must be recovered from a later cwd-bearing line so the
// session still gets repo labels instead of coming back cwd:null.
describe('codex cwd recovery — continuation sessions', () => {
  it('recovers cwd from turn_context when the leading session_meta lacks it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-codex-cont-'))
    const day = join(base, 'sessions', '2026', '06', '20')
    mkdirSync(day, { recursive: true })
    const lines = [
      { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 'cont1' } },
      { type: 'turn_context', timestamp: '2026-06-20T00:00:01Z', payload: { model: 'gpt-4', cwd: '/home/u/code/myrepo' } },
    ]
    writeFileSync(join(day, 'rollout-2026-06-20T00-00-00-cont1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = base
    try {
      const refs = await new CodexAdapter().locate({})
      expect(refs.find((r) => r.sessionId === 'cont1')?.cwd).toBe('/home/u/code/myrepo')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('discovers a session with malformed head data and records its corruption', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-codex-malformed-'))
    const day = join(base, 'sessions', '2026', '07', '13')
    mkdirSync(day, { recursive: true })
    const path = join(day, 'rollout-2026-07-13T00-00-00-malformed.jsonl')
    const rawSecret = 'secret-codex-session-head'
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'malformed', cwd: '/x' } })}\n${rawSecret}\n`,
    )

    const refs = await withEnv('CODEX_HOME', base, () => new CodexAdapter().locate({}))
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      sessionId: 'malformed',
      path,
      integrity: {
        status: 'degraded_not_lossless',
        corruptions: [{
          lineNumber: 2,
          sha256: createHash('sha256').update(rawSecret).digest('hex'),
        }],
      },
    })
    expect(JSON.stringify(refs)).not.toContain(rawSecret)
  })

  it('keeps a degraded session with unknown cwd when a cwd filter is requested', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-codex-malformed-cwd-'))
    const day = join(base, 'sessions', '2026', '07', '13')
    mkdirSync(day, { recursive: true })
    const path = join(day, 'rollout-2026-07-13T00-00-00-unknown-cwd.jsonl')
    const rawSecret = 'secret-corrupt-session-meta'
    writeFileSync(path, `${rawSecret}\n{}\n`)

    const refs = await withEnv('CODEX_HOME', base, () => new CodexAdapter().locate({ cwd: '/expected/repo' }))

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      path,
      cwd: null,
      integrity: {
        status: 'degraded_not_lossless',
        corruptions: [{ lineNumber: 1 }],
      },
    })
    expect(JSON.stringify(refs)).not.toContain(rawSecret)
  })
})

// Gemini/Qwen-family sessions live at tmp/<projectHash>/chats/; for a *registered*
// project the hash IS the project name, reversible via <home>/projects.json →
// recover cwd. (Unregistered/digest dirs stay null — unavoidable.)
describe('gemini cwd recovery — registered projects', () => {
  it('resolves cwd from projects.json for a registered project name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-gem-home-'))
    mkdirSync(join(home, '.gemini', 'tmp', 'myrepo', 'chats'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: { '/home/u/code/myrepo': 'myrepo' } }))
    writeFileSync(join(home, '.gemini', 'tmp', 'myrepo', 'chats', 'session-1.json'), JSON.stringify({ sessionId: 's1', messages: [] }))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const refs = await new GeminiAdapter().locate({})
      expect(refs.find((r) => r.sessionId === 'session-1')?.cwd).toBe('/home/u/code/myrepo')
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
    }
  })

  it('rejects malformed optional project metadata instead of losing cwd labels', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-gem-bad-projects-'))
    const metadataPath = join(home, '.gemini', 'projects.json')
    const rawSecret = 'secret-gemini-project-metadata'
    mkdirSync(dirname(metadataPath), { recursive: true })
    mkdirSync(join(home, '.gemini', 'tmp'), { recursive: true })
    writeFileSync(metadataPath, rawSecret)

    await withEnv('HOME', home, () =>
      expectJsonSourceFailure(new GeminiAdapter().locate({}), metadataPath, 'parse', rawSecret),
    )
  })
})
