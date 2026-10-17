/**
 * `traces upload` on an OTLP ref. A dry run redacts, prints the share verdict
 * of the payload it would send, exits 0, sends nothing, and writes the
 * redacted preview only under `--out`. A sent upload delivers every span of
 * the ref with its trace id, span id and start time intact, which is what
 * Tangle Intelligence serves back (`tangle traces get <id> --ndjson`). The
 * ingest endpoint is the one faked boundary: an HTTP peer that keeps what it
 * was sent.
 */
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveHexId, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const TRACE = deriveHexId('upload-test-trace', 16)
const EMAIL = 'synthetic.person@example.com'

interface SentSpan {
  traceId: string
  spanId: string
  startTimeUnixNano: string
  attributes: Record<string, unknown>
}

let root: string
let env: Record<string, string>
let spans: string
let ingest: Server
let ingestUrl: string
const received: Array<{ headers: Record<string, unknown>; spans: SentSpan[] }> = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'traces-upload-'))
  env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  spans = join(root, 'run.otlp.jsonl')
  const rows = [
    llmSpan({
      traceId: TRACE, spanId: deriveHexId('upload-llm', 8), parentSpanId: null, name: 'turn', model: 'glm-5.2',
      inputTokens: 1200, outputTokens: 40, startTime: '2026-10-14T10:00:00.000Z', endTime: '2026-10-14T10:00:02.000Z',
    }),
    toolSpan({
      traceId: TRACE, spanId: deriveHexId('upload-tool-1', 8), parentSpanId: null, name: 'bash', toolName: 'bash',
      startTime: '2026-10-14T10:00:03.000Z', endTime: '2026-10-14T10:00:04.000Z', status: { code: 'STATUS_CODE_OK' },
    }),
    toolSpan({
      traceId: TRACE, spanId: deriveHexId('upload-tool-2', 8), parentSpanId: null, name: 'bash', toolName: 'bash',
      startTime: '2026-10-14T10:00:05.000Z', endTime: '2026-10-14T10:00:06.000Z', status: { code: 'STATUS_CODE_ERROR', message: `mail ${EMAIL} bounced` },
    }),
  ]
  await writeFile(spans, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  // Tangle Intelligence's ingest endpoint: keeps what it is sent and accepts every span.
  ingest = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const sent = (JSON.parse(body) as { spans: SentSpan[] }).spans
      received.push({ headers: request.headers, spans: sent })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accepted: sent.length, rejected: [] }))
    })
  })
  ingest.listen(0, '127.0.0.1')
  await once(ingest, 'listening')
  ingestUrl = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`
})

afterAll(() => {
  ingest?.close()
})

const nanosOf = (iso: string): string => String(BigInt(Date.parse(iso)) * 1_000_000n)

describe('upload <otlp ref>', () => {
  it('--dry-run prints the share verdict of the redacted payload, sends nothing, and writes the preview only under --out', async () => {
    const cwd = await mkdtemp(join(root, 'cwd-'))
    const bare = await runCli(['upload', spans, '--dry-run'], { env, cwd })
    expect(bare.code, bare.stderr).toBe(0)
    expect(bare.stdout).toMatch(/^share verdict: SAFE(?:_WITH_WARNINGS)? \(the redacted payload; UNSAFE and UNKNOWN are refused\)$/mu)
    expect(bare.stdout).toContain('dry run: 1 session(s), 1 redaction(s). Pass --out FILE to keep the redacted OTLP.')
    expect(bare.stderr).toContain('PII/secrets redacted: 1')
    expect(await readdir(cwd)).toEqual([])
    expect(received).toEqual([])

    const preview = join(root, 'preview.otlp.jsonl')
    const run = await runCli(['upload', spans, '--dry-run', '--out', preview], { env })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toContain(`Redacted OTLP -> ${preview}`)
    const written = (await readFile(preview, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { span_id: string })
    expect(written.map((span) => span.span_id).sort()).toEqual([
      deriveHexId('upload-llm', 8), deriveHexId('upload-tool-1', 8), deriveHexId('upload-tool-2', 8),
    ].sort())
    expect(await readFile(preview, 'utf8')).not.toContain(EMAIL)
    expect(received).toEqual([])
  })

  it('sends every span with its trace id, span id and start time, under the configured key', async () => {
    const sent = await runCli(['upload', spans, '--yes'], {
      env: { ...env, TANGLE_INGEST_URL: ingestUrl, TANGLE_INGEST_API_KEY: 'test-ingest-key', TANGLE_TENANT_ID: 'tenant-upload' },
    })
    expect(sent.code, sent.stderr).toBe(0)
    expect(sent.stdout).toContain('Uploaded 1 session(s), 3 spans accepted')
    expect(received).toHaveLength(1)
    const [request] = received
    expect(request!.headers.authorization).toBe('Bearer test-ingest-key')
    expect(request!.headers['x-tangle-tenant-id']).toBe('tenant-upload')
    expect(request!.spans.map((span) => [span.traceId, span.spanId, span.startTimeUnixNano]).sort()).toEqual([
      [TRACE, deriveHexId('upload-llm', 8), nanosOf('2026-10-14T10:00:00.000Z')],
      [TRACE, deriveHexId('upload-tool-1', 8), nanosOf('2026-10-14T10:00:03.000Z')],
      [TRACE, deriveHexId('upload-tool-2', 8), nanosOf('2026-10-14T10:00:05.000Z')],
    ].sort())
    expect(JSON.stringify(request!.spans)).not.toContain(EMAIL)

    // The same ref again is already uploaded: nothing is sent twice.
    const again = await runCli(['upload', spans, '--yes'], {
      env: { ...env, TANGLE_INGEST_URL: ingestUrl, TANGLE_INGEST_API_KEY: 'test-ingest-key', TANGLE_TENANT_ID: 'tenant-upload' },
    })
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain('Uploaded 0 session(s)')
    expect(received).toHaveLength(1)
  })
})
