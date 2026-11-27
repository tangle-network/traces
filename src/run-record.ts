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
 *
 * Nothing here classifies a stop or a run: the requester, the operator, the reason and Runtime's
 * terminal reason are reported as recorded. A record that is absent is absent; one that cannot be
 * read is named in `unread`, never read as empty.
 */
import { open, readFile, type FileHandle } from 'node:fs/promises'
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

export interface RunRecord {
  readonly runId: string
  /** The records read, by their path in the run directory. */
  readonly read: readonly string[]
  readonly unread: ReadonlyArray<{ readonly record: string; readonly reason: string }>
  readonly pressedAt: string | null
  /** Runtime's settle result, when Runtime settled the run, and its failure record. */
  readonly runtime: {
    readonly kind: string | null
    readonly reason: string | null
    readonly settledAt: string | null
    readonly failure: { readonly at: string | null; readonly message: string | null } | null
  } | null
  /** The last event Runtime's root stream recorded. */
  readonly rootStream: { readonly lastAt: string | null; readonly lastSeq: number | null; readonly lastKind: string | null } | null
  readonly stop: RunStopRecord | null
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
  /** Epoch seconds the last span that is not a session container ended; null when it recorded none. */
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

/** When the run stopped: the first of the stop request, Runtime's settle and the settle record. */
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

  /** The last event of a JSONL stream, read from its last megabyte: a stream can be tens of megabytes. */
  async lastLine(name: string): Promise<Json | null> {
    let handle: FileHandle
    try {
      handle = await open(join(this.dir, name), 'r')
    } catch (error) {
      if (!missing(error)) this.unread.push({ record: name, reason: errorText(error) })
      return null
    }
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, 1 << 20)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      this.read.push(name)
      const lines = buffer.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!.trim()
        if (!line) continue
        try {
          const value: unknown = JSON.parse(line)
          if (isObject(value) && str(value.at) !== null) return value
        } catch {
          // a torn last write, or the cut first line of the tail
        }
      }
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

async function readStop(reader: Reader, result: Json | null): Promise<RunStopRecord | null> {
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
      from: requestFile,
    }
  }
  // A settle result written before the request file existed still names who cancelled.
  if (result && result.reason === 'cancelled' && (str(result.cancellationReason) !== null || str(result.operationId) !== null)) {
    return {
      requestedAt: null,
      source: str(result.source),
      operator: str(result.operator),
      operationId: str(result.operationId),
      reason: str(result.cancellationReason),
      applied: null,
      from: 'result.json',
    }
  }
  return null
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
  const stop = await readStop(reader, result)
  const last = await reader.lastLine('root-stream.jsonl')
  if (reader.read.length === 0 && reader.unread.length === 0) return null
  const failureError = failure && isObject(failure.error) ? failure.error : null
  const firstAt = (event: string): string | null => str(lifecycle.find((row) => row.event === event)?.at)
  return {
    runId: str(procedure?.runId) ?? str(failure?.runId) ?? basename(dir),
    read: [...new Set(reader.read)],
    unread: reader.unread,
    pressedAt: firstAt('press'),
    runtime: result || failure ? {
      kind: result ? str(result.kind) : null,
      reason: result ? str(result.reason) : null,
      settledAt: firstAt('runtime.settled'),
      failure: failure ? { at: str(failure.at), message: failureError ? str(failureError.message) : null } : null,
    } : null,
    rootStream: last ? { lastAt: str(last.at), lastSeq: num(last.seq), lastKind: isObject(last.event) ? str(last.event.kind) ?? str(last.event.type) : null } : null,
    stop,
    settle: readSettle(procedure, lifecycle),
    checks,
    submissions: lifecycle.flatMap((row) => {
      const at = str(row.at)
      if (row.event !== 'submit' || at === null) return []
      const evidence = isObject(row.evidence) ? row.evidence : {}
      return [{ at, entity: str(row.entity), commit: str(evidence.commit) }]
    }),
  }
}

const epoch = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso))

/** The first of the stop request, Runtime's settle and the settle record: when the agents were stopped. */
export function stopTime(record: RunRecord): RunStopTime | null {
  const candidates: RunStopTime[] = []
  if (record.stop?.requestedAt) candidates.push({ at: record.stop.requestedAt, what: 'stop request' })
  if (record.runtime?.settledAt) candidates.push({ at: record.runtime.settledAt, what: 'Runtime settle' })
  if (record.settle?.at) candidates.push({ at: record.settle.at, what: 'settle record' })
  const known = candidates.filter((candidate) => Number.isFinite(epoch(candidate.at)))
  return known.reduce<RunStopTime | null>((first, candidate) => (first === null || epoch(candidate.at) < epoch(first.at) ? candidate : first), null)
}

/** Each agent's last act against the stop. */
export function quietBeforeStop(record: RunRecord, nodes: readonly RunNodeActivity[]): RunQuiet[] {
  const stop = stopTime(record)
  const stopS = stop === null ? null : epoch(stop.at) / 1000
  return nodes.map((node) => ({
    node: node.id,
    label: node.label,
    state: node.state,
    lastActivity: node.lastActivity === null ? null : new Date(node.lastActivity * 1000).toISOString(),
    minutesBeforeStop: node.lastActivity === null || stopS === null ? null : Math.round((stopS - node.lastActivity) / 6) / 10,
  }))
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

/** The run's own records as text lines: the stop, the progress at it, the quiet before it, the settle. */
export function renderRunRecordLines(record: RunRecord, quiet: readonly RunQuiet[] = []): string[] {
  const lines: string[] = []
  const { settle, runtime, stop, checks, submissions } = record
  const runtimeText = runtime?.kind
    ? `Runtime settled ${runtime.settledAt ? `${hhmm(runtime.settledAt)} ` : ''}${runtime.kind}${runtime.reason ? `/${runtime.reason}` : ''}`
    : 'no Runtime result'
  lines.push(`run ${record.runId}: pressed ${clock(record.pressedAt)}; ${runtimeText}; ${settle ? `settle record ${clock(settle.at)} ${settle.status ?? 'status unknown'}` : 'no settle record'}`)
  if (stop) {
    lines.push(`stop: requested ${clock(stop.requestedAt)} by ${stop.source ?? 'an unnamed source'}${stop.operator ? ` (operator ${stop.operator})` : ''}: ${stop.reason ? oneLine(stop.reason) : 'no reason recorded'}`)
    const applied = stop.applied
    lines.push(applied
      ? `  Runtime acknowledged it ${hhmm(applied.observedAt)}${applied.path ? ` via ${applied.path}` : ''}${applied.afterMs === null ? '' : ` after ${Math.round(applied.afterMs / 100) / 10}s`}` +
        ` (effect ${applied.effect ?? 'unknown'}${applied.deadlineExceeded ? ', past its deadline' : ''}${applied.detail ? `: ${oneLine(applied.detail, 160)}` : ''})`
      : '  Runtime recorded no acknowledgement of the request')
    const late = minutesBetween(runtime?.settledAt ?? null, stop.requestedAt)
    if (late !== null && late > 0) lines.push(`  the request came ${late}m after Runtime had settled the run (${runtime?.reason ?? 'reason unrecorded'})`)
  } else {
    lines.push(`stop: no stop request recorded${settle?.reason ? `; settle reason: ${oneLine(settle.reason)}` : ''}`)
  }
  if (runtime?.failure) lines.push(`  Runtime failure record ${clock(runtime.failure.at)}: ${oneLine(runtime.failure.message ?? 'no message', 200)}`)
  if (checks.length === 0) lines.push(`progress at stop: no check recorded, ${submissions.length} submission(s)`)
  else {
    const last = checks.at(-1)!
    lines.push(`progress at stop: ${checks.length} check(s), ${submissions.length} submission(s); last ${clock(last.at)} ${last.kind}: ${checkText(last)}`)
    const ratio = (check: RunCheckRecord): number => (check.reached ?? 0) / (check.of || 1)
    const best = checks.filter((check) => check.reached !== null).reduce<RunCheckRecord | null>((top, check) => (top === null || ratio(check) > ratio(top) ? check : top), null)
    if (best && ratio(best) > ratio(last)) lines.push(`  best: ${clock(best.at)} ${checkText(best)}`)
  }
  if (submissions.length > 0) {
    const shown = submissions.slice(-4).map((submission) => `${submission.entity ?? 'candidate'} ${hhmm(submission.at)} (${short(submission.commit)})`)
    lines.push(`  submissions: ${submissions.length > shown.length ? `${submissions.length - shown.length} earlier, then ` : ''}${shown.join(', ')}`)
  }
  const stopAt = stopTime(record)
  const parts = quiet.map((q) => {
    const when = q.lastActivity === null ? 'no act recorded' : `${sinceStop(q.minutesBeforeStop)} (last act ${hhmm(q.lastActivity)})`
    return `${q.label}${q.state ? ` [${q.state}]` : ''} ${when}`
  })
  const stream = record.rootStream
  if (stream && stopAt) {
    parts.push(`Runtime root stream ${sinceStop(minutesBetween(stream.lastAt, stopAt.at))} (last event ${hhmm(stream.lastAt)}${stream.lastKind ? ` ${stream.lastKind}` : ''}${stream.lastSeq === null ? '' : `, seq ${stream.lastSeq}`})`)
  }
  if (parts.length > 0 && stopAt) lines.push(`quiet before the ${stopAt.what} ${hhmm(stopAt.at)}: ${parts.join('; ')}`)
  if (settle && settle.from === 'procedure-record.json') {
    lines.push(`settle record: wall ${wall(settle.wallMs)} · ${tokensText(settle.tokens)}` +
      ` · compute ${settle.computeUsd === null ? 'unknown' : usd(settle.computeUsd)}` +
      `${settle.listUsd === null ? '' : ` · list ${usd(settle.listUsd)}`}${settle.usdBasis ? ` (${settle.usdBasis})` : ''}` +
      `${settle.model ? ` · ${settle.model}` : ''}`)
  }
  for (const gap of record.unread) lines.push(`  unread: ${gap.record}: ${oneLine(gap.reason, 160)}`)
  return lines
}
