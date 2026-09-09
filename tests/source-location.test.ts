import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AmpAdapter } from '../src/adapters/amp.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { CodexAdapter } from '../src/adapters/codex.js'
import { CodexExecAdapter } from '../src/adapters/codex-exec.js'
import { CopilotAdapter } from '../src/adapters/copilot.js'
import { FactoryAdapter } from '../src/adapters/factory.js'
import { ForgeAdapter } from '../src/adapters/forge.js'
import { GeminiAdapter } from '../src/adapters/gemini.js'
import { OpencodeAdapter } from '../src/adapters/opencode.js'
import { PiAdapter } from '../src/adapters/pi.js'
import { QwenAdapter } from '../src/adapters/qwen.js'
import { assembleSessionBundle } from '../src/bundle.js'
import { createBundleSourceReader } from '../src/bundle-source.js'
import { readOtlpInput } from '../src/otlp-input.js'
import { canonicalJson } from '../src/adapters/tool-io.js'
import { readJsonl } from '../src/jsonl.js'
import { collectSessionSelection } from '../src/session-selection.js'
import { SOURCE_ATTRIBUTE_PREFIX, sourceOf, type SourceRecordReference } from '../src/source-location.js'
import type { HarnessTraceAdapter, SessionRef } from '../src/types.js'

const directories: string[] = []
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }) })
const text = `${'message '.repeat(2300)}message-tail`
const args = { path: `${'input '.repeat(3000)}input-tail` }
const output = `${'output '.repeat(2600)}output-tail`
const blocks = [{ type: 'text', text }, { type: 'tool_use', id: 'call', name: 'Read', input: args }]
const resultBlocks = [{ type: 'tool_result', tool_use_id: 'call', content: output }]
const timestamp = '2026-01-01T00:00:00Z'
const cases: Array<{ harness: string; adapter: HarnessTraceAdapter; json?: unknown; lines?: unknown[] }> = [
  { harness: 'amp', adapter: new AmpAdapter(), json: { id: 'fixture', messages: [{ role: 'assistant', messageId: 1, content: blocks }, { role: 'user', content: resultBlocks }] } },
  { harness: 'claude-code', adapter: new ClaudeAdapter(), lines: [
    { type: 'assistant', uuid: 'a', sessionId: 'fixture', timestamp, message: { id: 'm', role: 'assistant', content: blocks } },
    { type: 'user', uuid: 'b', sessionId: 'fixture', timestamp, message: { role: 'user', content: resultBlocks } },
  ] },
  { harness: 'factory', adapter: new FactoryAdapter(), lines: [
    { type: 'session_start', id: 'fixture', timestamp },
    { type: 'message', id: 'a', timestamp, message: { role: 'assistant', content: blocks } },
    { type: 'message', id: 'b', timestamp, message: { role: 'user', content: resultBlocks } },
  ] },
  { harness: 'github-copilot', adapter: new CopilotAdapter(), lines: [
    { type: 'assistant.message', timestamp, data: { messageId: 'm', content: text } },
    { type: 'tool.execution_start', timestamp, data: { toolCallId: 'call', toolName: 'Read', arguments: args } },
    { type: 'tool.execution_complete', timestamp, data: { toolCallId: 'call', success: true, output } },
  ] },
  { harness: 'qwen', adapter: new QwenAdapter(), lines: [
    { type: 'assistant', sessionId: 'fixture', timestamp, message: { role: 'model', parts: [{ text }, { functionCall: { name: 'Read', args } }] } },
    { type: 'tool_result', sessionId: 'fixture', timestamp, message: { role: 'user', parts: [{ functionResponse: { name: 'Read', response: output } }] } },
  ] },
  { harness: 'pi', adapter: new PiAdapter(), lines: [
    { type: 'session', id: 'fixture', timestamp },
    { type: 'message', id: 'm', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_call', id: 'call', toolName: 'Read', input: args }] } },
    { type: 'message', id: 'r', timestamp, message: { role: 'toolResult', toolCallId: 'call', toolName: 'Read', content: [{ type: 'text', text: output }] } },
  ] },
  { harness: 'gemini', adapter: new GeminiAdapter(), json: { sessionId: 'fixture', startTime: timestamp, messages: [{ id: 'm', type: 'assistant', timestamp, content: text, toolCalls: [{ id: 'call', name: 'Read', args, result: output, status: 'ok' }] }] } },
  { harness: 'gemini', adapter: new GeminiAdapter(), json: { sessionId: 'fixture', startTime: timestamp, messages: [{ id: 'm', type: 'assistant', timestamp, content: { text, structured: true }, toolCalls: [{ id: 'call', name: 'Read', args, result: output, status: 'ok' }] }] } },
  { harness: 'forge', adapter: new ForgeAdapter(), json: { conversation_id: 'fixture', messages: [
    { text: { role: 'assistant', content: text, tool_calls: [{ name: 'Read', call_id: 'call', arguments: args }] } },
    { tool: { name: 'Read', call_id: 'call', output: { is_error: false, values: output } } },
  ] } },
  { harness: 'codex', adapter: new CodexAdapter(), lines: [
    { type: 'session_meta', timestamp, payload: { id: 'fixture' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'call', name: 'Read', arguments: JSON.stringify(args) } },
    { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'call', output } },
  ] },
  { harness: 'codex-exec', adapter: new CodexExecAdapter(), lines: [
    { type: 'thread.started', thread_id: 'fixture' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'm', type: 'agent_message', text } },
    { type: 'item.started', item: { id: 'call', type: 'command_execution', command: args.path, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'call', type: 'command_execution', command: args.path, aggregated_output: output, exit_code: 0, status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ] },
]

async function verifyLocations(adapter: HarnessTraceAdapter, ref: SessionRef): Promise<void> {
  const selection = await collectSessionSelection([{ adapter, refs: [ref] }], { bindSources: true })
  const row = selection.rows[0]!
  const found = new Set<string>()
  for (const span of row.spans) {
    for (const attribute of ['content', 'input.value', 'output.value']) {
      const encoded = span.attributes[`${SOURCE_ATTRIBUTE_PREFIX}${attribute}`]
      if (typeof encoded !== 'string') continue
      for (const reference of JSON.parse(encoded) as SourceRecordReference[]) {
        const file = row.sourceFiles!.find((file) => file.sha256 === reference.sourceSha256)!
        const bytes = await readFile(file.path)
        const raw = bytes.subarray(reference.recordOffset, reference.recordOffset + reference.recordBytes)
        expect(createHash('sha256').update(raw).digest('hex')).toBe(reference.recordSha256)
        let field: unknown = JSON.parse(raw.toString('utf8'))
        for (const key of reference.fieldLocator.slice(2).split('/')) field = (field as Record<string, unknown>)[key.replaceAll('~1', '/').replaceAll('~0', '~')]
        const value = typeof field === 'string' ? field : canonicalJson(field)
        const tail = attribute === 'content' ? 'message-tail' : attribute === 'input.value' ? 'input-tail' : 'output-tail'
        expect(value).toContain(tail)
        if (attribute === 'content') expect(value).not.toContain('input-tail')
        expect(String(span.attributes[attribute])).not.toContain(tail)
        found.add(attribute)
      }
    }
  }
  expect([...found].sort()).toEqual(['content', 'input.value', 'output.value'])
  if (ref.harness === 'codex' || ref.harness === 'opencode') {
    const destination = await mkdtemp(join(tmpdir(), 'native-retained-'))
    directories.push(destination)
    await assembleSessionBundle({ adapter, ref, outDir: destination })
    const retained = (await readOtlpInput(join(destination, 'derived/trace.otlp.jsonl'))).spans
    for (const file of row.sourceFiles!) await rm(file.path)
    const reader = await createBundleSourceReader(destination, retained)
    const message = retained.find((span) => span.attributes[`${SOURCE_ATTRIBUTE_PREFIX}content`] !== undefined)!
    expect(await reader!({ trace_id: message.trace_id, span_id: message.span_id, attribute: 'content', offset: Buffer.byteLength(text) - 12, limit: 12 })).toMatchObject({ status: 'available', text: 'message-tail', next_offset: null })
  }
}

describe('native retained source locations', () => {
  it('preserves canonical BOM rejection and exact CRLF record receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-source-bom-'))
    directories.push(directory)
    const path = join(directory, 'bom.jsonl')
    const rejected = '\ufeff{"text":"rejected"}\r'
    const accepted = '{"text":"accepted"}\r'
    await writeFile(path, `${rejected}\n${accepted}\n`)
    const corrupt: unknown[] = []
    const rows = []
    for await (const row of readJsonl(path, { captureSources: true, mode: 'recover', onCorruption: (receipt) => corrupt.push(receipt) })) rows.push(row)
    expect(corrupt).toHaveLength(1)
    expect(rows).toEqual([{ text: 'accepted' }])
    expect(sourceOf(rows[0], 'text')).toMatchObject({ recordOffset: Buffer.byteLength(rejected) + 1, recordBytes: Buffer.byteLength(accepted), recordSha256: createHash('sha256').update(accepted).digest('hex') })
  })
  it.each(cases)('$harness pins omitted values to the correct original fields', async ({ harness, adapter, json, lines }) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-source-'))
    directories.push(directory)
    const path = join(directory, json ? 'session.json' : 'session.jsonl')
    await writeFile(path, json ? JSON.stringify(json) : lines!.map((line) => JSON.stringify(line)).join('\r\n'))
    await verifyLocations(adapter, { harness, sessionId: 'fixture', path, cwd: null, mtimeMs: 0 })
  })

  it('retains OpenCode message and part files from directory sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-source-opencode-'))
    directories.push(directory)
    const storage = join(directory, 'opencode/storage')
    for (const [path, value] of [
      ['message/fixture/m.json', { id: 'm', role: 'assistant', time: { created: 1000 } }],
      ['part/m/text.json', { type: 'text', text }],
      ['part/m/tool.json', { type: 'tool', tool: 'Read', callID: 'call', state: { status: 'ok', input: args, output } }],
    ] as const) {
      const destination = join(storage, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, JSON.stringify(value))
    }
    const before = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = directory
    try {
      await verifyLocations(new OpencodeAdapter(), { harness: 'opencode', sessionId: 'fixture', path: join(storage, 'message/fixture'), cwd: null, mtimeMs: 0 })
    } finally {
      if (before === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = before
    }
  })
})
