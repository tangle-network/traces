/**
 * The diagnosis kit runs on public commands. The customer's scrub is
 * `traces convert raw --no-content --out f` and `traces check f --share-safe`;
 * the operator's `prepare-bundle.ts` and `run-checks.ts` spawn the same CLI.
 * A canary planted in every content field of a customer trace never survives
 * the scrub, and the measures that need no content still come through.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../tests/run-cli.js'

const CANARY = 'CUSTOMER_PROSE_CANARY_20260923'
const CHECKS = dirname(fileURLToPath(import.meta.url))
const ROOT = join(CHECKS, '..', '..')

/** Every content attribute the kit's metadata-only rule must drop from this trace. */
const CONTENT_KEYS = [
  'input.value', 'output.value', 'input', 'result', 'text', 'thinking', 'prompt', 'request', 'response', 'command', 'args',
  'tool_arguments', 'full_command', 'chat.content', 'error.message', 'error_message', 'ERROR_MESSAGE', 'error.inner.message',
  'events', 'exception.message', 'status.message', 'tool.args_captured', 'traces.input.sha256', 'traces.output.sha256',
  'traces.source_record.input.value',
]

/** A customer's raw export: a failed session of four failed reads of different files, content everywhere. */
function rawTrace(): string {
  const root = {
    trace_id: 'case-1', span_id: 'root', parent_span_id: null, name: 'session',
    start_time: '2026-09-23T12:00:00Z', end_time: '2026-09-23T12:00:05Z',
    status: { code: 'ERROR', message: `${CANARY}: failed session` }, attributes: { 'openinference.span.kind': 'AGENT' },
  }
  const tools = Array.from({ length: 4 }, (_, i) => ({
    trace_id: 'case-1', span_id: `read-${i}`, parent_span_id: 'root', name: 'read',
    start_time: new Date(Date.parse(root.start_time) + i * 700).toISOString(),
    end_time: new Date(Date.parse(root.start_time) + i * 700 + 300).toISOString(),
    status: { code: 'ERROR', message: `${CANARY}: failed read` },
    attributes: {
      'openinference.span.kind': 'TOOL',
      'tool.name': 'read',
      'input.value': `${CANARY}:file-${i}.md`,
      ...(i === 0
        ? {
            input: CANARY, 'output.value': CANARY, result: CANARY, text: CANARY, thinking: CANARY, prompt: CANARY, request: CANARY,
            response: CANARY, command: CANARY, args: CANARY, tool_arguments: CANARY, full_command: CANARY, 'chat.content': CANARY,
            'error.message': CANARY, error_message: CANARY, ERROR_MESSAGE: CANARY, 'error.inner.message': CANARY,
            events: [{ message: CANARY }], 'exception.message': CANARY, 'traces.source_record.input.value': CANARY,
          }
        : {}),
    },
  }))
  return `${[root, ...tools].map((row) => JSON.stringify(row)).join('\n')}\n`
}

/** `tsx diagnosis-kit/checks/<script> …argv`, as the operator runs it. */
function kit(script: string, argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', join(CHECKS, script), ...argv], { cwd: ROOT, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error)
      else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

async function engagement(root: string, name: string, incoming: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'incoming'), { recursive: true })
  await mkdir(join(dir, 'bundle'))
  await writeFile(join(dir, 'engagement.json'), JSON.stringify({ id: name, contentIncluded: false }))
  await writeFile(join(dir, 'incoming', 'spans.otlp.jsonl'), incoming)
  return dir
}

let dir: string
let raw: string
let scrubbed: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diagnosis-kit-'))
  raw = join(dir, 'raw.otlp.jsonl')
  scrubbed = join(dir, 'metadata-only.otlp.jsonl')
  await writeFile(raw, rawTrace())
})

describe('diagnosis kit on public commands', () => {
  it("the customer's scrub drops every content attribute, and analyze still measures what needs none", async () => {
    const convert = await runCli(['convert', raw, '--no-content', '--out', scrubbed, '--format', 'json'])
    expect(convert.code, convert.stderr).toBe(0)
    const summary = JSON.parse(convert.stdout) as { out: string; spans: number; droppedAttributes: string[] }
    expect(summary).toMatchObject({ out: scrubbed, spans: 5 })
    expect(summary.droppedAttributes).toEqual(expect.arrayContaining(CONTENT_KEYS))
    expect(await readFile(scrubbed, 'utf8')).not.toContain(CANARY)
    expect((await runCli(['check', scrubbed, '--share-safe'])).code).toBe(0)

    const metadata = await runCli(['analyze', scrubbed, '--format', 'json'])
    expect(metadata.code, metadata.stderr).toBe(0)
    expect(`${metadata.stdout}${metadata.stderr}`).not.toContain(CANARY)
    const analysis = JSON.parse(metadata.stdout) as {
      measures: { stuckLoops: { findings: unknown[] }; failureClusters: { clusters: unknown[] } }
      cannotAnswer: Array<{ analysis: string; reason: string }>
    }
    expect(analysis.measures.stuckLoops.findings).toEqual([])
    expect(analysis.measures.failureClusters.clusters).toHaveLength(1)
    expect(analysis.cannotAnswer.some((entry) => entry.analysis.startsWith('argument comparisons'))).toBe(true)

    // The same trace with its content: distinct inputs make no loop, and the error text is the canary.
    const content = JSON.parse((await runCli(['analyze', raw, '--format', 'json'])).stdout) as {
      measures: { stuckLoops: { findings: unknown[] }; failureClusters: { clusters: Array<{ exampleError?: string }> } }
    }
    expect(content.measures.stuckLoops.findings).toEqual([])
    expect(content.measures.failureClusters.clusters[0]?.exampleError).toContain(CANARY)
  })

  it('prepare-bundle refuses a raw export and keeps nothing; on the scrubbed export it and run-checks report the measures', async () => {
    const refused = await engagement(dir, 'raw-engagement', rawTrace())
    const refusal = await kit('prepare-bundle.ts', [refused])
    expect(refusal.code).toBe(1)
    expect(refusal.stderr).toContain('request a customer-side metadata-only export')
    expect(refusal.stderr).not.toContain(CANARY)
    await expect(stat(join(refused, 'bundle', 'spans.flat.jsonl'))).rejects.toThrow()

    const accepted = await engagement(dir, 'metadata-engagement', await readFile(scrubbed, 'utf8'))
    const prepared = await kit('prepare-bundle.ts', [accepted])
    expect(prepared.code, prepared.stderr).toBe(0)
    const bundle = join(accepted, 'bundle', 'spans.flat.jsonl')
    expect(JSON.parse(prepared.stdout)).toMatchObject({ output: bundle, spans: 5, droppedAttributes: ['tool.args_captured'] })
    expect((await stat(bundle)).mode & 0o777).toBe(0o600)

    const checks = await kit('run-checks.ts', [bundle, '--label', 'synthetic agent'])
    expect(checks.code, checks.stderr).toBe(0)
    expect(checks.stdout).not.toContain(CANARY)
    const report = JSON.parse(checks.stdout) as {
      schemaVersion: number
      subject: { label: string; runCount: number; window: string; contentIncluded: boolean }
      coverage: { capabilities: Record<string, { available: boolean; reason?: string }>; skipped: Array<{ analysis: string; reason: string }> }
      findings: Array<{ id: string; measure: { name: string; value: number }; evidence: string[]; confidence: string }>
    }
    expect(report.schemaVersion).toBe(1)
    expect(report.subject).toEqual({ label: 'synthetic agent', runCount: 1, window: '2026-09-23T12:00:00.000Z/2026-09-23T12:00:05.000Z', contentIncluded: false })
    expect(Object.keys(report.coverage.capabilities)).toContain('tool-usage')
    for (const capability of Object.values(report.coverage.capabilities)) if (!capability.available) expect(capability.reason).toBeTruthy()
    expect(report.coverage.skipped.some((entry) => entry.analysis.startsWith('argument comparisons'))).toBe(true)
    const failing = report.findings.find((finding) => finding.measure.name === 'failed tool calls')
    expect(failing?.measure.value).toBe(4)
    expect(failing?.evidence.length).toBeGreaterThan(0)
    expect(failing?.confidence).toBe('observed')
  })
})
