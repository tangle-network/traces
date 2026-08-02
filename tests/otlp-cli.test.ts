import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { deriveHexId, llmSpan, loopSpan, steeredBy, toolSpan } from '@tangle-network/agent-trace-contract'

const execFileAsync = promisify(execFile)

// Hex wire ids, as OTLP and W3C `traceparent` require.
const TRACE = deriveHexId('cli-otlp-trace', 16)
const ROUND_1 = deriveHexId('cli-round-1', 8)
const LLM_1 = deriveHexId('cli-llm-1', 8)
const TOOL_1 = deriveHexId('cli-tool-1', 8)
const ROUND_2 = deriveHexId('cli-round-2', 8)
const ENV = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' }

async function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: ENV,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 }
  }
}

function conformingRows(): unknown[] {
  return [
    loopSpan({
      traceId: TRACE,
      spanId: ROUND_1,
      parentSpanId: null,
      name: 'round 1',
      loopId: 'loop-a',
      iteration: 1,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:10.000Z',
    }),
    llmSpan({
      traceId: TRACE,
      spanId: LLM_1,
      parentSpanId: ROUND_1,
      name: 'coder turn',
      model: 'glm-5.2',
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0042,
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:06.000Z',
    }),
    toolSpan({
      traceId: TRACE,
      spanId: TOOL_1,
      parentSpanId: ROUND_1,
      name: 'bash',
      toolName: 'bash',
      startTime: '2026-01-01T00:00:06.000Z',
      endTime: '2026-01-01T00:00:07.000Z',
    }),
    loopSpan({
      traceId: TRACE,
      spanId: ROUND_2,
      parentSpanId: null,
      name: 'round 2',
      loopId: 'loop-a',
      iteration: 2,
      resumed: true,
      startTime: '2026-01-01T00:00:10.000Z',
      endTime: '2026-01-01T00:00:20.000Z',
      links: [steeredBy(LLM_1, TRACE)],
    }),
  ]
}

async function writeRows(dir: string, name: string, rows: readonly unknown[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return path
}

describe('traces validate', () => {
  it('exits 0 on a conforming trace and lists every capability it unlocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-ok-'))
    const path = await writeRows(dir, 'spans.otlp.jsonl', conformingRows())

    const result = await runCli(['validate', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('CONFORMS')
    expect(result.stdout).toContain('| `token-accounting` | ✅ available')
    expect(result.stdout).toContain('| `steering-chain` | ✅ available')
  })

  // Severity says what a finding claims about the INPUT: `warn` is "readable but
  // degraded". A dangling parent edge costs real roll-up and costs it loudly —
  // and the spans still hold real tokens, a real model and real outcomes, so the
  // file IS a trace and failing CI on it would fail on thinness.
  it('exits 0 on a degraded-but-readable trace and names the capability the degradation costs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-degraded-'))
    const rows = conformingRows() as Record<string, unknown>[]
    // A parent that is not in the export: the subtree cannot attach, so spend
    // below it never rolls up to a run.
    rows[1] = { ...rows[1], parent_span_id: deriveHexId('round-missing', 8) }
    const path = await writeRows(dir, 'spans.otlp.jsonl', rows)

    const result = await runCli(['validate', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('CONFORMS')
    expect(result.stdout).toContain('🟠 WARN | `orphan-parent`')
    expect(result.stdout).toContain('| `cost-attribution` | ❌ unavailable')
  })

  // The other half of the same rule: `error` is "not a trace", and that is the
  // ONLY thing the exit code reports.
  it('exits 1 when not one entry is a span, and marks every capability unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-nospans-'))
    const path = await writeRows(dir, 'spans.otlp.jsonl', [
      { hello: 'world' },
      { type: 'delta', index: 1 },
    ])

    const result = await runCli(['validate', path])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('NOT A TRACE')
    expect(result.stdout).toContain('🔴 ERROR | `invalid-span`')
    for (const capability of ['token-accounting', 'cost-attribution', 'tool-usage', 'latency-analysis']) {
      expect(result.stdout).toContain(`| \`${capability}\` | ❌ unavailable`)
    }
  })

  it('reports a partially-conforming trace without failing, naming what it costs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-thin-'))
    const path = await writeRows(dir, 'spans.otlp.jsonl', [
      {
        trace_id: TRACE,
        span_id: deriveHexId('event-1', 8),
        parent_span_id: null,
        name: 'vb.task.start',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T00:00:00.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: { 'openinference.span.kind': 'AGENT' },
      },
      {
        trace_id: TRACE,
        span_id: deriveHexId('event-2', 8),
        parent_span_id: null,
        name: 'vb.backend.progress',
        start_time: '2026-01-01T00:00:01.000Z',
        end_time: '2026-01-01T00:00:01.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: { 'openinference.span.kind': 'AGENT' },
      },
    ])

    const result = await runCli(['validate', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('flat-hierarchy')
    expect(result.stdout).toContain('2/2 (100.0%) carry no parent edge')
    expect(result.stdout).toContain('no spans carry gen_ai.usage.input_tokens')
    expect(result.stdout).toContain('| `token-accounting` | ❌ unavailable')
  })

  it('validates every jsonl in a directory as one body of work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-dir-'))
    await mkdir(join(dir, 'nested'), { recursive: true })
    const rows = conformingRows()
    await writeRows(dir, 'a.jsonl', rows.slice(0, 2))
    await writeRows(join(dir, 'nested'), 'b.jsonl', rows.slice(2))

    const result = await runCli(['validate', dir])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Ingested:** 4 span(s) from 4 row(s) across 2 OTLP file(s)')
  })

  it('reads only the span files in a run directory and names the event logs it skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-run-'))
    await writeRows(dir, 'agent-eval-trace-shot-1.analyst-otlp.jsonl', conformingRows())
    await writeFile(
      join(dir, 'stream-shot-1.jsonl'),
      `${Array.from({ length: 40 }, (_unused, index) => JSON.stringify({ type: 'delta', index })).join('\n')}\n`,
      'utf8',
    )
    await writeFile(join(dir, 'reviewer-memory.jsonl'), `${JSON.stringify({ note: 'x' })}\n`, 'utf8')

    const result = await runCli(['validate', dir])
    expect(result.code).toBe(0)
    // 4 rows, not 45: the event logs are named, not counted as broken spans.
    expect(result.stdout).toContain('Ingested:** 4 span(s) from 4 row(s) across 1 OTLP file(s)')
    expect(result.stdout).toContain('2 JSONL file(s) in this directory are not OTLP')
    expect(result.stdout).toContain('stream-shot-1.jsonl')
    expect(result.stdout).toContain('reviewer-memory.jsonl')
  })

  it('reports a file that is not spans at all instead of crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-junk-'))
    const path = join(dir, 'junk.jsonl')
    await writeFile(path, '{"hello":"world"}\nnot json at all\n[1,2,3]\n', 'utf8')

    const result = await runCli(['validate', path])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('invalid-span')
    expect(result.stdout).toContain('unparseable-line')
    expect(result.stderr).not.toContain('Error')
  })

  // An export with nothing in it is not a thin trace, it is an absent one: there
  // is no span to read, so no analysis can run. Reading that as CONFORMS told a
  // caller to spend a run on a file that answers no question.
  it('does not call an empty file conforming, and does not exit 0 on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-empty-'))
    const path = join(dir, 'spans.otlp.jsonl')
    await writeFile(path, '', 'utf8')

    const result = await runCli(['validate', path])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('NOT A TRACE')
    expect(result.stdout).not.toContain('CONFORMS')
    expect(result.stdout).toContain('🔴 ERROR | `no-spans`')
    expect(result.stderr).not.toContain('Error')
  })

  it('does not call an all-unparseable file conforming, and names every bad line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-unparseable-'))
    const path = join(dir, 'spans.otlp.jsonl')
    await writeFile(path, 'not json at all\n{ broken\n<<<>>>\n', 'utf8')

    const result = await runCli(['validate', path])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('NOT A TRACE')
    expect(result.stdout).not.toContain('CONFORMS')
    expect(result.stdout).toContain('3 row(s) could not be analysed')
    for (const line of ['| 1 |', '| 2 |', '| 3 |']) expect(result.stdout).toContain(line)
    expect(result.stderr).not.toContain('Error')
  })

  it('passes a file with one good span among unreadable lines, counting only the span', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-validate-mixed-'))
    const path = join(dir, 'spans.otlp.jsonl')
    const good = JSON.stringify(conformingRows()[0])
    await writeFile(path, `garbage line one\n${good}\n{ still broken\n`, 'utf8')

    const result = await runCli(['validate', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('CONFORMS')
    expect(result.stdout).toContain('Ingested:** 1 span(s) from 1 row(s)')
    expect(result.stdout).toContain('2 row(s) could not be analysed')
    expect(result.stderr).not.toContain('Error')
  })
})

describe('traces analyze --otlp', () => {
  it('analyses OTLP a foreign system emitted, with no adapter in the path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-otlp-'))
    const path = await writeRows(dir, 'spans.otlp.jsonl', conformingRows())
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', path, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('# Trace analysis — otlp')
    expect(written).toContain('trace conformance')
    expect(written).toContain('| `token-accounting` | ✅ available')
    // The tool span reached the tool analysis under its semconv name.
    expect(written).toContain('bash')
  })

  it('states which analyses it skipped when the trace cannot support them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-thin-'))
    const path = await writeRows(dir, 'spans.otlp.jsonl', [
      {
        trace_id: TRACE,
        span_id: deriveHexId('event-1', 8),
        parent_span_id: null,
        name: 'vb.task.start',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T00:00:00.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: { 'openinference.span.kind': 'AGENT' },
      },
      {
        trace_id: TRACE,
        span_id: deriveHexId('event-2', 8),
        parent_span_id: null,
        name: 'vb.backend.progress',
        start_time: '2026-01-01T00:00:05.000Z',
        end_time: '2026-01-01T00:00:05.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: { 'openinference.span.kind': 'AGENT' },
      },
    ])
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', path, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('analyses skipped, and why')
    expect(written).toContain('Direct model usage')
    expect(written).toContain('Cost coverage')
  })

  it('degrades instead of crashing on a trace the span model cannot represent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-dupe-'))
    const rows = conformingRows() as Record<string, unknown>[]
    const conflicting = { ...rows[1], name: 'a different call entirely' }
    const path = await writeRows(dir, 'spans.otlp.jsonl', [...rows, conflicting, 'not json object'])
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', path, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('conflicting-span-id')
    expect(written).toContain('could not be analysed')
  })

  it('reports a multi-shot cell re-declaring its ancestors as repeats, not as defects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-shots-'))
    const [round1, call, tool, round2] = conformingRows()
    // Every shot file re-declares the round it hangs under, byte-identically.
    await writeRows(dir, 'shot-1.jsonl', [round1, call])
    await writeRows(dir, 'shot-2.jsonl', [round1, tool, round2])
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', dir, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('1 row(s) re-declared a span already read, identically')
    expect(written).toContain('Identical repeats are not a defect')
    expect(written).not.toContain('conflicting-span-id')
    // The repeat did not cost token accounting, because it double-counts nothing.
    expect(written).toContain('| `token-accounting` | ✅ available')
  })

  it('reports round-over-round convergence and the verdict that steered each round', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-loop-'))
    const rows = conformingRows() as Record<string, unknown>[]
    const verdict1 = {
      trace_id: TRACE,
      span_id: deriveHexId('verdict-1', 8),
      parent_span_id: ROUND_1,
      name: 'verification',
      kind: 'EVALUATOR',
      start_time: '2026-01-01T00:00:08.000Z',
      end_time: '2026-01-01T00:00:09.000Z',
      status: { code: 'STATUS_CODE_ERROR' },
      attributes: { 'openinference.span.kind': 'EVALUATOR', 'agent.outcome': 'fail', 'agent.outcome.score': 0.25 },
    }
    const verdict2 = {
      ...verdict1,
      span_id: deriveHexId('verdict-2', 8),
      parent_span_id: ROUND_2,
      start_time: '2026-01-01T00:00:18.000Z',
      end_time: '2026-01-01T00:00:19.000Z',
      status: { code: 'STATUS_CODE_OK' },
      attributes: { 'openinference.span.kind': 'EVALUATOR', 'agent.outcome': 'pass', 'agent.outcome.score': 0.9 },
    }
    // Round 2 was caused by round 1's verdict, not nested inside it.
    rows[3] = { ...rows[3], links: [{ trace_id: TRACE, span_id: verdict1.span_id, attributes: { 'agent.link.kind': 'steered_by' } }] }
    const path = await writeRows(dir, 'spans.otlp.jsonl', [...rows, verdict1, verdict2])
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', path, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('## round-over-round convergence')
    expect(written).toContain('improved')
    expect(written).toContain('score 0.25 → 0.9 across 2 graded round(s)')
    expect(written).toContain('## steering chain (which verdict caused which retry)')
    expect(written).toContain('`steered_by`')
    // The EVALUATOR verdict survived ingest as an EVALUATOR.
    expect(written).toContain('| `steering-chain` | ✅ available')
  })

  it('marks tree-comparison as not yet implemented rather than claiming every analysis ran', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-unbuilt-'))
    const rows = conformingRows() as Record<string, unknown>[]
    rows[0] = { ...rows[0], attributes: { ...(rows[0]!.attributes as object), 'agent.branch.id': 'arm-a' } }
    rows[3] = { ...rows[3], attributes: { ...(rows[3]!.attributes as object), 'agent.branch.id': 'arm-b' } }
    const path = await writeRows(dir, 'spans.otlp.jsonl', rows)
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', path, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('| `tree-comparison` | ⚠️ available, unused')
    expect(written).toContain('not yet implemented here')
    expect(written).not.toContain('Every analysis these spans DO support ran')
  })

  it('marks the sections whose inputs are incomplete, at the table, not only in the preamble', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-analyze-gate-'))
    const path = await writeRows(dir, 'spans.otlp.jsonl', [
      {
        trace_id: TRACE,
        span_id: deriveHexId('event-1', 8),
        parent_span_id: null,
        name: 'vb.task.start',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-01T00:00:00.000Z',
        status: { code: 'STATUS_CODE_UNSET' },
        attributes: { 'openinference.span.kind': 'AGENT' },
      },
    ])
    const report = join(dir, 'report.md')

    const result = await runCli(['analyze', '--otlp', path, '--out', report])
    expect(result.code).toBe(0)
    const written = await readFile(report, 'utf8')
    expect(written).toContain('### Direct model usage — inputs incomplete')
    expect(written).toContain('### Cost coverage — inputs incomplete')
    expect(written).toContain('⚠️ **Inputs incomplete — `token-accounting` unavailable:**')
    expect(written).toContain('⚠️ **Inputs incomplete — `cost-attribution` unavailable:**')
    expect(written).toContain('⚠️ **Inputs incomplete — `tool-usage` unavailable:**')
    // The marker sits above the token table, not forty lines away from it.
    const marker = written.indexOf('`token-accounting` unavailable')
    const table = written.indexOf('| Token category | Total |')
    expect(marker).toBeGreaterThan(-1)
    expect(table - marker).toBeGreaterThan(0)
    expect(table - marker).toBeLessThan(600)
  })

  // A round trip through `traces` must not turn a defective trace into a clean
  // one. What CAN be re-emitted is every field the reader substituted — the
  // producer's own status spelling, their own coined span kind, the trace id they
  // never wrote; what cannot is a row that was never a span, so the artifact
  // declares how much of the source is missing from it rather than quietly
  // validating cleaner.
  //
  // `tests/otlp-round-trip.test.ts` holds the invariant over every finding code
  // the reader can emit. This is the same property proven through the CLI a user
  // actually runs, on the three fields whose laundering was found in the wild.
  it('does not launder a source through --otlp-out: findings survive, and dropped rows are declared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-roundtrip-'))
    const rows = conformingRows() as Record<string, unknown>[]
    rows[2] = { ...rows[2], status: { code: 'WEIRD', message: 'exit 2' } }
    // A kind this contract has no word for. The reader analyses the span as
    // something it can bucket; the export must still say TELEPATHY.
    rows[1] = {
      ...rows[1],
      kind: 'SPAN_KIND_TELEPATHY',
      attributes: { ...(rows[1]!.attributes as object), 'openinference.span.kind': 'SPAN_KIND_TELEPATHY' },
    }
    // No trace id at all. The reader MUST invent one to group by, and exporting
    // the invented id erased `missing-trace-id` and raised `non-hex-id` against
    // an id this package minted rather than one the producer wrote.
    delete (rows[3] as Record<string, unknown>).trace_id
    const source = join(dir, 'source.jsonl')
    await writeFile(
      source,
      `${['not a json line', ...rows.map((row) => JSON.stringify(row))].join('\n')}\n`,
      'utf8',
    )
    const artifact = join(dir, 'artifact.jsonl')

    const sourceValidation = await runCli(['validate', source])
    expect(sourceValidation.code).toBe(0)
    expect(sourceValidation.stdout).toContain('🟠 WARN | `invalid-status`')
    expect(sourceValidation.stdout).toContain('ℹ️  INFO | `unknown-span-kind`')
    expect(sourceValidation.stdout).toContain('🟠 WARN | `missing-trace-id`')

    const analyzed = await runCli(['analyze', '--otlp', source, '--otlp-out', artifact, '--out', join(dir, 'r.md')])
    expect(analyzed.code).toBe(0)

    const artifactValidation = await runCli(['validate', artifact])
    // Same verdict, same exit, same findings — the defects did not wash out.
    expect(artifactValidation.code).toBe(sourceValidation.code)
    expect(artifactValidation.stdout).toContain('CONFORMS')
    expect(artifactValidation.stdout).toContain('🟠 WARN | `invalid-status`')
    expect(artifactValidation.stdout).toContain('ℹ️  INFO | `unknown-span-kind`')
    // `missing-trace-id` is the ONE finding a re-export cannot carry: agent-eval's
    // store cannot read a row without a trace id, so the artifact must mint one.
    // It is not laundered — the substitution is stated above the findings.
    expect(artifactValidation.stdout).not.toContain('🟠 WARN | `missing-trace-id`')
    expect(artifactValidation.stdout).toContain('span(s) carry a trace_id this tool minted')
    expect(artifactValidation.stdout).toContain('`missing-trace-id` is NOT reported below')
    // And the one row that could not be re-emitted is declared, not hidden.
    expect(artifactValidation.stdout).toContain('1 row(s) of the ORIGINAL source are not in this file')
    expect(artifactValidation.stdout).toContain('NOT a substitute for validating the source')
  })

  it('accepts the deprecated --otlp on a writing command, with a warning, and still writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-flag-'))
    const source = await writeRows(dir, 'spans.otlp.jsonl', conformingRows())
    const out = join(dir, 'out.jsonl')

    const result = await runCli(['export', source, '--otlp', out])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('--otlp is deprecated')
    expect(result.stderr).toContain('--otlp-out')
    expect((await readFile(out, 'utf8')).trim().split('\n')).toHaveLength(4)
  })

  it('refuses --otlp AND --otlp-out together on a writing command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-both-'))
    const source = await writeRows(dir, 'spans.otlp.jsonl', conformingRows())

    const result = await runCli(['export', source, '--otlp', join(dir, 'a.jsonl'), '--otlp-out', join(dir, 'b.jsonl')])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('deprecated spelling')
  })

  it('fails with an actionable message when a file holds no analyzable span', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-otlp-empty-'))
    const path = join(dir, 'junk.jsonl')
    await writeFile(path, '{"hello":"world"}\n', 'utf8')

    const result = await runCli(['analyze', '--otlp', path])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('traces validate')
  })
})
