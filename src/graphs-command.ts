/** Graph ingestion and comparison over Runtime's one durable graph registry. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { graphOwner, graphRecordObject as object } from './graph-owner.js'
import { importDiscoveryRunIndex } from './graphs-discovery.js'
import { sourceCoverage } from './graph-source-coverage.js'
import { GraphSourceCache } from './graph-source-cache.js'
import { CliError, UsageError } from './commands.js'
import type { CliArgs } from './cli-selection-types.js'
import type { OtlpSpan } from './otlp.js'
import { buildSpanRunTree } from './run-span-tree.js'
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

function pullRequestEvidence(facts: readonly SessionFacts[]): Array<{ kind: string; url: string; at: string }> {
  return facts.flatMap((fact) => {
    const references = fact.pullRequests.value
    return references ? (['created', 'merged'] as const).flatMap((action) => references[action].flatMap((reference) =>
      reference.repository && reference.number && reference.url ? [{ kind: action === 'created' ? 'pr-created-command' : 'pr-merge-command', url: reference.url, at: reference.at }] : [])) : []
  })
}

function render(report: Record<string, unknown>): string {
  const number = (value: unknown, digits = 1): string => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'unknown'
  const groups = Array.isArray(report.groups) ? report.groups.map(object) : []
  const lines = [
    `${report.recordCount} graph run(s) · ${report.ingested} ingested · ${report.cached} unchanged · ${Array.isArray(report.unreadSessions) ? report.unreadSessions.length : 0} unreadable · ${report.registry}`,
    'task type       topology      delivered / known (unknown)  median merge min  wall min  tokens    human',
    ...groups.map((group) => `${String(group.taskType ?? 'unknown').padEnd(15)} ${String(group.topologyDigest ?? 'unknown').slice(0, 12).padEnd(13)} `
      + `${group.delivered}/${group.assessed} (${group.unknown}) ${typeof group.deliveredRate === 'number' ? `${(group.deliveredRate * 100).toFixed(1)}%` : 'unknown'}`.padEnd(29)
      + `${number(typeof group.medianMergeMs === 'number' ? group.medianMergeMs / 60_000 : null).padEnd(18)} ${number(typeof group.medianWallMs === 'number' ? group.medianWallMs / 60_000 : null).padEnd(9)} ${number(group.medianTokens, 0).padEnd(9)} ${number(group.medianHumanMessages)}`),
    'Ranking and denominators are computed by Runtime graph registry; unknown measurements remain unknown.',
  ]
  for (const group of groups) for (const run of Array.isArray(group.runs) ? group.runs.map(object) : []) {
    const source = object(run.source)
    lines.push(`  ${String(object(run.outcome).kind ?? 'unknown').padEnd(10)} ${source.id ?? String(run.graphDigest).slice(0, 12)} ${source.url ?? `(graph ${run.graphDigest}, task ${run.taskDigest})`}`)
  }
  return `${lines.join('\n')}\n`
}

/** The CLI supplies its maintained ref selection; this command never opens native session bytes. */
export async function cmdGraphs(args: CliArgs, readers: GraphCommandReaders): Promise<void> {
  const selected = args.discoveryIndex !== undefined || args.refs.length > 0 || args.current || args.last > 0 || args.since !== undefined
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
    const existingSources = new Set((await owner.listGraphRuns(registry)).map((record) => {
      const source = object(record.source)
      return JSON.stringify([source.kind, source.id])
    }))
    const ingest = async (facts: readonly SessionFacts[], options: Record<string, unknown>): Promise<void> => {
      const overlaps = facts.some((fact) => {
        const start = Date.parse(fact.firstRecordAt.value ?? '')
        const end = Date.parse(fact.lastRecordAt.value ?? '')
        return (bounds.since === undefined || end >= bounds.since) && (bounds.until === undefined || start < bounds.until)
      })
      if (!overlaps) return
      const observation = owner.graphFromSessionFacts!(facts, { ...options, taskType: args.taskType, evidence: [...(Array.isArray(options.evidence) ? options.evidence : []), ...pullRequestEvidence(facts)] })
      await owner.recordStoredGraphRun!(registry, observation.graph, observation.record, { preserveLabels: true })
      ingested += 1
    }
    if (args.discoveryIndex) {
      const result = await importDiscoveryRunIndex(args.discoveryIndex, { owner, registry,
        taskType: args.taskType, sinceMs: bounds.since, untilMs: bounds.until })
      ingested += result.ingested
      unread.push(...result.unread)
    }
    const named = args.selection?.sessions ?? []
    if (args.fleetRun && (named.length !== 1 || args.discoveryIndex || args.selection?.spans.length)) throw new UsageError('--fleet-run requires exactly one named native session; it binds a run ID, not a reusable lane ID')
    const found = args.discoveryIndex && args.refs.length === 0 && !args.current && !args.last ? { sessions: [], unread: [] } : named.length ? { sessions: named, unread: [] } : args.selection?.spans.length ? { sessions: [], unread: [] } : await readers.discover()
    unread.push(...found.unread)
    const parents = named.length === 0
    for (const { adapter, ref } of found.sessions) {
      const cacheKey = JSON.stringify([adapter.harness, ref.path, args.latestTurn, args.taskType, args.fleetRun, args.runtimeModule ?? 'installed', args.since, args.until, parents])
      if (seen.has(`${adapter.harness}:${ref.path}`)) continue
      if (await cache.unchanged(cacheKey, existingSources)) { cached += 1; continue }
      try {
        const readStartedAt = Date.now()
        const selection = await collectSessionSelection([{ adapter, refs: [ref] }], {
          workflow: true, parents, maxWorkflowSessions: 100, home: args.selection?.home,
          taskScope: args.latestTurn ? 'latest' : 'all', bindSources: true,
          onUnreadable: (failure) => {
            if (failure.seed && named.length) throw failure.error
            unread.push({ sessionId: failure.ref.sessionId, reason: String(failure.error) })
          },
        })
        const facts: SessionFacts[] = []
        const relationships = []
        const execution = buildSpanRunTree(selection.rows.flatMap((row) => [...row.spans]), ref.path)
        for (const row of selection.rows) {
          seen.add(`${row.adapter.harness}:${row.ref.path}`)
          facts.push(...computeSessionFacts(row.spans, { includeSubagents: true }))
          relationships.push(describeSessionRelationship(row.ref, row.spans))
        }
        const rootFact = facts.find((fact) => fact.parentSessionId === null) ?? facts[0]
        const rootRelation = relationships.find((relation) => relation.sessionId === rootFact?.sessionId)
        const nativeSourceId = `${rootFact?.sessionId ?? ref.sessionId}${args.latestTurn && rootRelation?.turnId ? `#turn=${rootRelation.turnId}` : ''}`
        const sourceId = args.fleetRun ? `${args.fleetRun}:${ref.sessionId}` : nativeSourceId
        const sourceKind = args.fleetRun ? 'fleet' : adapter.harness
        await ingest(facts, { source: { kind: sourceKind, id: sourceId, url: pathToFileURL(ref.path).href },
          relationships, complete: selection.workflow?.complete,
          issues: [...sourceCoverage(selection.rows.flatMap((row) => [...row.spans])), ...(selection.workflow?.issues ?? []),
            ...(execution.orphanSpans ? [{ kind: 'orphan-spans', count: execution.orphanSpans }] : []),
            ...(execution.nodes.length === 0 && execution.spanCount > 0 ? [{ kind: 'unplaced-span-tree' }] : [])],
          evidence: [...execution.traceIds.map((traceId) => ({ kind: 'trace-run', url: `trace://${traceId}` })),
            ...(args.fleetRun ? [{ kind: 'fleet-run', url: `fleet://${encodeURIComponent(args.fleetRun)}/session/${encodeURIComponent(ref.sessionId)}` }] : [])],
          spanRun: execution, traceRunId: execution.traceIds.length === 1 ? execution.traceIds[0] : undefined,
          observedAt: new Date().toISOString(),
        })
        if (selection.workflow?.complete !== false) await cache.remember(cacheKey, selection.rows, readStartedAt, JSON.stringify([sourceKind, sourceId]))
      } catch (error) {
        if (named.length) throw error
        unread.push({ sessionId: ref.sessionId, reason: String(error) })
      }
    }
    await cache.save()
    if (args.selection?.spans.length) {
      const input = await readers.readSpans()
      for (const traceId of new Set(input.spans.map((span) => span.trace_id))) {
        const spans = input.spans.filter((span) => span.trace_id === traceId)
        const facts = computeSessionFacts(spans, { includeSubagents: true })

        const execution = buildSpanRunTree(spans, args.refs.join(', '))
        const runtimeRunId = spans.find((span) => typeof span.attributes['traces.runtime.run_id'] === 'string')?.attributes['traces.runtime.run_id']
        await ingest(facts, { source: { kind: runtimeRunId ? 'agent-runtime' : 'otlp', id: runtimeRunId ?? traceId }, spanRun: execution, traceRunId: traceId,
          evidence: [{ kind: 'trace-run', url: `trace://${traceId}` }],
          issues: [...sourceCoverage(spans), ...(execution.orphanSpans ? [{ kind: 'orphan-spans', count: execution.orphanSpans }] : [])], observedAt: new Date().toISOString() })
      }
    }
  }
  if (!owner.graphCorpusSummary) throw new CliError(
    'Runtime public module lacks graphCorpusSummary; use --runtime-module /path/to/built/dist/kernel.js until the corpus query is published', 'setup')
  const summary = await owner.graphCorpusSummary(registry, { taskType: args.taskType, topologyDigest: args.shape })
  const report = { ...summary, registry: registry.root, ingested, cached, unreadSessions: unread,
    factScope: 'whole-session', selectionWindow: { since: args.since ?? null, until: args.until ?? null },
    accountingCutoffApplied: false, observedAt: new Date().toISOString() }
  process.stdout.write(args.format === 'json' ? `${JSON.stringify(report)}\n` : render(report))
}
