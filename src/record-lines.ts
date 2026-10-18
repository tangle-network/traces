/**
 * Where a fact came from, as `file:line`: one line scan of a session's own
 * JSONL files. The shared reader's spans carry each tool call's id
 * (`gen_ai.tool.call.id`) but no source offsets (U18), so a facts reader that
 * wants to quote or cite a record otherwise has to search the files itself.
 * Only a line naming a wanted id or timestamp is parsed.
 */
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { OtlpSpan } from './otlp.js'
import type { SessionFacts, SessionMatch } from './session-facts.js'

/** One record of a session file: its absolute path and 1-based line. */
export interface RecordLine {
  readonly file: string
  readonly line: number
}

/** A record on the facts sheet: `file` only when it is not the session's `recordFile` (a subagent's sidechain). */
export type SheetRecord = { readonly file?: string; readonly line: number }

export interface RecordLinesQuery {
  /** Tool call ids to locate. */
  readonly callIds: ReadonlySet<string>
  /** Call ids whose output text {@link RecordLines.outputText} should return. */
  readonly outputTextFor?: ReadonlySet<string>
  /** Typed turns to locate, by their record time and text. */
  readonly turns?: ReadonlyArray<{ readonly at: string; readonly text: string }>
}

export interface RecordLines {
  /** The record that made the call. */
  call(id: string): RecordLine | null
  /** The record holding the call's result, else null. */
  output(id: string): RecordLine | null
  /** The full text of the call's result, for ids in `outputTextFor`. */
  outputText(id: string): string | null
  /** The record of a typed turn, by the `at` and `text` the facts give it. */
  turn(at: string, text: string): RecordLine | null
}

/**
 * Codex `call_id`, Claude Code `tool_use_id`, a Claude `tool_use` block's own `id`, and an OTLP
 * span's `gen_ai.tool.call.id`, as a flat contract row's attribute or an OTLP/JSON key-value pair.
 */
const CALL_ID =
  /"(?:call_id|tool_use_id)":"([^"]+)"|"id":"(toolu_[^"]+)"|"gen_ai\.tool\.call\.id":\s*"([^"]+)"|"key":\s*"gen_ai\.tool\.call\.id",\s*"value":\s*\{\s*"stringValue":\s*"([^"]+)"/gu
/** A Codex `*_output` item or a Claude `tool_result` block: the record holding a call's result. */
const OUTPUT_RECORD = /"type":"(?:[a-z_]+_output|tool_result)"/u
const TIMESTAMP = /"timestamp":"([^"]+)"/u
const USER_ROLE = /"role":"user"/u

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim()

/** Every string under `value`, depth first. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, into)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, into)
  return into
}

/** The result text an output record carries: Codex `payload.output`, or the Claude `tool_result` block for `id`. */
function resultText(record: unknown, id: string): string | null {
  if (!record || typeof record !== 'object') return null
  const payload = (record as { payload?: { output?: unknown } }).payload
  if (payload && typeof payload.output === 'string') return payload.output
  const content = (record as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  const block = content.find((item) => item && typeof item === 'object' && (item as { tool_use_id?: unknown }).tool_use_id === id) as
    { content?: unknown } | undefined
  if (block === undefined) return null
  return typeof block.content === 'string' ? block.content : strings(block.content).join('\n')
}

/**
 * The files one session's records live in: `path`, and for a Claude Code
 * transcript its subagents' sidechains (`<id>/subagents/*.jsonl`).
 */
export async function sessionRecordFiles(path: string): Promise<string[]> {
  const files = [path]
  if (!path.endsWith('.jsonl')) return files
  const subagents = join(dirname(path), basename(path, '.jsonl'), 'subagents')
  const names = await readdir(subagents).catch(() => [] as string[])
  for (const name of names.filter((entry) => entry.endsWith('.jsonl')).sort()) files.push(join(subagents, name))
  return files
}

/** Scan `files` once and locate what `query` names. A file that cannot be read locates nothing. */
export async function readRecordLines(files: readonly string[], query: RecordLinesQuery): Promise<RecordLines> {
  const calls = new Map<string, RecordLine>()
  const outputs = new Map<string, RecordLine>()
  const texts = new Map<string, string>()
  const wantedTurns = new Map<number, string[]>()
  for (const turn of query.turns ?? []) {
    const ms = Date.parse(turn.at)
    if (Number.isFinite(ms)) wantedTurns.set(ms, [...(wantedTurns.get(ms) ?? []), flat(turn.text)])
  }
  // Codex writes a typed turn as a `response_item` message and an `event_msg`; the item is the record.
  const turns = new Map<string, { at: RecordLine; item: boolean }>()
  // Nothing to locate reads nothing: a collector's file of long lines with no call ids costs no scan.
  const scan = query.callIds.size > 0 || wantedTurns.size > 0 ? files : []
  for (const file of scan) {
    let line = 0
    try {
      const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const raw of lines) {
        line += 1
        const here = { file, line }
        let parsed: unknown
        const parse = (): unknown => {
          if (parsed === undefined) {
            try {
              parsed = JSON.parse(raw) as unknown
            } catch {
              parsed = null
            }
          }
          return parsed
        }
        const isOutput = OUTPUT_RECORD.test(raw)
        for (const match of raw.matchAll(CALL_ID)) {
          const id = match[1] ?? match[2] ?? match[3] ?? match[4]!
          if (!query.callIds.has(id)) continue
          if (!isOutput) {
            if (!calls.has(id)) calls.set(id, here)
          } else if (!outputs.has(id)) {
            outputs.set(id, here)
            if (query.outputTextFor?.has(id)) {
              const text = resultText(parse(), id)
              if (text !== null) texts.set(id, text)
            }
          }
        }
        if (wantedTurns.size === 0 || !USER_ROLE.test(raw)) continue
        const stamp = TIMESTAMP.exec(raw)?.[1]
        const wanted = stamp === undefined ? undefined : wantedTurns.get(Date.parse(stamp))
        if (wanted === undefined) continue
        const record = parse()
        if (record === null) continue
        const said = strings(record).map(flat)
        const item = (record as { type?: unknown }).type === 'response_item'
        for (const text of wanted) {
          const key = `${Date.parse(stamp!)}\0${text}`
          const prior = turns.get(key)
          if ((prior === undefined || (item && !prior.item)) && said.some((value) => value.includes(text))) turns.set(key, { at: here, item })
        }
      }
    } catch {
      // An unreadable file cites nothing; the facts themselves already say what was read.
    }
  }
  return {
    call: (id) => calls.get(id) ?? null,
    output: (id) => outputs.get(id) ?? null,
    outputText: (id) => texts.get(id) ?? null,
    turn: (at, text) => turns.get(`${Date.parse(at)}\0${flat(text)}`)?.at ?? null,
  }
}

/** What citing one session's facts needs: the file it was read from, and each tool span's call id. */
export interface SessionCiting {
  readonly path: string
  /** Span id to `gen_ai.tool.call.id`, for the session's tool spans. */
  readonly callIds: ReadonlyMap<string, string>
}

/**
 * Span id to call id for every span that names a tool call: the shared reader's
 * `gen_ai.tool.call.id`, else traces' own Codex reader's `tool:<call_id>` source span id.
 */
export function callIdsOf(spans: readonly OtlpSpan[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const span of spans) {
    const shared = span.attributes['gen_ai.tool.call.id']
    const native = span.attributes['traces.codex.source_span_id']
    const id = typeof shared === 'string' && shared !== ''
      ? shared
      : typeof native === 'string' && native.startsWith('tool:') ? native.slice('tool:'.length) : undefined
    if (id !== undefined && id !== '') ids.set(span.span_id, id)
  }
  return ids
}

/** The last line of `text` that is not blank, else null. */
function lastLine(text: string): string | null {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
  return lines.at(-1) ?? null
}

type Cited<T> = T & { readonly record: RecordLine | null }

/**
 * `sessions` and `matches` with the record each fact came from: `record` on
 * every human turn, on the first failure (the failing call's result, else the
 * call), on every commands row (its latest run's result) and each of its
 * `nonZeroExits`, and on every changed file (the call that first changed it);
 * a command `--match` row also gets `lastLine`, the last line of the command's
 * full output when its call ran it alone. A session's own file is named once,
 * as `recordFile`, so a record in it is `{line}`; a match row's is `{file, line}`.
 * Sessions without a {@link SessionCiting} are left as they are.
 */
export async function citeFacts<M extends SessionMatch>(
  sessions: readonly SessionFacts[],
  matches: readonly M[],
  citings: ReadonlyMap<string, SessionCiting>,
): Promise<{ sessions: unknown[]; matches: Array<M | Cited<M> & { readonly lastLine: string | null }> }> {
  const citedSessions: unknown[] = []
  const citedMatches = new Map<M, Cited<M> & { readonly lastLine: string | null }>()
  for (const facts of sessions) {
    const key = facts.sessionId ?? facts.traceId
    const citing = citings.get(key)
    if (citing === undefined) {
      citedSessions.push(facts)
      continue
    }
    const own = matches.filter((match) => match.kind === 'command' && match.sessionId === facts.sessionId)
    const wanted = (spanIds: Iterable<string | undefined>): string[] =>
      [...spanIds].flatMap((spanId) => {
        const id = spanId === undefined ? undefined : citing.callIds.get(spanId)
        return id === undefined ? [] : [id]
      })
    const failure = { spanId: 'spanId' in facts.firstFailure && typeof facts.firstFailure.spanId === 'string' ? facts.firstFailure.spanId : undefined }
    const commands = facts.commands.value ?? []
    const files = facts.changedFiles.value ?? []
    const outputTextFor = new Set(wanted(own.map((match) => match.spanId)))
    // A native `file.change` span comes first in a changed file's spanIds but is no tool call; cite the first call.
    const firstCall = (file: { readonly spanIds: readonly string[] }): string | undefined =>
      file.spanIds.find((spanId) => citing.callIds.has(spanId))
    const lines = await readRecordLines(await sessionRecordFiles(citing.path), {
      callIds: new Set([
        ...wanted([failure.spanId]),
        ...wanted(commands.flatMap((row) => [row.lastSpanId, ...row.nonZeroExits.map((exit) => exit.spanId)])),
        ...wanted(files.map(firstCall)),
        ...outputTextFor,
      ]),
      outputTextFor,
      turns: facts.humanTurns.value ?? [],
    })
    const result = (spanId: string | undefined): RecordLine | null => {
      const id = spanId === undefined ? undefined : citing.callIds.get(spanId)
      return id === undefined ? null : lines.output(id) ?? lines.call(id)
    }
    const call = (spanId: string | undefined): RecordLine | null => {
      const id = spanId === undefined ? undefined : citing.callIds.get(spanId)
      return id === undefined ? null : lines.call(id)
    }
    // The sheet names the session's own file once, as `recordFile`; a record there is just its line.
    const short = (record: RecordLine | null): SheetRecord | null =>
      record === null ? null : record.file === citing.path ? { line: record.line } : record
    for (const match of own) {
      const id = citing.callIds.get(match.spanId)
      // Only a call that ran this one command has output of its own: a script's or a chain's is shared.
      const text = id === undefined || match.failed == null ? null : lines.outputText(id)
      citedMatches.set(match, { ...match, record: result(match.spanId), lastLine: text === null ? null : lastLine(text) })
    }
    citedSessions.push({
      ...facts,
      recordFile: citing.path,
      humanTurns: facts.humanTurns.value === null
        ? facts.humanTurns
        : { ...facts.humanTurns, value: facts.humanTurns.value.map((turn) => ({ ...turn, record: short(lines.turn(turn.at, turn.text)) })) },
      changedFiles: facts.changedFiles.value === null
        ? facts.changedFiles
        : { ...facts.changedFiles, value: files.map((file) => ({ ...file, record: short(call(firstCall(file))) })) },
      commands: facts.commands.value === null
        ? facts.commands
        : {
            ...facts.commands,
            // `lastSpanId` only finds the latest run's record; the row carries the record instead.
            value: commands.map(({ lastSpanId, ...row }) => ({
              ...row,
              record: short(result(lastSpanId)),
              nonZeroExits: row.nonZeroExits.map((exit) => ({ ...exit, record: short(result(exit.spanId)) })),
            })),
          },
      firstFailure: failure.spanId === undefined ? facts.firstFailure : { ...facts.firstFailure, record: short(result(failure.spanId)) },
    })
  }
  return { sessions: citedSessions, matches: matches.map((match) => citedMatches.get(match) ?? match) }
}
