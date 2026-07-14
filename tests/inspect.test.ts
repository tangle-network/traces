import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeExecution } from '@tangle-network/agent-eval/contract'
import { afterAll, describe, expect, it } from 'vitest'
import {
  inspectSessionIndex,
  readSessionIndexFile,
  renderInspectionReport,
  writeInspectionReportFile,
  type TraceSessionIndex,
} from '../src/index.js'

const created: string[] = []

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

function fixtureIndex(): TraceSessionIndex {
  const execution = summarizeExecution({ runs: [] })
  return {
    schemaVersion: 1,
    kind: 'traces.session_index',
    generatedAt: '2026-01-01T00:00:00.000Z',
    selection: { purpose: 'inspect-test' },
    totals: {
      sessions: 2,
      spans: 250,
      llmTurns: 30,
      toolCalls: 120,
      erroredToolCalls: 30,
      inputTokens: 910_000,
      outputTokens: 210_000,
      stuckLoopSessions: 1,
      stuckLoops: 12,
      harnesses: ['codex'],
      repos: ['github.com/tangle-network/traces'],
      models: ['gpt-test'],
      tools: ['apply_patch', 'bash'],
    },
    context: {
      totals: {
        roots: 1,
        files: 4,
        instructionDocs: 1,
        evolveFiles: 2,
        jsonlRows: 5,
        invalidJsonlRows: 1,
      },
      roots: [{
        root: '/repo',
        files: [
          {
            kind: 'instruction-doc',
            path: '/repo/AGENTS.md',
            bytes: 12_000,
            mtimeMs: 1,
            lines: 180,
            markdown: { headings: 12, hasToc: false },
          },
          {
            kind: 'evolve-jsonl',
            path: '/repo/.evolve/governor.jsonl',
            bytes: 200,
            mtimeMs: 2,
            lines: 2,
            jsonlRows: 2,
            jsonl: { rows: 2, invalidRows: 1, keys: { next: 1 } },
          },
          {
            kind: 'evolve-jsonl',
            path: '/repo/.evolve/skill-runs.jsonl',
            bytes: 500,
            mtimeMs: 3,
            lines: 3,
            jsonlRows: 3,
            jsonl: { rows: 3, invalidRows: 0, keys: { skill: 3, transcriptPath: 1 } },
          },
          {
            kind: 'reflection',
            path: '/repo/.evolve/reflections/2026-01-01.md',
            bytes: 4_000,
            mtimeMs: 4,
            lines: 60,
            markdown: { headings: 8, hasToc: false },
          },
        ],
      }],
    },
    sessions: [
      {
        session: {
          harness: 'codex',
          sessionId: 'sess-loop-heavy',
          path: '/traces/sess-loop-heavy.jsonl',
          cwd: '/repo',
          mtimeMs: Date.parse('2026-01-01T00:00:00.000Z'),
        },
        repo: {
          subjectKey: 'github.com/tangle-network/traces',
          repository: 'github.com/tangle-network/traces',
          branch: 'main',
          commit: 'abc123',
          cwd: '/repo',
          resolutionSource: 'payload.cwd',
        },
        time: {
          firstSpanAt: '2026-01-01T00:00:00.000Z',
          lastSpanAt: '2026-01-01T01:00:00.000Z',
        },
        metrics: {
          spanCount: 200,
          llmTurnCount: 24,
          toolCallCount: 100,
          erroredToolCallCount: 30,
          inputTokens: 900_000,
          outputTokens: 200_000,
          toolErrorRate: 0.3,
        },
        models: ['gpt-test'],
        tools: [
          { name: 'bash', calls: 70, errors: 25 },
          { name: 'apply_patch', calls: 30, errors: 5 },
        ],
        signals: {
          stuckLoopCount: 12,
          affectedRunRatio: 0.6,
          stuckLoops: [{ toolName: 'bash', occurrences: 6 }],
          stuckLoopsOmitted: 11,
          toolErrorRate: 0.3,
        },
        execution,
      },
      {
        session: {
          harness: 'codex',
          sessionId: 'sess-missing-repo',
          path: '/traces/sess-missing-repo.jsonl',
          cwd: null,
          mtimeMs: Date.parse('2026-01-01T00:05:00.000Z'),
        },
        repo: {},
        time: {
          firstSpanAt: '2026-01-01T00:05:00.000Z',
          lastSpanAt: '2026-01-01T00:10:00.000Z',
        },
        metrics: {
          spanCount: 50,
          llmTurnCount: 6,
          toolCallCount: 20,
          erroredToolCallCount: 0,
          inputTokens: 10_000,
          outputTokens: 10_000,
          toolErrorRate: 0,
        },
        models: ['gpt-test'],
        tools: [{ name: 'bash', calls: 20, errors: 0 }],
        signals: {
          stuckLoopCount: 0,
          affectedRunRatio: 0,
          stuckLoops: [],
          stuckLoopsOmitted: 0,
          toolErrorRate: 0,
        },
        execution,
      },
    ],
  }
}

describe('session index inspection', () => {
  it('ranks improvement findings from sessions and context files', () => {
    const report = inspectSessionIndex(fixtureIndex(), { generatedAt: '2026-01-01T02:00:00.000Z' })
    const ids = report.findings.map((finding) => finding.id)

    expect(report.kind).toBe('traces.inspection_report')
    expect(report.source.sessions).toBe(2)
    expect(report.source.contextFiles).toBe(4)
    expect(report.totals.high).toBe(4)
    expect(ids.slice(0, 4)).toEqual([
      'session.tool-errors',
      'session.repeated-call-loops',
      'context.invalid-jsonl',
      'repo.missing-attribution',
    ])
    expect(ids).toContain('session.large-token-runs')
    expect(ids).toContain('context.long-docs-without-toc')
    expect(ids).toContain('context.long-narrative-docs-without-toc')
    expect(ids).toContain('context.skill-run-trace-links')

    const skillRunFinding = report.findings.find((finding) => finding.id === 'context.skill-run-trace-links')
    expect(skillRunFinding?.evidence[0]).toContain('best link key covers 1/3 row(s)')
  })

  it('renders and writes inspection reports from index JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-inspect-test-'))
    created.push(dir)
    const indexPath = join(dir, 'index.json')
    await writeFile(indexPath, `${JSON.stringify(fixtureIndex(), null, 2)}\n`, 'utf8')

    const loaded = await readSessionIndexFile(indexPath)
    const report = inspectSessionIndex(loaded, { generatedAt: '2026-01-01T02:00:00.000Z' })
    const rendered = renderInspectionReport(report)
    expect(rendered).toContain('traces inspect - 8 finding(s) from 2 session(s), 4 context file(s)')
    expect(rendered).toContain('[high] Repeated tool-call loops in 1/2 session(s)')
    expect(rendered).toContain('Next: Inspect the repeated commands')

    const outPath = await writeInspectionReportFile(report, join(dir, 'report.md'))
    expect(await readFile(outPath, 'utf8')).toBe(rendered)
  })
})
