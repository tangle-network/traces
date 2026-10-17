/**
 * Standard OTLP/JSON in (U10): `resourceSpans → scopeSpans → spans` with
 * camelCase hex ids, nanosecond times and key/value attribute lists is read
 * wherever a ref is, as one document or as the collector file exporter's one
 * envelope per line, streamed so memory follows the spans and not the bytes
 * of content they carry. The span rows Tangle Intelligence serves
 * (`tangle traces get <id> --ndjson`) are read the same way.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contractSpan, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SPEC = join(fixtures, 'otlp-json', 'spec-trace.json')
/**
 * Captured with `tangle traces get <id> --ndjson` from production Intelligence on
 * 2026-10-17, after `traces upload` sent the spec fixture's agent run under the
 * trace id {@link SERVED_RUN} (traces 1.0 step 16). The tenant id and host are
 * replaced with placeholders; every other field is as served.
 */
const SERVED = join(fixtures, 'otlp-json', 'intelligence-spans.ndjson')
const SERVED_RUN = 'bde470ac10ae31e5d81a4304a7941192'
const MAX_RSS = pathToFileURL(join(fixtures, 'max-rss.mjs')).href
/** The agent run in both fixtures. */
const RUN = '4bf92f3577b34da6a3ce929d0e0e4736'

interface Attribute {
  key: string
  value: { stringValue?: string; intValue?: string }
}
interface Span {
  traceId: string
  spanId: string
  parentSpanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  status?: { code: number; message?: string }
}
interface Envelope {
  resourceSpans: Array<{ resource: { attributes: Attribute[] }; scopeSpans: Array<{ scope: unknown; spans: Span[] }> }>
}
interface FactsSheet {
  traceId: string
  toolCalls: { value: number }
  toolCallsByName: { value: Record<string, number> }
}

let dir: string
let env: Record<string, string>
let spec: Envelope
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-otlp-json-'))
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
  spec = JSON.parse(await readFile(SPEC, 'utf8')) as Envelope
})

const attribute = (span: Span, key: string): string | undefined => {
  const value = span.attributes.find((entry) => entry.key === key)?.value
  return value?.stringValue ?? value?.intValue
}
const spansOf = (envelope: Envelope): Span[] => envelope.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
const iso = (nanos: string): string => new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString()

async function facts(path: string, extraEnv: Record<string, string> = {}): Promise<FactsSheet[]> {
  const run = await runCli(['facts', path, '--format', 'json'], { env: { ...env, ...extraEnv }, timeoutMs: 120_000 })
  expect(run.code, run.stderr).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: FactsSheet[] }).sessions
}

/** The agent run of the spec fixture as the contract's own OTLP-JSONL, built with its span builders. */
function contractTwin(): string {
  const run = spansOf(spec).filter((span) => span.traceId.toLowerCase() === RUN)
  return `${run.map((span) => {
    const base = {
      traceId: RUN,
      spanId: span.spanId.toLowerCase(),
      parentSpanId: span.parentSpanId ? span.parentSpanId.toLowerCase() : null,
      name: span.name,
      startTime: iso(span.startTimeUnixNano),
      endTime: iso(span.endTimeUnixNano),
    }
    const operation = attribute(span, 'gen_ai.operation.name')
    if (operation === 'execute_tool') {
      return toolSpan({ ...base, toolName: attribute(span, 'gen_ai.tool.name')!, attributes: { 'input.value': attribute(span, 'gen_ai.tool.call.arguments') } })
    }
    if (operation === 'chat') {
      return llmSpan({
        ...base,
        model: attribute(span, 'gen_ai.request.model')!,
        inputTokens: Number(attribute(span, 'gen_ai.usage.input_tokens')),
        outputTokens: Number(attribute(span, 'gen_ai.usage.output_tokens')),
      })
    }
    return contractSpan({ ...base, kind: 'AGENT' })
  }).map((row) => JSON.stringify(row)).join('\n')}\n`
}

/** Tool calls by name, counted from the raw OTLP/JSON: the oracle. */
function toolCallsIn(envelope: Envelope): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const span of spansOf(envelope)) {
    if (attribute(span, 'gen_ai.operation.name') !== 'execute_tool') continue
    const name = attribute(span, 'gen_ai.tool.name')!
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

describe('standard OTLP/JSON as a ref', () => {
  it('conforms: the OTLP/JSON spec sample, one pretty-printed document, passes conformance with capabilities', async () => {
    const run = await runCli(['check', SPEC, '--contract', 'conformance', '--format', 'json'], { env })
    expect(run.code, run.stderr).toBe(0)
    const gate = (JSON.parse(run.stdout) as { gates: Array<{ validation: { ok: boolean; capabilities: Array<{ name: string; available: boolean }> } }> }).gates[0]!
    expect(gate.validation.ok).toBe(true)
    const available = gate.validation.capabilities.filter((capability) => capability.available).map((capability) => capability.name)
    expect(available.length).toBeGreaterThanOrEqual(1)
    expect(available).toContain('tool-usage')
  })

  it('counts the same tool calls as its contract-JSONL twin, and as the raw spans say', async () => {
    const twin = join(dir, 'twin.otlp.jsonl')
    await writeFile(twin, contractTwin(), 'utf8')
    const fromOtlp = (await facts(SPEC)).find((sheet) => sheet.traceId === RUN)!
    const fromTwin = (await facts(twin)).find((sheet) => sheet.traceId === RUN)!
    expect(fromOtlp.toolCallsByName.value).toEqual(toolCallsIn(spec))
    expect(fromOtlp.toolCalls.value).toBe(fromTwin.toolCalls.value)
    expect(fromOtlp.toolCallsByName.value).toEqual(fromTwin.toolCallsByName.value)
  })

  it("reads the collector file exporter's one envelope per line", async () => {
    const lines = join(dir, 'collector.jsonl')
    // One envelope per span, each with its resource and scope, as the exporter batches them.
    const envelopes = spec.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => ({
      resourceSpans: [{ resource: resource.resource, scopeSpans: [{ scope: scope.scope, spans: [span] }] }],
    }))))
    await writeFile(lines, `${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`, 'utf8')
    const sheet = (await facts(lines)).find((entry) => entry.traceId === RUN)!
    expect(sheet.toolCallsByName.value).toEqual(toolCallsIn(spec))
  })

  it('reads past a line it cannot parse, and keeps a long value as a prefix of whole characters', async () => {
    const run = spansOf(spec).filter((span) => span.traceId.toLowerCase() === RUN)
    // Over the 16 KiB cap, with escapes and multibyte characters to cut between.
    const long = `naïve ✓ "quoted"\n\\path ${'é'.repeat(20_000)}`
    const withLong = run.map((span) => (attribute(span, 'gen_ai.tool.call.result') === 'PASS tests/a.test.ts'
      ? { ...span, attributes: [...span.attributes.filter((entry) => entry.key !== 'gen_ai.tool.call.result'), { key: 'gen_ai.tool.call.result', value: { stringValue: long } }] }
      : span))
    const envelope = (spans: Span[]): string => JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'gen' }, spans }] }] })
    const path = join(dir, 'collector-mixed.jsonl')
    await writeFile(path, `${envelope(withLong.slice(0, 2))}\n{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"cut off\n${envelope(withLong.slice(2))}\n`, 'utf8')

    expect((await facts(path)).find((sheet) => sheet.traceId === RUN)!.toolCallsByName.value).toEqual(toolCallsIn(spec))
    const conformance = await runCli(['check', path, '--contract', 'conformance'], { env })
    expect(conformance.code).toBe(0)
    expect(conformance.stdout).toContain('unparseable-line')

    const out = join(dir, 'collector-mixed.otlp.jsonl')
    expect((await runCli(['convert', path, '--out', out], { env })).code).toBe(0)
    const output = (await readFile(out, 'utf8')).trim().split('\n')
      .map((line) => (JSON.parse(line) as { attributes: Record<string, unknown> }).attributes['output.value'])
      .find((value): value is string => typeof value === 'string' && value.startsWith('naïve'))!
    expect(output.startsWith(`naïve ✓ "quoted"\n\\path é`)).toBe(true)
    expect(output).toMatch(/é\n\[truncated \d+ bytes\]$/u)
    expect(output).not.toContain('�')
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024)
  })

  it('reads the span rows Tangle Intelligence serves (tangle traces get <id> --ndjson): the run uploaded, span for span', async () => {
    const sheets = await facts(SERVED)
    expect(sheets.map((sheet) => sheet.traceId)).toEqual([SERVED_RUN])
    expect(sheets[0]!.toolCallsByName.value).toEqual(toolCallsIn(spec))

    const out = join(dir, 'served.otlp.jsonl')
    expect((await runCli(['convert', SERVED, '--out', out], { env })).code).toBe(0)
    const served = (await readFile(out, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { span_id: string; start_time: string; status?: { code?: string } })
    const uploaded = spansOf(spec).filter((span) => span.traceId.toLowerCase() === RUN)
    const key = (spanId: string, start: string) => `${spanId.toLowerCase()}@${start}`
    expect(served.map((span) => key(span.span_id, span.start_time)).sort())
      .toEqual(uploaded.map((span) => key(span.spanId, iso(span.startTimeUnixNano))).sort())
    expect(served.filter((span) => span.status?.code?.endsWith('ERROR')).length).toBe(uploaded.filter((span) => span.status?.code === 2).length)
  })
})

const ROOT_SPAN = 'ffffffffffffffff'

/**
 * An envelope-per-line file of one agent run: a root `invoke_agent` span, then
 * `spans` model and tool calls under it, each carrying `payload` bytes of
 * content (a model call's messages, or a tool's output), `perLine` spans to an
 * envelope. The span count stays fixed while the bytes grow.
 */
async function writeCollectorFile(path: string, spans: number, payload: number, perLine: number): Promise<void> {
  const content = 'x'.repeat(payload)
  const out = createWriteStream(path)
  const root: Span = {
    traceId: RUN,
    spanId: ROOT_SPAN,
    parentSpanId: '',
    name: 'invoke_agent coder',
    startTimeUnixNano: '1792214780000000000',
    endTimeUnixNano: String(1792214780000000000n + BigInt(spans + 1) * 1_000_000_000n),
    attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }],
  }
  out.write(`${JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'gen' }, spans: [root] }] }] })}\n`)
  for (let first = 0; first < spans; first += perLine) {
    const batch: Span[] = []
    for (let n = first; n < Math.min(spans, first + perLine); n++) {
      const tool = n % 2 === 1
      batch.push({
        traceId: RUN,
        spanId: n.toString(16).padStart(16, '0'),
        parentSpanId: ROOT_SPAN,
        name: tool ? 'execute_tool bash' : 'chat glm-5.2',
        startTimeUnixNano: String(1792214780000000000n + BigInt(n) * 1_000_000_000n),
        endTimeUnixNano: String(1792214780500000000n + BigInt(n) * 1_000_000_000n),
        attributes: tool
          ? [
            { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
            { key: 'gen_ai.tool.name', value: { stringValue: 'bash' } },
            { key: 'gen_ai.tool.call.arguments', value: { stringValue: `{"command":"echo ${n}"}` } },
            { key: 'gen_ai.tool.call.result', value: { stringValue: content } },
          ]
          : [
            { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
            { key: 'gen_ai.request.model', value: { stringValue: 'glm-5.2' } },
            { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
            { key: 'gen_ai.input.messages', value: { stringValue: content } },
          ],
      })
    }
    const line = `${JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'gen' }, spans: batch }] }] })}\n`
    if (!out.write(line)) await once(out, 'drain')
  }
  out.end()
  await once(out, 'finish')
}

describe('bounded memory', () => {
  it('keeps the peak RSS of facts within 20% while an envelope-per-line file grows from 20 MB to 200 MB', async () => {
    const spans = 600
    const perLine = 10
    const peaks: number[] = []
    const sheets: FactsSheet[] = []
    for (const megabytes of [20, 200]) {
      const path = join(dir, `collector-${megabytes}mb.jsonl`)
      await writeCollectorFile(path, spans, Math.floor((megabytes * 1024 * 1024) / spans), perLine)
      const rss = join(dir, `rss-${megabytes}mb.txt`)
      sheets.push((await facts(path, { NODE_OPTIONS: `--import=${MAX_RSS}`, MAX_RSS_OUT: rss })).find((sheet) => sheet.traceId === RUN)!)
      peaks.push(Number(await readFile(rss, 'utf8')))
    }
    // Same spans, same answer: only the bytes of content grew.
    expect(sheets[1]!.toolCalls.value).toBe(spans / 2)
    expect(sheets[1]!.toolCallsByName.value).toEqual(sheets[0]!.toolCallsByName.value)
    const [small, large] = peaks as [number, number]
    console.log(`facts peak RSS: ${small} KB on 20 MB, ${large} KB on 200 MB (${(large / small).toFixed(3)}x)`)
    expect(large / small, `peak RSS ${small} KB at 20 MB, ${large} KB at 200 MB`).toBeLessThan(1.2)
  }, 300_000)
})
