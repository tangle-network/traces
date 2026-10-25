/** The user's selected Discovery source: the maintained run index/catalog, once. */
import { sourceCoverage } from './graph-source-coverage.js'
import { readRuntimeRunSpans } from './adapters/runtime-run.js'
import { buildSpanRunTree } from './run-span-tree.js'
import { computeSessionFacts } from './session-facts.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError } from './commands.js'
import { graphRecordObject as object, type GraphOwner, type Registry } from './graph-owner.js'
import { readJsonlLines } from './jsonl.js'

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

/** Import honest partial containers; the index records no node identities or topology. */
export async function importDiscoveryRunIndex(path: string, options: {
  readonly owner: GraphOwner
  readonly registry: Registry
  readonly taskType?: string
  readonly sinceMs?: number
  readonly untilMs?: number
}): Promise<{ ingested: number; unread: readonly unknown[] }> {
  const { owner, registry } = options
  if (!owner.graphDigest || !owner.taskShapeDigest || !owner.recordStoredGraphRun) {
    throw new CliError('Runtime public module lacks observed graph persistence; select its built public kernel with --runtime-module', 'setup')
  }
  const unread: unknown[] = []
  let ingested = 0
  for await (const line of readJsonlLines<unknown>(path, { mode: 'recover', onCorruption: (receipt) => {
    unread.push({ source: path, line: receipt.lineNumber, reason: 'invalid Discovery index row' })
  } })) {
    const row = object(line.value)
    if (typeof row.runId !== 'string' || row.runId.length === 0) continue // The committed index header.
    const startedAt = timestamp(row.startedAt) ?? timestamp(row.registeredAt)
    if (!startedAt) {
      unread.push({ runId: row.runId, reason: 'Discovery index has no recorded start or registration timestamp' })
      continue
    }
    const settledAt = timestamp(row.settledAt)
    if (options.sinceMs !== undefined && settledAt && Date.parse(settledAt) < options.sinceMs) continue
    if (options.untilMs !== undefined && Date.parse(startedAt) >= options.untilMs) continue
    const location = object(row.location)
    const evidence = { kind: 'discovery-run-index', url: `${pathToFileURL(resolve(path)).href}#line=${line.lineNumber}` }
    if (location.kind === 'dir' && typeof location.path === 'string' && owner.graphFromSessionFacts) {
      try {
        const input = await readRuntimeRunSpans(location.path, row.runId)
        if (input.spans.length > 0) {
          const execution = buildSpanRunTree(input.spans, location.path)
          const observation = owner.graphFromSessionFacts(computeSessionFacts(input.spans, { includeSubagents: true }), {
            source: { kind: 'discovery', id: row.runId, url: pathToFileURL(resolve(location.path)).href },
            taskType: options.taskType, spanRun: execution, traceRunId: execution.traceIds.length === 1 ? execution.traceIds[0] : undefined,
            observedAt: new Date().toISOString(), evidence: [evidence], complete: false,
            issues: [...sourceCoverage(input.spans), ...input.unknowns.map((reason) => ({ kind: 'source-coverage', reason }))],
          })
          await owner.recordStoredGraphRun(registry, observation.graph, observation.record, { preserveLabels: true })
          ingested += 1
          continue
        }
        unread.push({ runId: row.runId, reasons: input.unknowns })
      } catch { unread.push({ runId: row.runId, reason: 'Runtime owner could not read the catalog run directory' }) }
    }
    const content = { observed: true, nodes: [], edges: [], deliverable: {} }
    const digest = owner.graphDigest(content)
    const finishedAt = timestamp(row.settledAt)
    const unknowns = [
      'topology unavailable from run index', 'node identities unavailable from run index',
      'tokens, traversals and human messages unavailable from run index',
      `Discovery operational state ${typeof row.state === 'string' ? row.state : 'unknown'} is not independent software delivery evidence`,
    ]
    if (!timestamp(row.startedAt)) unknowns.push('task execution start unavailable; startedAt is recorded registration time')
    const record = {
      graphDigest: digest,
      taskDigest: owner.taskShapeDigest({ source: 'discovery', taskType: options.taskType ?? 'unknown',
        ...(typeof row.program === 'string' ? { program: row.program } : {}),
        ...(typeof row.play === 'string' ? { play: row.play } : {}) }),
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      outcome: { kind: 'unknown', reason: 'Discovery run index does not establish PR merge or served-release delivery' },
      cost: {}, source: { kind: 'discovery', id: row.runId, url: evidence.url },
      ...(options.taskType ? { taskType: options.taskType } : {}),
      evidence: [evidence], unknowns,
    }
    await owner.recordStoredGraphRun(registry, { ...content, digest }, record, { preserveLabels: true })
    ingested += 1
  }
  return { ingested, unread }
}
