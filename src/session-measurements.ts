import { basename } from 'node:path'
import { INTERRUPT_TEXT } from './adapters/actor.js'
import { ACTOR_ATTR } from './adapters/conversation.js'
import { canonicalJson } from './adapters/tool-io.js'
import { INHERITED_SOURCE_ATTR, INHERITED_SPAN_ATTR } from './adapters/provenance.js'
import type { OtlpSpan } from './otlp.js'
import type { SessionFact } from './session-facts.js'
import { describeSessionRelationship, type SessionRelationship } from './session-relationship.js'
import { commandLines, commandTextFromInput } from './shell-commands.js'
import { skillUseOfSpans, type SkillUseCount } from './skill-usage.js'

/** Coverage counts refer to observed records, never an assertion that capture was complete. */
export interface CoveredMeasurement {
  readonly total: number | null
  readonly measured: number
  readonly eligible: number
  readonly unavailable: string | null
}
export interface ToolMeasurement {
  readonly name: string
  readonly calls: number
  readonly outcomes: { readonly ok: number; readonly error: number; readonly unset: number }
  readonly inputBytes: CoveredMeasurement
  readonly outputBytes: CoveredMeasurement
  /** Recorded call-to-result interval. Not CPU time or model latency; overlaps may occur. */
  readonly callToResultMs: CoveredMeasurement
  readonly spanIds: readonly string[]
}
export interface CompactionMeasurement {
  readonly spanId: string
  readonly at: string
  readonly sincePreviousMs: number | null
  readonly latencyMs: number | null
  readonly tokensBefore: number | null
  readonly tokensAfter: number | null
}
export interface ContentFootprint {
  readonly spanId: string
  readonly field: string
  readonly bytes: number
  readonly lines: number
  readonly entries: number | null
  /** Source representation, not the reconstructed full model request. */
  readonly scope: 'captured-attribute'
}
/** A gap this long with no record of the session's own is a stall, unless a turn sent in ended it. */
export const STALL_MINUTES = 10

/** Failed runs of one command in a row that make a streak: a loop is 3 identical calls. */
export const STREAK_RUNS = 3

/** Characters of a streak's command the sheet keeps. */
const COMMAND_TEXT_CAP = 300

/** One command that failed {@link STREAK_RUNS} or more times in a row. */
export interface FailingStreak {
  /** The command as it ran, whitespace collapsed, at most 300 characters; null when content was not requested. */
  readonly command: string | null
  readonly tool: string
  readonly runs: number
  /** From the first failed run's start to the last one's end. */
  readonly minutes: number
  readonly at: string
  readonly spanIds: readonly string[]
}

/** A gap of {@link STALL_MINUTES} or more in the session's own records that no turn sent in ended. */
export interface Stall {
  /** The last record before the gap. */
  readonly at: string
  readonly minutes: number
  /** `waiting on a command` when a tool result ended the gap, else `idle`. */
  readonly kind: 'waiting on a command' | 'idle'
  /** The span whose record ended the gap. */
  readonly spanId: string
}

/** Commands the session ran more than once, the way `reflect/scripts/self-audit` counts rework. */
export interface RepeatedCommands {
  /** Distinct commands run more than once. */
  readonly commands: number
  /** Runs beyond each command's first. */
  readonly extraRuns: number
}

/**
 * Where the session's own agent lost time. `minutes` is the time inside a
 * failing streak or a stall, each minute counted once, and null with
 * `unavailable` when either cannot be read from the spans.
 */
export interface SessionWaste {
  readonly minutes: number | null
  readonly unavailable: string | null
  readonly failingStreaks: SessionFact<readonly FailingStreak[]>
  readonly stalls: SessionFact<readonly Stall[]>
  /** `git revert` and `git reset --hard` commands run. */
  readonly rollbacks: SessionFact<number>
  readonly repeatedCommands: SessionFact<RepeatedCommands>
}

/**
 * Measures beside the sheet's counts. Token counts and cost are the sheet's own
 * `tokens` and `cost` (`execution.ts`), and spawns are its `subagents`; none is
 * measured a second way here.
 */
export interface SessionMeasurements {
  /** Skills used, by name and kind, counted by `skill-usage.ts`'s classifier, the one `traces skills` uses. */
  readonly skills: Readonly<Record<string, SkillUseCount>>
  readonly waste: SessionWaste
  /** Minutes between the session's own records, each gap capped at {@link STALL_MINUTES}. */
  readonly activeMinutes: SessionFact<number>
  readonly relationship: SessionRelationship
  readonly tools: readonly ToolMeasurement[]
  readonly compactions: SessionFact<readonly CompactionMeasurement[]>
  readonly contextFootprints: readonly ContentFootprint[]
}
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

function measure(spans: readonly OtlpSpan[], read: (span: OtlpSpan) => number | null, reason: string): CoveredMeasurement {
  let total = 0
  let measured = 0
  for (const span of spans) {
    const value = read(span)
    if (value !== null) { total += value; measured += 1 }
  }
  return {
    total: measured > 0 || spans.length === 0 ? total : null,
    measured,
    eligible: spans.length,
    unavailable: measured === spans.length ? null : reason,
  }
}
function bytes(span: OtlpSpan, side: 'input' | 'output'): number | null {
  const recorded = number(span.attributes[`traces.${side}.bytes`])
  if (recorded !== null) return recorded
  const text = span.attributes[`${side}.value`]
  if (typeof text !== 'string' || span.attributes[`traces.${side}.truncated`] === true) return null
  return Buffer.byteLength(text)
}
function toolMeasurements(tools: readonly OtlpSpan[]): ToolMeasurement[] {
  const groups = new Map<string, OtlpSpan[]>()
  for (const tool of tools) {
    const name = typeof tool.attributes['tool.name'] === 'string'
      ? tool.attributes['tool.name'] : tool.name
    const group = groups.get(name)
    if (group) group.push(tool)
    else groups.set(name, [tool])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, spans]) => ({
    name,
    calls: spans.length,
    outcomes: {
      ok: spans.filter((span) => span.status.code === 'OK').length,
      error: spans.filter((span) => span.status.code === 'ERROR').length,
      unset: spans.filter((span) => span.status.code === 'UNSET').length,
    },
    inputBytes: measure(spans, (span) => bytes(span, 'input'), 'Input byte count missing or truncated without a size receipt.'),
    outputBytes: measure(spans, (span) => bytes(span, 'output'), 'Output byte count missing or truncated without a size receipt.'),
    callToResultMs: measure(spans, (span) => {
      if (span.status.code === 'UNSET') return null
      const elapsed = Date.parse(span.end_time) - Date.parse(span.start_time)
      // Legacy readers use start == end when no end was recorded. Do not turn that into zero latency.
      return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null
    }, 'A completed span with distinct recorded endpoints is required; equal endpoints may be an adapter default.'),
    spanIds: spans.map((span) => span.span_id),
  }))
}
function compactions(spans: readonly OtlpSpan[]): SessionFact<readonly CompactionMeasurement[]> {
  const events = spans.filter((span) => span.name === 'session.compacted'
    && span.attributes[INHERITED_SOURCE_ATTR] !== 'pre-task-prefix')
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
  if (events.length === 0) return {
    value: null, spanIds: [],
    unavailable: 'No compaction boundary was captured. This does not establish that no compaction occurred.',
  }
  return {
    value: events.map((span, i) => {
      const previous = i > 0 ? events[i - 1] : undefined
      const interval = previous ? Date.parse(span.start_time) - Date.parse(previous.start_time) : NaN
      return {
        spanId: span.span_id,
        at: span.start_time,
        sincePreviousMs: Number.isFinite(interval) && interval >= 0 ? interval : null,
        latencyMs: number(span.attributes['traces.compaction.latency_ms']),
        tokensBefore: number(span.attributes['traces.compaction.tokens_before']),
        tokensAfter: number(span.attributes['traces.compaction.tokens_after']),
      }
    }),
    spanIds: events.map((span) => span.span_id), unavailable: null,
    partial: 'Observed boundaries only. Latency and context sizes are null unless the source explicitly records them.',
  }
}
function contextFootprints(spans: readonly OtlpSpan[]): ContentFootprint[] {
  const out: ContentFootprint[] = []
  for (const span of spans) {
    const fields = ['gen_ai.tool.definitions', 'gen_ai.system_instructions']
    if (span.name === 'message.system' || span.name === 'message.developer'
      || (span.name === 'user.prompt' && span.attributes['tangle.actor'] === 'injected')) fields.push('content')
    for (const field of fields) {
      const value = span.attributes[field]
      if (value === undefined || value === null) continue
      const text = typeof value === 'string' ? value : canonicalJson(value)
      let entries: number | null = Array.isArray(value) ? value.length : null
      if (typeof value === 'string') {
        try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) entries = parsed.length } catch { /* text */ }
      }
      out.push({ spanId: span.span_id, field, bytes: Buffer.byteLength(text), lines: text.split('\n').length, entries, scope: 'captured-attribute' })
    }
  }
  return out
}

const MINUTE_MS = 60_000
const STALL_MS = STALL_MINUTES * MINUTE_MS
/** Stalls kept in the list before the rest are reported as omitted. */
const STALL_LIST_CAP = 200

/** Milliseconds as minutes, to a tenth. */
const minutes = (ms: number): number => Math.round(ms / 6_000) / 10

function timeOf(value: string): number | null {
  const ms = Date.parse(value)
  // Some readers stamp the epoch on a record with no time: that is no time, not 1970.
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** History copied from a parent or kept by a compaction: the session carries it but did not do it. */
const isInherited = (span: OtlpSpan): boolean => span.attributes[INHERITED_SPAN_ATTR] === true

/**
 * A turn sent in, which ends a wait rather than a stall: a person typing (or a
 * fleet session or pasted relay through the same prompt), a parent agent, or
 * the person interrupting.
 */
function endsWait(span: OtlpSpan): boolean {
  if (span.name !== 'user.prompt') return false
  const actor = span.attributes[ACTOR_ATTR]
  const content = typeof span.attributes.content === 'string' ? span.attributes.content.trim() : ''
  return actor === 'human' || actor === 'agent' || INTERRUPT_TEXT.test(content)
}

const toolNameOf = (span: OtlpSpan): string =>
  typeof span.attributes['tool.name'] === 'string' ? span.attributes['tool.name'] : span.name.replace(/^tool\./u, '')

/** True when one simple command rolls work back: `git revert`, or `git reset` with `--hard`. */
function isRollback(line: string): boolean {
  const words = line.split(' ')
  if (basename(words[0] ?? '') !== 'git') return false
  let at = 1
  while (at < words.length && words[at]!.startsWith('-')) at += words[at] === '-C' || words[at] === '-c' ? 2 : 1
  return words[at] === 'revert' || (words[at] === 'reset' && words.slice(at + 1).includes('--hard'))
}

interface CommandRun {
  readonly span: OtlpSpan
  readonly script: string
  readonly command: string
}

interface TimePoint {
  readonly at: number
  readonly span: OtlpSpan
  /** The span's end, not its start. */
  readonly end: boolean
}

function timeline(records: readonly OtlpSpan[]): TimePoint[] {
  const points: TimePoint[] = []
  for (const span of records) {
    const start = timeOf(span.start_time)
    const end = timeOf(span.end_time)
    if (start !== null) points.push({ at: start, span, end: false })
    if (end !== null && (start === null || end > start)) points.push({ at: end, span, end: true })
  }
  return points.sort((left, right) => left.at - right.at)
}

/** Total length of the union of `[start, end]` intervals, in ms. */
function unionMs(intervals: Array<readonly [number, number]>): number {
  let total = 0
  let reach = Number.NEGATIVE_INFINITY
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (end <= reach) continue
    total += end - Math.max(start, reach)
    reach = end
  }
  return total
}

/**
 * Stalls, active minutes and the command measures of one session.
 * `spans` are its own spans in trace order, `records` the ones built from its
 * records, and `tools` the tool calls its own agent made.
 */
function measureTime(spans: readonly OtlpSpan[], records: readonly OtlpSpan[], tools: readonly OtlpSpan[]): {
  waste: SessionWaste
  activeMinutes: SessionFact<number>
} {
  const points = timeline(records.filter((span) => !isInherited(span)))
  const stalls: Stall[] = []
  const stallIntervals: Array<readonly [number, number]> = []
  let activeMs = 0
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1]!.at
    const gap = points[i]!.at - before
    activeMs += Math.min(gap, STALL_MS)
    if (gap < STALL_MS) continue
    // Every record at the instant the gap ended: a turn sent in among them makes it a wait.
    const ending: TimePoint[] = []
    for (let j = i; j < points.length && points[j]!.at === points[i]!.at; j++) ending.push(points[j]!)
    if (ending.some((point) => !point.end && endsWait(point.span))) continue
    const result = ending.find((point) => point.end && point.span.attributes['openinference.span.kind'] === 'TOOL')
    stalls.push({
      at: new Date(before).toISOString(),
      minutes: minutes(gap),
      kind: result ? 'waiting on a command' : 'idle',
      spanId: (result ?? ending[0]!).span.span_id,
    })
    stallIntervals.push([before, points[i]!.at])
  }
  const noTime = "no record of this session's own carries a readable time"
  const stallFact: SessionFact<readonly Stall[]> = points.length === 0
    ? { value: null, spanIds: [], unavailable: noTime }
    : {
        value: stalls.slice(0, STALL_LIST_CAP),
        spanIds: stalls.map((stall) => stall.spanId),
        unavailable: null,
        ...(stalls.length > STALL_LIST_CAP
          ? { partial: `${stalls.length - STALL_LIST_CAP} of ${stalls.length} stalls omitted; the spanIds are complete` }
          : {}),
      }

  const own = tools.filter((span) => !isInherited(span))
  const runs: CommandRun[] = []
  for (const span of own) {
    const input = span.attributes['input.value']
    const script = typeof input === 'string' ? commandTextFromInput(input) : undefined
    if (script !== undefined) runs.push({ span, script, command: script.replace(/\s+/gu, ' ').trim() })
  }
  // A trace that kept no tool arguments cannot say which commands ran: that is unknown, not none.
  const unread = own.length > 0 && !own.some((span) => typeof span.attributes['input.value'] === 'string')
    ? 'no tool call recorded its arguments, so which commands ran cannot be read'
    : null

  const byCommand = new Map<string, CommandRun[]>()
  for (const run of runs) {
    const group = byCommand.get(run.command)
    if (group) group.push(run)
    else byCommand.set(run.command, [run])
  }
  const repeated = [...byCommand.values()].filter((group) => group.length > 1)
  const rollbacks = runs.flatMap((run) => commandLines(run.script).filter(isRollback).map(() => run.span.span_id))

  // A streak is one command failing run after run; a success of it, or a turn sent in, ends it.
  const streaks: FailingStreak[] = []
  const streakIntervals: Array<readonly [number, number]> = []
  const open = new Map<string, CommandRun[]>()
  const close = (command: string): void => {
    const failed = open.get(command)
    open.delete(command)
    if (!failed || failed.length < STREAK_RUNS) return
    const start = Math.min(...failed.map((run) => timeOf(run.span.start_time) ?? Number.POSITIVE_INFINITY))
    const end = Math.max(...failed.map((run) => timeOf(run.span.end_time) ?? timeOf(run.span.start_time) ?? Number.NEGATIVE_INFINITY))
    const known = Number.isFinite(start) && Number.isFinite(end) && end >= start
    streaks.push({
      command: failed[0]!.command.length > COMMAND_TEXT_CAP ? `${failed[0]!.command.slice(0, COMMAND_TEXT_CAP - 1)}…` : failed[0]!.command,
      tool: toolNameOf(failed[0]!.span),
      runs: failed.length,
      minutes: known ? minutes(end - start) : 0,
      at: failed[0]!.span.start_time,
      spanIds: failed.map((run) => run.span.span_id),
    })
    if (known) streakIntervals.push([start, end])
  }
  const runOf = new Map(runs.map((run) => [run.span, run]))
  for (const span of spans) {
    if (endsWait(span)) {
      for (const command of [...open.keys()]) close(command)
      continue
    }
    const run = runOf.get(span)
    if (!run) continue
    if (span.status.code === 'OK') close(run.command)
    else if (span.status.code === 'ERROR') {
      const failed = open.get(run.command)
      if (failed) failed.push(run)
      else open.set(run.command, [run])
    }
  }
  for (const command of [...open.keys()]) close(command)
  streaks.sort((left, right) => (timeOf(left.at) ?? 0) - (timeOf(right.at) ?? 0))

  const commandFact = <T>(value: T, spanIds: readonly string[]): SessionFact<T> =>
    unread === null ? { value, spanIds, unavailable: null } : { value: null, spanIds: [], unavailable: unread }
  const unavailable = [unread, points.length === 0 ? noTime : null].filter((reason) => reason !== null).join('; ')
  return {
    waste: {
      minutes: unavailable === '' ? minutes(unionMs([...streakIntervals, ...stallIntervals])) : null,
      unavailable: unavailable === '' ? null : unavailable,
      failingStreaks: commandFact<readonly FailingStreak[]>(streaks, streaks.flatMap((streak) => streak.spanIds)),
      stalls: stallFact,
      rollbacks: commandFact(rollbacks.length, rollbacks),
      repeatedCommands: commandFact(
        { commands: repeated.length, extraRuns: repeated.reduce((sum, group) => sum + group.length - 1, 0) },
        repeated.flatMap((group) => group.slice(1).map((run) => run.span.span_id)),
      ),
    },
    activeMinutes: points.length === 0
      ? { value: null, spanIds: [], unavailable: noTime }
      : { value: minutes(activeMs), spanIds: [], unavailable: null },
  }
}

/**
 * Called by the session facts sheet; no filesystem or inference. `spans` are
 * the session's own spans in trace order, `records` the ones built from its
 * records (no root, no integrity receipt), and `tools` its own agent's calls.
 */
export function computeSessionMeasurements(input: {
  readonly spans: readonly OtlpSpan[]
  readonly records: readonly OtlpSpan[]
  readonly tools: readonly OtlpSpan[]
  readonly sessionId: string | null
  readonly harness: string | null
}): SessionMeasurements {
  const { spans, records, tools, sessionId, harness } = input
  return {
    skills: skillUseOfSpans(spans.filter((span) => !isInherited(span)), harness),
    ...measureTime(spans, records, tools),
    relationship: describeSessionRelationship({
      sessionId: sessionId ?? spans[0]?.trace_id ?? '', harness: harness ?? '', path: '', cwd: null, mtimeMs: 0,
    }, spans),
    tools: toolMeasurements(tools),
    compactions: compactions(spans),
    contextFootprints: contextFootprints(spans),
  }
}

