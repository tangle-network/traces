import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildSpanRunTree,
  readRunWatchSnapshot,
  readSpanRunSnapshot,
  renderRunContextSnapshot,
  renderRunWatchSnapshot,
  renderSpanRunSnapshot,
  resolveRunWatchTarget,
  readRunContextSnapshot,
  span,
  spanRunTotals,
  watchRunTarget,
  type OtlpSpan,
} from '../src/index.js'

const execFileAsync = promisify(execFile)

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `traces-${prefix}-`))
}

interface SpawnRow {
  kind: string
  [key: string]: unknown
}

function journal(root: string, events: SpawnRow[]): string {
  const rows = [
    JSON.stringify({ kind: 'begin', root, at: '2026-07-31T10:00:00.000Z' }),
    ...events.map((event) => JSON.stringify({ kind: 'event', root, event })),
  ]
  return `${rows.join('\n')}\n`
}

function spawned(
  id: string,
  parent: string | undefined,
  label: string,
  at: string,
  budget: Record<string, number> = { maxIterations: 5, maxTokens: 1000 },
): SpawnRow {
  return { kind: 'spawned', id, ...(parent ? { parent } : {}), label, budget, runtime: 'pi', seq: 0, at }
}

function metered(id: string, input: number, output: number, usd: number | null, at: string): SpawnRow {
  return {
    kind: 'metered',
    id,
    spend: {
      iterations: 0,
      tokens: { input, output },
      usd: usd ?? 0,
      ...(usd === null ? { usdKnown: false } : {}),
      ms: 0,
    },
    seq: 0,
    at,
  }
}

function settled(
  id: string,
  status: string,
  input: number,
  output: number,
  usd: number | null,
  at: string,
): SpawnRow {
  return {
    kind: 'settled',
    id,
    status,
    spent: {
      iterations: 2,
      tokens: { input, output },
      usd: usd ?? 0,
      ...(usd === null ? { usdKnown: false } : {}),
      ms: 0,
    },
    seq: 0,
    at,
  }
}

function llmSpan(
  spanId: string,
  parentSpanId: string | null,
  agent: string,
  input: number,
  output: number,
  cost?: number,
): OtlpSpan {
  return span({
    traceId: 't1',
    spanId,
    parentSpanId,
    name: 'message.assistant',
    kind: 'LLM',
    startTime: '2026-07-31T10:00:01.000Z',
    endTime: '2026-07-31T10:00:02.000Z',
    agent,
    service: 'pi',
    inputTokens: input,
    outputTokens: output,
    ...(cost === undefined ? {} : { costUsd: cost }),
  })
}

// ---------------------------------------------------------------------------
// The general source: OTLP spans, for any emitter.
// ---------------------------------------------------------------------------

describe('buildSpanRunTree — the general OTLP source', () => {
  it('reconstructs a tree from parent_span_id alone and splits driver from child work', () => {
    const spans: OtlpSpan[] = [
      span({
        traceId: 't1',
        spanId: 'root',
        parentSpanId: null,
        name: 'session',
        kind: 'AGENT',
        startTime: '2026-07-31T10:00:00.000Z',
        endTime: '2026-07-31T10:05:00.000Z',
        agent: 'driver',
        service: 'pi',
      }),
      llmSpan('d0', 'root', 'driver', 1200, 340, 0.0042),
      span({
        traceId: 't1',
        spanId: 'tool1',
        parentSpanId: 'root',
        name: 'tool.task',
        kind: 'TOOL',
        startTime: '2026-07-31T10:00:05.000Z',
        agent: 'driver',
        service: 'pi',
        tool: 'Task',
      }),
      // No AGENT span here: only the changed agent name marks the handover, the
      // shape this repo's Claude adapter actually emits for a subagent.
      llmSpan('sub1', 'tool1', 'subagent:researcher', 40_000, 900),
    ]

    const tree = buildSpanRunTree(spans, 'fixture')
    expect(tree.nodes.map((node) => [node.label, node.depth, node.role])).toEqual([
      ['driver', 0, 'driver'],
      ['subagent:researcher', 1, 'leaf'],
    ])

    const totals = spanRunTotals(tree)
    expect(totals.driver.tokensIn).toBe(1200)
    expect(totals.leaves.tokensIn).toBe(40_000)
    // The two halves partition the run: neither hides inside the other.
    expect(totals.driver.tokensIn + totals.leaves.tokensIn).toBe(41_200)
  })

  it('places a GenAI-semconv worker by gen_ai.operation.name, not by an invented key', () => {
    const worker = span({
      traceId: 't1',
      spanId: 'gen1',
      parentSpanId: 'root',
      name: 'loop.iteration',
      kind: 'CHAIN',
      startTime: '2026-07-31T10:03:10.000Z',
      endTime: '2026-07-31T10:04:00.000Z',
    })
    worker.attributes['gen_ai.operation.name'] = 'invoke_agent'
    worker.attributes['gen_ai.agent.name'] = 'codex-worker'

    const tree = buildSpanRunTree(
      [
        span({
          traceId: 't1',
          spanId: 'root',
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-07-31T10:00:00.000Z',
          agent: 'driver',
        }),
        worker,
      ],
      'fixture',
    )
    expect(tree.nodes.map((node) => node.label)).toEqual(['driver', 'codex-worker'])
  })

  it('never renders unpriced spend as $0 and says how many turns were unpriced', () => {
    const tree = buildSpanRunTree(
      [
        span({
          traceId: 't1',
          spanId: 'root',
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-07-31T10:00:00.000Z',
          agent: 'pi',
        }),
        llmSpan('a', 'root', 'pi', 100, 20),
        llmSpan('b', 'root', 'pi', 200, 30),
      ],
      'fixture',
    )
    const rendered = renderSpanRunSnapshot(tree)
    expect(rendered).toContain('cost unknown (2 unpriced)')
    expect(rendered).not.toContain('$0.0000')
    expect(rendered).toContain('carry no cost attribute')
    // A cost the emitter never wrote is a gap in the telemetry, so the node
    // reports it as one rather than as a free turn.
    expect(tree.llmSpansWithoutCost).toBe(2)
  })

  it('re-roots a span whose parent is absent instead of dropping its spend', () => {
    const tree = buildSpanRunTree(
      [
        span({
          traceId: 't1',
          spanId: 'root',
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-07-31T10:00:00.000Z',
          agent: 'pi',
        }),
        llmSpan('orphan', 'never-written', 'detached', 10, 5),
      ],
      'fixture',
    )
    expect(tree.orphanSpans).toBe(1)
    expect(tree.nodes.map((node) => node.label)).toContain('detached')
    const totals = spanRunTotals(tree)
    expect(totals.driver.tokensIn + totals.leaves.tokensIn).toBe(10)
  })

  it('reports an authored budget as absent from spans, never as zero', () => {
    const tree = buildSpanRunTree(
      [
        span({
          traceId: 't1',
          spanId: 'root',
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-07-31T10:00:00.000Z',
          agent: 'pi',
        }),
      ],
      'fixture',
    )
    const rendered = renderSpanRunSnapshot(tree)
    expect(rendered).toContain('budget not in spans')
    expect(rendered).not.toMatch(/budget 0it/)
  })

  it('surfaces an unreadable span file as a state to display, not a crash', async () => {
    const dir = await scratch('spans-bad')
    const file = join(dir, 'broken.otlp.jsonl')
    await writeFile(file, '{"not":"a span"}\n')
    const snapshot = await readSpanRunSnapshot(file)
    expect(snapshot.readError).not.toBeNull()
    expect(renderSpanRunSnapshot(snapshot)).toContain('unreadable')
  })
})

// ---------------------------------------------------------------------------
// The specific source: agent-runtime's durable spawn journal.
// ---------------------------------------------------------------------------

describe('readRunContextSnapshot — the spawn-journal source', () => {
  it('renders arbitrary depth with the driver half separated from the child half', async () => {
    const dir = await scratch('journal-deep')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [
        spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z', {
          maxIterations: 20,
          maxTokens: 400_000,
        }),
        metered('r', 1000, 500, 0.01, '2026-07-31T10:00:10.000Z'),
        spawned('r:s0', 'r', 'mid', '2026-07-31T10:00:11.000Z'),
        spawned('r:s1', 'r', 'sibling', '2026-07-31T10:00:11.500Z'),
        spawned('r:s0:s0', 'r:s0', 'leaf', '2026-07-31T10:00:12.000Z'),
        settled('r:s0:s0', 'done', 9000, 120, null, '2026-07-31T10:00:40.000Z'),
        settled('r:s0', 'done', 12_000, 400, null, '2026-07-31T10:00:45.000Z'),
        settled('r:s1', 'done', 100, 10, 0.002, '2026-07-31T10:00:46.000Z'),
      ]),
    )

    const snapshot = await readRunContextSnapshot(dir)
    expect(snapshot.maxDepth).toBe(2)
    expect(snapshot.nodes.map((node) => [node.label, node.depth, node.role])).toEqual([
      ['root', 0, 'supervisor'],
      ['mid', 1, 'supervisor'],
      ['leaf', 2, 'worker'],
      ['sibling', 1, 'worker'],
    ])

    const rendered = renderRunContextSnapshot(snapshot)
    // The decisive question in three real runs: which half spent the budget.
    expect(rendered).toContain('driver    1 turn(s) · in 1,000 · out 500 · $0.0100')
    expect(rendered).toContain('children  2 settled · in 12,100 · out 410 · $0.0020 + 1 unpriced')
    // `mid` has a sibling below it, so its own subtree keeps a continuing
    // column — the difference between a readable tree and an ambiguous indent.
    expect(rendered).toMatch(/├─ ✓ mid/)
    expect(rendered).toMatch(/│ {2}└─ ✓ leaf/)
    expect(rendered).toMatch(/└─ ✓ sibling/)
  })

  it('reports a $0 price paid on real tokens as ambiguous rather than free', async () => {
    const dir = await scratch('journal-zero')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [
        spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z'),
        metered('r', 10_000, 400, 0, '2026-07-31T10:00:10.000Z'),
      ]),
    )
    const rendered = renderRunContextSnapshot(await readRunContextSnapshot(dir))
    expect(rendered).toContain('(zero across 1 priced)')
    expect(rendered).toContain('rather than unmetered')
  })

  it('surfaces a blocking question with its full text the moment it appears', async () => {
    const dir = await scratch('journal-question')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')]),
    )
    await writeFile(
      join(dir, 'coordination-log.jsonl'),
      `${JSON.stringify({
        version: 1,
        runId: 'r',
        source: 'worker',
        record: {
          seq: 0,
          at: 1_785_484_820_000,
          event: {
            type: 'question',
            question: {
              id: 'q1',
              from: 'r:s0',
              question: 'The target path is outside my workspace. Should I create it?',
              reason: 'Writing outside the workspace could clobber a sibling run.',
              urgency: 'blocks-run',
              status: 'open',
              openedAt: 1_785_484_820_000,
            },
          },
        },
      })}\n`,
    )
    const snapshot = await readRunContextSnapshot(dir)
    expect(snapshot.questions[0]?.blocking).toBe(true)
    const rendered = renderRunContextSnapshot(snapshot)
    expect(rendered).toContain('⚠ BLOCKING from r:s0 [open]')
    expect(rendered).toContain('Should I create it?')
    expect(rendered).toContain('why: Writing outside the workspace')
  })

  it('names the typed result reason and the driver error on a terminal run', async () => {
    const dir = await scratch('journal-result')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')]),
    )
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({
        kind: 'error',
        reason: 'driver-failed',
        error: { name: 'BudgetError', message: 'the driver exhausted its iteration budget' },
      }),
    )
    const snapshot = await readRunContextSnapshot(dir)
    expect(snapshot.terminal).toBe(true)
    const rendered = renderRunContextSnapshot(snapshot)
    expect(rendered).toContain('RESULT error · driver-failed')
    expect(rendered).toContain('driver error (BudgetError):')
    expect(rendered).toContain('exhausted its iteration budget')
  })

  it('tolerates a half-written last line rather than reporting corruption every poll', async () => {
    const dir = await scratch('journal-partial')
    const complete = journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')])
    await writeFile(join(dir, 'spawn-journal.jsonl'), `${complete}{"kind":"event","root":"r","ev`)
    const snapshot = await readRunContextSnapshot(dir)
    expect(snapshot.invalidJournalRows).toBe(0)
    expect(snapshot.partialTail).toBe(true)
    expect(renderRunContextSnapshot(snapshot)).toContain('ends mid-line')
  })
})

// ---------------------------------------------------------------------------
// The two together.
// ---------------------------------------------------------------------------

describe('traces watch <target>', () => {
  it('reads both sources for one run and labels which number came from which', async () => {
    const dir = await scratch('both')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [
        spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z'),
        metered('r', 1000, 500, 0.01, '2026-07-31T10:00:10.000Z'),
      ]),
    )
    await writeFile(
      join(dir, 'traces.otlp.jsonl'),
      `${[
        span({
          traceId: 't1',
          spanId: 'root',
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-07-31T10:00:00.000Z',
          agent: 'pi',
        }),
        llmSpan('a', 'root', 'pi', 1000, 500, 0.01),
      ]
        .map((s) => JSON.stringify(s))
        .join('\n')}\n`,
    )

    const target = await resolveRunWatchTarget(dir)
    expect(target.runDir).toBe(dir)
    expect(target.spanFiles).toHaveLength(1)

    const rendered = renderRunWatchSnapshot(await readRunWatchSnapshot(target))
    expect(rendered).toContain('authored budget, settled spend, settlement status (authoritative)')
    expect(rendered).toContain('tree shape and per-turn detail')
    // Both sections are present and separately attributed; neither is merged
    // into the other's column.
    expect(rendered).toContain('run r')
    expect(rendered).toContain('spans ')
  })

  it('says what is unavailable when only one source exists', async () => {
    const dir = await scratch('spans-only')
    await writeFile(
      join(dir, 'run.otlp.jsonl'),
      `${JSON.stringify(
        span({
          traceId: 't1',
          spanId: 'root',
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-07-31T10:00:00.000Z',
          agent: 'pi',
        }),
      )}\n`,
    )
    const rendered = renderRunWatchSnapshot(await readRunWatchSnapshot(await resolveRunWatchTarget(dir)))
    expect(rendered).toContain('budget and settlement are UNAVAILABLE, not zero')
  })

  it('names both things it looked for when a directory holds neither', async () => {
    const dir = await scratch('empty')
    await expect(resolveRunWatchTarget(dir)).rejects.toThrow(/spawn-journal\.jsonl/)
    await expect(resolveRunWatchTarget(dir)).rejects.toThrow(/otlp\.jsonl/)
  })

  it('--once writes exactly one snapshot and returns without polling', async () => {
    const dir = await scratch('once')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')]),
    )
    const written: string[] = []
    const snapshot = await watchRunTarget(await resolveRunWatchTarget(dir), {
      once: true,
      write: (text) => written.push(text),
    })
    expect(written).toHaveLength(1)
    expect(snapshot.journal?.nodes).toHaveLength(1)
  })

  it('stops tailing when result.json lands and prints only on change', async () => {
    const dir = await scratch('tail')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')]),
    )
    await writeFile(join(dir, 'result.json'), JSON.stringify({ kind: 'winner', reason: 'accepted' }))
    const written: string[] = []
    await watchRunTarget(await resolveRunWatchTarget(dir), {
      intervalMs: 5,
      write: (text) => written.push(text),
    })
    // Terminal on the first read: one block, then the loop returns.
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('RESULT winner · accepted')
  })

  it('an aborted tail returns instead of spinning', async () => {
    const dir = await scratch('abort')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')]),
    )
    const controller = new AbortController()
    const written: string[] = []
    const pending = watchRunTarget(await resolveRunWatchTarget(dir), {
      intervalMs: 5,
      write: (text) => written.push(text),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)
    const snapshot = await pending
    expect(snapshot.journal?.present).toBe(true)
    expect(written.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The CLI surface, run as a real process.
// ---------------------------------------------------------------------------

describe('traces watch CLI', () => {
  it('prints one snapshot for a run directory and exits 0', async () => {
    const dir = await scratch('cli-once')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [
        spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z'),
        metered('r', 1000, 500, 0.01, '2026-07-31T10:00:10.000Z'),
        spawned('r:s0', 'r', 'worker', '2026-07-31T10:00:11.000Z'),
        settled('r:s0', 'done', 9000, 120, null, '2026-07-31T10:00:40.000Z'),
      ]),
    )
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'watch', dir, '--once'],
      { cwd: process.cwd(), timeout: 60_000 },
    )
    expect(stdout).toContain('driver    1 turn(s)')
    expect(stdout).toContain('children  1 settled')
    expect(stdout).toContain('cost unknown (1 unpriced)')
  })

  it('exits non-zero when the run ended with a driver error', async () => {
    const dir = await scratch('cli-error')
    await writeFile(
      join(dir, 'spawn-journal.jsonl'),
      journal('r', [spawned('r', undefined, 'root', '2026-07-31T10:00:01.000Z')]),
    )
    await writeFile(
      join(dir, 'result.json'),
      JSON.stringify({ kind: 'error', reason: 'driver-failed', error: { name: 'E', message: 'boom' } }),
    )
    // A terminal run that ended badly must not look like a success to a script.
    await expect(
      execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch', dir, '--once'], {
        cwd: process.cwd(),
        timeout: 60_000,
      }),
    ).rejects.toMatchObject({ code: 1 })
  })
})
