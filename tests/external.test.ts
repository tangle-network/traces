import { mkdtempSync } from 'node:fs'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnalystFinding } from '@tangle-network/agent-eval/analyst'
import { describe, expect, it } from 'vitest'
import {
  commandAnalyzer,
  commandRedactor,
  haloAnalyzer,
  runCommand,
  runExternalAnalyzers,
} from '../src/external.js'
import { serializeSpans, span } from '../src/otlp.js'
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

/**
 * `sentinelDelayMs` is how long the terminator gets before the escaped
 * descendant proves it survived. It is a budget for the KILL, not part of the
 * invariant: the sentinel must never appear, whatever the budget. Every caller
 * uses the same 1.5s, because the two that used 500ms failed on a loaded
 * machine — walking /proc and signalling a process tree takes longer than half
 * a second when 32 cores are saturated, and a budget that tight tests the
 * machine rather than the code.
 */
function descendantFixture(onReady: string, sentinelDelayMs: number): DescendantFixture {
  const directory = mkdtempSync(join(tmpdir(), 'traces-process-tree-'))
  const startedPath = join(directory, 'descendant-started')
  const sentinelPath = join(directory, 'descendant-escaped')
  const leafScript = [
    `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, String(Date.now()))`,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'escaped'), ${sentinelDelayMs})`,
  ].join(';')
  const descendantScript = [
    `const { spawn } = require('node:child_process')`,
    `const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(leafScript)}], { stdio: 'ignore', detached: process.platform !== 'win32' })`,
    `leaf.unref()`,
    `setInterval(() => {}, 1000)`,
  ].join(';')
  const parentScript = [
    `const { existsSync, mkdirSync } = require('node:fs')`,
    `const { spawn } = require('node:child_process')`,
    `mkdirSync(${JSON.stringify(directory)}, { recursive: true })`,
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore', detached: process.platform !== 'win32' })`,
    `descendant.unref()`,
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

  it('closes stdin when no input is provided', async () => {
    const r = await runCommand(process.execPath, [
      '-e',
      "process.stdin.on('end',()=>process.stdout.write('closed'));process.stdin.resume()",
    ])

    expect(r).toMatchObject({ stdout: 'closed', code: 0 })
  })

  it('limits combined stdout and stderr by encoded byte length', async () => {
    await expect(
      runCommand(
        process.execPath,
        [
          '-e',
          "process.stdout.write('é'.repeat(20));process.stderr.write('é'.repeat(20))",
        ],
        { maxBuffer: 64 },
      ),
    ).rejects.toThrow(/output exceeded 64 bytes/)
  })

  it('rejects invalid resource limits before spawning', () => {
    expect(() => runCommand('not-run', [], { timeoutMs: 0 })).toThrow(
      /timeoutMs must be a positive safe integer/,
    )
    expect(() => runCommand('not-run', [], { maxBuffer: Number.POSITIVE_INFINITY })).toThrow(
      /maxBuffer must be a positive safe integer/,
    )
  })

  it('enforces a timeout', async () => {
    await expect(runCommand('node', ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 100 })).rejects.toThrow(/timed out/)
  })

  it('terminates the detached descendant tree before rejecting a timeout', async () => {
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

  it('uses /proc to terminate detached descendants when ps is unavailable on Linux', async () => {
    if (process.platform !== 'linux') return
    const fixture = descendantFixture(`process.stdout.write('ready')`, 1_500)
    const originalPath = process.env.PATH
    process.env.PATH = '/path-without-ps'
    try {
      await expect(
        runCommand(process.execPath, ['-e', fixture.parentScript], { timeoutMs: 800 }),
      ).rejects.toThrow(/timed out/)
      await expectDescendantTerminated(fixture)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('terminates the detached descendant tree before rejecting output overflow', async () => {
    const fixture = descendantFixture(`process.stdout.write('x'.repeat(4096))`, 1_500)
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

  it('terminates the detached descendant tree before rejecting cancellation', async () => {
    const fixture = descendantFixture(`process.stdout.write('ready')`, 1_500)
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

  it('rejects parser attempts to spoof library-controlled result fields', async () => {
    const analyzer = commandAnalyzer({
      name: 'trusted',
      command: process.execPath,
      args: () => ['-e', 'process.stdout.write("observed")'],
      parse: () => ({
        kind: 'report',
        analyzer: 'spoofed',
        ok: false,
        output: 'forged',
      }) as never,
    })

    await expect(analyzer.analyze('/tmp/spans.otlp.jsonl')).resolves.toMatchObject({
      analyzer: 'trusted',
      kind: 'report',
      ok: false,
      output: 'observed',
      error: expect.stringContaining("unexpected field 'analyzer'"),
    })
  })

  it('rejects malformed parser findings without throwing', async () => {
    const analyzer = commandAnalyzer({
      name: 'trusted',
      command: process.execPath,
      args: () => ['-e', 'process.stdout.write("observed")'],
      parse: () => ({ kind: 'findings', findings: { poison: true } }) as never,
    })

    await expect(analyzer.analyze('/tmp/spans.otlp.jsonl')).resolves.toMatchObject({
      analyzer: 'trusted',
      kind: 'report',
      ok: false,
      output: 'observed',
      error: expect.stringContaining('findings must be an array'),
    })
  })

  it('binds direct structured findings to spans in the source artifact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'traces-command-analyzer-'))
    const otlpPath = join(directory, 'spans.otlp.jsonl')
    await writeFile(
      otlpPath,
      serializeSpans([
        span({
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'tool.exec',
          kind: 'TOOL',
          startTime: '2026-01-01T00:00:00Z',
        }),
      ]),
      'utf8',
    )
    let evidenceUri = 'trace://trace-1/span/span-1'
    const finding = (): AnalystFinding => ({
      schema_version: '1.0.0',
      finding_id: 'finding-1',
      analyst_id: 'external-test',
      produced_at: '2026-01-01T00:00:01Z',
      severity: 'high',
      area: 'tool-use',
      claim: 'The tool failed.',
      evidence_refs: [{ kind: 'span', uri: evidenceUri }],
      recommended_action: 'Fix the command.',
      validation_plan: 'Rerun the same command.',
      confidence: 1,
    })
    const analyzer = commandAnalyzer({
      name: 'structured',
      command: process.execPath,
      args: () => ['-e', 'process.stdout.write("observed")'],
      parse: () => ({ kind: 'findings', findings: [finding()] }),
    })

    try {
      await expect(analyzer.analyze(otlpPath)).resolves.toMatchObject({
        analyzer: 'structured',
        kind: 'findings',
        ok: true,
        findings: [finding()],
      })

      evidenceUri = 'trace://trace-1/span/not-present'
      await expect(analyzer.analyze(otlpPath)).resolves.toMatchObject({
        analyzer: 'structured',
        kind: 'report',
        ok: false,
        output: 'observed',
        error: expect.stringContaining('unknown span evidence URI'),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('runExternalAnalyzers', () => {
  it('keeps successful results when another analyzer throws', async () => {
    const results = await runExternalAnalyzers('/tmp/spans.otlp.jsonl', [
      {
        name: 'throws',
        async analyze() {
          throw new Error('boom')
        },
      },
      {
        name: 'works',
        async analyze() {
          return {
            analyzer: 'works',
            kind: 'report',
            ok: true,
            output: 'kept',
          }
        },
      },
    ])

    expect(results).toEqual([
      {
        analyzer: 'throws',
        kind: 'report',
        ok: false,
        output: '',
        error: 'boom',
      },
      {
        analyzer: 'works',
        kind: 'report',
        ok: true,
        output: 'kept',
      },
    ])
  })

  it('rejects malformed custom analyzer results and preserves the registered name', async () => {
    const [result] = await runExternalAnalyzers('/tmp/spans.otlp.jsonl', [
      {
        name: 'trusted',
        async analyze() {
          return {
            analyzer: 'spoofed',
            kind: 'findings',
            ok: true,
            output: 'forged',
            findings: { poison: true },
          } as never
        },
      },
    ])

    expect(result).toMatchObject({
      analyzer: 'trusted',
      kind: 'report',
      ok: false,
      output: '',
      error: expect.stringContaining("reported analyzer 'spoofed'"),
    })
  })

  it('rejects malformed finding collections from custom analyzers', async () => {
    const [result] = await runExternalAnalyzers('/tmp/spans.otlp.jsonl', [
      {
        name: 'trusted',
        async analyze() {
          return {
            analyzer: 'trusted',
            kind: 'findings',
            ok: true,
            output: 'observed',
            findings: { poison: true },
          } as never
        },
      },
    ])

    expect(result).toMatchObject({
      analyzer: 'trusted',
      kind: 'report',
      ok: false,
      output: '',
      error: expect.stringContaining('findings must be an array'),
    })
  })
})

describe('haloAnalyzer', () => {
  it('drives "<cmd> <otlp> -p <prompt> [-m model]" — our artifact is already canonical', async () => {
    const a = haloAnalyzer({
      command: 'echo',
      model: 'glm-5.2',
      maxDepth: 0,
      maxTurns: 3,
      maxParallel: 1,
      instructions: 'Cite exact spans.',
      reasoningEffort: 'low',
      telemetry: true,
    })
    expect(a.name).toBe('halo')
    const res = await a.analyze('/tmp/spans.otlp.jsonl', { prompt: 'diagnose loops' })
    expect(res.ok).toBe(true)
    expect(res.output).toContain('/tmp/spans.otlp.jsonl')
    expect(res.output).toContain('-p diagnose loops')
    expect(res.output).toContain('-m glm-5.2')
    expect(res.output).toContain('--max-depth 0')
    expect(res.output).toContain('--max-turns 3')
    expect(res.output).toContain('--max-parallel 1')
    expect(res.output).toContain('--instructions Cite exact spans.')
    expect(res.output).toContain('--reasoning-effort low')
    expect(res.output).toContain('--telemetry')
  })

  it('rejects invalid resource limits before running HALO', () => {
    expect(() => haloAnalyzer({ maxTurns: 0 })).toThrow(/maxTurns/)
    expect(() => haloAnalyzer({ maxDepth: -1 })).toThrow(/maxDepth/)
  })

  it('uses bounded defaults instead of HALO upstream resource defaults', async () => {
    const result = await haloAnalyzer({ command: 'echo' }).analyze('/tmp/spans.otlp.jsonl')
    expect(result.output).toContain('--max-depth 0')
    expect(result.output).toContain('--max-turns 3')
    expect(result.output).toContain('--max-parallel 1')
  })
})

describe('serializeSpans → canonical OpenInference (one artifact for analysts + HALO)', () => {
  it('emits top-level kind, resource, scope, string parent, and HALO status names', async () => {
    const { serializeSpans } = await import('../src/otlp.js')
    const root = span({
      traceId: 't',
      spanId: 'r',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00Z',
      status: 'ERROR',
      statusMessage: 'failed',
      service: 'claude-code',
    })
    const [row] = serializeSpans([root]).trim().split('\n').map((l) => JSON.parse(l))
    expect(row.kind).toBe('AGENT') // top-level (HALO), not only in attributes
    expect(row.parent_span_id).toBe('') // root → "" (HALO requires a string)
    expect(row.resource.attributes['service.name']).toBe('claude-code')
    expect(row.scope.name).toBeTruthy()
    expect(row.status).toEqual({ code: 'STATUS_CODE_ERROR', message: 'failed' })
    expect(row.attributes['openinference.span.kind']).toBe('AGENT') // kept for our reader
    expect(row.attributes['inference.observation_kind']).toBe('AGENT')
  })

  it('projects standard OpenInference usage into the fields HALO indexes', async () => {
    const { serializeSpans } = await import('../src/otlp.js')
    const llm = span({
      traceId: 't',
      spanId: 'llm',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:00Z',
      agent: 'worker',
      model: 'gpt-test',
      inputTokens: 123,
      outputTokens: 45,
      costUsd: 0.01,
    })
    const [row] = serializeSpans([llm]).trim().split('\n').map((line) => JSON.parse(line))

    expect(row.attributes).toMatchObject({
      'inference.agent_name': 'worker',
      'inference.llm.model_name': 'gpt-test',
      'inference.llm.input_tokens': 123,
      'inference.llm.output_tokens': 45,
      'inference.llm.cost.total': 0.01,
    })
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
