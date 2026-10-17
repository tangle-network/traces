/**
 * `traces check` is the one gate (U9): it needs a gate, and each of
 * `--contract FILE`, `--contract conformance` and `--share-safe` decides on
 * its own; together they exit 1 if any fails, else 2 if any could not decide,
 * else 0. The verdict is stdout in text, JSON, JUnit XML or GitHub
 * annotations, and a share verdict never prints a value it found.
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveHexId, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeFixtureHome } from './fixtures/home.js'
import { runCli } from './run-cli.js'

const TRACE = deriveHexId('check-test-trace', 16)
const TOOL_SPAN = deriveHexId('check-test-bash', 8)
const EMAIL = 'planted.person@fastmail.com'
const SECRET = 'planted-secret-value-7f3a91c2e8b4d605'

let dir: string
let env: Record<string, string>
let run: string
let pass: string
let fail: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-check-'))
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
  run = await spanFile('run.otlp.jsonl')
  pass = await json('bash-required.json', { name: 'bash-required', tools: { required: ['bash'] } })
  fail = await json('no-bash.json', { name: 'no-bash', tools: { forbidden: ['bash'] } })
})

async function json(name: string, value: unknown): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(value), 'utf8')
  return path
}

/** One run: a model turn, then one bash call. `extra` lines follow the spans. */
async function spanFile(name: string, extra = ''): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${[
    llmSpan({
      traceId: TRACE, spanId: deriveHexId('check-test-llm', 8), parentSpanId: null, name: 'turn', model: 'glm-5.2',
      inputTokens: 10, outputTokens: 2, startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.000Z',
    }),
    toolSpan({
      traceId: TRACE, spanId: TOOL_SPAN, parentSpanId: null, name: 'bash', toolName: 'bash',
      startTime: '2026-01-01T00:00:01.000Z', endTime: '2026-01-01T00:00:02.000Z', status: { code: 'STATUS_CODE_OK' },
    }),
  ].map((row) => JSON.stringify(row)).join('\n')}\n${extra}`, 'utf8')
  return path
}

interface Verdict {
  status: string
  exitCode: number
  gates: Array<{
    gate: string
    status: string
    report?: { traces: Array<{ verdict: { violations: Array<{ spanId?: string }> } }> }
    validation?: { ok: boolean; capabilities: Array<{ available: boolean }> }
    verdict?: { status: string; findings: Array<{ category: string; detector: string; paths: string[] }> }
  }>
}

const verdictOf = (stdout: string): Verdict => JSON.parse(stdout) as Verdict

/** True when `xml` is one well-formed document: a declaration, then one root whose tags nest and close, entities escaped. */
function parsesAsXml(xml: string): boolean {
  const declaration = /^<\?xml\s[^?]*\?>/u.exec(xml.trim())
  if (!declaration) return false
  const body = xml.trim().slice(declaration[0].length)
  const stray = /&(?!(?:amp|lt|gt|quot|apos|#\d+);)/u
  const token = /\s*(?:<\/([\w.-]+)\s*>|<([\w.-]+)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)>|([^<]+))/uy
  const open: string[] = []
  let roots = 0
  for (let at = 0; at < body.length;) {
    token.lastIndex = at
    const match = token.exec(body)
    if (!match) return false
    at = token.lastIndex
    const [, close, start, attributes, selfClosing, text] = match
    if (text !== undefined) {
      if ((open.length === 0 && text.trim()) || stray.test(text)) return false
    } else if (close !== undefined) {
      if (open.pop() !== close) return false
    } else {
      if (stray.test(attributes ?? '')) return false
      if (open.length === 0) roots += 1
      if (!selfClosing) open.push(start!)
    }
  }
  return open.length === 0 && roots === 1
}

describe('traces check needs a gate', () => {
  it('exits 2 naming both gates when none is given, so an empty contract variable never passes', async () => {
    for (const format of ['text', 'json']) {
      const result = await runCli(['check', run, '--format', format], { env })
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('--contract FILE|conformance')
      expect(result.stderr).toContain('--share-safe')
      if (format === 'json') expect((JSON.parse(result.stderr) as { code: string }).code).toBe('usage')
    }
  })

  it('explains a contract given no ref, and reads no trace', async () => {
    const text = await runCli(['check', '--contract', pass, '--contract', 'conformance'], { env })
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('bash')
    expect(text.stdout).toContain('conformance: whether the input can be read as a trace')
    const explained = await runCli(['check', '--contract', pass, '--format', 'json'], { env })
    expect(explained.code).toBe(0)
    expect((JSON.parse(explained.stdout) as { explain: Array<{ contract: string }> }).explain.map((entry) => entry.contract)).toEqual(['bash-required'])
  })
})

describe('--contract FILE', () => {
  it('exits 0 on a pass, 1 on a fail with the span ids it broke on, and 2 on a contract that contradicts itself', async () => {
    const passed = await runCli(['check', run, '--contract', pass, '--format', 'json'], { env })
    expect(passed.code).toBe(0)
    expect(verdictOf(passed.stdout)).toMatchObject({ status: 'pass', exitCode: 0, gates: [{ gate: 'contract', status: 'pass' }] })

    const failed = await runCli(['check', run, '--contract', fail, '--format', 'json'], { env })
    expect(failed.code).toBe(1)
    const violations = verdictOf(failed.stdout).gates[0]!.report!.traces[0]!.verdict.violations
    expect(violations.map((violation) => violation.spanId)).toContain(TOOL_SPAN)

    const contradicts = await json('contradicts.json', { name: 'contradicts', tools: { required: ['bash'], forbidden: ['bash'] } })
    const bad = await runCli(['check', run, '--contract', contradicts, '--format', 'json'], { env })
    expect(bad.code).toBe(2)
    expect(bad.stdout).toBe('')
    expect((JSON.parse(bad.stderr) as { code: string }).code).toBe('usage')
  })

  it('takes a session id as its ref', async () => {
    const fx = await makeFixtureHome()
    const bounded = await json('bounded.json', { name: 'bounded', tools: { maxCalls: 10_000 } })
    const result = await runCli(['check', IDS.codex, '--contract', bounded, '--format', 'json'], { env: fx.env })
    expect(result.code, result.stderr).toBe(0)
    expect(verdictOf(result.stdout).gates[0]).toMatchObject({ gate: 'contract', status: 'pass' })
  }, 60_000)

  it('prints JUnit XML that parses, and GitHub annotations, on stdout', async () => {
    const junit = await runCli(['check', run, '--contract', fail, '--contract', 'conformance', '--format', 'junit'], { env })
    expect(junit.code).toBe(1)
    expect(parsesAsXml(junit.stdout)).toBe(true)
    expect(junit.stdout).toContain('<failure')
    expect(junit.stdout).toContain('classname="conformance"')

    const github = await runCli(['check', run, '--contract', fail, '--format', 'github'], { env })
    expect(github.code).toBe(1)
    const lines = github.stdout.trimEnd().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toMatch(/^::(error|warning) /u)
  })
})

describe('--contract conformance', () => {
  it("gives validate's verdict: 0 on a trace, 1 on a file that is not one", async () => {
    const trace = await runCli(['check', run, '--contract', 'conformance'], { env })
    expect(trace.code).toBe(0)
    expect(trace.stdout).toContain('CONFORMS')

    const junk = join(dir, 'junk.jsonl')
    await writeFile(junk, '{"hello":"world"}\nnot json at all\n', 'utf8')
    const notTrace = await runCli(['check', junk, '--contract', 'conformance', '--format', 'json'], { env })
    expect(notTrace.code).toBe(1)
    expect(verdictOf(notTrace.stdout).gates[0]).toMatchObject({ gate: 'conformance', status: 'fail', validation: { ok: false } })

    const evidence = join(dir, 'conformance-evidence')
    expect((await runCli(['check', junk, '--contract', 'conformance', '--out', evidence], { env })).code).toBe(1)
    expect(await readdir(evidence)).toEqual(['conformance.md'])
  })
})

describe('--share-safe', () => {
  it('fails a Markdown handoff that holds an email, read as bytes, and never prints the value', async () => {
    const handoff = join(dir, 'handoff.md')
    await writeFile(handoff, `# Handoff\n\nNext: ask ${EMAIL} for the staging key.\n`, 'utf8')
    const result = await runCli(['check', handoff, '--share-safe', '--format', 'json'], { env })
    expect(result.code).toBe(1)
    const verdict = verdictOf(result.stdout)
    // One gate, over one file: the path was read as bytes, not resolved or sniffed as a trace.
    expect(verdict.gates).toHaveLength(1)
    expect(verdict.gates[0]).toMatchObject({ gate: 'share-safe', status: 'fail', verdict: { status: 'UNSAFE', target: handoff, files: 1 } })
    expect(`${result.stdout}${result.stderr}`).not.toContain(EMAIL)

    const evidence = join(dir, 'share-evidence')
    expect((await runCli(['check', handoff, '--share-safe', '--out', evidence], { env })).code).toBe(1)
    const kept = await readFile(join(evidence, 'share-safe.json'), 'utf8')
    expect(kept).toContain('UNSAFE')
    expect(kept).not.toContain(EMAIL)
  })

  it('fails a file holding the value of --known-secret-env, without printing it', async () => {
    const notes = join(dir, 'notes.txt')
    await writeFile(notes, `deploy with ${SECRET} tonight\n`, 'utf8')
    const result = await runCli(['check', notes, '--share-safe', '--known-secret-env', 'PLANTED_SECRET'], { env: { ...env, PLANTED_SECRET: SECRET } })
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET)
  })

  it('does not read number-only values under content-named keys as content', async () => {
    // A session summary's token distributions: `input` and `output` name numbers here, not text.
    const summary = await json('summary.json', {
      session: 'synthetic',
      tokenUsage: {
        input: { n: 1, mean: 12, p50: 12, p95: null, histogram: [{ lo: 12, hi: 12, count: 1 }] },
        output: { n: 1, mean: 2926, totals: [2926] },
      },
    })
    const result = await runCli(['check', summary, '--share-safe', '--format', 'json'], { env })
    expect(result.code).toBe(0)
    expect(verdictOf(result.stdout).gates[0]!.verdict).toMatchObject({ status: 'SAFE', findings: [] })
  })

  it('raises no warning on a numeric value in a Codex upload preview', async () => {
    const fx = await makeFixtureHome()
    const preview = join(fx.root, 'preview.otlp.jsonl')
    expect((await runCli(['upload', IDS.codex, '--dry-run', '--out', preview], { env: fx.env })).code).toBe(0)
    const result = await runCli(['check', preview, '--share-safe', '--format', 'json'], { env: fx.env })
    expect(result.code, result.stdout).toBe(0)
    const rows = (await readFile(preview, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown)
    for (const finding of verdictOf(result.stdout).gates[0]!.verdict!.findings) {
      for (const path of finding.paths) {
        const [where, pointer] = path.split('#') as [string, string]
        let value: unknown = rows[Number(where.slice(where.lastIndexOf(':') + 1)) - 1]
        for (const segment of pointer.split('/').slice(1)) {
          value = (value as Record<string, unknown> | undefined)?.[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')]
        }
        expect(typeof value, `${finding.category}/${finding.detector} at ${path}`).not.toBe('number')
      }
    }
  }, 60_000)
})

describe('gates together', () => {
  it('fail when any gate fails, and could not decide when one could not and none failed', async () => {
    const safeFailing = await runCli(['check', run, '--contract', fail, '--share-safe'], { env })
    expect(safeFailing.code).toBe(1)

    // The trace reader skips the line that is not JSON; the share verdict cannot vouch for it.
    const partial = await spanFile('partial.otlp.jsonl', 'this line is not JSON\n')
    const undecided = await runCli(['check', partial, '--contract', pass, '--share-safe', '--format', 'json'], { env })
    expect(undecided.code).toBe(2)
    expect(verdictOf(undecided.stdout).gates.map((gate) => [gate.gate, gate.status])).toEqual([['contract', 'pass'], ['share-safe', 'unknown']])
    expect((JSON.parse(undecided.stderr) as { code: string }).code).toBe('unknown-verdict')

    const unsafePassing = join(dir, 'with-email')
    await mkdir(unsafePassing, { recursive: true })
    const spans = await spanFile(join('with-email', 'run.otlp.jsonl'), `${JSON.stringify({ note: EMAIL })}\n`)
    const both = await runCli(['check', spans, '--contract', pass, '--share-safe'], { env })
    expect(both.code).toBe(1)
    expect(`${both.stdout}${both.stderr}`).not.toContain(EMAIL)
  })
})
