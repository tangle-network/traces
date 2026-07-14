import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  collectSessionIndex,
  serializeSessionIndex,
  span,
  type HarnessTraceAdapter,
  type OtlpSpan,
  type SessionRef,
} from '../src/index.js'

const created: string[] = []

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

const ref: SessionRef = {
  harness: 'synthetic',
  sessionId: 'sess-index',
  path: '/tmp/sess-index.jsonl',
  cwd: null,
  mtimeMs: Date.parse('2026-01-01T00:00:00.000Z'),
}

function indexSpans(cwd = '/work/traces'): OtlpSpan[] {
  const repo = {
    'tangle.subject.key': 'github.com/tangle-network/traces',
    'git.repository': 'github.com/tangle-network/traces',
    'git.branch': 'main',
    'git.commit': 'abc123',
    'tangle.cwd': cwd,
    'traces.repo_resolution_source': 'span-path',
  }
  return [
    span({
      traceId: 'sess-index',
      spanId: 'root',
      name: 'session',
      kind: 'AGENT',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:04.000Z',
      service: 'synthetic',
      extra: repo,
    }),
    span({
      traceId: 'sess-index',
      spanId: 'llm-1',
      parentSpanId: 'root',
      name: 'llm.turn',
      kind: 'LLM',
      startTime: '2026-01-01T00:00:01.000Z',
      service: 'synthetic',
      model: 'gpt-test',
      inputTokens: 100,
      outputTokens: 25,
      extra: repo,
    }),
    ...[1, 2, 3].map((i) =>
      span({
        traceId: 'sess-index',
        spanId: `tool-${i}`,
        parentSpanId: 'llm-1',
        name: 'tool.bash',
        kind: 'TOOL',
        startTime: `2026-01-01T00:00:0${i + 1}.000Z`,
        service: 'synthetic',
        tool: 'bash',
        status: i === 3 ? 'ERROR' : 'OK',
        extra: { ...repo, 'input.value': 'pnpm test' },
      })),
  ]
}

describe('session index', () => {
  it('builds a general reusable session catalog over scanned sessions', async () => {
    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [ref]
      },
      async parse() {
        return indexSpans()
      },
    }

    const index = await collectSessionIndex({
      adapters: [adapter],
      generatedAt: '2026-01-01T00:00:10.000Z',
      minLoopOccurrences: 3,
      selection: { purpose: 'test' },
    })

    expect(index.kind).toBe('traces.session_index')
    expect(index.generatedAt).toBe('2026-01-01T00:00:10.000Z')
    expect(index.selection).toEqual({ purpose: 'test' })
    expect(index.totals.sessions).toBe(1)
    expect(index.totals.spans).toBe(5)
    expect(index.totals.toolCalls).toBe(3)
    expect(index.totals.erroredToolCalls).toBe(1)
    expect(index.totals.stuckLoopSessions).toBe(1)
    expect(index.totals.repos).toEqual(['github.com/tangle-network/traces'])
    expect(index.totals.models).toEqual(['gpt-test@otlp'])
    expect(index.totals.tools).toEqual(['bash'])

    const row = index.sessions[0]!
    expect(row.session.cwd).toBe('/work/traces')
    expect(row.repo.resolutionSource).toBe('span-path')
    expect(row.metrics.toolErrorRate).toBe(1 / 3)
    expect(row.tools).toEqual([{ name: 'bash', calls: 3, errors: 1 }])
    expect(row.signals.stuckLoopCount).toBe(1)
    expect(JSON.parse(serializeSessionIndex(index)).kind).toBe('traces.session_index')
  })

  it('indexes nearby local context files without interpreting one workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traces-index-context-'))
    created.push(root)
    await mkdir(join(root, '.evolve', 'reflections'), { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '# Agents\n\n## Contents\n\n- [Rules](#rules)\n\n## Rules\n\nUse tests.\n', 'utf8')
    await writeFile(join(root, '.evolve', 'skill-runs.jsonl'), '{"skill":"/evolve","verdict":"pass"}\n{"skill":"/verify"}\nnot-json\n', 'utf8')
    await writeFile(join(root, '.evolve', 'governor.jsonl'), '{"next":"verify"}\n', 'utf8')
    await writeFile(join(root, '.evolve', 'reflections', 'r.md'), '# Reflection\n\nNext: verify.\n', 'utf8')

    const adapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [{ ...ref, sessionId: 'sess-context', cwd: root }]
      },
      async parse() {
        return indexSpans(root)
      },
    }

    const index = await collectSessionIndex({
      adapters: [adapter],
      generatedAt: '2026-01-01T00:00:10.000Z',
    })

    expect(index.context?.totals.roots).toBe(1)
    expect(index.context?.totals.instructionDocs).toBe(1)
    expect(index.context?.totals.evolveFiles).toBe(2)
    expect(index.context?.totals.jsonlRows).toBe(4)
    expect(index.context?.totals.invalidJsonlRows).toBe(1)
    expect(index.context?.roots[0]?.files.map((file) => file.kind).sort()).toEqual([
      'evolve-jsonl',
      'evolve-jsonl',
      'instruction-doc',
      'reflection',
    ])
    const agents = index.context?.roots[0]?.files.find((file) => file.path.endsWith('AGENTS.md'))
    expect(agents?.markdown).toEqual({ headings: 3, hasToc: true })
    const skillRuns = index.context?.roots[0]?.files.find((file) => file.path.endsWith('skill-runs.jsonl'))
    expect(skillRuns?.jsonl).toEqual({
      rows: 3,
      invalidRows: 1,
      keys: { skill: 2, verdict: 1 },
    })
  })
})
