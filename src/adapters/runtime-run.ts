import { exactCount } from '../spend-roll.js'
/** A Runtime node's records come from its bound capture, retained spans or own journal meter. */
import { join } from 'node:path'
import { readSessionInput } from '@tangle-network/harness-sessions'
import { FileResultBlobStore, captureBoundHarnessTranscript, contentAddress, harnessTranscriptArtifact, materializeTreeView, readSpawnJournal, type HarnessTranscriptArtifact, type HarnessTranscriptBinding, type HarnessTranscriptEvidence, type SpawnEvent } from '@tangle-network/agent-runtime/kernel'
import { HarnessSessionsAdapter } from './harness-sessions.js'
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { ATTR, RUNTIME_INPUT_FLOOR_ATTR, RUNTIME_OUTPUT_FLOOR_ATTR, SOURCE_MISSING_CHANNELS_ATTR, SESSION_TOTAL_INPUT_ATTR, SESSION_TOTAL_OUTPUT_ATTR, sessionIdFromAttributes } from '../attributes.js'
import { span, type OtlpSpan } from '../otlp.js'
import { SUBSTITUTED_FIELDS_ATTR, type OtlpInput } from '../otlp-input.js'
import { readConsistentOtlpInput } from '../otlp-measurement.js'
import { spanKey } from '../span-identity.js'

export async function readRuntimeRunSpans(runDir: string, expectedRunId?: string): Promise<{
  spans: OtlpSpan[]; unknowns: string[]; retained?: OtlpInput
}> {
  const { selected, unbound, materialized, meteredSessions } = await readRuntimeCaptures(runDir, expectedRunId)
  const retained = await readConsistentOtlpInput(runDir, { allowEmptyDirectory: true })
  // Preserve the raw OTLP integrity report and avoid an extra journal fold when there is no possible node join.
  if (!selected && retained.files.length && !retained.spans.some(({ attributes }) =>
    attributes['traces.runtime.node_id'] || attributes['tangle.node.id'] ||
    (typeof attributes['cli_bridge.session.id'] === 'string' && materialized.has(attributes['cli_bridge.session.id'])))) {
    return { spans: [...retained.spans], retained, unknowns: [...unbound, 'Retained OTLP selected; journal nodes cannot be joined to its spans and their usage is excluded.'] }
  }
  const journal = await readRuntimeJournalSpans(runDir, expectedRunId, unbound)
  if (!selected && !retained.files.length) return journal
  const nodes = new Set(journal.spans.map((item) => String(item.attributes['traces.runtime.node_id'])))
  const runId = journal.spans[0]?.attributes['traces.runtime.run_id'] ?? expectedRunId
  // A native session spanning several nodes has no per-node placement. Keep
  // those journal boundaries, with the shared usage measured only on the session.
  const included = new Set<string>()
  for (const item of selected?.spans ?? []) {
    const node = item.attributes['traces.runtime.node_id']
    if (typeof node === 'string') included.add(node)
  }
  const spans = [...(selected?.spans ?? [])]
  const unknowns = new Set([...unbound, ...(selected?.unknowns ?? [])])
  const { owners, bridgeSessions } = retainedOwners(retained.spans, nodes, runId, materialized, selected)
  const unplacedSessions = new Set<string | undefined>()
  let unidentified = 0
  let separateSessions = 0
  let overlaps = 0
  for (const item of retained.spans) {
    const key = spanKey(item.trace_id, item.span_id)
    const owner = owners.get(key)
    if (owner === CAPTURED) { overlaps++; continue }
    if (owner === SEPARATE_SESSION) {
      separateSessions++
      unplacedSessions.add(bridgeSessions.get(key))
    }
    else if (owner) included.add(owner)
    else {
      unidentified++
      if (selected) continue
      unplacedSessions.add(bridgeSessions.get(key))
    }
    spans.push(item)
  }
  if (!selected && included.size === 0) return {
    spans, retained, unknowns: [...unbound, 'Retained OTLP identities could not be joined to journal nodes; journal usage is excluded.'],
  }
  if (overlaps) unknowns.add(`Bound native captures supersede ${overlaps} of ${retained.spans.length} retained OTLP spans.`)
  if (unidentified) unknowns.add(selected
    ? `Ownership is ambiguous for ${unidentified} of ${retained.spans.length} retained OTLP spans. They were excluded to avoid duplicate native usage.`
    : `Ownership is ambiguous for ${unidentified} of ${retained.spans.length} retained OTLP spans. Journal meters without a disjoint session binding are excluded.`)
  if (separateSessions) unknowns.add(`A distinct backend session contributed ${separateSessions} retained spans without a Runtime node binding. Journal meters without a disjoint session binding are excluded.`)
  const sharedSessions = new Set<string>()
  for (const [session, materializations] of materialized) {
    if (selected?.sessions.has(session)) for (const node of materializations) sharedSessions.add(node)
  }
  const selectedSpanCount = spans.length
  for (const item of journal.spans) {
    const node = String(item.attributes['traces.runtime.node_id'])
    if (included.has(node)) continue
    const meter = meteredSessions.get(node)
    const overlap = unplacedSessions.size > 0 && (unplacedSessions.has(undefined) || !meter ||
      [...meter].some((session) => session === undefined || unplacedSessions.has(session)))
    const shared = (selected?.nodes.has(node) || sharedSessions.has(node)) &&
      (!meter || [...meter].some((session) => session === undefined || selected?.sessions.has(session)))
    if (overlap || shared) {
      delete item.attributes[SESSION_TOTAL_INPUT_ATTR]
      delete item.attributes[SESSION_TOTAL_OUTPUT_ATTR]
      delete item.attributes[RUNTIME_INPUT_FLOOR_ATTR]
      delete item.attributes[RUNTIME_OUTPUT_FLOOR_ATTR]
      delete item.attributes['traces.runtime.token_coverage']
      if (shared) unknowns.add('A journal node shares a captured Bridge session. Its separate driver usage is unknown.')
    }
    spans.push(item)
  }
  for (const issue of journal.unknowns) unknowns.add(issue)
  if (retained.issues.length) unknowns.add(`${retained.issues.length} retained OTLP ingestion issues; see the original OTLP for details.`)
  if (!selected && spans.length === selectedSpanCount) return { spans, retained, unknowns: [...unknowns] }
  if (spans[0]) spans[0].attributes['traces.source.unknowns'] = JSON.stringify([...unknowns])
  return { spans, unknowns: [...unknowns] }
}

const CAPTURED = Symbol('bound native capture')
const SEPARATE_SESSION = Symbol('distinct backend session without a node binding')
type Owner = string | typeof CAPTURED | typeof SEPARATE_SESSION | null
interface BoundCaptures {
  spans: OtlpSpan[]; unknowns: string[]; nodes: Set<string>; sessions: Set<string>; requests: Set<string>
}

/** Resolve each span at its nearest recorded owner. A shared trace id alone cannot identify a node. */
function retainedOwners(spans: readonly OtlpSpan[], nodes: Set<string>, runId: unknown, materialized: Map<string, Set<string>>, native?: BoundCaptures) {
  const byId = new Map(spans.map((item) => [spanKey(item.trace_id, item.span_id), item]))
  const nativeSpans = new Set(native?.spans.map((item) => spanKey(item.trace_id, item.span_id)))
  const owners = new Map<string, Owner>()
  const bridgeSessions = new Map<string, string>()
  for (const span of spans) {
    let item: OtlpSpan | undefined = span
    let owner: Owner = null
    let inheritedBridge: string | undefined
    const trail: Array<{ key: string; separate: boolean; bridge: string | undefined }> = []
    while (item) {
      const key = spanKey(item.trace_id, item.span_id)
      if (owners.has(key)) { owner = owners.get(key)!; inheritedBridge = bridgeSessions.get(key); break }
      const bridge = item.attributes['cli_bridge.session.id']
      const step = { key, separate: false, bridge: typeof bridge === 'string' && bridge ? bridge : undefined }
      trail.push(step)
      owners.set(key, null) // Unresolved if the parent chain cycles.
      const attrs = item.attributes
      const declared = attrs['traces.runtime.node_id'] ?? attrs['tangle.node.id']
      if (attrs['tangle.node.id'] && declared !== attrs['tangle.node.id']) break
      const root = attrs['traces.runtime.run_id'] ?? (declared ? attrs['tangle.run.id'] : undefined)
      if (root !== undefined && root !== runId) break
      const session = sessionIdFromAttributes(attrs)
      const bridgeSession = attrs['cli_bridge.session.id']
      const binding = typeof bridgeSession === 'string' ? materialized.get(bridgeSession) : undefined
      if (typeof declared === 'string' && binding && !binding.has(declared)) break
      const node = declared ?? (binding?.size === 1 ? [...binding][0] : undefined)
      const bound = nativeSpans.has(key) || [session, attrs['cli_bridge.session.id'], attrs['cli_bridge.backend.session_id']]
        .some((id) => typeof id === 'string' && native?.sessions.has(id)) ||
        (typeof attrs['cli_bridge.run.id'] === 'string' && native?.requests.has(attrs['cli_bridge.run.id']))
      if (typeof node === 'string') {
        if (native?.nodes.has(node)) owner = CAPTURED
        else if (!bound && (nodes.has(node) || (typeof runId === 'string' && root === runId))) owner = node
        break
      }
      if (bound) { owner = CAPTURED; break }
      if (binding) break // Multiple journal nodes used this session; the records cannot be divided across them.
      step.separate = !!native && typeof attrs['cli_bridge.backend.session_id'] === 'string' && !!attrs['cli_bridge.backend.session_id']
      item = item.parent_span_id ? byId.get(spanKey(item.trace_id, item.parent_span_id)) : undefined
    }
    for (const { key, separate, bridge } of trail.reverse()) {
      if (owner === null && separate) owner = SEPARATE_SESSION
      inheritedBridge = bridge ?? inheritedBridge
      if (inheritedBridge) bridgeSessions.set(key, inheritedBridge)
      owners.set(key, owner)
    }
  }
  return { owners, bridgeSessions }
}

async function readRuntimeJournalSpans(runDir: string, expectedRunId: string | undefined, unbound: readonly string[]) {
  const { readRunContextSnapshot } = await import('../supervisor-run-context.js')
  const snapshot = await readRunContextSnapshot(runDir)
  const unknowns = [
    'Runtime parent relationships establish containment, not delegation.',
    'Journal driver usage is retained once per node; child-inclusive settlement totals are excluded.',
    'Human messages, tool calls and workflow phases are unavailable from the supervisor journal.',
    ...unbound,
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
    const input = exactCount(own, 'tokensIn'), output = exactCount(own, 'tokensOut')
    const gaps = []
    if (input === null) gaps.push(own.tokensIn > 0 ? `at least ${own.tokensIn} input tokens` : 'input tokens unknown')
    if (output === null) gaps.push(own.tokensOut > 0 ? `at least ${own.tokensOut} output tokens` : 'output tokens unknown')
    const coverage = gaps.length ? `Runtime driver usage is incomplete (${gaps.join(', ')})` : undefined
    if (coverage) unknowns.push('At least one journal node has incomplete driver token usage.')
    spans.push(span({
      traceId, spanId: deriveHexId(`${traceId}:${node.id}`, 8),
      parentSpanId: node.parent ? deriveHexId(`${traceId}:${node.parent}`, 8) : null,
      name: 'runtime.agent', kind: 'AGENT', startTime: new Date(start).toISOString(),
      ...(end !== null ? { endTime: new Date(end).toISOString() } : {}),
      status: node.status === 'failed' ? 'ERROR' : node.status === 'done' ? 'OK' : 'UNSET',
      service: 'agent-runtime',
      extra: {
        'traces.runtime.node_id': node.id, 'tangle.node.state': node.status, [ATTR.HARNESS]: node.runtime ?? 'agent-runtime',
        'traces.runtime.run_id': runId, [SOURCE_MISSING_CHANNELS_ATTR]: JSON.stringify(['human-turns', 'tool-calls', 'cache-read', 'cache-write']), 'agent.parent.confidence': 'explicit',
        ...(input !== null ? { [SESSION_TOTAL_INPUT_ATTR]: input } : {}),
        ...(output !== null ? { [SESSION_TOTAL_OUTPUT_ATTR]: output } : {}),
        ...(input === null && own.tokensIn > 0 ? { [RUNTIME_INPUT_FLOOR_ATTR]: own.tokensIn } : {}),
        ...(output === null && own.tokensOut > 0 ? { [RUNTIME_OUTPUT_FLOOR_ATTR]: own.tokensOut } : {}),
        ...(coverage ? { 'traces.runtime.token_coverage': coverage } : {}),
        ...(end === null ? { [SUBSTITUTED_FIELDS_ATTR]: 'end_time' } : {}),
      },
    }))
  }
  if (spans[0]) Object.assign(spans[0].attributes, { [ATTR.CORRUPTION_COUNT]: snapshot.invalidJournalRows, 'traces.source.partial_tail': snapshot.partialTail, 'traces.source.unknowns': JSON.stringify([...new Set(unknowns)]) })
  return { spans, unknowns: [...new Set(unknowns)] }
}

interface RuntimeNativeCapture {
  text: string; path: string; refs: Set<string>; bindings: HarnessTranscriptBinding[]
}

async function readRuntimeCapture(evidence: Extract<HarnessTranscriptEvidence, { status: 'available' }>, artifact: HarnessTranscriptArtifact | undefined, root: string, nodeId: string, events: readonly SpawnEvent[]) {
  const binding = artifact?.binding
  if (!artifact || artifact.harness !== evidence.harness || artifact.harness !== 'codex' || !binding || binding.kind !== 'bridge'
    || binding.node?.rootId !== root || binding.node.nodeId !== nodeId) {
    throw new Error('Runtime native capture lacks a supported, exact node/session/request binding')
  }
  if (evidence.coverageComplete !== true || evidence.skippedCount || evidence.missing?.length
    || artifact.skipped.length || artifact.source?.coverageComplete === false) {
    throw new Error('Runtime native capture is incomplete; full record facts are unavailable')
  }
  // Parse only retained bytes through the maintained native reader, never a host session store.
  const files = artifact.files.map((file) => ({
    ...file, session: readSessionInput('codex', { text: file.content }, {
      nativeSessionId: 'unattributed:runtime-capture', label: evidence.transcriptRef,
    }, { corruption: 'strict' }),
  }))
  const family = await captureBoundHarnessTranscript({
    harness: 'codex', binding, nativeSessionId: binding.nativeSessionId,
    files: files.map((file) => ({ path: file.path, nativeSessionId: file.session.nativeSessionId, byteLength: file.bytes })),
    read: async (file) => Buffer.from(files.find((value) => value.path === file.path)!.content),
    parse: (_text, file) => files.find((value) => value.path === file.path)!.session,
  })
  if (family.status !== 'captured') throw new Error('Runtime native family was not captured')
  assertRuntimeCaptureBinding(binding, events)
  return { binding, files: family.artifact.files.map((file) => ({
    path: file.path, text: file.content,
    nativeSessionId: files.find((value) => value.path === file.path)!.session.nativeSessionId,
  })) }
}

/** Join at the receipt's journal prefix, before later reentry or seat materializations exist. */
function assertRuntimeCaptureBinding(binding: HarnessTranscriptBinding, events: readonly SpawnEvent[]): void {
  const context = binding.node!
  const node = materializeTreeView([...events]).nodes.find((value) => value.id === context.nodeId)
  const spawned = events.find((event) => event.kind === 'spawned' && event.id === context.nodeId)
  const execution = node?.executionBindings?.at(-1)
  const attemptId = execution?.attemptId ?? (spawned?.kind === 'spawned' ? spawned.attemptId : undefined)
  if (!node || !attemptId) throw new Error('Runtime capture attempt provenance is unavailable')
  if (context.attemptId !== attemptId) throw new Error('Runtime capture attempt disagrees with journal')
  if (context.parentId !== (node.parent ?? context.rootId)) throw new Error('Runtime capture parent disagrees with journal')
  for (const key of ['profileDigest', 'taskDigest'] as const) {
    if (node.identity?.[key] && context.identity?.[key] !== node.identity[key]) {
      throw new Error('Runtime capture authored identity disagrees with journal')
    }
  }
  const materialization = node.materialization
  if (materialization?.status !== 'known') throw new Error('Runtime capture effective profile provenance is unavailable')
  if (materialization.effectiveProfileDigest !== binding.profileDigest) throw new Error('Runtime capture effective profile disagrees with journal')
  if (execution && execution.materializationReceiptDigest !== contentAddress(materialization)) {
    throw new Error('Runtime capture execution binding disagrees with materialization')
  }
  if (materialization.execution.kind === 'session' && materialization.execution.id !== binding.sessionId) {
    throw new Error('Runtime capture session disagrees with journal')
  }
}

/** Keep native session containment; Bridge request spans and journal spend would count it twice. An unbound capture is left to the run's other sources. */
async function readRuntimeCaptures(runDir: string, expectedRunId?: string): Promise<{
  selected?: BoundCaptures; unbound: string[]; materialized: Map<string, Set<string>>; meteredSessions: Map<string, Set<string | undefined>>
}> {
  const journal = await readSpawnJournal(runDir, { invalid: 'skip' })
  const blobs = new FileResultBlobStore(join(runDir, 'blobs'))
  const sessions = new Map<string, RuntimeNativeCapture>()
  const prefixes = new Map<string, SpawnEvent[]>()
  const materialized = new Map<string, Set<string>>()
  const activeBridge = new Map<string, string>()
  const meteredSessions = new Map<string, Set<string | undefined>>()
  const unknowns = new Set<string>([
    'Capture bindings identify whole native sessions; per-request record scope is unavailable.',
  ])
  const unbound = new Set<string>()
  let available = false
  for (const row of journal.records) {
    if (expectedRunId && row.root !== expectedRunId) throw new Error('Catalog run ID disagrees with Runtime journal root')
    if (row.kind !== 'event') continue
    const events = prefixes.get(row.root) ?? []
    events.push(row.event)
    prefixes.set(row.root, events)
    if (row.event.kind === 'spawned' || row.event.kind === 'materialized') activeBridge.delete(row.event.id)
    if (row.event.kind === 'materialized' && row.event.receipt.status === 'known' && row.event.receipt.backend === 'bridge' && row.event.receipt.execution.kind === 'session') {
      const id = row.event.receipt.execution.id
      activeBridge.set(row.event.id, id)
      const nodes = materialized.get(id) ?? new Set<string>()
      nodes.add(row.event.id)
      materialized.set(id, nodes)
    }
    if (row.event.kind === 'metered') {
      const sessions = meteredSessions.get(row.event.id) ?? new Set<string | undefined>()
      sessions.add(activeBridge.get(row.event.id))
      meteredSessions.set(row.event.id, sessions)
    }
    if (!('harnessTranscript' in row.event)) {
      if (row.event.kind === 'settled') unknowns.add('A settled Runtime node has no transcript receipt and is excluded from native record facts.')
      continue
    }
    const evidence = row.event.harnessTranscript
    if (!evidence) continue
    if (evidence.status !== 'available') {
      unbound.add(`Runtime transcript unavailable: ${evidence.reason}`)
      continue
    }
    const artifact = await harnessTranscriptArtifact(evidence, blobs)
    if (artifact && !artifact.binding && artifact.harness === evidence.harness) {
      unbound.add(`A Runtime ${artifact.harness} transcript carries no binding to a node, native session and request, so its records are not read as native facts.`)
      continue
    }
    available = true
    const { binding, files } = await readRuntimeCapture(evidence, artifact, row.root, row.event.id, events)
    for (const file of files) {
      const text = file.text
      const previous = sessions.get(file.nativeSessionId)
      if (previous) {
        // Reentry captures grow the same native file; conflicting copies cannot be added or guessed.
        if (!text.startsWith(previous.text) && !previous.text.startsWith(text)) {
          throw new Error('Runtime captures contain conflicting copies of one native session')
        }
        if (text.length > previous.text.length) { previous.text = text; previous.path = file.path }
        previous.refs.add(evidence.transcriptRef)
        previous.bindings.push(binding)
      } else sessions.set(file.nativeSessionId, {
        text, path: file.path, refs: new Set([evidence.transcriptRef]), bindings: [binding],
      })
    }
  }
  if (!available) return { unbound: [...unbound], materialized, meteredSessions }
  // Journal summaries retain their historical recovery; a capture join requires an intact binding log.
  const verified = await readSpawnJournal(runDir)
  if (verified.cursor?.file !== journal.cursor?.file || verified.cursor?.offset !== journal.cursor?.offset
    || verified.cursor?.boundary !== journal.cursor?.boundary) throw new Error('Runtime binding journal changed during capture read')
  if (journal.remainingBytes || journal.truncated) throw new Error('Runtime capture journal has an unread tail')
  for (const reason of unbound) unknowns.add(reason)
  const bindings = [...sessions.values()].flatMap((capture) => capture.bindings)
  return { selected: {
    spans: await projectRuntimeCaptures(sessions, unknowns), unknowns: [...unknowns],
    nodes: new Set(bindings.map((binding) => binding.node!.nodeId)),
    sessions: new Set([...sessions.keys(), ...bindings.map((binding) => binding.sessionId)]),
    requests: new Set(bindings.flatMap((binding) => binding.runs.map((run) => run.runId))),
  }, unbound: [...unbound], materialized, meteredSessions }
}

async function projectRuntimeCaptures(sessions: Map<string, RuntimeNativeCapture>, unknowns: Set<string>): Promise<OtlpSpan[]> {
  const adapter = new HarnessSessionsAdapter('codex')
  const spans: OtlpSpan[] = []
  for (const [sessionId, capture] of sessions) {
    const records = capture.text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>)
    const ref = { harness: 'codex', sessionId, path: capture.path, cwd: null, mtimeMs: 0 }
    if (!adapter.readsPieces(ref, records)) throw new Error('Captured Codex session requires unsupported fork or legacy task scoping')
    const projected = await adapter.readPiece(ref, records)
    const nodeIds = new Set(capture.bindings.map((binding) => binding.node!.nodeId))
    const [nodeId] = nodeIds
    if (nodeIds.size > 1) unknowns.add('One native session was bound to multiple Runtime nodes; its records and usage cannot be split by node.')
    for (const item of projected.spans) Object.assign(item.attributes, {
      'traces.runtime.run_id': capture.bindings[0]!.node!.rootId,
      ...(nodeIds.size === 1 ? { 'traces.runtime.node_id': nodeId } : {}),
      'traces.runtime.capture_refs': JSON.stringify([...capture.refs]),
      'traces.runtime.capture_bindings': JSON.stringify(capture.bindings.map(({ kind, sessionId, nativeSessionId, profileDigest, runs, node }) => ({
        kind, sessionId, nativeSessionId, profileDigest, runs,
        node: { rootId: node!.rootId, parentId: node!.parentId, nodeId: node!.nodeId, attemptId: node!.attemptId },
      }))),
      'traces.source.unknowns': JSON.stringify([...unknowns]),
    })
    spans.push(...projected.spans)
  }
  if (!spans.length) throw new Error('Bound Runtime native captures contain no readable records with recorded timing')
  return spans
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
