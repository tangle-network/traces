import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExecutionReport } from '@tangle-network/agent-eval/contract'
import {
  buildPolicyEvidenceRecord,
  type BuildPolicyEvidenceOptions,
  type PolicyEvidenceRecord,
} from './evidence.js'
import { type ScanOptions, scanSessions } from './session-source.js'
import type { OtlpSpan } from './otlp.js'
import type { SessionRef } from './types.js'

export interface TraceSessionIndexRow {
  readonly session: PolicyEvidenceRecord['session']
  readonly repo: PolicyEvidenceRecord['repo']
  readonly time: {
    readonly firstSpanAt: string | null
    readonly lastSpanAt: string | null
  }
  readonly metrics: {
    readonly spanCount: number
    readonly llmTurnCount: number
    readonly toolCallCount: number
    readonly erroredToolCallCount: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly toolErrorRate: number
  }
  readonly models: readonly string[]
  readonly tools: PolicyEvidenceRecord['metrics']['tools']
  readonly signals: PolicyEvidenceRecord['signals']
  readonly execution: ExecutionReport
}

export interface TraceIndexedFile {
  readonly kind: 'instruction-doc' | 'evolve-jsonl' | 'evolve-json' | 'reflection' | 'handoff' | 'other'
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
  readonly lines?: number
  readonly jsonlRows?: number
  readonly markdown?: {
    readonly headings: number
    readonly hasToc: boolean
  }
  readonly jsonl?: {
    readonly rows: number
    readonly invalidRows: number
    readonly keys: Record<string, number>
  }
}

export interface TraceContextRoot {
  readonly root: string
  readonly files: readonly TraceIndexedFile[]
}

export interface TraceContextIndex {
  readonly totals: {
    readonly roots: number
    readonly files: number
    readonly instructionDocs: number
    readonly evolveFiles: number
    readonly jsonlRows: number
    readonly invalidJsonlRows: number
  }
  readonly roots: readonly TraceContextRoot[]
}

export interface TraceSessionIndex {
  readonly schemaVersion: 1
  readonly kind: 'traces.session_index'
  readonly generatedAt: string
  readonly selection?: Record<string, unknown>
  readonly totals: {
    readonly sessions: number
    readonly spans: number
    readonly llmTurns: number
    readonly toolCalls: number
    readonly erroredToolCalls: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly stuckLoopSessions: number
    readonly stuckLoops: number
    readonly harnesses: readonly string[]
    readonly repos: readonly string[]
    readonly models: readonly string[]
    readonly tools: readonly string[]
  }
  readonly context?: TraceContextIndex
  readonly sessions: readonly TraceSessionIndexRow[]
}

export interface BuildSessionIndexOptions extends Pick<BuildPolicyEvidenceOptions, 'generatedAt' | 'minLoopOccurrences'> {
  readonly selection?: Record<string, unknown>
  /** Index nearby local docs/artifacts for joins. Defaults to true in scan paths. */
  readonly includeContext?: boolean
}

export interface CollectSessionIndexOptions extends ScanOptions, BuildSessionIndexOptions {}

function indexRow(record: PolicyEvidenceRecord): TraceSessionIndexRow {
  return {
    session: record.session,
    repo: record.repo,
    time: {
      firstSpanAt: record.metrics.firstSpanAt,
      lastSpanAt: record.metrics.lastSpanAt,
    },
    metrics: {
      spanCount: record.metrics.spanCount,
      llmTurnCount: record.metrics.llmTurnCount,
      toolCallCount: record.metrics.toolCallCount,
      erroredToolCallCount: record.metrics.erroredToolCallCount,
      inputTokens: record.metrics.inputTokens,
      outputTokens: record.metrics.outputTokens,
      toolErrorRate: record.signals.toolErrorRate,
    },
    models: record.metrics.models,
    tools: record.metrics.tools,
    signals: record.signals,
    execution: record.execution,
  }
}

function uniqueSorted(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))].sort()
}

export function buildSessionIndex(
  records: readonly PolicyEvidenceRecord[],
  opts: BuildSessionIndexOptions & { context?: TraceContextIndex } = {},
): TraceSessionIndex {
  const sessions = records.map(indexRow)
  return {
    schemaVersion: 1,
    kind: 'traces.session_index',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    ...(opts.selection ? { selection: opts.selection } : {}),
    totals: {
      sessions: sessions.length,
      spans: sessions.reduce((sum, row) => sum + row.metrics.spanCount, 0),
      llmTurns: sessions.reduce((sum, row) => sum + row.metrics.llmTurnCount, 0),
      toolCalls: sessions.reduce((sum, row) => sum + row.metrics.toolCallCount, 0),
      erroredToolCalls: sessions.reduce((sum, row) => sum + row.metrics.erroredToolCallCount, 0),
      inputTokens: sessions.reduce((sum, row) => sum + row.metrics.inputTokens, 0),
      outputTokens: sessions.reduce((sum, row) => sum + row.metrics.outputTokens, 0),
      stuckLoopSessions: sessions.filter((row) => row.signals.stuckLoopCount > 0).length,
      stuckLoops: sessions.reduce((sum, row) => sum + row.signals.stuckLoopCount, 0),
      harnesses: uniqueSorted(sessions.map((row) => row.session.harness)),
      repos: uniqueSorted(sessions.map((row) => row.repo.subjectKey ?? row.repo.repository ?? row.repo.cwd ?? row.session.cwd ?? undefined)),
      models: uniqueSorted(sessions.flatMap((row) => row.models)),
      tools: uniqueSorted(sessions.flatMap((row) => row.tools.map((tool) => tool.name))),
    },
    ...(opts.context ? { context: opts.context } : {}),
    sessions,
  }
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean((await pathStat(path))?.isFile())
}

async function dirExists(path: string): Promise<boolean> {
  return Boolean((await pathStat(path))?.isDirectory())
}

async function findContextRoot(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null
  let current = cwd
  const s = await pathStat(current)
  if (!s) return null
  if (!s.isDirectory()) current = dirname(current)

  for (;;) {
    if (
      (await pathStat(join(current, '.git'))) ||
      (await dirExists(join(current, '.evolve'))) ||
      (await fileExists(join(current, 'AGENTS.md'))) ||
      (await fileExists(join(current, 'CLAUDE.md')))
    ) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return s.isDirectory() ? cwd : dirname(cwd)
    current = parent
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

function summarizeMarkdown(text: string): TraceIndexedFile['markdown'] {
  const lines = text.split('\n')
  return {
    headings: lines.filter((line) => /^#{1,6}\s+\S/.test(line)).length,
    hasToc: /\btable of contents\b/i.test(text) || /^\s*-\s+\[[^\]]+\]\(#[^)]+\)/m.test(text),
  }
}

function summarizeJsonl(text: string): NonNullable<TraceIndexedFile['jsonl']> {
  const keys: Record<string, number> = {}
  let rows = 0
  let invalidRows = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    rows += 1
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of Object.keys(parsed)) keys[key] = (keys[key] ?? 0) + 1
      }
    } catch {
      invalidRows += 1
    }
  }
  return { rows, invalidRows, keys: Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b))) }
}

async function summarizeFile(path: string, kind: TraceIndexedFile['kind']): Promise<TraceIndexedFile | null> {
  const s = await pathStat(path)
  if (!s?.isFile()) return null
  const base: TraceIndexedFile = { kind, path, bytes: Number(s.size), mtimeMs: Number(s.mtimeMs) }

  if (!path.endsWith('.md') && !path.endsWith('.jsonl')) return base
  try {
    const text = await readFile(path, 'utf8')
    const lines = countLines(text)
    const jsonl = path.endsWith('.jsonl') ? summarizeJsonl(text) : undefined
    return {
      ...base,
      lines,
      ...(path.endsWith('.md') ? { markdown: summarizeMarkdown(text) } : {}),
      ...(jsonl ? { jsonlRows: jsonl.rows, jsonl } : {}),
    }
  } catch {
    return base
  }
}

async function walkMarkdown(root: string, kind: TraceIndexedFile['kind'], maxFiles = 100): Promise<TraceIndexedFile[]> {
  const out: TraceIndexedFile[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const summary = await summarizeFile(path, kind)
        if (summary) out.push(summary)
      }
    }
  }
  await walk(root)
  return out
}

async function collectContextRoot(root: string): Promise<TraceContextRoot> {
  const files: TraceIndexedFile[] = []
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const summary = await summarizeFile(join(root, name), 'instruction-doc')
    if (summary) files.push(summary)
  }

  const evolve = join(root, '.evolve')
  for (const name of ['skill-runs.jsonl', 'governor.jsonl', 'experiments.jsonl']) {
    const summary = await summarizeFile(join(evolve, name), 'evolve-jsonl')
    if (summary) files.push(summary)
  }
  for (const name of ['scorecard.json']) {
    const summary = await summarizeFile(join(evolve, name), 'evolve-json')
    if (summary) files.push(summary)
  }
  files.push(...(await walkMarkdown(join(evolve, 'reflections'), 'reflection')))
  files.push(...(await walkMarkdown(join(evolve, 'handoffs'), 'handoff')))

  return { root, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

async function collectContextIndex(records: readonly PolicyEvidenceRecord[]): Promise<TraceContextIndex> {
  const rootSet = new Set<string>()
  for (const record of records) {
    const root = await findContextRoot(record.repo.cwd ?? record.session.cwd)
    if (root) rootSet.add(root)
  }

  const roots = await Promise.all([...rootSet].sort().map(collectContextRoot))
  const files = roots.flatMap((root) => root.files)
  return {
    totals: {
      roots: roots.length,
      files: files.length,
      instructionDocs: files.filter((file) => file.kind === 'instruction-doc').length,
      evolveFiles: files.filter((file) => file.kind.startsWith('evolve-')).length,
      jsonlRows: files.reduce((sum, file) => sum + (file.jsonlRows ?? 0), 0),
      invalidJsonlRows: files.reduce((sum, file) => sum + (file.jsonl?.invalidRows ?? 0), 0),
    },
    roots,
  }
}

export async function buildSessionIndexFromRows(
  rows: readonly { ref: SessionRef; spans: readonly OtlpSpan[] }[],
  opts: BuildSessionIndexOptions = {},
): Promise<TraceSessionIndex> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const records = await Promise.all(rows.map((row) =>
    buildPolicyEvidenceRecord(row.ref, row.spans, {
      generatedAt,
      minLoopOccurrences: opts.minLoopOccurrences,
    }),
  ))
  const context = opts.includeContext === false ? undefined : await collectContextIndex(records)
  return buildSessionIndex(records, { ...opts, generatedAt, context })
}

export async function collectSessionIndex(opts: CollectSessionIndexOptions = {}): Promise<TraceSessionIndex> {
  const rows: Array<{ ref: SessionRef; spans: readonly OtlpSpan[] }> = []
  for await (const session of scanSessions(opts)) {
    rows.push({ ref: session.ref, spans: session.spans })
  }
  return buildSessionIndexFromRows(rows, opts)
}

export function serializeSessionIndex(index: TraceSessionIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`
}

export async function writeSessionIndexFile(index: TraceSessionIndex, outPath?: string): Promise<string> {
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-index-')), 'session-index.json')
  await writeFile(path, serializeSessionIndex(index), 'utf8')
  return path
}
