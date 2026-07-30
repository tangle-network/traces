import { mkdtempSync } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandAnalyzer, commandRedactor, haloAnalyzer, runCommand } from '../src/external.js'
import { span } from '../src/otlp.js'
import { applyRedactor } from '../src/redact.js'

// Redactor stub: read a JSON array on stdin, return each element replaced.
const REDACT_STUB = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const a=JSON.parse(s);process.stdout.write(JSON.stringify(a.map(()=>'[ML]')))})`

interface DescendantFixture {
  directory: string
  startedPath: string
  sentinelPath: string
  sentinelDelayMs: number
  parentScript: string
}

function descendantFixture(onReady: string, sentinelDelayMs: number): DescendantFixture {
  const directory = mkdtempSync(join(tmpdir(), 'traces-process-tree-'))
  const startedPath = join(directory, 'descendant-started')
  const sentinelPath = join(directory, 'descendant-escaped')
  const descendantScript = [
    `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, String(Date.now()))`,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'escaped'), ${sentinelDelayMs})`,
  ].join(';')
  const parentScript = [
    `const { existsSync, mkdirSync } = require('node:fs')`,
    `const { spawn } = require('node:child_process')`,
    `mkdirSync(${JSON.stringify(directory)}, { recursive: true })`,
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
    `const deadline = Date.now() + 5000`,
    `const ready = setInterval(() => {`,
    `  if (existsSync(${JSON.stringify(startedPath)})) { clearInterval(ready); ${onReady} } else if (Date.now() >= deadline) { process.exit(2) }`,
    `}, 5)`,
    `setInterval(() => {}, 1000)`,
  ].join(';')
  return { directory, startedPath, sentinelPath, sentinelDelayMs, parentScript }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitForPath(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function expectDescendantTerminated(fixture: DescendantFixture): Promise<void> {
  await waitForPath(fixture.startedPath)
  const startedAt = Number(await readFile(fixture.startedPath, 'utf8'))
  const remaining = Math.max(0, startedAt + fixture.sentinelDelayMs + 100 - Date.now())
  await new Promise((resolve) => setTimeout(resolve, remaining))
  expect(await pathExists(fixture.sentinelPath)).toBe(false)
}

describe('runCommand', () => {
  it('captures stdout/stderr and exit code', async () => {
    const r = await runCommand('node', ['-e', 'console.log("hi");console.error("warn")'])
    expect(r.stdout.trim()).toBe('hi')
    expect(r.stderr.trim()).toBe('warn')
    expect(r.code).toBe(0)
  })
  it('enforces a timeout', async () => {
    await expect(runCommand('node', ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 100 })).rejects.toThrow(/timed out/)
  })

  it('terminates descendants before rejecting a timeout', async () => {
    const fixture = descendantFixture(`process.stdout.write('ready')`, 1_500)
    try {
      await expect(
        runCommand(process.execPath, ['-e', fixture.parentScript], { timeoutMs: 800 }),
      ).rejects.toThrow(/timed out/)
      await expectDescendantTerminated(fixture)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('terminates descendants before rejecting output overflow', async () => {
    const fixture = descendantFixture(`process.stdout.write('x'.repeat(4096))`, 500)
    try {
      await expect(
        runCommand(process.execPath, ['-e', fixture.parentScript], {
          timeoutMs: 5_000,
          maxBuffer: 64,
        }),
      ).rejects.toThrow(/output exceeded/)
      await expectDescendantTerminated(fixture)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('terminates descendants before rejecting cancellation', async () => {
    const fixture = descendantFixture(`process.stdout.write('ready')`, 500)
    const controller = new AbortController()
    try {
      const result = runCommand(process.execPath, ['-e', fixture.parentScript], {
        signal: controller.signal,
        timeoutMs: 5_000,
      })
      await waitForPath(fixture.startedPath)
      controller.abort(new Error('cancelled by test'))
      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      await expectDescendantTerminated(fixture)
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})

describe('commandAnalyzer', () => {
  it('runs over the OTLP path and returns ok output', async () => {
    const a = commandAnalyzer({ name: 'stub', command: 'node', args: (p) => ['-e', 'console.log("ran on "+process.argv[1])', p] })
    const res = await a.analyze('/tmp/spans.otlp.jsonl')
    expect(res.ok).toBe(true)
    expect(res.output).toContain('/tmp/spans.otlp.jsonl')
  })
  it('fails soft on a non-zero exit', async () => {
    const a = commandAnalyzer({ name: 'boom', command: 'node', args: () => ['-e', 'process.exit(3)'] })
    const res = await a.analyze('/tmp/x')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/exit 3/)
  })
  it('fails soft when the command does not exist', async () => {
    const a = commandAnalyzer({ name: 'missing', command: 'definitely-not-a-real-binary-xyz', args: (p) => [p] })
    const res = await a.analyze('/tmp/x')
    expect(res.ok).toBe(false)
  })
})

describe('haloAnalyzer', () => {
  it('drives "<cmd> <otlp> -p <prompt> [-m model]" — our artifact is already canonical', async () => {
    const a = haloAnalyzer({ command: 'echo', model: 'glm-5.2' })
    expect(a.name).toBe('halo')
    const res = await a.analyze('/tmp/spans.otlp.jsonl', { prompt: 'diagnose loops' })
    expect(res.ok).toBe(true)
    expect(res.output).toContain('/tmp/spans.otlp.jsonl')
    expect(res.output).toContain('-p diagnose loops')
    expect(res.output).toContain('-m glm-5.2')
  })
})

describe('serializeSpans → canonical OpenInference (one artifact for analysts + HALO)', () => {
  it('emits top-level kind, resource, scope, string parent', async () => {
    const { serializeSpans } = await import('../src/otlp.js')
    const root = span({ traceId: 't', spanId: 'r', name: 'session', kind: 'AGENT', startTime: '2026-01-01T00:00:00Z', service: 'claude-code' })
    const [row] = serializeSpans([root]).trim().split('\n').map((l) => JSON.parse(l))
    expect(row.kind).toBe('AGENT') // top-level (HALO), not only in attributes
    expect(row.parent_span_id).toBe('') // root → "" (HALO requires a string)
    expect(row.resource.attributes['service.name']).toBe('claude-code')
    expect(row.scope.name).toBeTruthy()
    expect(row.attributes['openinference.span.kind']).toBe('AGENT') // kept for our reader
  })
})

describe('commandRedactor', () => {
  it('round-trips a JSON array through the tool', async () => {
    const r = commandRedactor({ name: 'stub', command: 'node', args: ['-e', REDACT_STUB] })
    expect(await r.redactText(['secret one', 'secret two'])).toEqual(['[ML]', '[ML]'])
    expect(await r.redactText([])).toEqual([])
  })
  it('rejects a length mismatch', async () => {
    const r = commandRedactor({ name: 'bad', command: 'node', args: ['-e', 'process.stdin.resume();process.stdout.write("[]")'] })
    await expect(r.redactText(['a', 'b'])).rejects.toThrow(/array of 2/)
  })
})

describe('applyRedactor', () => {
  it('scrubs span content and counts changes', async () => {
    const spans = [
      span({ traceId: 't', spanId: 'u', name: 'user.prompt', kind: 'CHAIN', startTime: '2026-01-01T00:00:00Z', content: 'call me at Bob Smith' }),
      span({ traceId: 't', spanId: 'x', name: 'tool.bash', kind: 'TOOL', startTime: '2026-01-01T00:00:01Z', tool: 'bash' }),
    ]
    const fake = { name: 'fake', redactText: async (ts: readonly string[]) => ts.map((t) => t.replace('Bob Smith', '[NAME]')) }
    const { spans: out, changed } = await applyRedactor(spans, fake)
    expect(changed).toBe(1)
    expect(out[0]!.attributes['content']).toBe('call me at [NAME]')
    expect(spans[0]!.attributes['content']).toBe('call me at Bob Smith') // input not mutated
  })
})
