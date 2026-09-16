/**
 * Runtime journal snapshots for the live view, plus report-reader enrichment.
 * Eval owns report normalization, terminal records, and evidence accounting.
 * This module adds coordination-log steers and questions to those sources.
 * The live view uses Runtime's tree fold and keeps partial journal tails visible.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Budget, NodeStatus, Runtime, Spend, SpawnEvent, TreeView } from '@tangle-network/agent-runtime/kernel'
import { materializeTreeView } from '@tangle-network/agent-runtime/kernel'
import {
  readRuntimeSupervisorRun,
  type SupervisorRunNodeRole,
  type SupervisorRunReader,
  type SupervisorRunSources,
  type WorkerLogSource,
} from '@tangle-network/agent-eval/supervisor-run'

export const SPAWN_JOURNAL_FILE = 'spawn-journal.jsonl'
export const COORDINATION_LOG_FILE = 'coordination-log.jsonl'
export const RESULT_FILE = 'result.json'
export const BLOBS_DIR = 'blobs'

// ---------------------------------------------------------------------------
// Reading whole lines — a tail can catch the writer mid-line.
// ---------------------------------------------------------------------------

interface JsonlRead {
  /** Rows that parsed as JSON objects. */
  readonly rows: Record<string, unknown>[]
  /** Rows that were present, non-empty, and did not parse as a JSON object. */
  readonly invalidRows: number
  /** True when the file did not end in a newline — the last line is still being written. */
  readonly partialTail: boolean
  /** False when the file itself was absent (which is NOT "the file was empty"). */
  readonly present: boolean
}

async function readMaybe(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

/**
 * Parse JSONL, dropping only an unterminated final line. A half-written last
 * line is not a malformed row — it is a row that has not finished being
 * written, and counting it as corruption would make every live tail report
 * corruption once per poll.
 */
function readJsonlLines(text: string | null): JsonlRead {
  if (text === null) {
    return { rows: [], invalidRows: 0, partialTail: false, present: false }
  }
  const lines = text.split('\n')
  const partialTail = text.length > 0 && !text.endsWith('\n')
  if (partialTail) lines.pop()
  const rows: Record<string, unknown>[] = []
  let invalidRows = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>)
      } else invalidRows += 1
    } catch {
      invalidRows += 1
    }
  }
  return { rows, invalidRows, partialTail, present: true }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ---------------------------------------------------------------------------
// The spawn journal.
// ---------------------------------------------------------------------------

export interface RunContextJournal {
  /** The `root` of the `begin` record, or of the first event envelope. */
  readonly root: string | null
  /** ISO instant the tree was begun, when a `begin` record was written. */
  readonly begunAt: string | null
  /** Events in file order, unwrapped from their envelopes. */
  readonly events: readonly SpawnEvent[]
  /** Node ids that appear as some spawn's `parent` — the exact supervisor set. */
  readonly supervisorIds: ReadonlySet<string>
  readonly invalidRows: number
  readonly partialTail: boolean
  readonly present: boolean
}

/**
 * Unwrap `FileSpawnJournal`'s `{kind:'begin'|'event', root, event}` records.
 * A record whose `kind` is neither is counted as invalid rather than dropped:
 * an unrecognized record shape is a finding, not silence.
 */
export function readRunContextJournal(text: string | null): RunContextJournal {
  const parsed = readJsonlLines(text)
  let root: string | null = null
  let begunAt: string | null = null
  const events: SpawnEvent[] = []
  let invalidRows = parsed.invalidRows
  for (const record of parsed.rows) {
    const recordRoot = str(record.root)
    if (root === null && recordRoot !== null) root = recordRoot
    if (record.kind === 'begin') {
      if (begunAt === null) begunAt = str(record.at)
      continue
    }
    if (record.kind !== 'event') {
      invalidRows += 1
      continue
    }
    const event = asRecord(record.event)
    if (str(event.kind) === null || str(event.id) === null) {
      invalidRows += 1
      continue
    }
    events.push(event as unknown as SpawnEvent)
  }
  const supervisorIds = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'spawned' && event.kind !== 'waiting') continue
    const parent = event.parent
    if (typeof parent === 'string' && parent.length > 0) supervisorIds.add(parent)
  }
  return {
    root,
    begunAt,
    events,
    supervisorIds,
    invalidRows,
    partialTail: parsed.partialTail,
    present: parsed.present,
  }
}

/**
 * A node's role, decided by the tree's own shape. `supervisorIds` is the set of
 * ids some spawn named as its parent, so the rule is exact at any depth and
 * needs no field agent-runtime does not emit.
 */
export function inferRole(
  id: string,
  parent: string | null | undefined,
  supervisorIds: ReadonlySet<string>,
): SupervisorRunNodeRole {
  if (parent === null || parent === undefined) return 'supervisor'
  return supervisorIds.has(id) ? 'supervisor' : 'worker'
}

// ---------------------------------------------------------------------------
// The coordination log.
// ---------------------------------------------------------------------------

/** One steer the driver sent down to a named node. */
export interface CoordinationSteer {
  readonly messageId: string | null
  readonly toWorker: string | null
  readonly instruction: string
  readonly deliveryMode: string | null
  readonly at: number | null
}

/** A question a node raised up. `blocking` is the run-stopping urgency. */
export interface CoordinationQuestion {
  readonly id: string | null
  readonly from: string | null
  readonly question: string
  readonly reason: string | null
  readonly urgency: string | null
  readonly status: string | null
  readonly blocking: boolean
  readonly at: number | null
}

export interface CoordinationLog {
  readonly present: boolean
  readonly steers: readonly CoordinationSteer[]
  /** `messageId → delivered`, from `delivery` receipts. */
  readonly deliveries: readonly { messageId: string | null; delivered: boolean | null }[]
  readonly questions: readonly CoordinationQuestion[]
  readonly invalidRows: number
  readonly partialTail: boolean
}

const EMPTY_COORDINATION: CoordinationLog = {
  present: false,
  steers: [],
  deliveries: [],
  questions: [],
  invalidRows: 0,
  partialTail: false,
}

/**
 * Two record envelopes are in the wild for this file: the versioned
 * `{version, runId, source, record:{seq, at, event}}` and the flat
 * `{runId, at, event}`. Both carry the same `event`, so the unwrap is a single
 * lookup and neither shape is privileged.
 */
export function readCoordinationLog(text: string | null): CoordinationLog {
  const parsed = readJsonlLines(text)
  if (!parsed.present) return EMPTY_COORDINATION
  const steers: CoordinationSteer[] = []
  const deliveries: { messageId: string | null; delivered: boolean | null }[] = []
  const questions: CoordinationQuestion[] = []
  let invalidRows = parsed.invalidRows
  for (const row of parsed.rows) {
    const record = asRecord(row.record)
    const event = asRecord(Object.keys(record).length > 0 ? record.event : row.event)
    const at = typeof record.at === 'number' ? record.at : parseInstant(row.at)
    switch (event.type) {
      case 'steer': {
        const down = asRecord(event.down)
        steers.push({
          messageId: str(down.messageId),
          toWorker: str(down.toWorker),
          instruction: typeof down.instruction === 'string' ? down.instruction : '',
          deliveryMode: str(down.deliveryMode),
          at,
        })
        break
      }
      case 'delivery': {
        const receipt = asRecord(event.receipt)
        deliveries.push({
          messageId: str(receipt.messageId),
          delivered: typeof receipt.delivered === 'boolean' ? receipt.delivered : null,
        })
        break
      }
      case 'question': {
        const q = asRecord(event.question)
        const urgency = str(q.urgency)
        questions.push({
          id: str(q.id),
          from: str(q.from),
          question: typeof q.question === 'string' ? q.question : '',
          reason: str(q.reason),
          urgency,
          status: str(q.status),
          blocking: urgency === 'blocks-run',
          at: typeof q.openedAt === 'number' ? q.openedAt : at,
        })
        break
      }
      case 'settled':
        // Already journaled as a `settled` SpawnEvent; the coordination copy adds
        // nothing the tree does not already carry.
        break
      default:
        if (str(event.type) === null) invalidRows += 1
    }
  }
  return {
    present: true,
    steers,
    deliveries,
    questions,
    invalidRows,
    partialTail: parsed.partialTail,
  }
}

function parseInstant(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// ---------------------------------------------------------------------------
// The reader.
// ---------------------------------------------------------------------------

export interface FileRunContextReaderOptions {
  /** Override the recorded Runtime identity used for rollup grouping. */
  readonly instanceId?: string | null
  /** Which arm of a comparison this run is (default: the run directory's basename). */
  readonly arm?: string | null
}

/**
 * Read a `createFileRunContext` run directory into `SupervisorRunSources`.
 * Eval preserves missing evidence and rejects malformed Runtime records.
 * Coordination-log evidence extends the normalized worker sources.
 */
export async function readFileRunContext(
  runDir: string,
  opts: FileRunContextReaderOptions = {},
): Promise<SupervisorRunSources> {
  const sources = await readRuntimeSupervisorRun(runDir)
  const coordination = readCoordinationLog(await readMaybe(join(runDir, COORDINATION_LOG_FILE)))
  return {
    ...sources,
    instanceId: opts.instanceId !== undefined ? opts.instanceId : sources.instanceId,
    arm: opts.arm !== undefined ? opts.arm : basename(runDir),
    workers: sources.workers !== null && coordination.present
      ? workerSources(sources.workers, coordination)
      : sources.workers,
    ...(sources.journal !== null ? {
      rootTranscriptRef: join(runDir, SPAWN_JOURNAL_FILE),
      traceCommand: `traces watch ${runDir}`,
    } : {}),
  }
}

/** The `createFileRunContext` on-disk layout, as a `SupervisorRunReader`. */
export function fileRunContextSupervisorRunReader(
  runDir: string,
  opts: FileRunContextReaderOptions = {},
): SupervisorRunReader {
  return { runRef: runDir, read: () => readFileRunContext(runDir, opts) }
}

/** Does this directory hold a `createFileRunContext` run? */
export async function isFileRunContextDir(runDir: string): Promise<boolean> {
  return stat(join(runDir, SPAWN_JOURNAL_FILE))
    .then((s) => s.isFile())
    .catch(() => false)
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Add recorded steer requests, delivery receipts, and upward questions. */
function workerSources(
  workers: readonly WorkerLogSource[],
  coordination: CoordinationLog,
): WorkerLogSource[] {
  const deliveredById = new Map<string, boolean | null>()
  for (const receipt of coordination.deliveries) {
    if (receipt.messageId !== null) deliveredById.set(receipt.messageId, receipt.delivered)
  }
  return workers.map((worker) => {
    const steers = coordination.steers.filter((steer) => steer.toWorker === worker.workerId)
    const questions = coordination.questions.filter((question) => question.from === worker.workerId)
    return {
      ...worker,
      events: [
        ...steers.map((steer) => JSON.stringify({
          kind: 'message',
          requestId: steer.messageId,
          delivered: steer.messageId === null ? null : (deliveredById.get(steer.messageId) ?? null),
        })),
        ...questions.map((question) => JSON.stringify({ kind: 'message', direction: 'up', id: question.id })),
      ].join('\n'),
      inbox: steers.map((steer) => JSON.stringify({ id: steer.messageId, message: steer.instruction })).join('\n'),
    }
  })
}

// ---------------------------------------------------------------------------
// The live snapshot — the view model `traces watch` renders.
// ---------------------------------------------------------------------------

/**
 * A sum over spend records that keeps "unknown" out of the number.
 *
 * `usd` is the total of the records that priced themselves; `usdUnknown` is how
 * many declined to. A renderer that has 0 known records and >=1 unknown one must
 * print "unknown", never `$0.0000`: an unmetered turn and a free turn are
 * different facts, and agent-runtime's `Spend.usdKnown` is the only signal that
 * separates them (absent means known, per its contract).
 */
export interface SpendRoll {
  readonly records: number
  readonly iterations: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly usd: number
  readonly usdKnownRecords: number
  readonly usdUnknownRecords: number
}

export const ZERO_ROLL: SpendRoll = {
  records: 0,
  iterations: 0,
  tokensIn: 0,
  tokensOut: 0,
  usd: 0,
  usdKnownRecords: 0,
  usdUnknownRecords: 0,
}

export function addSpend(roll: SpendRoll, spend: Spend): SpendRoll {
  const known = spend.usdKnown !== false
  return {
    records: roll.records + 1,
    iterations: roll.iterations + (spend.iterations ?? 0),
    tokensIn: roll.tokensIn + (spend.tokens?.input ?? 0),
    tokensOut: roll.tokensOut + (spend.tokens?.output ?? 0),
    usd: roll.usd + (known ? (spend.usd ?? 0) : 0),
    usdKnownRecords: roll.usdKnownRecords + (known ? 1 : 0),
    usdUnknownRecords: roll.usdUnknownRecords + (known ? 0 : 1),
  }
}

export function mergeRolls(a: SpendRoll, b: SpendRoll): SpendRoll {
  return {
    records: a.records + b.records,
    iterations: a.iterations + b.iterations,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    usd: a.usd + b.usd,
    usdKnownRecords: a.usdKnownRecords + b.usdKnownRecords,
    usdUnknownRecords: a.usdUnknownRecords + b.usdUnknownRecords,
  }
}

export interface RunContextNode {
  readonly id: string
  readonly parent: string | null
  readonly label: string
  readonly depth: number
  readonly role: SupervisorRunNodeRole
  readonly status: NodeStatus
  readonly runtime: Runtime | null
  /** The budget this node was AUTHORED with, exactly as the spawn recorded it. */
  readonly budget: Budget
  /** This node's own driver inference — its `metered` events. */
  readonly driver: SpendRoll
  /** What this node's direct children consumed — their `settled` spend. */
  readonly children: SpendRoll
  /** What this node's own settlement charged its parent (its whole subtree). */
  readonly settled: SpendRoll
  readonly spawnedAt: number | null
  readonly settledAt: number | null
  /** Wall from spawn to settlement; null while the node is still live. */
  readonly wallMs: number | null
  readonly outRef: string | null
  /** Why a cancelled node was cancelled. */
  readonly cancelReason: string | null
}

export interface RunContextResult {
  readonly kind: string | null
  readonly reason: string | null
  readonly errorName: string | null
  readonly errorMessage: string | null
}

export interface RunContextSnapshot {
  readonly runDir: string
  readonly runId: string | null
  readonly present: boolean
  /** Depth-first, parents before children. */
  readonly nodes: readonly RunContextNode[]
  readonly maxDepth: number
  readonly begunAt: number | null
  /** Latest instant any event carried. */
  readonly lastEventAt: number | null
  readonly questions: readonly CoordinationQuestion[]
  readonly steers: readonly CoordinationSteer[]
  readonly result: RunContextResult | null
  /** True once `result.json` exists — the run has reached a terminal state. */
  readonly terminal: boolean
  /** Rows that were present and unreadable, per artifact. */
  readonly invalidJournalRows: number
  readonly invalidCoordinationRows: number
  /** True when an artifact's last line was still being written. */
  readonly partialTail: boolean
  /** Why the tree could not be folded, when it could not. */
  readonly treeError: string | null
}

/**
 * Read the run directory into the shape a live view renders. The tree comes
 * from agent-runtime's own `materializeTreeView` — the owner's fold of its own
 * event log, so a new event kind stays correctly classified here without this
 * file changing.
 *
 * The one thing the fold deliberately does NOT answer is the split this view
 * exists for: `materializeTreeView` accumulates a node's `metered` driver
 * inference ONTO its settled child-work base, which is the right total and the
 * wrong breakdown. Driver and child spend are therefore rolled separately
 * straight off the events, which is a partition of the same rows, not a second
 * tree.
 */
export async function readRunContextSnapshot(runDir: string): Promise<RunContextSnapshot> {
  const journal = readRunContextJournal(await readMaybe(join(runDir, SPAWN_JOURNAL_FILE)))
  const coordination = readCoordinationLog(await readMaybe(join(runDir, COORDINATION_LOG_FILE)))
  const resultText = await readMaybe(join(runDir, RESULT_FILE))
  const result = parseResult(resultText)

  const view = safeTreeView(journal.events)
  const nodes = view === null ? [] : orderNodes(view, journal)
  return {
    runDir,
    runId: journal.root,
    present: journal.present,
    nodes,
    maxDepth: nodes.reduce((max, n) => Math.max(max, n.depth), 0),
    begunAt: parseInstant(journal.begunAt),
    lastEventAt: journal.events.reduce<number | null>((latest, event) => {
      const at = parseInstant(event.at)
      return at === null ? latest : latest === null ? at : Math.max(latest, at)
    }, null),
    questions: coordination.questions,
    steers: coordination.steers,
    result,
    terminal: resultText !== null,
    invalidJournalRows: journal.invalidRows,
    invalidCoordinationRows: coordination.invalidRows,
    partialTail: journal.partialTail || coordination.partialTail,
    treeError:
      view === null && journal.present
        ? 'spawn journal could not be folded into a tree (a settle or cancel names a node that was never spawned)'
        : null,
  }
}

/**
 * `materializeTreeView` fails loud on a corrupted log — a settle for a node
 * that was never spawned. That is right for a replay and wrong for a watch,
 * where the answer is to show the corruption and keep tailing.
 */
function safeTreeView(events: readonly SpawnEvent[]): TreeView | null {
  if (events.length === 0) return null
  try {
    return materializeTreeView([...events])
  } catch {
    return null
  }
}

function orderNodes(view: TreeView, journal: RunContextJournal): RunContextNode[] {
  const driver = new Map<string, SpendRoll>()
  const settled = new Map<string, SpendRoll>()
  const childRoll = new Map<string, SpendRoll>()
  const spawnedAt = new Map<string, number | null>()
  const settledAt = new Map<string, number | null>()
  const cancelReason = new Map<string, string>()
  const parentOf = new Map<string, string | undefined>(view.nodes.map((n) => [n.id, n.parent]))

  for (const event of journal.events) {
    const at = parseInstant(event.at)
    if (event.kind === 'spawned' || event.kind === 'waiting') {
      spawnedAt.set(event.id, at)
    } else if (event.kind === 'metered') {
      driver.set(event.id, addSpend(driver.get(event.id) ?? ZERO_ROLL, event.spend))
    } else if (event.kind === 'settled') {
      settled.set(event.id, addSpend(settled.get(event.id) ?? ZERO_ROLL, event.spent))
      settledAt.set(event.id, at)
      const parent = parentOf.get(event.id)
      if (parent !== undefined) {
        childRoll.set(parent, addSpend(childRoll.get(parent) ?? ZERO_ROLL, event.spent))
      }
    } else if (event.kind === 'cancelled') {
      settledAt.set(event.id, at)
      cancelReason.set(event.id, event.reason)
    } else if (event.kind === 'woken') {
      settledAt.set(event.id, at)
    }
  }

  const byParent = new Map<string | null, typeof view.nodes[number][]>()
  for (const node of view.nodes) {
    const key = node.parent ?? null
    const bucket = byParent.get(key)
    if (bucket) bucket.push(node)
    else byParent.set(key, [node])
  }

  const out: RunContextNode[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return
    seen.add(id)
    const node = view.nodes.find((n) => n.id === id)
    if (node === undefined) return
    const spawned = spawnedAt.get(id) ?? null
    const closed = settledAt.get(id) ?? null
    out.push({
      id: node.id,
      parent: node.parent ?? null,
      label: node.label,
      depth,
      role: inferRole(node.id, node.parent, journal.supervisorIds),
      status: node.status,
      runtime: node.runtime ?? null,
      budget: node.budget,
      driver: driver.get(id) ?? ZERO_ROLL,
      children: childRoll.get(id) ?? ZERO_ROLL,
      settled: settled.get(id) ?? ZERO_ROLL,
      spawnedAt: spawned,
      settledAt: closed,
      wallMs: spawned !== null && closed !== null ? closed - spawned : null,
      outRef: node.outRef ?? null,
      cancelReason: cancelReason.get(id) ?? null,
    })
    for (const child of byParent.get(id) ?? []) walk(child.id, depth + 1)
  }

  walk(view.root, 0)
  // A node whose parent never appeared (a truncated or interleaved log) is still
  // real work that spent budget; show it rather than dropping it.
  for (const node of view.nodes) if (!seen.has(node.id)) walk(node.id, 0)
  return out
}

function parseResult(text: string | null): RunContextResult | null {
  const result = parseJsonObject(text)
  if (result === null) return null
  const error = asRecord(result.error)
  return {
    kind: str(result.kind),
    reason: str(result.reason),
    errorName: str(error.name),
    errorMessage: str(error.message),
  }
}
