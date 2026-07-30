import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hodoscopeAnalyzer, writeHodoscopeInput } from '../src/hodoscope.js'
import { serializeSpans, span } from '../src/otlp.js'

function fixture(options: { duplicateLlmContent?: boolean } = {}) {
  const root = span({
    traceId: 'trace-one',
    spanId: 'root',
    name: 'session',
    kind: 'AGENT',
    startTime: '2026-01-01T00:00:00.000Z',
    service: 'codex',
    extra: { comparison_group: 'candidate' },
  })
  return [
    root,
    span({
      traceId: 'trace-one',
      spanId: 'user',
      parentSpanId: 'root',
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:01.000Z',
      step: 0,
      content: 'Fix the failing test.',
    }),
    span({
      traceId: 'trace-one',
      spanId: 'llm-planning',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:02.000Z',
      step: 1,
      inputTokens: 100,
      outputTokens: 20,
    }),
    span({
      traceId: 'trace-one',
      spanId: 'assistant-progress',
      parentSpanId: 'root',
      name: 'message.assistant',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:03.000Z',
      step: 2,
      content: 'I will inspect the repository.',
    }),
    span({
      traceId: 'trace-one',
      spanId: 'tool',
      parentSpanId: 'llm-planning',
      name: 'tool.exec_command',
      kind: 'TOOL',
      startTime: '2026-01-01T00:00:04.000Z',
      step: 3,
      tool: 'exec_command',
      status: 'ERROR',
      statusMessage: 'exit 1',
      extra: { 'input.value': '{"cmd":"pnpm test"}', 'output.value': 'failed' },
    }),
    span({
      traceId: 'trace-one',
      spanId: 'llm-final',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:05.000Z',
      step: 4,
      inputTokens: 180,
      outputTokens: 40,
      ...(options.duplicateLlmContent
        ? { content: 'The bug is fixed and tests pass.' }
        : {}),
    }),
    span({
      traceId: 'trace-one',
      spanId: 'assistant-final',
      parentSpanId: 'root',
      name: 'message.assistant',
      kind: 'CHAIN',
      startTime: '2026-01-01T00:00:06.000Z',
      step: 5,
      content: 'The bug is fixed and tests pass.',
    }),
  ]
}

function reidentifyFixture(traceId: string) {
  return fixture().map((item) => ({
    ...item,
    trace_id: traceId,
    span_id: `${traceId}-${item.span_id}`,
    parent_span_id: item.parent_span_id ? `${traceId}-${item.parent_span_id}` : null,
  }))
}

describe('writeHodoscopeInput', () => {
  it('preserves production Codex assistant actions and their source spans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hodoscope-input-test-'))
    const otlp = join(directory, 'spans.jsonl')
    await writeFile(otlp, serializeSpans(fixture()), 'utf8')
    const prepared = await writeHodoscopeInput(otlp, { directory: join(directory, 'input') })
    expect(prepared).toMatchObject({ trajectoryCount: 1, actionCount: 3 })
    expect(prepared.sourceMap).toEqual([
      expect.objectContaining({
        traceId: 'trace-one',
        spanId: 'assistant-progress',
        turnId: 1,
      }),
      expect.objectContaining({ traceId: 'trace-one', spanId: 'tool', turnId: 2 }),
      expect.objectContaining({ traceId: 'trace-one', spanId: 'assistant-final', turnId: 4 }),
    ])
    const [file] = await readdir(join(prepared.directory, 'samples'))
    const trajectory = JSON.parse(
      await readFile(join(prepared.directory, 'samples', file!), 'utf8'),
    )
    expect(trajectory.metadata.comparison_group).toBe('candidate')
    expect(trajectory.messages[1]).toEqual({
      role: 'assistant',
      content: 'I will inspect the repository.',
    })
    expect(trajectory.messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ function: 'exec_command', arguments: { cmd: 'pnpm test' } }],
    })
    expect(trajectory.messages[3].content).toContain('STATUS: error')
    expect(trajectory.messages[4]).toEqual({
      role: 'assistant',
      content: 'The bug is fixed and tests pass.',
    })
  })

  it('does not duplicate assistant text repeated by an LLM span', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hodoscope-dedup-test-'))
    const otlp = join(directory, 'spans.jsonl')
    await writeFile(
      otlp,
      serializeSpans(fixture({ duplicateLlmContent: true })),
      'utf8',
    )

    const prepared = await writeHodoscopeInput(otlp, { directory: join(directory, 'input') })

    expect(prepared.actionCount).toBe(3)
    expect(prepared.sourceMap.map(({ spanId }) => spanId)).toEqual([
      'assistant-progress',
      'tool',
      'assistant-final',
    ])
  })

  it('rejects reuse of a non-empty explicit directory without mixing samples', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hodoscope-reuse-test-'))
    const otlp = join(directory, 'spans.jsonl')
    const input = join(directory, 'input')
    await writeFile(
      otlp,
      serializeSpans([...reidentifyFixture('trace-one'), ...reidentifyFixture('trace-two')]),
      'utf8',
    )
    await writeHodoscopeInput(otlp, { directory: input })
    const originalFiles = await readdir(join(input, 'samples'))
    expect(originalFiles).toHaveLength(2)

    await writeFile(otlp, serializeSpans(reidentifyFixture('trace-three')), 'utf8')
    await expect(writeHodoscopeInput(otlp, { directory: input })).rejects.toThrow(
      /explicit directory must be empty/,
    )
    expect(await readdir(join(input, 'samples'))).toEqual(originalFiles)
  })
})

describe('hodoscopeAnalyzer', () => {
  it('returns review candidates mapped back to exact trace spans', async () => {
    const result = await runStub('valid')
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('discovery')
    expect(result.candidates).toEqual([
      expect.objectContaining({
        engine: 'hodoscope',
        engineVersion: '0.2.4',
        status: 'needs_review',
        group: 'candidate',
        rank: 0,
        traceId: 'trace-one',
        spanId: 'assistant-progress',
        evidenceUri: 'trace://trace-one/span/assistant-progress',
      }),
      expect.objectContaining({
        engine: 'hodoscope',
        engineVersion: '0.2.4',
        status: 'needs_review',
        group: 'candidate',
        rank: 1,
        traceId: 'trace-one',
        spanId: 'tool',
        evidenceUri: 'trace://trace-one/span/tool',
      }),
      expect.objectContaining({
        engine: 'hodoscope',
        engineVersion: '0.2.4',
        status: 'needs_review',
        group: 'candidate',
        rank: 2,
        traceId: 'trace-one',
        spanId: 'assistant-final',
        evidenceUri: 'trace://trace-one/span/assistant-final',
      }),
    ])
  })

  it.each([
    ['analysis-empty-id', 'analysis.summaries[0].trajectory_id must be a non-empty string'],
    ['analysis-fractional-turn', 'analysis.summaries[0].turn_id must be a non-negative safe integer'],
    ['analysis-empty-summary', 'analysis.summaries[0].summary must be a non-empty string'],
    ['analysis-short-embedding', 'expected 3840 for 768 float32 values'],
    ['analysis-invalid-embedding', 'contains invalid RFC 1924 base85'],
    ['analysis-nonfinite-embedding', 'contains a non-finite float32 at index 0'],
    ['analysis-source-document', 'does not match requested input'],
    ['analysis-unknown-source', 'references unknown source action'],
    ['analysis-duplicate-source', 'contains duplicate source action'],
    ['sample-unknown-source', 'references unknown source action'],
    ['sample-duplicate-source', 'samples contain duplicate source action'],
    ['sample-negative-rank', '.rank must be a non-negative safe integer'],
    ['sample-rank-gap', '.rank must be 1, received 2'],
    ['sample-fractional-total', '.total must be a non-negative safe integer'],
    ['sample-total-mismatch', "group 'candidate' reports 4/3 source actions"],
    ['sample-count-mismatch', "group 'candidate' contains 2/3 requested samples"],
    ['sample-text-mismatch', 'text does not match its analysis row'],
    ['sample-metadata-mismatch', '.metadata does not match its analysis row'],
    ['sample-method-mismatch', "samples.method 'tsne' does not match requested 'pca'"],
    ['sample-size-mismatch', 'samples.n_per_group 1 does not match requested 20'],
    ['sample-missing-group', "samples are missing group 'candidate'"],
  ])('rejects untrusted %s output', async (mode, message) => {
    const result = await runStub(mode)
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(message),
    })
  })

  it('isolates concurrent runs under the same output directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hodoscope-concurrency-test-'))
    const otlp = join(directory, 'spans.jsonl')
    const stub = join(directory, 'hodoscope-stub.mjs')
    const outputDir = join(directory, 'output')
    await writeFile(otlp, serializeSpans(fixture()), 'utf8')
    await writeFile(stub, STUB, 'utf8')
    const analyzer = hodoscopeAnalyzer({
      command: process.execPath,
      commandArgs: [stub, 'valid'],
      outputDir,
    })

    const [left, right] = await Promise.all([analyzer.analyze(otlp), analyzer.analyze(otlp)])
    const leftDirectory = JSON.parse(left.output) as { directory: string }
    const rightDirectory = JSON.parse(right.output) as { directory: string }

    expect(left.ok).toBe(true)
    expect(right.ok).toBe(true)
    expect(leftDirectory.directory).not.toBe(rightDirectory.directory)
    expect(leftDirectory.directory.startsWith(outputDir)).toBe(true)
    expect(rightDirectory.directory.startsWith(outputDir)).toBe(true)
  })
})

async function runStub(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'hodoscope-analyzer-test-'))
  const otlp = join(directory, 'spans.jsonl')
  const stub = join(directory, 'hodoscope-stub.mjs')
  await writeFile(otlp, serializeSpans(fixture()), 'utf8')
  await writeFile(stub, STUB, 'utf8')
  return hodoscopeAnalyzer({
    command: process.execPath,
    commandArgs: [stub, mode],
    outputDir: join(directory, 'output'),
  }).analyze(otlp)
}

const STUB = String.raw`
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const mode = process.argv[2]
const args = process.argv.slice(3)
const output = args[args.indexOf('--output') + 1]
if (args[0] === 'analyze') {
  const files = await readdir(join(args[1], 'samples'))
  const trajectories = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(args[1], 'samples', file), 'utf8'))))
  const summaries = trajectories.flatMap((trajectory) => trajectory.messages.flatMap((message, turn_id) => message.role === 'assistant' ? [{
    trajectory_id: trajectory.id,
    turn_id,
    summary: message.source === 'tool' ? 'Runs the test command' : 'Inspects the repository',
    action_text: message.content,
    task_context: '',
    embedding: '004kL' + '00000'.repeat(767),
    metadata: trajectory.metadata,
  }] : []))
  if (mode === 'analysis-empty-id') summaries[0].trajectory_id = ' '
  if (mode === 'analysis-fractional-turn') summaries[0].turn_id = 0.5
  if (mode === 'analysis-empty-summary') summaries[0].summary = ' '
  if (mode === 'analysis-short-embedding') summaries[0].embedding = '00000'
  if (mode === 'analysis-invalid-embedding') summaries[0].embedding = ':0000' + '00000'.repeat(767)
  if (mode === 'analysis-nonfinite-embedding') summaries[0].embedding = '006*$' + '00000'.repeat(767)
  if (mode === 'analysis-unknown-source') summaries[0].trajectory_id = 'trace-other'
  if (mode === 'analysis-duplicate-source') summaries[1] = { ...summaries[0] }
  await writeFile(output, JSON.stringify({
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    source: mode === 'analysis-source-document' ? '/tmp/other-input' : args[1],
    fields: {},
    embedding_model: args[args.indexOf('--embedding-model') + 1],
    embedding_dimensionality: Number(args[args.indexOf('--embed-dim') + 1]),
    summaries,
  }))
} else {
  const analysis = JSON.parse(await readFile(args[1], 'utf8'))
  const samples = analysis.summaries.map((summary, rank) => ({ ...summary, rank }))
  if (mode === 'sample-unknown-source') samples[0].trajectory_id = 'trace-other'
  if (mode === 'sample-duplicate-source') samples[1] = { ...samples[0], rank: 1 }
  if (mode === 'sample-negative-rank') samples[0].rank = -1
  if (mode === 'sample-rank-gap') samples[1].rank = 2
  if (mode === 'sample-count-mismatch') samples.pop()
  if (mode === 'sample-text-mismatch') samples[0].summary = 'Different behavior'
  if (mode === 'sample-metadata-mismatch') samples[0].metadata = { ...samples[0].metadata, extra: true }
  const document = {
    group_by: 'comparison_group',
    method: mode === 'sample-method-mismatch' ? 'tsne' : 'pca',
    n_per_group: mode === 'sample-size-mismatch' ? 1 : 20,
    groups: mode === 'sample-missing-group' ? {} : {
      candidate: {
        total: mode === 'sample-fractional-total'
          ? 1.5
          : mode === 'sample-total-mismatch'
            ? 4
            : analysis.summaries.length,
        samples,
      },
    },
  }
  await writeFile(output, JSON.stringify(document))
}
`
