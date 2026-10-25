/** Workflow lifecycle metadata joins existing transcript nodes; never script text. */
import { ATTR, SOURCE_MISSING_CHANNELS_ATTR } from '../attributes.js'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readJsonl } from '../jsonl.js'
import { isMissingPathError } from '../json.js'
import { span, type OtlpSpan } from '../otlp.js'
import { SUBSTITUTED_FIELDS_ATTR } from '../otlp-input.js'
import { SUBAGENT_SPAN_ATTR } from './provenance.js'
import type { WorkflowRunBinding } from './claude-workflow.js'

type Row = Record<string, unknown>
const KINDS = new Set(['started', 'launched', 'result', 'failed'])
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
function instant(row: Row): string | undefined {
  for (const field of ['timestamp', 'ts', 'time', 'createdAt']) {
    const value = row[field]
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  }
  return undefined
}

export async function workflowJournalPaths(directories: readonly string[]): Promise<string[]> {
  const files: string[] = []
  for (const directory of directories) {
    const path = join(directory, 'journal.jsonl')
    try { if ((await stat(path)).isFile()) files.push(path) } catch (error) { if (!isMissingPathError(error)) throw error }
  }
  return files
}

/** Enrich exact native agent anchors; emit calls only where no transcript exists. */
export async function appendClaudeWorkflowJournals(options: {
  readonly directories: readonly string[]
  readonly bindings: ReadonlyMap<string, readonly WorkflowRunBinding[]>
  readonly toolSpans: ReadonlyMap<string, OtlpSpan>
  readonly traceId: string
  readonly spans: OtlpSpan[]
}): Promise<void> {
  const unknowns: string[] = []
  let invalidRows = 0
  for (const path of await workflowJournalPaths(options.directories)) {
    const runId = basename(dirname(path))
    const bindings = [...options.bindings.values()].flat().filter((binding) => binding.runId === runId)
    const parents = [...new Set(bindings.map((binding) => options.toolSpans.get(binding.toolUseId)?.span_id).filter((id): id is string => !!id))]
    if (parents.length !== 1) { unknowns.push('Workflow journal has no unique recorded parent tool binding'); continue }
    const rows: Row[] = []
    for await (const row of readJsonl<unknown>(path, { mode: 'recover', onCorruption: () => { invalidRows += 1; unknowns.push('Workflow journal has an invalid row') } })) {
      if (row && typeof row === 'object' && !Array.isArray(row) && KINDS.has(String((row as Row).type))) rows.push({ ...(row as Row), kind: (row as Row).type })
    }
    const agentByKey = new Map<string, Set<string>>()
    for (const row of rows) {
      const key = text(row.key), id = text(row.agentId)
      if (key && id) { const ids = agentByKey.get(key) ?? new Set<string>(); ids.add(id); agentByKey.set(key, ids) }
    }
    const agents = new Map<string, Row[]>()
    const phases = new Map<string, Row[]>()
    for (const row of rows) {
      const byKey = text(row.key) ? agentByKey.get(text(row.key)!) : undefined
      const agent = text(row.agentId) ?? (byKey?.size === 1 ? [...byKey][0] : undefined)
      if (agent) { const events = agents.get(agent) ?? []; events.push(row); agents.set(agent, events) }
      // A phase lifecycle without an agent is distinct from a phase name on
      // an agent call. The latter establishes association, not phase clocks.
      else if (text(row.phase) && text(row.key)) { const events = phases.get(text(row.key)!) ?? []; events.push(row); phases.set(text(row.key)!, events) }
      else unknowns.push('Workflow journal event has no unambiguous agent or phase identity')
    }
    for (const [key, events, isAgent] of [...[...agents].map(([key, events]) => [key, events, true] as const), ...[...phases].map(([key, events]) => [key, events, false] as const)]) {
      const start = events.filter((row) => row.kind === 'started' || row.kind === 'launched').map(instant).find((value) => !!value)
      const end = [...events].reverse().filter((row) => row.kind === 'result' || row.kind === 'failed').map(instant).find((value) => !!value)
      if (!start || (end && Date.parse(end) < Date.parse(start))) { unknowns.push('Workflow lifecycle lacks a valid recorded start/end interval'); continue }
      const phaseNames = [...new Set(events.map((row) => text(row.phase)).filter((value): value is string => !!value))]
      const anchors = isAgent ? options.spans.filter((item) => item.attributes['traces.claude.subagent_agent_id'] === key
        && String(item.attributes['traces.claude.subagent_transcript'] ?? '').split(/[\\/]/).includes(runId)) : []
      const metadata = { 'traces.workflow.run_id': runId, 'traces.workflow.lifecycle_key': key,
        ...(phaseNames.length === 1 ? { 'traces.workflow.phase': phaseNames[0] } : {}) }
      if (anchors.length === 1) { Object.assign(anchors[0]!.attributes, metadata); continue }
      if (anchors.length > 1) { unknowns.push('Workflow agent ID has multiple native transcript anchors'); continue }
      options.spans.push(span({ traceId: options.traceId, spanId: `workflow:${runId}:${isAgent ? 'agent' : 'phase'}:${key}`,
        parentSpanId: parents[0], name: isAgent ? 'workflow.agent' : 'workflow.phase', kind: isAgent ? 'AGENT' : 'CHAIN',
        startTime: start, ...(end ? { endTime: end } : {}), status: events.some((row) => row.kind === 'failed') ? 'ERROR' : 'UNSET',
        service: 'claude-code', extra: { ...metadata, 'agent.parent.confidence': 'explicit', [SOURCE_MISSING_CHANNELS_ATTR]: JSON.stringify(['human-turns', 'tool-calls']), [SUBAGENT_SPAN_ATTR]: true,
          ...(!end ? { [SUBSTITUTED_FIELDS_ATTR]: 'end_time' } : {}) } }))
    }
    if (agents.size > 0 && phases.size === 0) unknowns.push('Workflow agent phase associations have no separate recorded phase lifecycle; phase timings remain unknown')
    unknowns.push('Workflow journal lifecycle does not establish complete tool coverage, provider usage or software delivery')
  }
  if (invalidRows && options.spans[0]) options.spans[0].attributes[ATTR.CORRUPTION_COUNT] = Number(options.spans[0].attributes[ATTR.CORRUPTION_COUNT] ?? 0) + invalidRows
  if (unknowns.length && options.spans[0]) options.spans[0].attributes['traces.source.unknowns'] = JSON.stringify([...new Set(unknowns)])
}
