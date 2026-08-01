/**
 * A SECOND implementation of agent-eval's `SupervisorRunReader` port, over the
 * run directory that agent-runtime's `createFileRunContext(dir)` writes:
 *
 *   <runDir>/spawn-journal.jsonl     required — the append-only SpawnEvent log
 *   <runDir>/coordination-log.jsonl  optional — steer / delivery / question / settled
 *   <runDir>/blobs/                  optional — content-addressed settled results
 *   <runDir>/result.json             optional — the terminal outcome document
 *
 * `loopsSupervisorRunReader` is the other implementation, over a completely
 * different layout. Neither knows about the other, and NOTHING here analyzes:
 * `analyzeSupervisorRun` / `parseSupervisorTree` / `rollupSupervisorRuns` in
 * `@tangle-network/agent-eval/supervisor-run` compute every metric, and
 * `materializeTreeView` in `@tangle-network/agent-runtime/kernel` folds the
 * event log into the tree. This file is translation only.
 *
 * ## Two translations, both faithful
 *
 * 1. **The envelope.** agent-runtime's `FileSpawnJournal` writes each event
 *    wrapped as `{kind:'event', root, event:{…}}` after one `{kind:'begin'}`
 *    record. agent-eval's parser reads `kind` at the TOP level, so an
 *    un-translated file parses as zero spawns AND zero malformed rows — a run
 *    that reads as "the supervisor did nothing" rather than "I cannot read
 *    this". The reader unwraps the envelope and re-emits flat JSONL.
 *
 * 2. **`role`.** `SupervisorRunSources.journal` documents
 *    `role: 'supervisor' | 'worker'` on spawned rows for recursive readers.
 *    agent-runtime's `SpawnEvent` has no such field, so it is INFERRED
 *    structurally and exactly: a node that appears as another spawn's `parent`
 *    is a supervisor; the root is a supervisor because it has no parent;
 *    everything else is a worker. No new upstream field is needed for this,
 *    and no depth limit applies — `<root>:s0:s0` classifies its parent
 *    `<root>:s0` as a supervisor by the same rule that classifies the root.
 *
 * Steer traffic is translated the same way: this layout records steers in
 * `coordination-log.jsonl` rather than per-worker inbox files, and each
 * recorded field maps 1:1 onto the per-worker artifacts the analyzer reads.
 * Nothing is synthesized from an absent fact — an artifact this layout does
 * not keep is declared in `SourceLimits`, which is what turns the dependent
 * metric into `unavailable` instead of 0.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Budget, NodeStatus, Runtime, Spend, SpawnEvent, TreeView } from '@tangle-network/agent-runtime/kernel'
import { materializeTreeView } from '@tangle-network/agent-runtime/kernel'
import {
  NO_SOURCE_LIMITS,
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
  /** Override the run identity used for rollup grouping (default: the journal root). */
  readonly instanceId?: string | null
  /** Which arm of a comparison this run is (default: the run directory's basename). */
  readonly arm?: string | null
}

/**
 * Read a `createFileRunContext` run directory into `SupervisorRunSources`.
 * Never throws on a missing artifact: an absent file becomes a `null` field or
 * a declared `SourceLimits` reason, which is what makes the dependent metric
 * `unavailable` rather than 0.
 */
export async function readFileRunContext(
  runDir: string,
  opts: FileRunContextReaderOptions = {},
): Promise<SupervisorRunSources> {
  const journalText = await readMaybe(join(runDir, SPAWN_JOURNAL_FILE))
  const journal = readRunContextJournal(journalText)
  const coordination = readCoordinationLog(await readMaybe(join(runDir, COORDINATION_LOG_FILE)))
  const result = await readMaybe(join(runDir, RESULT_FILE))

  return {
    runRef: runDir,
    instanceId: opts.instanceId !== undefined ? opts.instanceId : journal.root,
    arm: opts.arm !== undefined ? opts.arm : basename(runDir),
    // The journal is the store, and it lives directly in the run directory —
    // this layout has no separate supervisor sub-directory.
    supRunDir: journal.present ? runDir : null,
    journal: journal.present ? flattenJournal(journal) : null,
    // Per-brain-call taps and progress streams are loops artifacts; this layout
    // writes neither, so truncation genuinely cannot be ruled out.
    brainLog: null,
    state: journal.present ? runState(journal, result) : null,
    progress: null,
    ...workerSources(journal, coordination),
    result,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens: null,
    harnessMissingReason:
      'the file run context journals each child’s own settled spend, so no external harness join is used',
    limits: sourceLimits(journal, coordination),
    rootTranscriptRef: journal.present ? join(runDir, SPAWN_JOURNAL_FILE) : null,
    traceCommand: `traces watch ${runDir}`,
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

/** The unwrapped events, re-emitted flat with the structurally inferred `role`. */
function flattenJournal(journal: RunContextJournal): string {
  return journal.events
    .map((event) => {
      if (event.kind !== 'spawned') return JSON.stringify(event)
      return JSON.stringify({
        ...event,
        role: inferRole(event.id, event.parent, journal.supervisorIds),
      })
    })
    .join('\n')
}

/**
 * The run's own state document, translated from the two records that hold it:
 * `begin.at` is when the tree started, and `result.json`'s typed `kind` /
 * `reason` are its status and verdict. Field renaming only — nothing is
 * computed, and `spentUsd` is carried across only when the run said its dollar
 * accounting was known.
 */
function runState(journal: RunContextJournal, resultText: string | null): string {
  const result = parseJsonObject(resultText)
  const state: Record<string, unknown> = {}
  if (journal.begunAt !== null) state.startedAt = journal.begunAt
  if (result !== null) {
    const kind = str(result.kind)
    const reason = str(result.reason)
    if (kind !== null) state.status = kind
    if (reason !== null) state.verdict = reason
    const spentTotal = asRecord(result.spentTotal)
    if (typeof spentTotal.usd === 'number' && spentTotal.usdKnown !== false) {
      state.result = { spentUsd: spentTotal.usd }
    }
  }
  return JSON.stringify(state)
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

/**
 * One `WorkerLogSource` per spawned non-root node.
 *
 * This layout keeps no per-worker log files; it records the same steer/question
 * traffic in the coordination log, keyed by node id. Each translated row is a
 * recorded fact renamed, never a fact invented: a steer becomes its inbox
 * request, a delivery receipt becomes its acknowledgement, a question becomes
 * an upward message. `started`/`finished` events are deliberately NOT
 * synthesized from spawn/settle instants — that would report queue time as
 * worker wall time — so the wall distribution stays `unavailable`.
 *
 * When the coordination log is absent, `events` and `inbox` stay `null`, which
 * makes the steer counts `unavailable`. An absent log does not mean zero
 * steers.
 */
function workerSources(
  journal: RunContextJournal,
  coordination: CoordinationLog,
): Pick<SupervisorRunSources, 'workers' | 'workersMissingReason'> {
  if (!journal.present) {
    return { workers: null, workersMissingReason: `${SPAWN_JOURNAL_FILE} absent` }
  }
  const view = safeTreeView(journal.events)
  if (view === null) {
    return { workers: null, workersMissingReason: 'spawn journal could not be folded into a tree' }
  }
  const deliveredById = new Map<string, boolean | null>()
  for (const receipt of coordination.deliveries) {
    if (receipt.messageId !== null) deliveredById.set(receipt.messageId, receipt.delivered)
  }
  const spendById = settledSpendById(journal.events)

  const workers: WorkerLogSource[] = []
  for (const node of view.nodes) {
    if (node.parent === undefined) continue
    const steers = coordination.steers.filter((s) => s.toWorker === node.id)
    const questions = coordination.questions.filter((q) => q.from === node.id)
    const spend = spendById.get(node.id) ?? null
    workers.push({
      workerId: node.id,
      label: node.label,
      events: coordination.present
        ? [
            ...steers.map((s) =>
              JSON.stringify({
                kind: 'message',
                requestId: s.messageId,
                delivered: s.messageId === null ? null : (deliveredById.get(s.messageId) ?? null),
              }),
            ),
            ...questions.map((q) => JSON.stringify({ kind: 'message', direction: 'up', id: q.id })),
          ].join('\n')
        : null,
      inbox: coordination.present
        ? steers.map((s) => JSON.stringify({ id: s.messageId, message: s.instruction })).join('\n')
        : null,
      // Content-addressed result blobs are not patches; this layout retains no
      // per-worker diff, so byte counts would be a fabricated zero.
      patchBytes: null,
      transcriptRef: null,
      patchPath: null,
      tokensIn: spend?.tokens.input ?? null,
      tokensOut: spend?.tokens.output ?? null,
    })
  }
  return { workers, workersMissingReason: null }
}

function settledSpendById(events: readonly SpawnEvent[]): Map<string, Spend> {
  const out = new Map<string, Spend>()
  for (const event of events) {
    if (event.kind !== 'settled') continue
    out.set(event.id, event.spent)
  }
  return out
}

/**
 * What this store structurally cannot record. Each non-null reason is what the
 * analyzer reports instead of a number it would otherwise compute as 0.
 */
function sourceLimits(
  journal: RunContextJournal,
  coordination: CoordinationLog,
): SupervisorRunSources['limits'] {
  const unpriced = unpricedNodes(journal.events)
  const verdicts = journal.events.filter(
    (event) => event.kind === 'settled' && event.verdict !== undefined,
  ).length
  const settlements = journal.events.filter((event) => event.kind === 'settled').length
  return {
    ...NO_SOURCE_LIMITS,
    // Both are journaled per node: `metered` for a driver's own inference,
    // `settled.spent` for what a child consumed.
    managerTokens: null,
    workerTokens: null,
    spendUsd:
      unpriced.length === 0
        ? null
        : `${unpriced.length} spend record(s) carry usdKnown:false (${unpriced
            .slice(0, 4)
            .join(', ')}${unpriced.length > 4 ? ', …' : ''}) — the run’s dollar total is unknown, not $0`,
    workerVerdicts:
      settlements === 0 || verdicts > 0
        ? null
        : 'no settled event carried a verdict; this layout records a done/down status only',
    deliverables: `${BLOBS_DIR}/ holds content-addressed result artifacts, not patches`,
  }
}

/** Node ids whose journaled spend explicitly declared its dollar value unknown. */
function unpricedNodes(events: readonly SpawnEvent[]): string[] {
  const ids: string[] = []
  for (const event of events) {
    const spend = event.kind === 'settled' ? event.spent : event.kind === 'metered' ? event.spend : null
    if (spend?.usdKnown === false) ids.push(event.id)
  }
  return [...new Set(ids)]
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
