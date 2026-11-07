/** Runtime runs select bound native captures before request-only OTLP or journal summaries. */
import { join } from 'node:path'
import { readSessionInput } from '@tangle-network/harness-sessions'
import { FileResultBlobStore, captureBoundHarnessTranscript, contentAddress, harnessTranscriptArtifact, materializeTreeView, readSpawnJournal, type HarnessTranscriptBinding, type HarnessTranscriptEvidence, type SpawnEvent } from '@tangle-network/agent-runtime/kernel'
import { HarnessSessionsAdapter } from './harness-sessions.js'
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { ATTR, SOURCE_MISSING_CHANNELS_ATTR, SESSION_TOTAL_INPUT_ATTR, SESSION_TOTAL_OUTPUT_ATTR } from '../attributes.js'
import { span, type OtlpSpan } from '../otlp.js'
import { readOtlpInput, SUBSTITUTED_FIELDS_ATTR, type OtlpInput } from '../otlp-input.js'

export async function readRuntimeRunSpans(runDir: string, expectedRunId?: string): Promise<{
  spans: OtlpSpan[]; unknowns: string[]; retained?: OtlpInput
}> {
  const captured = await readRuntimeCaptures(runDir, expectedRunId)
  if (captured) return captured
  const retained = await readOtlpInput(runDir, { allowEmptyDirectory: true })
  if (retained.files.length > 0) return { spans: [...retained.spans], retained, unknowns: ['Retained OTLP selected; supervisor journal is excluded to avoid duplicate accounting'] }
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

interface RuntimeNativeCapture {
  text: string; path: string; refs: Set<string>; bindings: HarnessTranscriptBinding[]
}

async function readRuntimeCapture(evidence: Extract<HarnessTranscriptEvidence, { status: 'available' }>, blobs: FileResultBlobStore, root: string, nodeId: string, events: readonly SpawnEvent[]) {
  const artifact = await harnessTranscriptArtifact(evidence, blobs)
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

/** Keep native session containment; Bridge request spans and journal spend would count it twice. */
async function readRuntimeCaptures(runDir: string, expectedRunId?: string): Promise<{
  spans: OtlpSpan[]; unknowns: string[]
} | undefined> {
  const journal = await readSpawnJournal(runDir, { invalid: 'skip' })
  const blobs = new FileResultBlobStore(join(runDir, 'blobs'))
  const sessions = new Map<string, RuntimeNativeCapture>()
  const prefixes = new Map<string, SpawnEvent[]>()
  const unknowns = new Set<string>([
    'Bound native sessions selected; Bridge request spans and supervisor journal usage are excluded to avoid duplicate accounting.',
    'Capture bindings identify whole native sessions; per-request record scope is unavailable.',
  ])
  let available = false
  for (const row of journal.records) {
    if (expectedRunId && row.root !== expectedRunId) throw new Error('Catalog run ID disagrees with Runtime journal root')
    if (row.kind !== 'event') continue
    const events = prefixes.get(row.root) ?? []
    events.push(row.event)
    prefixes.set(row.root, events)
    if (!('harnessTranscript' in row.event)) {
      if (row.event.kind === 'settled') unknowns.add('A settled Runtime node has no transcript receipt and is excluded from native record facts.')
      continue
    }
    const evidence = row.event.harnessTranscript
    if (!evidence) continue
    if (evidence.status !== 'available') {
      unknowns.add(`Runtime transcript unavailable: ${evidence.reason}`)
      continue
    }
    available = true
    const { binding, files } = await readRuntimeCapture(evidence, blobs, row.root, row.event.id, events)
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
  if (!available) return undefined
  // Journal summaries retain their historical recovery; a capture join requires an intact binding log.
  const verified = await readSpawnJournal(runDir)
  if (verified.cursor?.file !== journal.cursor?.file || verified.cursor?.offset !== journal.cursor?.offset
    || verified.cursor?.boundary !== journal.cursor?.boundary) throw new Error('Runtime binding journal changed during capture read')
  if (journal.remainingBytes || journal.truncated) throw new Error('Runtime capture journal has an unread tail')
  return { spans: await projectRuntimeCaptures(sessions, unknowns), unknowns: [...unknowns] }
}

async function projectRuntimeCaptures(sessions: Map<string, RuntimeNativeCapture>, unknowns: Set<string>): Promise<OtlpSpan[]> {
  const adapter = new HarnessSessionsAdapter('codex')
  const spans: OtlpSpan[] = []
  for (const [sessionId, capture] of sessions) {
    const records = capture.text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>)
    const ref = { harness: 'codex', sessionId, path: capture.path, cwd: null, mtimeMs: 0 }
    if (!adapter.readsPieces(ref, records)) throw new Error('Captured Codex session requires unsupported fork or legacy task scoping')
    const projected = await adapter.readPiece(ref, records)
    for (const item of projected.spans) Object.assign(item.attributes, {
      'traces.runtime.run_id': capture.bindings[0]!.node!.rootId,
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
