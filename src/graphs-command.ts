/** Graph ingestion and comparison over Runtime's one durable graph registry. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GraphSourceCache } from './graph-source-cache.js'
import { CliError, UsageError } from './commands.js'
import type { CliArgs } from './cli-selection-types.js'
import type { OtlpSpan } from './otlp.js'
import { collectSessionSelection } from './session-selection.js'
import { computeSessionFacts, type SessionFacts, type UnreadSessionFact } from './session-facts.js'
import { describeSessionRelationship } from './session-relationship.js'
import { parseTimeBound } from './time.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

interface GraphCommandReaders {
  discover(): Promise<{
    sessions: ReadonlyArray<{ adapter: HarnessTraceAdapter; ref: SessionRef }>
    unread: readonly UnreadSessionFact[]
  }>
  readSpans(): Promise<{ spans: readonly OtlpSpan[] }>
}

type OwnerRow = Readonly<Record<string, unknown>>
type Registry = { readonly root: string }
interface GraphOwner {
  graphRegistry(root: string): Registry
  listGraphRuns(registry: Registry): Promise<OwnerRow[]>
  loadGraph(registry: Registry, digest: string): Promise<unknown | undefined>
  graphFromSessionFacts?: (facts: readonly SessionFacts[], options: Record<string, unknown>) => {
    graph: unknown; record: OwnerRow
  }
  recordStoredGraphRun?: (registry: Registry, graph: unknown, record: OwnerRow) => Promise<unknown>
}

async function graphOwner(moduleRef?: string): Promise<GraphOwner> {
  const module = moduleRef === undefined ? '@tangle-network/agent-runtime/kernel'
    : moduleRef.startsWith('file:') ? moduleRef
      : isAbsolute(moduleRef) || moduleRef.startsWith('.') ? pathToFileURL(resolve(moduleRef)).href : moduleRef
  let owner: Record<string, unknown>
  try { owner = await import(module) as Record<string, unknown> } catch (error) {
    throw new CliError(`cannot load Runtime public module ${module}: ${String(error)}`, 'setup')
  }
  for (const name of ['graphRegistry', 'listGraphRuns', 'loadGraph']) {
    if (typeof owner[name] !== 'function') throw new CliError(
      `Runtime public module lacks ${name}; install a Runtime release with graph registry exports, or pass --runtime-module /path/to/dist/kernel.js`, 'setup')
  }
  return owner as unknown as GraphOwner
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function field(record: OwnerRow, name: string): unknown { return object(record)[name] }
function scalar(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null }
function cost(record: OwnerRow, name: string): number | null {
  const value = object(record.cost)[name]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function median(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (known.length === 0) return null
  const middle = Math.floor(known.length / 2)
  return known.length % 2 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2
}

function summarize(records: readonly OwnerRow[]) {
  const groups = new Map<string, OwnerRow[]>()
  for (const record of records) {
    const key = JSON.stringify([scalar(field(record, 'taskType')), scalar(field(record, 'topologyDigest')) ?? record.graphDigest])
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  return [...groups.values()].map((runs) => {
    const delivered = runs.filter((run) => object(run.outcome).kind === 'delivered').length
    const known = runs.filter((run) => ['delivered', 'no-winner'].includes(String(object(run.outcome).kind))).length
    return {
      taskType: scalar(field(runs[0]!, 'taskType')),
      topologyDigest: scalar(field(runs[0]!, 'topologyDigest')),
      runs: runs.length, delivered, known, unknown: runs.length - known,
      deliveredRate: known === 0 ? null : delivered / known,
      medianMergeMinutes: median(runs.map((run) => cost(run, 'mergeMs') === null ? null : cost(run, 'mergeMs')! / 60_000)),
      medianWallMinutes: median(runs.map((run) => cost(run, 'ms') === null ? null : cost(run, 'ms')! / 60_000)),
      medianTokens: median(runs.map((run) => cost(run, 'tokens'))),
      medianHumanMessages: median(runs.map((run) => cost(run, 'humanMessages'))),
      runLinks: runs.map((run) => {
        const source = object(field(run, 'source'))
        return { id: scalar(source.id), url: scalar(source.url), graphDigest: run.graphDigest,
          taskDigest: run.taskDigest, outcome: object(run.outcome).kind, unknowns: field(run, 'unknowns') ?? [] }
      }),
    }
  }).sort((a, b) => (b.deliveredRate ?? -1) - (a.deliveredRate ?? -1)
    || (a.medianWallMinutes ?? Infinity) - (b.medianWallMinutes ?? Infinity)
    || (a.medianTokens ?? Infinity) - (b.medianTokens ?? Infinity)
    || (a.medianHumanMessages ?? Infinity) - (b.medianHumanMessages ?? Infinity)
    || String(a.taskType).localeCompare(String(b.taskType))
    || String(a.topologyDigest).localeCompare(String(b.topologyDigest)))
}

function render(report: { registry: string; ingested: number; cached: number; records: number; unreadSessions: readonly unknown[]; groups: ReturnType<typeof summarize> }): string {
  const number = (value: number | null, digits = 1): string => value === null ? 'unknown' : value.toFixed(digits)
  const lines = [
    `${report.records} graph run(s) · ${report.ingested} ingested · ${report.cached} unchanged · ${report.unreadSessions.length} unreadable · ${report.registry}`,
    'task type       topology      delivered / known (unknown)  median merge min  wall min  tokens    human',
    ...report.groups.map((group) => `${(group.taskType ?? 'unknown').padEnd(15)} ${(group.topologyDigest?.slice(0, 12) ?? 'unknown').padEnd(13)} `
      + `${group.delivered}/${group.known} (${group.unknown}) ${group.deliveredRate === null ? 'unknown' : `${(group.deliveredRate * 100).toFixed(1)}%`}`.padEnd(29)
      + `${number(group.medianMergeMinutes).padEnd(18)} ${number(group.medianWallMinutes).padEnd(9)} ${number(group.medianTokens, 0).padEnd(9)} ${number(group.medianHumanMessages)}`),
    'Ranking: delivered rate among known outcomes, then wall minutes, tokens, human messages. Unknown outcomes excluded from rate.',
  ]
  for (const group of report.groups) for (const link of group.runLinks) {
    lines.push(`  ${String(link.outcome).padEnd(10)} ${link.id ?? String(link.graphDigest).slice(0, 12)} ${link.url ?? `(graph ${link.graphDigest}, task ${link.taskDigest})`}`)
  }
  return `${lines.join('\n')}\n`
}

/** The CLI supplies its maintained ref selection; this command never opens native session bytes. */
export async function cmdGraphs(args: CliArgs, readers: GraphCommandReaders): Promise<void> {
  const selected = args.refs.length > 0 || args.current || args.last > 0 || args.since !== undefined
  if (args.registry && selected && !args.out) throw new UsageError('ingesting into a registry requires --out DIR; --registry DIR selects an existing registry to query')
  const root = args.out ?? args.registry ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'traces', 'graphs')
  const bounds = { since: args.since ? parseTimeBound(args.since, '--since') : undefined, until: args.until ? parseTimeBound(args.until, '--until') : undefined }
  if (bounds.since !== undefined && bounds.until !== undefined && bounds.since >= bounds.until) throw new UsageError('--since must precede --until')
  const owner = await graphOwner(args.runtimeModule)
  const registry = owner.graphRegistry(resolve(root))
  const unread: unknown[] = []
  let ingested = 0
  let cached = 0
  if (selected) {
    if (!owner.graphFromSessionFacts || !owner.recordStoredGraphRun) throw new CliError(
      'Runtime public module lacks graph corpus ingestion; use --runtime-module /path/to/built/dist/kernel.js until the corpus API is published', 'setup')
    const seen = new Set<string>()
    const cache = await GraphSourceCache.load(registry.root)
    const ingest = async (facts: readonly SessionFacts[], options: Record<string, unknown>): Promise<void> => {
      const selectedFacts = facts.filter((fact) => {
        const start = Date.parse(fact.firstRecordAt.value ?? '')
        const end = Date.parse(fact.lastRecordAt.value ?? '')
        return (!bounds.since || end >= bounds.since) && (!bounds.until || start < bounds.until)
      })
      if (selectedFacts.length === 0) return
      const observation = owner.graphFromSessionFacts!(selectedFacts, { ...options, taskType: args.taskType })
      await owner.recordStoredGraphRun!(registry, observation.graph, observation.record)
      ingested += 1
    }
    const named = args.selection?.sessions ?? []
    const found = named.length ? { sessions: named, unread: [] } : args.selection?.spans.length ? { sessions: [], unread: [] } : await readers.discover()
    unread.push(...found.unread)
    for (const { adapter, ref } of found.sessions) {
      const cacheKey = JSON.stringify([adapter.harness, ref.path, args.latestTurn, args.taskType, args.runtimeModule ?? 'installed', args.since, args.until])
      if (seen.has(`${adapter.harness}:${ref.sessionId}`)) continue
      if (await cache.unchanged(cacheKey)) { cached += 1; continue }
      try {
        const readStartedAt = Date.now()
        const selection = await collectSessionSelection([{ adapter, refs: [ref] }], {
          workflow: true, parents: named.length === 0, maxWorkflowSessions: 100, home: args.selection?.home,
          taskScope: args.latestTurn ? 'latest' : 'all',
          onUnreadable: (failure) => {
            if (failure.seed && named.length) throw failure.error
            unread.push({ sessionId: failure.ref.sessionId, reason: String(failure.error) })
          },
        })
        const facts: SessionFacts[] = []
        const relationships = []
        for (const row of selection.rows) {
          seen.add(`${row.adapter.harness}:${row.ref.sessionId}`)
          facts.push(...computeSessionFacts(row.spans, { includeSubagents: true }))
          relationships.push(describeSessionRelationship(row.ref, row.spans))
        }
        const rootFact = facts.find((fact) => fact.parentSessionId === null) ?? facts[0]
        await ingest(facts, { source: { kind: adapter.harness, id: rootFact?.sessionId ?? ref.sessionId, url: pathToFileURL(ref.path).href },
          relationships, complete: selection.workflow?.complete, issues: selection.workflow?.issues })
        if (selection.workflow?.complete !== false) await cache.remember(cacheKey, selection.rows, readStartedAt)
      } catch (error) {
        if (named.length) throw error
        unread.push({ sessionId: ref.sessionId, reason: String(error) })
      }
    }
    await cache.save()
    if (args.selection?.spans.length) {
      const input = await readers.readSpans()
      const facts = computeSessionFacts(input.spans, { includeSubagents: true })
      for (const fact of facts) await ingest([fact], { source: { kind: 'otlp', id: fact.sessionId ?? fact.traceId } })
    }
  }
  const records = (await owner.listGraphRuns(registry)).filter((record) =>
    (!args.taskType || field(record, 'taskType') === args.taskType)
    && (!args.shape || record.taskDigest === args.shape || field(record, 'topologyDigest') === args.shape))
  const report = { registry: registry.root, ingested, cached, records: records.length, unreadSessions: unread, groups: summarize(records) }
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(report)}\n` : render(report))
}
