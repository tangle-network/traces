import { describe, expect, it } from 'vitest'
import { commandAnalyzer, commandRedactor, haloAnalyzer, runCommand } from '../src/external.js'
import { span } from '../src/otlp.js'
import { applyRedactor } from '../src/redact.js'

// Redactor stub: read a JSON array on stdin, return each element replaced.
const REDACT_STUB = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const a=JSON.parse(s);process.stdout.write(JSON.stringify(a.map(()=>'[ML]')))})`

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
