/**
 * A run's own records, read beside its spans: who stopped it and why, how far its checks got, when
 * it settled, and when each agent and the root stream last recorded anything before the stop.
 *
 * Runtime's records come through Runtime's readers or in Runtime's layout: the cancel request and
 * its acknowledgement (`cancellations/`), the settle result (`result.json`), the failure record
 * (`failure.json`) and the root stream (`root-stream.jsonl`, of which only the last event is read).
 * Discovery's retained run records are read in the format they were written, because a retained run
 * is never rewritten: its lifecycle log (`lifecycle.jsonl`), its play checks (`play-checks.jsonl`,
 * `play-check.json`, `play-check-recheck.json`) and its settle record (`procedure-record.json`).
 * A reopened run keeps each earlier cancel request under `cancellations/reopened/<reopen>/<operation>/`,
 * the Runtime result its n-th reopen set aside as `settles/<n>.json`, and each reopen in the lifecycle
 * log; the reopens split the run into generations, and the stop read is the one that ended the latest
 * generation that stopped.
 *
 * Nothing here classifies a stop or a run: the requester, the operator, the reason and Runtime's
 * terminal reason are reported as recorded. A record that is absent is absent; one that cannot be
 * read is named in `unread`, never read as empty.
 */
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface RunStopRecord {
  readonly requestedAt: string | null
  /** Who asked: Runtime's `source`, such as a controller or an operator tool. */
  readonly source: string | null
  /** Who stops the run, as the request names it. */
  readonly operator: string | null
  readonly operationId: string | null
  readonly reason: string | null
  /** Runtime's acknowledgement of the request; null when Runtime recorded none. */
  readonly applied: {
    readonly observedAt: string | null
    readonly afterMs: number | null
    /** Runtime's own flag: the run outlived the request's deadline before it ended. */
    readonly deadlineExceeded: boolean | null
    readonly path: string | null
    readonly effect: string | null
    readonly detail: string | null
  } | null
  /** The record that named the stop. */
  readonly from: string
}

export interface RunCheckRecord {
  readonly at: string
  /** `submission` for a check of a submitted candidate, `settle` for the settle step's own, `recheck` for a later recheck. */
  readonly kind: 'submission' | 'settle' | 'recheck'
  readonly commit: string | null
  readonly solved: boolean | null
  readonly known: boolean | null
  readonly reached: number | null
  readonly of: number | null
  readonly stages: readonly string[] | null
  readonly failedStage: string | null
  /** The checker's first failing line, or its one-line detail. */
  readonly reason: string | null
}

export interface RunSettleRecord {
  readonly at: string | null
  readonly status: string | null
  readonly reason: string | null
  readonly wallMs: number | null
  /** `status` is the record's own: known, lower-bound (then `floor` is the least it was) or unknown. */
  readonly tokens: {
    readonly status: string | null
    readonly total: number | null
    readonly floor: number | null
    readonly input: number | null
    readonly output: number | null
    readonly cached: number | null
    readonly reason: string | null
  } | null
  readonly computeUsd: number | null
  /** How the model calls were paid: the record's `usd.basis`, such as subscription or free. */
  readonly usdBasis: string | null
  readonly listUsd: number | null
  readonly model: string | null
  readonly from: string
}

export interface RunReopen {
  readonly at: string
  readonly operator: string | null
  readonly reason: string | null
}

/** One generation of a run: from its press or a reopen to its stop, and the next reopen. */
export interface RunGeneration {
  /** From one: the press starts the first generation, each reopen the next. */
  readonly generation: number
  readonly startedAt: string | null
  /** The reopen that started it; null for the first. */
  readonly reopen: RunReopen | null
  readonly stop: RunStopRecord | null
  readonly stoppedAt: RunStopTime | null
  readonly runtime: { readonly kind: string | null; readonly reason: string | null; readonly settledAt: string | null } | null
  readonly checks: readonly RunCheckRecord[]
  readonly submissions: RunRecord['submissions']
  /** The root stream's last event before the next reopen, which can come before this generation started. */
  readonly rootStream: RunRecord['rootStream']
}

export interface RunRecord {
  readonly runId: string
  /** The records read, by their path in the run directory. */
  readonly read: readonly string[]
  readonly unread: ReadonlyArray<{ readonly record: string; readonly reason: string }>
  readonly pressedAt: string | null
  /** The run's state as its lifecycle log last moved it, such as open, settling or settled. */
  readonly state: { readonly value: string | null; readonly at: string } | null
  /** Runtime's settle result (of the latest generation; a reopen removes it), when Runtime settled the stopped generation, and its failure record. */
  readonly runtime: {
    readonly kind: string | null
    readonly reason: string | null
    readonly settledAt: string | null
    readonly failure: { readonly at: string | null; readonly message: string | null } | null
  } | null
  /** The last event Runtime's root stream recorded before the stopped generation ended. */
  readonly rootStream: { readonly lastAt: string | null; readonly lastSeq: number | null; readonly lastKind: string | null } | null
  /** The stop that ended the latest generation that stopped: its cancel request, when it had one. */
  readonly stop: RunStopRecord | null
  /** Every cancel request, earlier generations' first, in time order. */
  readonly stops: readonly RunStopRecord[]
  readonly reopens: readonly RunReopen[]
  /** Each generation, the first first; the fields above describe the latest one that stopped. */
  readonly generations: readonly RunGeneration[]
  /** When the agents were stopped: the first of the stopped generation's request, Runtime settle and settle record. */
  readonly stoppedAt: RunStopTime | null
  /** When the run last ended: Runtime's settle, unless a reopen came after it; null while it is open. */
  readonly endedAt: string | null
  readonly settle: RunSettleRecord | null
  /** Every check, in time order. */
  readonly checks: readonly RunCheckRecord[]
  /** Candidates the run submitted, in time order. */
  readonly submissions: ReadonlyArray<{ readonly at: string; readonly entity: string | null; readonly commit: string | null }>
}

/** One agent's last recorded act, from the spans a command read. */
export interface RunNodeActivity {
  readonly id: string
  readonly label: string
  readonly state: string | null
  /** Epoch seconds the last span that is not a session container ended before the stopped generation's reopen (see `reopenSeconds`); null when it recorded none. */
  readonly lastActivity: number | null
}

export interface RunQuiet {
  readonly node: string
  readonly label: string
  readonly state: string | null
  readonly lastActivity: string | null
  /** Minutes from the last act to the stop: negative when the agent acted after it. */
  readonly minutesBeforeStop: number | null
}

/** When the agents were stopped: the first of the stop request, Runtime's settle and the settle record. */
export interface RunStopTime {
  readonly at: string
  readonly what: 'stop request' | 'Runtime settle' | 'settle record'
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))
const epoch = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso))
/** How far back a root stream is read for its last event before a stop. */
const STREAM_SCAN_BYTES = 256 << 20

class Reader {
  readonly dir: string
  readonly read: string[] = []
  readonly unread: Array<{ record: string; reason: string }> = []

  constructor(dir: string) {
    this.dir = dir
  }

  /** A JSON document, null when absent; an unreadable one is named and read as null. */
  async json(name: string): Promise<Json | null> {
    const text = await this.text(name)
    if (text === null) return null
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObject(parsed)) return parsed
      this.unread.push({ record: name, reason: 'not a JSON object' })
    } catch (error) {
      this.unread.push({ record: name, reason: errorText(error) })
    }
    this.read.splice(this.read.lastIndexOf(name), 1)
    return null
  }

  /** The objects of a JSONL file; lines that do not parse are counted in `unread`. */
  async jsonl(name: string): Promise<Json[]> {
    const text = await this.text(name)
    if (text === null) return []
    const rows: Json[] = []
    let bad = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const value: unknown = JSON.parse(line)
        if (isObject(value)) rows.push(value)
        else bad++
      } catch {
        bad++
      }
    }
    if (bad > 0) this.unread.push({ record: name, reason: `${bad} line(s) are not JSON objects` })
    return rows
  }

  async text(name: string): Promise<string | null> {
    try {
      const text = await readFile(join(this.dir, name), 'utf8')
      this.read.push(name)
      return text
    } catch (error) {
      if (!missing(error)) this.unread.push({ record: name, reason: errorText(error) })
      return null
    }
  }

  /** The names of the directories in `name`; none when it is absent. */
  async dirs(name: string): Promise<string[]> {
    try {
      return (await readdir(join(this.dir, name), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch (error) {
      if (!missing(error)) this.unread.push({ record: name, reason: errorText(error) })
      return []
    }
  }

  /**
   * The last event of a JSONL stream recorded before `before` (epoch ms; any time when null), read
   * backwards a megabyte at a time: a stream can be tens of megabytes, and a reopened run's stream
   * goes on past its stop. Reading stops after STREAM_SCAN_BYTES, and then says so.
   */
  async lastLine(name: string, before: number | null = null): Promise<Json | null> {
    let handle: FileHandle
    try {
      handle = await open(join(this.dir, name), 'r')
    } catch (error) {
      if (!missing(error)) this.unread.push({ record: name, reason: errorText(error) })
      return null
    }
    try {
      const { size } = await handle.stat()
      this.read.push(name)
      let end = size
      let carry = ''
      while (end > 0 && size - end < STREAM_SCAN_BYTES) {
        const length = Math.min(end, 1 << 20)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, end - length)
        end -= length
        const lines = (buffer.toString('utf8') + carry).split('\n')
        // The first piece may be the cut end of an earlier line: it is joined to the next chunk read.
        carry = end > 0 ? lines.shift() ?? '' : ''
        for (let index = lines.length - 1; index >= 0; index--) {
          const line = lines[index]!.trim()
          if (!line) continue
          try {
            const value: unknown = JSON.parse(line)
            const at = isObject(value) ? str(value.at) : null
            if (at !== null && (before === null || Date.parse(at) < before)) return value as Json
          } catch {
            // a torn last write
          }
        }
      }
      if (end > 0) this.unread.push({ record: name, reason: `no event before the stop in its last ${STREAM_SCAN_BYTES >> 20} MB` })
      return null
    } finally {
      await handle.close()
    }
  }
}

interface CheckLines {
  readonly stages: string[] | null
  readonly reached: number | null
  readonly of: number | null
  readonly failedStage: string | null
  readonly reason: string | null
}

/** The checker's own lines: `SCORE {...}`, then `FAIL {...}` or `NOT SOLVED: ...` for what failed. */
function checkLines(detail: string | null, failing: unknown): CheckLines {
  const lines = (detail ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  let score: Json = {}
  for (const line of lines) {
    if (!line.startsWith('SCORE ')) continue
    try {
      const parsed: unknown = JSON.parse(line.slice('SCORE '.length))
      if (isObject(parsed)) score = parsed
    } catch {
      // a SCORE line that is not JSON names no stages
    }
  }
  const stages = Array.isArray(score.stages) ? score.stages.filter((stage): stage is string => typeof stage === 'string') : null
  const scored = { stages, reached: num(score.reached), of: num(score.of) }
  const failingLines = Array.isArray(failing) ? failing.flatMap((row) => (isObject(row) && typeof row.line === 'string' ? [row.line] : [])) : []
  for (const line of [...failingLines, ...lines]) {
    if (line.startsWith('FAIL ')) {
      try {
        const fail: unknown = JSON.parse(line.slice('FAIL '.length))
        if (isObject(fail) && str(fail.reason) !== null) return { ...scored, failedStage: str(fail.stage), reason: str(fail.reason) }
      } catch {
        return { ...scored, failedStage: null, reason: line.slice('FAIL '.length) }
      }
    }
    if (line.startsWith('NOT SOLVED: ')) return { ...scored, failedStage: null, reason: line.slice('NOT SOLVED: '.length) }
  }
  const first = lines.find((line) => !line.startsWith('SCORE ') && !line.startsWith('stage: ')) ?? null
  return { ...scored, failedStage: null, reason: first }
}

function checkOf(row: Json, at: string | null, kind: RunCheckRecord['kind']): RunCheckRecord | null {
  if (at === null) return null
  const score = isObject(row.score) ? row.score : {}
  const solved = bool(row.solved)
  const lines = checkLines(str(row.detail), row.failing)
  return {
    at,
    kind,
    commit: str(row.commit),
    solved,
    known: bool(row.known),
    // The row's own score, else the checker's SCORE line (a settle row carries only the line).
    reached: num(score.reached) ?? lines.reached,
    of: num(score.of) ?? lines.of,
    stages: lines.stages,
    failedStage: solved === true ? null : lines.failedStage,
    reason: solved === true ? null : lines.reason,
  }
}

/** Every check: the check log, the final check and any recheck, each once (a row and the final check share their time). */
async function readChecks(reader: Reader): Promise<RunCheckRecord[]> {
  const checks = new Map<string, RunCheckRecord>()
  for (const row of await reader.jsonl('play-checks.jsonl')) {
    const check = checkOf(row, str(row.at), row.settle === true ? 'settle' : 'submission')
    if (check) checks.set(`${check.at}\0${check.commit}`, check)
  }
  const final = await reader.json('play-check.json')
  if (final) {
    const at = str(final.checkedAt) ?? str(final.at)
    const previous = at === null ? undefined : checks.get(`${at}\0${str(final.commit)}`)
    // The final check carries its failing lines; it replaces its own log row.
    const check = checkOf(final, at, previous?.kind ?? 'settle')
    if (check) checks.set(`${check.at}\0${check.commit}`, check)
  }
  const recheck = await reader.json('play-check-recheck.json')
  if (recheck) {
    const check = checkOf(recheck, str(recheck.checkedAt) ?? str(recheck.at), 'recheck')
    if (check) checks.set(`${check.at}\0${check.commit}\0recheck`, check)
  }
  return [...checks.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

type CancelRequest = { readonly at?: unknown; readonly source?: unknown; readonly operator?: unknown; readonly operationId?: unknown; readonly reason?: unknown }
type CancelApplied = { readonly observedAt?: unknown; readonly appliedAfterMs?: unknown; readonly deadlineExceeded?: unknown; readonly path?: unknown; readonly effect?: unknown; readonly detail?: unknown }

function stopOf(request: CancelRequest, applied: CancelApplied | null | undefined, from: string): RunStopRecord {
  return {
    requestedAt: str(request.at),
    source: str(request.source),
    operator: str(request.operator),
    operationId: str(request.operationId),
    reason: str(request.reason),
    applied: applied ? {
      observedAt: str(applied.observedAt),
      afterMs: num(applied.appliedAfterMs),
      deadlineExceeded: bool(applied.deadlineExceeded),
      path: str(applied.path),
      effect: str(applied.effect),
      detail: str(applied.detail),
    } : null,
    from,
  }
}

/** The current cancel request through Runtime's readers, and each earlier one a reopen kept, in time order. */
async function readStops(reader: Reader, result: Json | null): Promise<RunStopRecord[]> {
  const stops: RunStopRecord[] = []
  for (const reopen of await reader.dirs('cancellations/reopened')) {
    for (const operation of await reader.dirs(`cancellations/reopened/${reopen}`)) {
      const dir = `cancellations/reopened/${reopen}/${operation}`
      const request = await reader.json(`${dir}/run.request.json`)
      if (!request) continue
      const applied = await reader.json(`${dir}/run.json`)
      if (applied && applied.operationId !== request.operationId) {
        reader.unread.push({ record: `${dir}/run.json`, reason: `holds operation ${String(applied.operationId)}, not ${String(request.operationId)}` })
      }
      stops.push(stopOf(request, applied?.operationId === request.operationId ? applied : null, `${dir}/run.request.json`))
    }
  }
  const { readRunCancelRequest, readRunCancellation } = await import('@tangle-network/agent-runtime/kernel')
  const requestFile = 'cancellations/run.request.json'
  const appliedFile = 'cancellations/run.json'
  let request: ReturnType<typeof readRunCancelRequest> = undefined
  try {
    request = readRunCancelRequest(reader.dir)
  } catch (error) {
    reader.unread.push({ record: requestFile, reason: errorText(error) })
  }
  if (request) {
    reader.read.push(requestFile)
    let applied: ReturnType<typeof readRunCancellation> = undefined
    try {
      applied = readRunCancellation(reader.dir, request.operationId)
      if (applied) reader.read.push(appliedFile)
    } catch (error) {
      reader.unread.push({ record: appliedFile, reason: errorText(error) })
    }
    stops.push(stopOf(request, applied, requestFile))
  } else if (result && result.reason === 'cancelled' && (str(result.cancellationReason) !== null || str(result.operationId) !== null)) {
    // A settle result written before the request file existed still names who cancelled.
    stops.push(stopOf({ ...result, reason: result.cancellationReason, at: null }, null, 'result.json'))
  }
  return stops.sort((a, b) => (epoch(a.requestedAt) || 0) - (epoch(b.requestedAt) || 0))
}

function readSettle(procedure: Json | null, lifecycle: readonly Json[]): RunSettleRecord | null {
  if (procedure) {
    const outcome = isObject(procedure.outcome) ? procedure.outcome : {}
    const tokens = isObject(procedure.tokens) ? procedure.tokens : null
    const usd = isObject(procedure.usd) ? procedure.usd : {}
    const model = isObject(procedure.model) ? procedure.model : null
    const routes = model && Array.isArray(model.routes) ? model.routes.filter((route): route is string => typeof route === 'string') : []
    const modelName = model && str(model.id) !== null
      ? `${str(model.provider) ? `${str(model.provider)}/` : ''}${str(model.id)}${routes.length ? ` (${routes.join(', ')})` : ''}`
      : null
    return {
      at: str(procedure.settledAt),
      status: str(outcome.status),
      reason: str(outcome.reason),
      wallMs: num(procedure.wallMs),
      tokens: tokens ? {
        status: str(tokens.status), total: num(tokens.total), floor: num(tokens.floor), input: num(tokens.input),
        output: num(tokens.output), cached: num(tokens.cached), reason: str(tokens.reason),
      } : null,
      computeUsd: isObject(procedure.compute) && procedure.compute.known !== false ? num(procedure.compute.value) : null,
      usdBasis: str(usd.basis),
      listUsd: num(usd.listUsd),
      model: modelName,
      from: 'procedure-record.json',
    }
  }
  const settled = [...lifecycle].reverse().find((row) => row.event === 'settle')
  if (!settled) return null
  const evidence = isObject(settled.evidence) ? settled.evidence : {}
  return {
    at: str(settled.at), status: str(evidence.outcome), reason: str(evidence.reason), wallMs: null, tokens: null,
    computeUsd: null, usdBasis: null, listUsd: null, model: null, from: 'lifecycle.jsonl',
  }
}

/** The records of the run in `dir`, or null when it holds none of them. */
export async function readRunRecord(dir: string): Promise<RunRecord | null> {
  const reader = new Reader(dir)
  const result = await reader.json('result.json')
  const failure = await reader.json('failure.json')
  const lifecycle = await reader.jsonl('lifecycle.jsonl')
  const procedure = await reader.json('procedure-record.json')
  const checks = await readChecks(reader)
  const stops = await readStops(reader, result)
  const settle = readSettle(procedure, lifecycle)
  const at = (row: Json): string | null => str(row.at)
  const events = (name: string): string[] => lifecycle.flatMap((row) => (row.event === name && at(row) !== null ? [at(row)!] : []))
  const reopens: RunReopen[] = lifecycle.flatMap((row) => {
    if (row.event !== 'reopen' || at(row) === null) return []
    const evidence = isObject(row.evidence) ? row.evidence : {}
    return [{ at: at(row)!, operator: str(evidence.actor) ?? str(row.actor), reason: str(row.reason) ?? str(evidence.reason) }]
  }).sort((a, b) => epoch(a.at) - epoch(b.at))
  const submissions = lifecycle.flatMap((row) => {
    if (row.event !== 'submit' || at(row) === null) return []
    const evidence = isObject(row.evidence) ? row.evidence : {}
    return [{ at: at(row)!, entity: str(row.entity), commit: str(evidence.commit) }]
  })
  const pressedAt = events('press')[0] ?? null
  // The reopens split the run into generations, numbered from one: the press starts the first, each reopen the next.
  const generationOf = (time: string | null): number => 1 + reopens.filter((reopen) => epoch(reopen.at) <= epoch(time)).length
  const generations: RunGeneration[] = []
  for (let n = 1; n <= reopens.length + 1; n++) {
    const opened = n === 1 ? null : reopens[n - 2]!
    const closedBy = reopens[n - 1] ?? null
    const within = (time: string | null): boolean => time !== null && Number.isFinite(epoch(time)) && generationOf(time) === n
    const stop = [...stops].reverse().find((candidate) => within(candidate.requestedAt)) ??
      (closedBy === null ? stops.find((candidate) => candidate.requestedAt === null) ?? null : null)
    const runtimeSettledAt = events('runtime.settled').find(within) ?? null
    const moments: RunStopTime[] = [
      ...(stop?.requestedAt && within(stop.requestedAt) ? [{ at: stop.requestedAt, what: 'stop request' as const }] : []),
      ...(runtimeSettledAt ? [{ at: runtimeSettledAt, what: 'Runtime settle' as const }] : []),
      ...(settle?.at && within(settle.at) ? [{ at: settle.at, what: 'settle record' as const }] : []),
    ].sort((a, b) => epoch(a.at) - epoch(b.at))
    // A reopen sets the Runtime result of the generation it ends aside as settles/<n>.json.
    const runtimeResult = closedBy === null ? result : await reader.json(`settles/${n}.json`)
    const last = await reader.lastLine('root-stream.jsonl', closedBy === null ? null : epoch(closedBy.at))
    generations.push({
      generation: n,
      startedAt: opened?.at ?? pressedAt,
      reopen: opened,
      stop,
      stoppedAt: moments[0] ?? null,
      runtime: runtimeResult || runtimeSettledAt ? { kind: str(runtimeResult?.kind), reason: str(runtimeResult?.reason), settledAt: runtimeSettledAt } : null,
      checks: checks.filter((check) => within(check.at)),
      submissions: submissions.filter((submission) => within(submission.at)),
      rootStream: last ? { lastAt: str(last.at), lastSeq: num(last.seq), lastKind: isObject(last.event) ? str(last.event.kind) ?? str(last.event.type) : null } : null,
    })
  }
  if (reader.read.length === 0 && reader.unread.length === 0) return null
  // The stop read is that of the latest generation that stopped.
  const stopped = [...generations].reverse().find((candidate) => candidate.stoppedAt !== null) ?? null
  const lastRuntimeSettle = events('runtime.settled').at(-1) ?? null
  const lastReopen = reopens.at(-1) ?? null
  const endedAt = lastRuntimeSettle !== null && (lastReopen === null || epoch(lastRuntimeSettle) > epoch(lastReopen.at))
    ? lastRuntimeSettle
    : lastReopen === null ? settle?.at ?? null : null
  const failureError = failure && isObject(failure.error) ? failure.error : null
  const lastRun = lifecycle.filter((row) => row.entity === 'run' && at(row) !== null).at(-1)
  const shown = stopped ?? generations[0]!
  return {
    runId: str(procedure?.runId) ?? str(failure?.runId) ?? basename(dir),
    read: [...new Set(reader.read)],
    unread: reader.unread,
    pressedAt,
    state: lastRun ? { value: str(lastRun.to), at: at(lastRun)! } : null,
    runtime: shown.runtime || failure ? {
      kind: shown.runtime?.kind ?? null,
      reason: shown.runtime?.reason ?? null,
      settledAt: shown.runtime?.settledAt ?? null,
      failure: failure ? { at: str(failure.at), message: failureError ? str(failureError.message) : null } : null,
    } : null,
    rootStream: shown.rootStream,
    stop: shown.stop,
    stops,
    reopens,
    generations,
    stoppedAt: stopped?.stoppedAt ?? null,
    endedAt,
    settle,
    checks,
    submissions,
  }
}

/** Each agent's last act against the stop. */
export function quietBeforeStop(record: RunRecord, nodes: readonly RunNodeActivity[]): RunQuiet[] {
  const stopS = record.stoppedAt === null ? null : epoch(record.stoppedAt.at) / 1000
  return nodes.map((node) => ({
    node: node.id,
    label: node.label,
    state: node.state,
    lastActivity: node.lastActivity === null ? null : new Date(node.lastActivity * 1000).toISOString(),
    minutesBeforeStop: node.lastActivity === null || stopS === null ? null : Math.round((stopS - node.lastActivity) / 6) / 10,
  }))
}

/** Epoch seconds of the reopen that followed the stop read, when one did: an agent's acts after it belong to the next generation. */
export function reopenSeconds(record: RunRecord): number | undefined {
  const stopped = epoch(record.stoppedAt?.at ?? null)
  const next = record.reopens.find((reopen) => epoch(reopen.at) > stopped)
  return next === undefined ? undefined : epoch(next.at) / 1000
}

/**
 * The times the run was stopped between generations, in epoch seconds: from each generation's end (its Runtime
 * settle, else its stop) to the reopen that started the next. A generation with neither has no end to cut at.
 */
export function stoppedBetweenGenerations(record: RunRecord): { stopped: Array<{ generation: number; from: number; to: number }>; unknowns: string[] } {
  const stopped: Array<{ generation: number; from: number; to: number }> = []
  const unknowns: string[] = []
  for (const generation of record.generations) {
    const next = record.generations.find((candidate) => candidate.generation === generation.generation + 1)
    if (next?.reopen == null) continue
    const ended = epoch(generation.runtime?.settledAt ?? generation.stoppedAt?.at ?? null)
    const reopened = epoch(next.reopen.at)
    if (!Number.isFinite(ended)) unknowns.push(`generation ${generation.generation} has no recorded end; its idle time runs on to the reopen`)
    else if (reopened > ended) stopped.push({ generation: generation.generation, from: ended / 1000, to: reopened / 1000 })
  }
  return { stopped, unknowns }
}

/** Epoch seconds the run last ended, for a reader that would otherwise run an unfinished node to now. */
export function runEndSeconds(record: RunRecord): number | undefined {
  const ended = epoch(record.endedAt)
  return Number.isFinite(ended) ? ended / 1000 : undefined
}

const clock = (iso: string | null): string => (iso === null ? '?' : `${iso.slice(0, 16).replace('T', ' ')}Z`)
const hhmm = (iso: string | null): string => (iso === null ? '?' : `${iso.slice(11, 16)}Z`)
const short = (commit: string | null): string => (commit === null ? 'no commit' : commit.slice(0, 7))
const oneLine = (text: string, max = 240): string => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const count = (n: number | null): string => {
  if (n === null) return '?'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
const minutesBetween = (from: string | null, to: string | null): number | null => {
  const ms = epoch(to) - epoch(from)
  return Number.isFinite(ms) ? Math.round(ms / 6000) / 10 : null
}
/** A wall time as a person reads it: seconds, minutes or hours. */
const wall = (ms: number | null): string => (ms === null ? '?' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`)
/** Dollars to the cent, or to a hundredth of a cent below one. */
const usd = (value: number): string => `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
/** `12.5m` before the stop, or how long after it. */
const sinceStop = (minutes: number | null): string => (minutes === null ? '?' : minutes < 0 ? `${-minutes}m after it` : `${minutes}m`)

function checkText(check: RunCheckRecord): string {
  if (check.solved === true) return `solved on ${short(check.commit)}`
  const stages = check.reached !== null && check.of !== null
    ? `reached ${check.reached} of ${check.of}${check.stages?.length ? ` (${check.stages.join(', ')})` : ''}`
    : 'no stage score'
  const failed = check.reason === null ? '' : `; failed${check.failedStage ? ` ${check.failedStage}` : ''}: ${oneLine(check.reason, 200)}`
  return `${stages} on ${short(check.commit)}${failed}${check.known === false ? ' (check unknown)' : ''}`
}

function tokensText(tokens: RunSettleRecord['tokens']): string {
  if (tokens === null) return 'tokens unrecorded'
  const split = `(in ${count(tokens.input)}, out ${count(tokens.output)}, cached ${count(tokens.cached)})`
  if (tokens.status === 'known' || (tokens.status === null && tokens.total !== null)) return `tokens ${count(tokens.total)} ${split}`
  if (tokens.status === 'lower-bound') return `tokens at least ${count(tokens.floor)} ${split}, ${tokens.reason ?? 'a lower bound'}`
  return `tokens unknown${tokens.reason ? `: ${tokens.reason}` : ''}`
}

function stopLines(stop: RunStopRecord, runtimeSettledAt: string | null, runtimeReason: string | null): string[] {
  const lines = [`stop: requested ${clock(stop.requestedAt)} by ${stop.source ?? 'an unnamed source'}${stop.operator ? ` (operator ${stop.operator})` : ''}: ${stop.reason ? oneLine(stop.reason) : 'no reason recorded'}`]
  const applied = stop.applied
  lines.push(applied
    ? `  Runtime acknowledged it ${hhmm(applied.observedAt)}${applied.path ? ` via ${applied.path}` : ''}${applied.afterMs === null ? '' : ` after ${Math.round(applied.afterMs / 100) / 10}s`}` +
      ` (effect ${applied.effect ?? 'unknown'}${applied.deadlineExceeded ? ', past its deadline' : ''}${applied.detail ? `: ${oneLine(applied.detail, 160)}` : ''})`
    : '  Runtime recorded no acknowledgement of the request')
  const late = minutesBetween(runtimeSettledAt, stop.requestedAt)
  if (late !== null && late > 0) lines.push(`  the request came ${late}m after Runtime had settled the run (${runtimeReason ?? 'reason not retained'})`)
  return lines
}

/** An earlier generation on one line: how it started, its stop, its progress, Runtime's settle and the root stream. */
function generationLine(generation: RunGeneration): string {
  const started = generation.reopen
    ? `reopened ${clock(generation.reopen.at)} by ${generation.reopen.operator ?? 'an unnamed operator'}`
    : `pressed ${clock(generation.startedAt)}`
  const { stop, stoppedAt, runtime, rootStream } = generation
  const stopText = stop
    ? `stop requested ${clock(stop.requestedAt)} by ${stop.source ?? 'an unnamed source'}${stop.operator ? ` (operator ${stop.operator})` : ''}: ${oneLine(stop.reason ?? 'no reason recorded', 200)}`
    : stoppedAt ? `stopped at its ${stoppedAt.what} ${clock(stoppedAt.at)}` : 'no stop recorded'
  const settled = runtime?.settledAt || runtime?.kind ? `Runtime settled ${runtime.settledAt ? `${clock(runtime.settledAt)} ` : ''}${runtime.kind ?? 'result not retained'}${runtime.reason ? `/${runtime.reason}` : ''}` : 'no Runtime settle'
  const stream = rootStream?.lastAt && epoch(rootStream.lastAt) >= epoch(generation.startedAt) ? `root stream last event ${clock(rootStream.lastAt)}` : 'no root stream event in it'
  return `generation ${generation.generation}, ${started}: ${stopText}; ${progressText(generation.checks, generation.submissions)}; ${settled}; ${stream}`
}

function progressText(checks: readonly RunCheckRecord[], submissions: RunRecord['submissions']): string {
  const last = checks.at(-1)
  return `${checks.length} check(s), ${submissions.length} submission(s)${last ? `; last ${clock(last.at)} ${last.kind}: ${checkText(last)}` : ''}`
}

/** The run's own records as text lines: the stop, the progress at it, the quiet before it, the settle, and any reopen after it. */
export function renderRunRecordLines(record: RunRecord, quiet: readonly RunQuiet[] = []): string[] {
  const lines: string[] = []
  const { settle, runtime, stop, stoppedAt } = record
  const runtimeText = runtime?.settledAt || runtime?.kind
    ? `Runtime settled ${runtime.settledAt ? `${hhmm(runtime.settledAt)} ` : ''}${runtime.kind ? `${runtime.kind}${runtime.reason ? `/${runtime.reason}` : ''}` : '(result not retained)'}`
    : 'no Runtime settle'
  // A settled run that was never reopened is where its settle record says; any other state is news.
  const state = record.state && (record.state.value !== 'settled' || record.reopens.length > 0)
    ? `; now ${record.state.value ?? 'in a state not recorded'} since ${clock(record.state.at)}`
    : ''
  lines.push(`run ${record.runId}: pressed ${clock(record.pressedAt)}; ${runtimeText}; ${settle ? `settle record ${clock(settle.at)} ${settle.status ?? 'status unknown'}` : 'no settle record'}${state}`)
  // The generations before the one read, a line each; then the one read in full; then the reopens after it.
  const stopS = stoppedAt === null ? Number.NaN : epoch(stoppedAt.at)
  const read = record.generations.find((candidate) => candidate.stoppedAt !== null && candidate.stoppedAt.at === stoppedAt?.at) ?? record.generations[0]
  const nextReopen = record.reopens.find((reopen) => epoch(reopen.at) > stopS) ?? null
  const boundary = nextReopen === null ? Number.POSITIVE_INFINITY : epoch(nextReopen.at)
  for (const earlier of record.generations) {
    if (read === undefined || earlier.generation >= read.generation) break
    lines.push(generationLine(earlier))
  }
  if (read?.reopen) lines.push(`generation ${read.generation}: reopened ${clock(read.reopen.at)} by ${read.reopen.operator ?? 'an unnamed operator'}: ${oneLine(read.reopen.reason ?? 'no reason recorded', 200)}`)
  if (stop) lines.push(...stopLines(stop, runtime?.settledAt ?? null, runtime?.reason ?? null))
  else lines.push(`stop: no stop request recorded${settle?.reason ? `; settle reason: ${oneLine(settle.reason)}` : ''}`)
  if (runtime?.failure) lines.push(`  Runtime failure record ${clock(runtime.failure.at)}: ${oneLine(runtime.failure.message ?? 'no message', 200)}`)
  const checks = record.checks.filter((check) => epoch(check.at) < boundary)
  const submissions = record.submissions.filter((submission) => epoch(submission.at) < boundary)
  lines.push(`progress at stop: ${progressText(checks, submissions)}`)
  const ratio = (check: RunCheckRecord): number => (check.reached ?? 0) / (check.of || 1)
  const best = checks.filter((check) => check.reached !== null).reduce<RunCheckRecord | null>((top, check) => (top === null || ratio(check) > ratio(top) ? check : top), null)
  const lastCheck = checks.at(-1)
  if (best && lastCheck && ratio(best) > ratio(lastCheck)) lines.push(`  best: ${clock(best.at)} ${checkText(best)}`)
  if (submissions.length > 0) {
    const shown = submissions.slice(-4).map((submission) => `${submission.entity ?? 'candidate'} ${hhmm(submission.at)} (${short(submission.commit)})`)
    lines.push(`  submissions: ${submissions.length > shown.length ? `${submissions.length - shown.length} earlier, then ` : ''}${shown.join(', ')}`)
  }
  // In a generation a reopen started, an act or event before that reopen belongs to an earlier one.
  const reopenedAt = read?.reopen ? epoch(read.reopen.at) : Number.NEGATIVE_INFINITY
  const parts = quiet.map((q) => {
    const when = q.lastActivity === null ? 'no act recorded'
      : epoch(q.lastActivity) < reopenedAt ? `no act since the reopen (last act ${clock(q.lastActivity)})`
        : `${sinceStop(q.minutesBeforeStop)} (last act ${hhmm(q.lastActivity)})`
    return `${q.label}${q.state ? ` [${q.state}]` : ''} ${when}`
  })
  const stream = record.rootStream
  if (stream && stoppedAt) {
    const event = `${stream.lastKind ? ` ${stream.lastKind}` : ''}${stream.lastSeq === null ? '' : `, seq ${stream.lastSeq}`}`
    parts.push(epoch(stream.lastAt) < reopenedAt
      ? `Runtime root stream: no event since the reopen (last event ${clock(stream.lastAt)}${event})`
      : `Runtime root stream ${sinceStop(minutesBetween(stream.lastAt, stoppedAt.at))} (last event ${hhmm(stream.lastAt)}${event})`)
  }
  if (parts.length > 0 && stoppedAt) lines.push(`quiet before the ${stoppedAt.what} ${hhmm(stoppedAt.at)}: ${parts.join('; ')}`)
  if (settle && settle.from === 'procedure-record.json') {
    lines.push(`settle record: wall ${wall(settle.wallMs)} · ${tokensText(settle.tokens)}` +
      ` · compute ${settle.computeUsd === null ? 'unknown' : usd(settle.computeUsd)}` +
      `${settle.listUsd === null ? '' : ` · list ${usd(settle.listUsd)}`}${settle.usdBasis ? ` (${settle.usdBasis})` : ''}` +
      `${settle.model ? ` · ${settle.model}` : ''}`)
  }
  for (const [index, reopen] of record.reopens.entries()) {
    if (epoch(reopen.at) <= stopS) continue
    const until = record.reopens[index + 1] ? epoch(record.reopens[index + 1]!.at) : Number.POSITIVE_INFINITY
    const within = <T extends { readonly at: string }>(rows: readonly T[]): T[] => rows.filter((row) => epoch(row.at) >= epoch(reopen.at) && epoch(row.at) < until)
    lines.push(`reopened ${clock(reopen.at)} by ${reopen.operator ?? 'an unnamed operator'}: ${oneLine(reopen.reason ?? 'no reason recorded')}`)
    lines.push(`  since: ${progressText(within(record.checks), within(record.submissions))}`)
  }
  for (const gap of record.unread) lines.push(`  unread: ${gap.record}: ${oneLine(gap.reason, 160)}`)
  return lines
}
