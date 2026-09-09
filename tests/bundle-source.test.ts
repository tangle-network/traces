import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalystRegistry, type Analyst } from '@tangle-network/agent-eval/analyst'
import { buildTraceAnalysisToolDescriptors, OtlpFileTraceStore, type ReadSpanSourceInput, type ReadSpanSourceResult, type TraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { analyzeSpans } from '../src/analyze.js'
import { assembleSessionBundle, type SessionBundleManifest } from '../src/bundle.js'
import { createBundleSourceReader } from '../src/bundle-source.js'
import { runTraceImprovement } from '../src/improvement.js'
import { readOtlpInput } from '../src/otlp-input.js'
import type { OtlpSpan } from '../src/otlp.js'
import { redactSpans } from '../src/redact.js'
import { SOURCE_ATTRIBUTE_PREFIX } from '../src/source-location.js'

let root: string
let bundle: string
let spans: readonly OtlpSpan[]
let input: ReadSpanSourceInput
const answer = `${'a'.repeat(18_000)}🙂 source-only-answer-tail`
const secret = `${'z'.repeat(18_000)} sibling-tool-input-tail`
const output = `${'o'.repeat(18_000)} source-only-output-tail`

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'traces-source-test-'))
  bundle = join(root, 'bundle')
  const path = join(root, 'session.jsonl')
  await writeFile(path, [
    { type: 'user', uuid: 'user', sessionId: 'source-test', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Inspect source' } },
    { type: 'assistant', uuid: 'assistant', sessionId: 'source-test', timestamp: '2026-01-01T00:00:01Z', message: { id: 'message', role: 'assistant', content: [
      { type: 'text', text: answer },
      { type: 'tool_use', id: 'call', name: 'Read', input: { path: secret } },
    ] } },
    { type: 'user', uuid: 'result', sessionId: 'source-test', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: output }] } },
  ].map((record) => JSON.stringify(record)).join('\n'))
  await assembleSessionBundle({ adapter: new ClaudeAdapter(), ref: { harness: 'claude-code', sessionId: 'source-test', path, cwd: null, mtimeMs: 0 }, outDir: bundle })
  spans = (await readOtlpInput(join(bundle, 'derived/trace.otlp.jsonl'))).spans
  const assistant = spans.find((span) => typeof span.attributes.content === 'string' && span.attributes.content.startsWith('aaaa'))!
  input = { trace_id: assistant.trace_id, span_id: assistant.span_id, attribute: 'content', offset: 18_000, limit: 100 }
  await rm(path)
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function copiedBundle(): Promise<string> {
  const destination = await mkdtemp(join(root, 'copy-'))
  await cp(bundle, destination, { recursive: true })
  return destination
}

async function sourcePath(directory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as SessionBundleManifest
  return join(directory, manifest.files.find((file) => file.sourceId)!.path)
}

describe('retained source capability', () => {
  it('reads omitted source text through the canonical tool after originals rotate', async () => {
    const reader = await createBundleSourceReader(bundle, spans)
    const store = new OtlpFileTraceStore({ path: join(bundle, 'derived/trace.otlp.jsonl'), sourceReader: reader })
    const tool = buildTraceAnalysisToolDescriptors({ store }).find((tool) => tool.name === 'readSpanSource')!
    const result = await tool.handler(input) as ReadSpanSourceResult
    expect(result).toMatchObject({ status: 'available', text: '🙂 source-only-answer-tail', offset: 18_000, total_bytes: Buffer.byteLength(answer), next_offset: null, source: { field_locator: '#/message/content/0/text', value_encoding: 'utf8-string' } })
    expect(spans.find((span) => span.span_id === input.span_id)!.attributes.content).not.toContain('source-only-answer-tail')
    expect(JSON.stringify(result)).not.toContain('sibling-tool-input-tail')
    expect(JSON.stringify(result)).not.toContain(root)
    if (result.status === 'available') expect(result.source.source_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await reader!({ ...input, source_index: 1 })).toMatchObject({ status: 'unavailable' })
    await expect(tool.handler({ ...input, limit: 16_385 })).rejects.toThrow()
    const largerStore = new OtlpFileTraceStore({ path: join(bundle, 'derived/trace.otlp.jsonl'), sourceReader: reader, perAttributeSpanBudget: 32_768 })
    const largerTool = buildTraceAnalysisToolDescriptors({ store: largerStore, budgets: { perAttributeSpanBudget: 32_768 } }).find((tool) => tool.name === 'readSpanSource')!
    const larger = await largerTool.handler({ ...input, offset: 0, limit: 17_000 }) as ReadSpanSourceResult
    expect(larger).toMatchObject({ status: 'available', next_offset: 17_000 })
    if (larger.status === 'available') expect(Buffer.byteLength(larger.text)).toBe(17_000)
  })

  it('recovers tool input and output tails using their own field locators', async () => {
    const reader = await createBundleSourceReader(bundle, spans)
    const tool = spans.find((span) => span.attributes['tool.name'] === 'Read')!
    for (const [attribute, tail, encoding] of [['input.value', 'sibling-tool-input-tail', 'json'], ['output.value', 'source-only-output-tail', 'utf8-string']]) {
      const result = await reader!({ ...input, span_id: tool.span_id, attribute: attribute!, offset: 18_000, limit: 100 })
      expect(result.status).toBe('available')
      if (result.status === 'available') {
        expect(result.text).toContain(tail)
        expect(result.source.value_encoding).toBe(encoding)
      }
    }
  })

  it('wires explicit authorization into the actual analysis registry', async () => {
    const observed: ReadSpanSourceResult[] = []
    const registry = new AnalystRegistry()
    const analyst: Analyst<TraceAnalysisStore> = { id: 'source-reader-proof', description: 'Read a retained field', inputKind: 'trace-store', cost: { kind: 'deterministic' }, version: '1', async analyze(store) {
      const tool = buildTraceAnalysisToolDescriptors({ store }).find((tool) => tool.name === 'readSpanSource')!
      observed.push(await tool.handler(input) as ReadSpanSourceResult)
      return []
    } }
    registry.register(analyst)
    await analyzeSpans(spans, { registry, sourceBundle: { path: bundle }, otlpOutPath: join(root, 'analysis.jsonl') })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ status: 'available', text: '🙂 source-only-answer-tail' })
    const store = new OtlpFileTraceStore({ path: join(bundle, 'derived/trace.otlp.jsonl') })
    expect(store.readSpanSource).toBeUndefined()
    expect(buildTraceAnalysisToolDescriptors({ store }).some((tool) => tool.name === 'readSpanSource')).toBe(false)
  })

  it('retains streamed message records without turning replayed UUIDs into conflicts', async () => {
    const path = join(root, 'streamed.jsonl')
    const first = { type: 'assistant', uuid: 'first', sessionId: 'streamed', timestamp: '2026-01-01T00:00:00Z', message: { id: 'shared-message', role: 'assistant', content: [{ type: 'text', text: 'first fragment' }] } }
    const second = { ...first, uuid: 'second', message: { ...first.message, content: [{ type: 'text', text: 'second fragment' }] } }
    await writeFile(path, [first, first, second].map((event) => JSON.stringify(event)).join('\n'))
    const destination = join(root, 'streamed-bundle')
    await assembleSessionBundle({ adapter: new ClaudeAdapter(), ref: { harness: 'claude-code', sessionId: 'streamed', path, cwd: null, mtimeMs: 0 }, outDir: destination })
    const selected = (await readOtlpInput(join(destination, 'derived/trace.otlp.jsonl'))).spans
    const message = selected.find((span) => span.attributes.content === 'first fragment\nsecond fragment')!
    expect(message).toBeDefined()
    await rm(path)
    const reader = await createBundleSourceReader(destination, selected)
    for (const [source_index, text] of ['first fragment', 'second fragment'].entries()) {
      expect(await reader!({ trace_id: message.trace_id, span_id: message.span_id, attribute: 'content', offset: 0, limit: 100, source_index })).toMatchObject({ status: 'available', text, source_index })
    }
    expect(await reader!({ trace_id: message.trace_id, span_id: message.span_id, attribute: 'content', offset: 0, limit: 100, source_index: 2 })).toMatchObject({ status: 'unavailable' })
  })

  it('accepts the CLI bundle input and rejects mixed input or archive output paths', async () => {
    const run = promisify(execFile)
    const cli = ['--import', 'tsx', 'src/cli.ts', 'analyze', '--source-bundle', bundle]
    const report = join(root, 'cli-report.md')
    await run(process.execPath, [...cli, '--out', report], { timeout: 30_000 })
    expect((await readFile(report, 'utf8')).length).toBeGreaterThan(0)
    await expect(run(process.execPath, [...cli, '--otlp', join(bundle, 'derived/trace.otlp.jsonl')], { timeout: 30_000 })).rejects.toThrow('cannot be combined')
    const manifestPath = join(bundle, 'manifest.json')
    const before = await readFile(manifestPath)
    await expect(run(process.execPath, [...cli, '--out', manifestPath], { timeout: 30_000 })).rejects.toThrow('outside')
    expect(await readFile(manifestPath)).toEqual(before)
  })

  it('rejects redacted, changed, and cross-trace attributes', async () => {
    expect(await createBundleSourceReader(bundle, redactSpans(spans, []).spans)).toBeUndefined()
    const selected = structuredClone(spans.find((span) => span.span_id === input.span_id)!)
    selected.attributes.content = 'changed'
    expect(await createBundleSourceReader(bundle, [selected])).toBeUndefined()
    const reader = await createBundleSourceReader(bundle, spans)
    expect(await reader!({ ...input, trace_id: 'another-trace' })).toMatchObject({ status: 'unavailable' })
    expect(await reader!({ ...input, attribute: 'unrecorded' })).toMatchObject({ status: 'unavailable' })
  })

  it('enforces field byte ranges, UTF-8 boundaries, cancellation, and configured parsing limits', async () => {
    const reader = await createBundleSourceReader(bundle, spans)
    expect(await reader!({ ...input, limit: 4 })).toMatchObject({ status: 'available', text: '🙂', next_offset: 18_004 })
    for (const update of [{ offset: 18_001 }, { limit: 3 }, { offset: -1 }, { offset: 0.5 }, { offset: Buffer.byteLength(answer) + 1 }]) {
      expect(await reader!({ ...input, ...update })).toMatchObject({ status: 'unavailable' })
    }
    expect(await reader!({ ...input, offset: Buffer.byteLength(answer) })).toMatchObject({ status: 'available', text: '', next_offset: null })
    const limited = await createBundleSourceReader(bundle, spans, { maxRecordBytes: 100 })
    expect(await limited!(input)).toMatchObject({ status: 'unavailable', reason: 'source record exceeds the configured parsing limit' })
    expect(await reader!({ ...input, limit: 16_385 })).toMatchObject({ status: 'available' })
    const controller = new AbortController()
    controller.abort()
    await expect(reader!(input, { signal: controller.signal })).rejects.toThrow()
    const parent = new AbortController()
    const cancellable = await createBundleSourceReader(bundle, spans, { signal: parent.signal })
    parent.abort()
    await expect(cancellable!(input, { signal: new AbortController().signal })).rejects.toThrow()
  })

  it.each(['missing', 'same-size-tamper', 'symlink'])('rejects %s retained source', async (mode) => {
    const directory = await copiedBundle()
    const reader = await createBundleSourceReader(directory, spans)
    const path = await sourcePath(directory)
    const bytes = await readFile(path)
    await rm(path)
    if (mode === 'same-size-tamper') { bytes[0] = 32; await writeFile(path, bytes) }
    if (mode === 'symlink') await symlink(await sourcePath(bundle), path)
    expect(await reader!(input)).toMatchObject({ status: 'unavailable' })
  })

  it('rejects evidence-only manifests and unsafe receipt paths', async () => {
    for (const mode of ['evidence-only', 'path']) {
      const directory = await copiedBundle()
      const path = join(directory, 'manifest.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      if (mode === 'evidence-only') manifest.view = 'evidence-only'
      else manifest.files[0].path = '../outside'
      await writeFile(path, JSON.stringify(manifest))
      await expect(createBundleSourceReader(directory, spans)).rejects.toThrow()
    }
  })

  it('detects record hash mismatch independently of the source receipt', async () => {
    const directory = await copiedBundle()
    const tracePath = join(directory, 'derived/trace.otlp.jsonl')
    const raw = await readFile(tracePath, 'utf8')
    const key = `${SOURCE_ATTRIBUTE_PREFIX}content`
    const ref = JSON.parse(String(spans.find((span) => span.span_id === input.span_id)!.attributes[key]))[0]
    const altered = raw.replaceAll(ref.recordSha256, '0'.repeat(64))
    await writeFile(tracePath, altered)
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const receipt = manifest.files.find((file: { path: string }) => file.path === 'derived/trace.otlp.jsonl')
    receipt.bytes = Buffer.byteLength(altered)
    receipt.sha256 = createHash('sha256').update(altered).digest('hex')
    await writeFile(manifestPath, JSON.stringify(manifest))
    const selected = (await readOtlpInput(tracePath)).spans
    const reader = await createBundleSourceReader(directory, selected)
    expect(await reader!(input)).toMatchObject({ status: 'unavailable', reason: 'retained record digest mismatch or source changed during read' })
  })

  it('protects retained artifacts from analysis output writes', async () => {
    const path = join(bundle, 'derived/trace.otlp.jsonl')
    const before = await readFile(path)
    await expect(analyzeSpans(spans, { sourceBundle: { path: bundle }, otlpOutPath: path })).rejects.toThrow('outside')
    expect(await readFile(path)).toEqual(before)
    await expect(
      runTraceImprovement({
        spans,
        sourceBundle: { path: bundle },
        outDir: bundle,
        otlpOutPath: join(root, 'outside.jsonl'),
        harness: 'test',
      }),
    ).rejects.toThrow('outside')
  })
})
