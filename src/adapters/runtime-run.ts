/** Runtime run directories reuse the maintained supervisor journal reader. */
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { ATTR, SOURCE_MISSING_CHANNELS_ATTR, SESSION_TOTAL_INPUT_ATTR, SESSION_TOTAL_OUTPUT_ATTR } from '../attributes.js'
import { span, type OtlpSpan } from '../otlp.js'
import { SUBSTITUTED_FIELDS_ATTR } from '../otlp-input.js'

export async function readRuntimeRunSpans(runDir: string, expectedRunId?: string): Promise<{
  spans: OtlpSpan[]; unknowns: string[]
}> {
  const { readRunContextSnapshot } = await import('../supervisor-run-context.js')
  const snapshot = await readRunContextSnapshot(runDir)
  const unknowns = [
    'Runtime parent relationships establish containment, not delegation.',
    'Journal driver usage is retained once per node; child-inclusive settlement totals are excluded.',
    'Human messages, tool calls and workflow phases are unavailable from the supervisor journal.',
  ]
  if (!snapshot.present) return { spans: [], unknowns: ['Runtime supervisor journal unavailable at catalog location'] }
  if (snapshot.treeError) return { spans: [], unknowns: ['Runtime supervisor journal could not be folded by its owner'] }
  if (snapshot.runId && expectedRunId && snapshot.runId !== expectedRunId) return { spans: [], unknowns: ['Catalog run ID disagrees with Runtime journal root'] }
  if (snapshot.invalidJournalRows || snapshot.partialTail || snapshot.retiredWaitRows) {
    unknowns.push(`Journal coverage: ${snapshot.invalidJournalRows} invalid rows, ${snapshot.retiredWaitRows} retired wait rows, partial tail ${snapshot.partialTail}`)
  }
  const runId = snapshot.runId ?? expectedRunId
  if (!runId) return { spans: [], unknowns: ['Runtime journal has no recorded run identity'] }
  const traceId = deriveHexId(`runtime-supervisor:${runId}`, 16)
  const spans: OtlpSpan[] = []
  for (const node of snapshot.nodes) {
    const start = node.spawnedAt ?? (node.parent === null ? snapshot.begunAt : null)
    if (start === null) {
      unknowns.push('A journal node has no recorded spawn/begin timestamp and is unplaced')
      continue
    }
    const own = node.driver
    const end = node.settledAt !== null && node.settledAt >= start ? node.settledAt : null
    // SpendRoll fills absent channels with zero; positive channels alone prove
    // measurement here. A missing/zero channel stays unknown, never free usage.
    const input = own.records > 0 && own.tokensIn > 0 ? own.tokensIn : undefined
    const output = own.records > 0 && own.tokensOut > 0 ? own.tokensOut : undefined
    if (input === undefined || output === undefined) unknowns.push('A node lacks positive evidence for both input/output usage channels')
    spans.push(span({
      traceId, spanId: deriveHexId(`${traceId}:${node.id}`, 8),
      parentSpanId: node.parent ? deriveHexId(`${traceId}:${node.parent}`, 8) : null,
      name: 'runtime.agent', kind: 'AGENT', startTime: new Date(start).toISOString(),
      ...(end !== null ? { endTime: new Date(end).toISOString() } : {}),
      status: node.status === 'failed' ? 'ERROR' : 'UNSET',
      service: 'agent-runtime',
      extra: {
        'traces.runtime.node_id': node.id, [ATTR.HARNESS]: node.runtime ?? 'agent-runtime',
        'traces.runtime.run_id': runId, [SOURCE_MISSING_CHANNELS_ATTR]: JSON.stringify(['human-turns', 'tool-calls', 'cache-read', 'cache-write']), 'agent.parent.confidence': 'explicit',
        ...(input !== undefined ? { [SESSION_TOTAL_INPUT_ATTR]: input } : {}),
        ...(output !== undefined ? { [SESSION_TOTAL_OUTPUT_ATTR]: output } : {}),
        ...(end === null ? { [SUBSTITUTED_FIELDS_ATTR]: 'end_time' } : {}),
      },
    }))
  }
  if (spans[0]) Object.assign(spans[0].attributes, { [ATTR.CORRUPTION_COUNT]: snapshot.invalidJournalRows, 'traces.source.partial_tail': snapshot.partialTail, 'traces.source.unknowns': JSON.stringify([...new Set(unknowns)]) })
  return { spans, unknowns: [...new Set(unknowns)] }
}

/** A named parent directory uses the existing run locator, with a finite bound. */
export async function readRuntimeRunDirectory(path: string): Promise<OtlpSpan[]> {
  const { findSupervisorRunDirs, isRuntimeSupervisorRunDir } = await import('@tangle-network/agent-eval/supervisor-run')
  const directories = await isRuntimeSupervisorRunDir(path) ? [path] : await findSupervisorRunDirs(path)
  const spans: OtlpSpan[] = []
  for (const directory of directories.slice(0, 100)) {
    const input = await readRuntimeRunSpans(directory)
    spans.push(...input.spans)
  }
  if (directories.length > 100 && spans[0]) {
    const value = spans[0].attributes['traces.source.unknowns']
    const reasons = typeof value === 'string' ? JSON.parse(value) as string[] : []
    spans[0].attributes['traces.source.unknowns'] = JSON.stringify([...reasons, `${directories.length - 100} run directories exceed the 100-run read bound`])
  }
  if (spans.length === 0) throw new Error('No readable Runtime supervisor journal nodes with recorded timing were found')
  return spans
}
