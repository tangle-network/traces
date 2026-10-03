import { spawnSync } from 'node:child_process'
import { open, rm, readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { JsonlParseError, readJsonl } from '../src/jsonl.js'
import { serializeSpans, span, writeOtlpFile } from '../src/otlp.js'

/**
 * Regression suite for sessions larger than V8's string limit: analysis must
 * complete by streaming rows and bounding what it retains, never by
 * materializing the session (or its export) as one string.
 */

/** One byte over the maximum string V8 can allocate (0x1fffffe8 characters). */
const V8_MAX_STRING_BYTES = 0x1fffffe8 + 1
const WRITE_CHUNK_BYTES = 8 * 1024 * 1024
const GIANT_ROW_HEAD =
  '{"type":"user","uuid":"giant-row","sessionId":"giant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"'
const GIANT_ROW_TAIL = '"}}\n'

const dir = await mkdtemp(join(tmpdir(), 'tt-large-session-'))
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A Claude session whose middle row cannot become a string in this runtime. */
async function writeGiantRowSession(path: string): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.write(
      `${JSON.stringify({
        type: 'user',
        uuid: 'turn-one',
        sessionId: 'giant',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'start the run' },
      })}\n`,
    )
    await handle.write(GIANT_ROW_HEAD)
    const chunk = Buffer.alloc(WRITE_CHUNK_BYTES, 0x61)
    for (let written = 0; written < V8_MAX_STRING_BYTES; written += WRITE_CHUNK_BYTES) {
      const take = Math.min(WRITE_CHUNK_BYTES, V8_MAX_STRING_BYTES - written)
      await handle.write(take === WRITE_CHUNK_BYTES ? chunk : chunk.subarray(0, take))
    }
    await handle.write(GIANT_ROW_TAIL)
    await handle.write(
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'answer-one',
        parentUuid: 'turn-one',
        sessionId: 'giant',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          id: 'message-one',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      })}\n`,
    )
  } finally {
    await handle.close()
  }
}

describe('sessions larger than the V8 string limit', () => {
  it('reports a row beyond the string limit as unreadable instead of throwing', async () => {
    const path = join(dir, 'giant-row-session.jsonl')
    await writeGiantRowSession(path)

    const rows: Array<{ type?: string; uuid?: string }> = []
    const receipts: Array<{ lineNumber: number; byteLength: number }> = []
    for await (const row of readJsonl<{ type?: string; uuid?: string }>(path, {
      mode: 'recover',
      onCorruption: (receipt) => receipts.push({ lineNumber: receipt.lineNumber, byteLength: receipt.byteLength }),
    })) rows.push(row)
    expect(rows.map((row) => row.uuid)).toEqual(['turn-one', 'answer-one'])
    expect(receipts).toEqual([
      {
        lineNumber: 2,
        byteLength: V8_MAX_STRING_BYTES + Buffer.byteLength(GIANT_ROW_HEAD) + Buffer.byteLength(GIANT_ROW_TAIL) - 1,
      },
    ])

    await expect(async () => {
      for await (const _row of readJsonl(path)) void _row
    }).rejects.toBeInstanceOf(JsonlParseError)
  }, 240_000)

  it('analyzes the session in a heap too small to hold it as one string', async () => {
    const path = join(dir, 'giant-row-session.jsonl')
    await writeGiantRowSession(path)

    const adapterUrl = pathToFileURL(join(process.cwd(), 'src/adapters/claude.ts')).href
    const analyzeUrl = pathToFileURL(join(process.cwd(), 'src/analyze.ts')).href
    const childSource = `
      import { ClaudeAdapter } from ${JSON.stringify(adapterUrl)}
      import { analyzeSpans } from ${JSON.stringify(analyzeUrl)}
      const ref = {
        harness: 'claude-code',
        sessionId: 'giant',
        path: ${JSON.stringify(path)},
        cwd: null,
        mtimeMs: 0,
      }
      const spans = await new ClaudeAdapter().parse(ref)
      await analyzeSpans(spans, {})
      process.stdout.write(JSON.stringify({
        spanCount: spans.length,
        integrity: ref.integrity
          ? { status: ref.integrity.status, lines: ref.integrity.corruptions.map((c) => c.lineNumber) }
          : null,
        maxRssKb: process.resourceUsage().maxRSS,
      }))
    `
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' }
    delete env.NODE_OPTIONS
    // A 64 MB old-space heap cannot hold the session (or its rows) as strings:
    // completing here proves the read stayed incremental and bounded.
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=64', '--max-semi-space-size=1', '--import', 'tsx', '--input-type=module', '--eval', childSource],
      { cwd: process.cwd(), encoding: 'utf8', env, timeout: 240_000 },
    )
    expect(child.status, child.stderr || child.error?.message).toBe(0)
    const result = JSON.parse(child.stdout) as {
      spanCount: number
      integrity: { status: string; lines: number[] } | null
      maxRssKb: number
    }
    expect(result.spanCount).toBeGreaterThan(0)
    expect(result.integrity).toMatchObject({ status: 'degraded_not_lossless', lines: [2] })
    expect(result.maxRssKb).toBeLessThan(3 * 1024 * 1024)
  }, 300_000)

  it('streams the OTLP export in bounded chunks instead of one string', async () => {
    const path = join(dir, 'streamed-export.otlp.jsonl')
    const spans = Array.from({ length: 3_000 }, (_, index) =>
      span({
        traceId: 't',
        spanId: `s${index}`,
        name: 'tool.call',
        kind: 'TOOL',
        startTime: '2026-01-01T00:00:00Z',
        content: 'x'.repeat(2048),
      }),
    )
    expect(Buffer.byteLength(serializeSpans(spans))).toBeGreaterThan(4 * 1024 * 1024)

    const outPath = await writeOtlpFile(spans, path)
    expect(await readFile(outPath, 'utf8')).toBe(serializeSpans(spans))

    const emptyPath = await writeOtlpFile([], join(dir, 'streamed-export-empty.otlp.jsonl'))
    expect(await readFile(emptyPath, 'utf8')).toBe('')
  })
})
