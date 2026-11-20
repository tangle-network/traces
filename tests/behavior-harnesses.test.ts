import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveHexId, resolveSpanKind } from '@tangle-network/agent-trace-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { behaviorFromSpans, type BehaviorResult } from '../src/behavior.js'
import { exportTraceEvidenceFile } from '../src/file-export.js'
import { readOtlpInput, type OtlpInput } from '../src/otlp-input.js'
import { span, writeOtlpFile, type OtlpSpan } from '../src/otlp.js'
import { listAdapters, resolveAdapter } from '../src/registry.js'
import { parseSession } from '../src/session-source.js'
import type { SessionRef } from '../src/types.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CONTRACT_SESSIONS = join(dirname(fileURLToPath(import.meta.url)), 'contracts-corpus', 'sessions')
const PARENT = '01a1adf8-1ee5-76e3-b687-b8f3a93dc9dc'
const CHILD = '01a1adfb-472d-7c51-b3ea-e009327df975'
const ROOT = 'magnetar-rust-sandbox-20261101e'
const S2 = `${ROOT}:s2`
const LOOPER = `${ROOT}:s2:s0`

interface Recording {
  readonly name: string
  readonly harness: string
  readonly sessionId: string
  readonly path: string
  /** Counted from the native records, independently of conversion or behavior(). */
  readonly rawToolCalls: number
}

const recording = (
  name: string,
  harness: string,
  sessionId: string,
  path: string,
  rawToolCalls: number,
): Recording => ({ name, harness, sessionId, path, rawToolCalls })

// Raw tool_use IDs in the six recorded Claude sessions: 1 + 1 + 2 + 2 + 2 + 2.
const CLAUDE_RECORDINGS = [
  recording('Claude Bash refund', 'claude-code', '0c04a660-cf17-40a1-abfe-672f882f766e', join(CONTRACT_SESSIONS, '0c04a660-cf17-40a1-abfe-672f882f766e.jsonl'), 1),
  recording('Claude Read refund', 'claude-code', 'be7a34a2-129b-4f06-ba07-85c69b6ba709', join(CONTRACT_SESSIONS, 'be7a34a2-129b-4f06-ba07-85c69b6ba709.jsonl'), 1),
  recording('Claude retry without key', 'claude-code', '9e760d11-5f49-4977-a578-807ca28c62f8', join(CONTRACT_SESSIONS, 'retry-keys0.jsonl'), 2),
  recording('Claude retry with key', 'claude-code', 'bbee6300-d989-4990-a532-87c3e71ade2c', join(CONTRACT_SESSIONS, 'retry-keys1.jsonl'), 2),
  recording('Claude in-stream subagent', 'claude-code', 'fb3c3af2-db4a-4f91-b5eb-ccb122a74769', join(CONTRACT_SESSIONS, 'subagent.jsonl'), 2),
  recording('Claude strict tools', 'claude-code', '170ce69e-7b58-48b2-b1d1-f2dbd94daae1', join(CONTRACT_SESSIONS, 'tools-strict.jsonl'), 2),
] as const

const RECORDINGS: readonly Recording[] = [
  ...CLAUDE_RECORDINGS,
  recording('Native Factory', 'factory', 'factory-example', join(FIXTURES, 'native-tools/factory/factory-example.jsonl'), 1),
  recording('Native Grok', 'grok', 'grok-example', join(FIXTURES, 'native-tools/grok/grok-example/updates.jsonl'), 1),
  recording('Native Pi', 'pi', 'pi-example', join(FIXTURES, 'native-tools/pi/pi-example.jsonl'), 1),
  recording('Kimi v1 wire', 'kimi', 'kimi-v1', join(FIXTURES, 'native-tools/kimi/kimi-v1/wire.jsonl'), 1),
  recording('Kimi v2 wire', 'kimi', 'kimi-v2', join(FIXTURES, 'native-tools/kimi/kimi-v2/wire.jsonl'), 1),
  recording('OpenCode SQLite store', 'opencode', 'ses_opencodeexample', join(FIXTURES, 'native-tools/opencode/opencode.sql'), 2),
  recording('Claude reentry', 'claude-code', 'origin-reemission', join(FIXTURES, 'claude-origin-reemission', 'origin-reemission.jsonl'), 1),
  recording('Codex parent', 'codex', PARENT, join(FIXTURES, 'codex-fork-child', 'parent.jsonl'), 2),
  recording('Codex inherited fork', 'codex', CHILD, join(FIXTURES, 'codex-fork-child', 'child.jsonl'), 3),
  recording('Sandbox Codex stream', 'codex-exec', '01a11f47-635a-77c1-bc39-9f09d3898731', join(FIXTURES, 'sandbox-live-stream', 'codex-director-in-progress.jsonl'), 6),
]

const EVIDENCE_RECORDINGS: readonly Recording[] = [
  recording('Sandbox OpenCode stream', 'opencode', 'retained-session-fixture-opencode', join(FIXTURES, 'sandbox-live-stream', 'opencode-tool-calls.jsonl'), 6),
]
const ALL_RECORDINGS = [...RECORDINGS, ...EVIDENCE_RECORDINGS]

const isActualTool = (item: OtlpSpan): boolean =>
  resolveSpanKind(item) === 'TOOL' && item.attributes['traces.span.synthesized'] !== true && item.attributes['traces.session.inherited'] !== true
const toolCount = (spans: readonly OtlpSpan[]): number => spans.filter(isActualTool).length
const behaviorCalls = (result: BehaviorResult): number => result.nodes.reduce((sum, node) => sum + node.tool_calls, 0)
const nodeSummary = (result: BehaviorResult): unknown => result.nodes.map((node) => ({
  id: node.id,
  parent: node.parent,
  depth: node.depth,
  tool_calls: node.tool_calls,
  harness: node.harness,
})).sort((a, b) => a.id.localeCompare(b.id))

async function refFor(rec: Recording, temp: string): Promise<SessionRef> {
  let path = rec.path
  if (path.endsWith('.sql')) {
    path = join(temp, 'opencode.db')
    const db = new DatabaseSync(path)
    try { db.exec(await readFile(rec.path, 'utf8')) } finally { db.close() }
  }
  return { harness: rec.harness, sessionId: rec.sessionId, path, cwd: null, mtimeMs: 0 }
}

describe('recorded harness behavior coverage', () => {
  const converted = new Map<string, OtlpSpan[]>()
  let existing: OtlpInput
  let replayDir: string | undefined

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'traces-behavior-harnesses-'))
    for (const rec of RECORDINGS) {
      const adapter = resolveAdapter(rec.harness)
      expect(adapter, rec.harness).toBeDefined()
      converted.set(rec.name, await parseSession(adapter!, await refFor(rec, replayDir)))
    }
    for (const rec of EVIDENCE_RECORDINGS) {
      converted.set(rec.name, (await exportTraceEvidenceFile(rec.path)).spans)
    }
    existing = await readOtlpInput(join(FIXTURES, 'behavior'))
    const otlp = join(replayDir, 'otlp')
    await mkdir(otlp, { recursive: true })
    for (const [index, rec] of ALL_RECORDINGS.entries()) {
      await writeOtlpFile(converted.get(rec.name)!, join(otlp, `${String(index).padStart(2, '0')}-${rec.harness}.jsonl`))
    }
    for (const name of ['root.otlp.jsonl', 's2.otlp.jsonl', 's2-s0.otlp.jsonl']) {
      await copyFile(join(FIXTURES, 'behavior', name), join(otlp, name))
    }
  })

  afterAll(async () => {
    if (replayDir) await rm(replayDir, { recursive: true, force: true })
  })

  it('has a positive native recording for every registered adapter', () => {
    expect(new Set(RECORDINGS.filter((rec) => rec.rawToolCalls > 0).map((rec) => rec.harness)))
      .toEqual(new Set(listAdapters().map((adapter) => adapter.harness)))
  })

  it.each(RECORDINGS)('$name preserves its $rawToolCalls native tool calls through the maintained registry', (rec) => {
    expect(toolCount(converted.get(rec.name)!)).toBe(rec.rawToolCalls)
  })

  it.each(EVIDENCE_RECORDINGS)('$name preserves its $rawToolCalls native tool calls through public evidence ingestion', (rec) => {
    expect(toolCount(converted.get(rec.name)!)).toBe(rec.rawToolCalls)
  })

  it('keeps a recorded Claude child under its parent, one Agent call and one child Read call', () => {
    const spans = converted.get('Claude in-stream subagent')!
    const result = behaviorFromSpans(spans)
    const sameSession = spans.map((span) => ({ ...span, attributes: { ...span.attributes, 'session.id': 'outer' } }))
    expect(behaviorFromSpans(sameSession).nodes.map((node) => [node.depth, node.tool_calls]).sort())
      .toEqual([[0, 1], [1, 1]])
    expect(result.nodes).toHaveLength(2)
    expect(behaviorCalls(result)).toBe(2)
    const parent = result.nodes.find((node) => node.parent === null)!
    const child = result.nodes.find((node) => node.parent !== null)!
    expect(parent.tool_calls).toBe(1)
    expect(child).toMatchObject({ parent: parent.id, depth: 1, tool_calls: 1 })
  })

  it('keeps the recorded Codex fork under its parent and excludes its inherited spawn call', () => {
    const result = behaviorFromSpans([
      ...converted.get('Codex parent')!,
      ...converted.get('Codex inherited fork')!,
    ])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.find((node) => node.id === PARENT)).toMatchObject({ parent: null, depth: 0, tool_calls: 2 })
    expect(result.nodes.find((node) => node.id === CHILD)).toMatchObject({ parent: PARENT, depth: 1, tool_calls: 3 })
  })

  it('mixes session.id producers with native identities and span trees without losing calls or parentage', async () => {
    // The three recorded Runtime actors made 356, 204, and 178 calls.
    const expectedCalls = 356 + 204 + 178 + ALL_RECORDINGS.reduce((sum, rec) => sum + rec.rawToolCalls, 0)
    const spans = [...existing.spans, ...ALL_RECORDINGS.flatMap((rec) => converted.get(rec.name)!)]
    const direct = behaviorFromSpans(spans)
    expect(behaviorCalls(direct)).toBe(expectedCalls)
    expect(direct.nodes.find((node) => node.id === ROOT)?.tool_calls).toBe(356)
    expect(direct.nodes.find((node) => node.id === S2)).toMatchObject({ parent: ROOT, tool_calls: 204 })
    expect(direct.nodes.find((node) => node.id === LOOPER)).toMatchObject({ parent: S2, tool_calls: 178 })
    for (const rec of ALL_RECORDINGS.filter((item) => item.name !== 'Claude in-stream subagent')) {
      expect(direct.nodes.find((node) => node.id === rec.sessionId), rec.name).toMatchObject({ tool_calls: rec.rawToolCalls })
    }

    const reversed = behaviorFromSpans([...spans].reverse())
    expect(nodeSummary(reversed)).toEqual(nodeSummary(direct))
    expect(behaviorCalls(reversed)).toBe(expectedCalls)

    const replayInput = await readOtlpInput(replayDir!)
    const replayed = behaviorFromSpans(replayInput.spans)
    expect(behaviorCalls(replayed)).toBe(expectedCalls)
    expect(nodeSummary(replayed)).toEqual(nodeSummary(direct))
  })
})

const TRACE = deriveHexId('behavior-mixed-annotations', 16)
const id = (name: string): string => deriveHexId(name, 8)
const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()

function contractSpan(
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  name: string,
  kind: 'AGENT' | 'TOOL',
  second: number,
  extra: Record<string, unknown> = {},
): OtlpSpan {
  return span({
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTime: at(second),
    endTime: at(second + 1),
    service: 'contract-recording',
    ...(kind === 'TOOL' ? { tool: name } : {}),
    extra,
  })
}

function mixedTopologySpans(): OtlpSpan[] {
  const rootId = id('mixed-root')
  const annotatedId = id('annotated-child')
  const grandchildId = id('unannotated-grandchild')
  const unannotatedId = id('unannotated-child')
  const unavailableId = id('unavailable-worker')
  return [
    contractSpan(TRACE, rootId, null, 'session', 'AGENT', 0, { 'tangle.node.id': 'root', 'session.id': 'root', 'agent.name': 'root' }),
    // The common contract's TOOL kind is sufficient; none of these names has a tool. prefix.
    contractSpan(TRACE, id('root-call'), rootId, 'Read', 'TOOL', 1),
    contractSpan(TRACE, annotatedId, rootId, 'worker-b', 'AGENT', 2, { 'traces.session.id': 'worker-b', 'agent.name': 'worker-b' }),
    contractSpan(TRACE, id('annotated-call'), annotatedId, 'Shell', 'TOOL', 3),
    contractSpan(TRACE, grandchildId, annotatedId, 'grandchild', 'AGENT', 4, { 'agent.name': 'grandchild' }),
    contractSpan(TRACE, id('grandchild-call'), grandchildId, 'Read', 'TOOL', 5),
    contractSpan(TRACE, unannotatedId, rootId, 'worker-c', 'AGENT', 6, { 'agent.name': 'worker-c' }),
    contractSpan(TRACE, id('unannotated-call'), unannotatedId, 'Grep', 'TOOL', 7),
    contractSpan(TRACE, unavailableId, rootId, 'unavailable-worker', 'AGENT', 8, { 'agent.name': 'unavailable-worker' }),
  ]
}

describe('behavior topology boundaries', () => {
  it('attributes mixed annotated and unannotated descendants, unprefixed TOOL calls, and an unavailable worker', () => {
    const result = behaviorFromSpans(mixedTopologySpans())
    expect(result.nodes).toHaveLength(5)
    expect(behaviorCalls(result)).toBe(4)
    expect(result.nodes.find((node) => node.id === 'root')).toMatchObject({ parent: null, depth: 0, tool_calls: 1 })
    expect(result.nodes.find((node) => node.id === 'worker-b')).toMatchObject({ parent: 'root', depth: 1, tool_calls: 1 })
    expect(result.nodes.find((node) => node.id === `${TRACE}/${id('unannotated-grandchild')}`)).toMatchObject({ parent: 'worker-b', depth: 2, tool_calls: 1 })
    expect(result.nodes.find((node) => node.id === `${TRACE}/${id('unannotated-child')}`)).toMatchObject({ parent: 'root', depth: 1, tool_calls: 1 })
    expect(result.nodes.find((node) => node.id === `${TRACE}/${id('unavailable-worker')}`)).toMatchObject({ parent: 'root', depth: 1, tool_calls: 0 })
  })

  it('keeps an enclosing conversation ID on a tool from reversing the worker relationship', () => {
    const rows = mixedTopologySpans().map((span) => span.span_id === id('unannotated-call')
      ? { ...span, attributes: { ...span.attributes, 'session.id': 'root' } } : span)
    const result = behaviorFromSpans(rows)
    expect(result.nodes.find((node) => node.id === 'root')).toMatchObject({ parent: null, tool_calls: 1 })
    expect(result.nodes.find((node) => node.label === 'worker-c')).toMatchObject({ parent: 'root', tool_calls: 1 })
  })

  it('scopes a reused local span id to its own trace', () => {
    const spans = [TRACE, deriveHexId('behavior-other-trace', 16)].flatMap((traceId) => {
      const rootId = id('reused-root')
      return [
        contractSpan(traceId, rootId, null, 'session', 'AGENT', 0),
        contractSpan(traceId, id('reused-call'), rootId, 'Read', 'TOOL', 1),
      ]
    })
    const result = behaviorFromSpans(spans)
    expect(result.nodes).toHaveLength(2)
    expect(behaviorCalls(result)).toBe(2)
    for (const traceId of new Set(spans.map((item) => item.trace_id))) {
      expect(result.nodes.find((node) => node.id === `${traceId}/${id('reused-root')}`)).toMatchObject({ parent: null, depth: 0, tool_calls: 1 })
    }
  })

  it('collapses duplicate and overlapping inputs without changing calls or parentage', async () => {
    const spans = mixedTopologySpans()
    const direct = behaviorFromSpans([...spans, ...spans])
    expect(direct.run.spans).toBe(spans.length)
    expect(behaviorCalls(direct)).toBe(4)
    expect(nodeSummary(direct)).toEqual(nodeSummary(behaviorFromSpans(spans)))

    const dir = await mkdtemp(join(tmpdir(), 'traces-behavior-overlap-'))
    try {
      await writeOtlpFile(spans, join(dir, 'full.otlp.jsonl'))
      await writeOtlpFile(spans.slice(0, 4), join(dir, 'overlap.otlp.jsonl'))
      const input = await readOtlpInput(dir)
      expect(input.spans).toHaveLength(spans.length)
      expect(input.files.reduce((sum, file) => sum + file.repeats, 0)).toBe(4)
      const replayed = behaviorFromSpans(input.spans)
      expect(behaviorCalls(replayed)).toBe(4)
      expect(nodeSummary(replayed)).toEqual(nodeSummary(direct))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
