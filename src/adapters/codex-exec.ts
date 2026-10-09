/**
 * Ephemeral `codex exec --json` adapter.
 *
 * Unlike Codex rollout files under `~/.codex/sessions`, this stream has no
 * durable discovery path and normally carries no timestamps, model name, or
 * user prompt. Callers select it explicitly with `--session`; event order is
 * preserved with `step`, and missing timestamps use the source file mtime
 * without inventing durations.
 *
 * The same events also arrive wrapped in a Tangle Sandbox live stream
 * (`retained-execution-*.jsonl`): `{ id, type: 'raw', data: { backend:
 * 'codex', event }, at }` beside the sandbox's own status, heartbeat, and
 * message events. The adapter reads `data.event` from Codex raw envelopes,
 * ignores every other envelope, and uses `at` (the sandbox's receipt time)
 * when the Codex event has no timestamp of its own.
 *
 * A stream that is still being written ends inside a turn. That turn, and any
 * item it started without completing, are emitted with status UNSET and an
 * `in_progress` marker, so a live session can be analyzed before it settles.
 */

import { sourceOf, textSources } from '../source-location.js'

import { sessionJsonlOptions } from '../integrity.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, ParseOptions, SessionRef } from '../types.js'
import { capText } from './conversation.js'
import { recordToolOutput, toolIoAttributes } from './tool-io.js'

const SERVICE = 'codex-exec'
const SUPPORTED_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'item.started',
  'item.completed',
  'turn.completed',
  'turn.failed',
  'error',
])

type JsonObject = Record<string, unknown>
type ToolItemType = 'command_execution' | 'file_change' | 'mcp_tool_call' | 'web_search'
type TimeSource = 'event' | 'envelope' | 'file_mtime'

interface TimedEvent {
  readonly time: string
  readonly source: TimeSource
}

const IN_PROGRESS = 'in_progress'

interface PendingTool {
  readonly itemType: ToolItemType
  readonly span: OtlpSpan
}

interface ActiveTurn {
  readonly index: number
  readonly spanId: string
  readonly startTime: string
  readonly step: number
  readonly pendingTools: Map<string, PendingTool>
  readonly completedItemIds: Set<string>
}

export class CodexExecStreamError extends Error {
  readonly sourcePath: string

  constructor(sourcePath: string, message: string) {
    super(`Invalid Codex exec event stream at ${sourcePath}: ${message}`)
    this.name = 'CodexExecStreamError'
    this.sourcePath = sourcePath
  }
}

function objectValue(value: unknown): JsonObject | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isoTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value
    return new Date(milliseconds).toISOString()
  }
  return undefined
}

function eventTime(event: JsonObject, envelopeTime: string | undefined, fallback: string): TimedEvent {
  for (const key of [
    'timestamp',
    'created_at',
    'started_at',
    'completed_at',
    'timestamp_ms',
    'started_at_ms',
    'completed_at_ms',
  ]) {
    const time = isoTime(event[key])
    if (time) return { time, source: 'event' }
  }
  if (envelopeTime) return { time: envelopeTime, source: 'envelope' }
  return { time: fallback, source: 'file_mtime' }
}

type Unwrapped =
  | { readonly kind: 'event'; readonly event: JsonObject; readonly envelopeTime?: string }
  | { readonly kind: 'sandbox-error'; readonly event: JsonObject; readonly envelopeTime?: string }
  | { readonly kind: 'sandbox-end'; readonly failed: boolean; readonly label: string; readonly envelopeTime: string }
  | { readonly kind: 'foreign-envelope' }

const SANDBOX_END_STATUSES = new Set(['failed', 'complete', 'completed'])

/**
 * Codex raw events from a Sandbox live-stream envelope; plain exec events pass
 * through. Codex events carry no `data` or `at`, so their presence marks an
 * envelope. The sandbox's own `error` envelope (a cancelled execution, a
 * refused lease) ends the execution, so it is surfaced rather than ignored.
 */
function unwrap(raw: JsonObject): Unwrapped {
  const data = objectValue(raw.data)
  const envelopeTime = isoTime(raw.at)
  if (!data || !envelopeTime) return { kind: 'event', event: raw }
  if (raw.type === 'error' && stringValue(data.message)) return { kind: 'sandbox-error', event: data, envelopeTime }
  // The execution's own end: `done` or `result` with its outcome, or a terminal status.
  const status = raw.type === 'status' ? stringValue(data.status) : undefined
  if (raw.type === 'done' || raw.type === 'result' || (status && SANDBOX_END_STATUSES.has(status))) {
    const outcome = stringValue(objectValue(data.outcome)?.type)
    const label = status ? `status ${status}` : `${raw.type as string}${outcome ? ` ${outcome}` : ''}`
    return { kind: 'sandbox-end', failed: status === 'failed', label, envelopeTime }
  }
  const event = raw.type === 'raw' && data.backend === 'codex' ? objectValue(data.event) : undefined
  if (!event) return { kind: 'foreign-envelope' }
  return { kind: 'event', event, envelopeTime }
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right
}

function later(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function requireObject(value: unknown, sourcePath: string, label: string): JsonObject {
  const object = objectValue(value)
  if (!object) throw new CodexExecStreamError(sourcePath, `${label} must be an object`)
  return object
}

function requireString(value: unknown, sourcePath: string, label: string): string {
  const string = stringValue(value)
  if (!string) throw new CodexExecStreamError(sourcePath, `${label} must be a non-empty string`)
  return string
}

function optionalTokenCount(usage: JsonObject | undefined, key: string, sourcePath: string): number | undefined {
  const value = usage?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CodexExecStreamError(sourcePath, `usage.${key} must be a non-negative integer`)
  }
  return value
}

function exitCode(item: JsonObject, sourcePath: string): number | undefined {
  const value = item.exit_code
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CodexExecStreamError(sourcePath, 'command_execution.exit_code must be an integer or null')
  }
  return value
}

function fileChanges(item: JsonObject, sourcePath: string): Array<{ path: string; kind: string }> {
  if (!Array.isArray(item.changes) || item.changes.length === 0) {
    throw new CodexExecStreamError(sourcePath, 'file_change.changes must be a non-empty array')
  }
  return item.changes.map((raw, index) => {
    const change = requireObject(raw, sourcePath, `file_change.changes[${index}]`)
    return {
      path: requireString(change.path, sourcePath, `file_change.changes[${index}].path`),
      kind: requireString(change.kind, sourcePath, `file_change.changes[${index}].kind`),
    }
  })
}

function toolInput(itemType: ToolItemType, item: JsonObject, sourcePath: string): JsonObject {
  if (itemType === 'command_execution') {
    const command = requireString(item.command, sourcePath, 'command_execution.command')
    const cwd = stringValue(item.cwd)
    return { cmd: command, ...(cwd ? { cwd } : {}) }
  }
  if (itemType === 'mcp_tool_call') {
    return {
      server: requireString(item.server, sourcePath, 'mcp_tool_call.server'),
      tool: requireString(item.tool, sourcePath, 'mcp_tool_call.tool'),
      ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
    }
  }
  if (itemType === 'web_search') {
    return {
      query: typeof item.query === 'string' ? item.query : '',
      ...(item.action === undefined ? {} : { action: item.action }),
    }
  }
  return { changes: fileChanges(item, sourcePath) }
}

function toolInputFields(itemType: ToolItemType): string[] {
  switch (itemType) {
    case 'command_execution': return ['command', 'cwd']
    case 'mcp_tool_call': return ['server', 'tool', 'arguments']
    case 'web_search': return ['query', 'action']
    case 'file_change': return ['changes']
  }
}

/** The text an MCP result carries, or its structured content when it has no text. */
function mcpOutput(item: JsonObject): { value: string; field: string } | undefined {
  const error = objectValue(item.error)
  const errorMessage = stringValue(error?.message) ?? stringValue(item.error)
  if (errorMessage) return { value: errorMessage, field: 'error' }
  const result = objectValue(item.result)
  if (!result) return undefined
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((block) => objectValue(block))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block!.text as string)
  if (text.length > 0) return { value: text.join('\n'), field: 'result' }
  if (result.structured_content !== undefined) {
    return { value: JSON.stringify(result.structured_content), field: 'result' }
  }
  return undefined
}

function completedStatus(
  itemType: ToolItemType,
  item: JsonObject,
  sourcePath: string,
): { code: 'OK' | 'ERROR'; message?: string; exitCode?: number } {
  // Codex records no status on a finished web search; its completion is the result.
  if (itemType === 'web_search' && item.status === undefined) return { code: 'OK' }
  const status = requireString(item.status, sourcePath, `${itemType}.status`)
  if (status !== 'completed' && status !== 'failed') {
    throw new CodexExecStreamError(
      sourcePath,
      `${itemType}.status on item.completed must be "completed" or "failed"`,
    )
  }
  const code = itemType === 'command_execution' ? exitCode(item, sourcePath) : undefined
  const mcpError = itemType === 'mcp_tool_call' && item.error != null
  const failed = status === 'failed' || mcpError || (code !== undefined && code !== 0)
  return {
    code: failed ? 'ERROR' : 'OK',
    ...(failed ? { message: code === undefined ? `${itemType} failed` : `command exited ${code}` } : {}),
    ...(code === undefined ? {} : { exitCode: code }),
  }
}

function itemType(item: JsonObject): string | undefined {
  return stringValue(item.type)
}

const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set<ToolItemType>([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
])

function toolItemType(item: JsonObject): ToolItemType | undefined {
  const type = itemType(item)
  return type && TOOL_ITEM_TYPES.has(type) ? type as ToolItemType : undefined
}

/** MCP calls use the `mcp__<server>__<tool>` spelling other harness adapters emit. */
function toolName(type: ToolItemType, input: JsonObject): string {
  switch (type) {
    case 'command_execution': return 'exec_command'
    case 'file_change': return 'apply_patch'
    case 'web_search': return 'web_search'
    case 'mcp_tool_call': return `mcp__${input.server as string}__${input.tool as string}`
  }
}

export class CodexExecAdapter implements HarnessTraceAdapter {
  readonly harness = SERVICE
  readonly aliases = ['codex-json'] as const

  async locate(_opts: LocateOptions = {}): Promise<SessionRef[]> {
    return []
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    const fallbackTime = Number.isFinite(ref.mtimeMs) && ref.mtimeMs >= 0
      ? new Date(ref.mtimeMs).toISOString()
      : new Date(0).toISOString()
    const spans: OtlpSpan[] = []
    let root: OtlpSpan | undefined
    let threadId: string | undefined
    let activeTurn: ActiveTurn | undefined
    let turnIndex = 0
    let step = 0
    let recognizedEventCount = 0
    let ignoredEventCount = 0
    let ignoredItemCount = 0
    const timeSourceCounts: Record<TimeSource, number> = { event: 0, envelope: 0, file_mtime: 0 }
    let envelopeCount = 0
    let terminalCount = 0
    let fatalError = false

    const fail = (message: string): never => {
      throw new CodexExecStreamError(ref.path, message)
    }

    const touchRoot = (timed: TimedEvent): void => {
      if (!root) return
      root.start_time = earlier(root.start_time, timed.time)
      root.end_time = later(root.end_time, timed.time)
      timeSourceCounts[timed.source] += 1
    }

    const requireRoot = (type: string): OtlpSpan => {
      const current = root
      if (!current) throw new CodexExecStreamError(ref.path, `${type} appeared before thread.started`)
      return current
    }

    const requireTurn = (type: string): ActiveTurn => {
      requireRoot(type)
      const current = activeTurn
      if (!current) throw new CodexExecStreamError(ref.path, `${type} appeared without an active turn.started`)
      return current
    }

    const inputSourceOf = (type: ToolItemType, item: JsonObject) => toolInputFields(type).flatMap((field) => {
      const reference = sourceOf(item, field)
      return item[field] !== undefined && reference ? [reference] : []
    })

    const createTool = (
      turn: ActiveTurn,
      item: JsonObject,
      type: ToolItemType,
      time: string,
      lifecycle: 'paired' | 'completed_only',
    ): PendingTool => {
      const id = requireString(item.id, ref.path, `${type}.id`)
      const input = toolInput(type, item, ref.path)
      const name = toolName(type, input)
      const cwd = stringValue(item.cwd)
      if (!ref.cwd && cwd) ref.cwd = cwd
      const toolSpan = span({
        traceId: threadId!,
        spanId: `tool:${turn.index}:${id}`,
        parentSpanId: turn.spanId,
        name: `tool.${name}`,
        kind: 'TOOL',
        startTime: time,
        status: 'UNSET',
        service: SERVICE,
        agent: SERVICE,
        tool: name,
        step: step++,
        extra: {
          ...toolIoAttributes({ input, argsCaptured: true, inputSource: inputSourceOf(type, item) }),
          'traces.codex.exec_item_id': id,
          'traces.codex.exec_item_type': type,
          'traces.codex.exec_lifecycle': lifecycle,
        },
      })
      spans.push(toolSpan)
      return { itemType: type, span: toolSpan }
    }

    const completeTool = (turn: ActiveTurn, item: JsonObject, time: string): void => {
      const type = toolItemType(item)
      if (!type) throw new CodexExecStreamError(ref.path, 'item.completed tool item has an unsupported type')
      const id = requireString(item.id, ref.path, `${type}.id`)
      if (turn.completedItemIds.has(id)) fail(`item ${id} completed more than once`)
      const existing = turn.pendingTools.get(id)
      if (existing && existing.itemType !== type) {
        fail(`item ${id} changed type from ${existing.itemType} to ${type}`)
      }
      const pending = existing ?? createTool(turn, item, type, time, 'completed_only')
      const result = completedStatus(type, item, ref.path)
      pending.span.end_time = later(pending.span.start_time, time)
      pending.span.status = {
        code: result.code,
        ...(result.message ? { message: result.message } : {}),
      }
      if (typeof item.status === 'string') pending.span.attributes['traces.codex.exec_item_status'] = item.status
      if (result.exitCode !== undefined) {
        pending.span.attributes['traces.codex.exec_exit_code'] = result.exitCode
        // One spelling for one fact: the rollout adapter's command spans use
        // this key, so a reader of exit codes needs no per-adapter branch.
        pending.span.attributes['process.exit_code'] = result.exitCode
      }
      if (type === 'command_execution') {
        recordToolOutput(pending.span, typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined, sourceOf(item, 'aggregated_output'))
      } else if (type === 'mcp_tool_call') {
        const output = mcpOutput(item)
        if (output) recordToolOutput(pending.span, output.value, sourceOf(item, output.field))
      } else if (type === 'web_search') {
        // A search starts with an empty query; the completed item names what ran.
        Object.assign(pending.span.attributes, toolIoAttributes({
          input: toolInput(type, item, ref.path),
          inputSource: inputSourceOf(type, item),
        }))
        if (Array.isArray(item.results)) recordToolOutput(pending.span, JSON.stringify(item.results), sourceOf(item, 'results'))
      }
      turn.pendingTools.delete(id)
      turn.completedItemIds.add(id)
    }

    const closeTurn = (
      code: 'OK' | 'ERROR',
      time: string,
      usage: JsonObject | undefined,
      message?: string,
    ): void => {
      const turn = requireTurn(code === 'OK' ? 'turn.completed' : 'turn.failed')
      const unclosedItemCount = code === 'OK' ? turn.pendingTools.size : 0
      if (code === 'OK') {
        // Codex emits no item.completed for some started items (a file_change
        // that adds a file, observed in Sandbox live streams), even in a turn that
        // completes. The item stays UNSET: neither its success nor its end is known.
        for (const pending of turn.pendingTools.values()) {
          pending.span.attributes['traces.codex.exec_item_status'] = 'no_completion_event'
        }
        turn.pendingTools.clear()
      }
      if (code === 'ERROR') {
        for (const pending of turn.pendingTools.values()) {
          pending.span.end_time = later(pending.span.start_time, time)
          pending.span.status = { code: 'ERROR', message: message ?? 'turn failed before item completion' }
          pending.span.attributes['traces.codex.exec_item_status'] = 'interrupted'
        }
        turn.pendingTools.clear()
      }
      spans.push(span({
        traceId: threadId!,
        spanId: turn.spanId,
        parentSpanId: root!.span_id,
        name: 'llm.turn',
        kind: 'LLM',
        startTime: turn.startTime,
        endTime: later(turn.startTime, time),
        status: code,
        statusMessage: message,
        service: SERVICE,
        agent: SERVICE,
        inputTokens: optionalTokenCount(usage, 'input_tokens', ref.path),
        cachedInputTokens:
          optionalTokenCount(usage, 'cached_input_tokens', ref.path) ??
          optionalTokenCount(usage, 'cache_read_input_tokens', ref.path),
        outputTokens: optionalTokenCount(usage, 'output_tokens', ref.path),
        reasoningTokens: optionalTokenCount(usage, 'reasoning_output_tokens', ref.path),
        step: turn.step,
        ...(unclosedItemCount > 0 ? { extra: { 'traces.codex.exec_unclosed_item_count': unclosedItemCount } } : {}),
      }))
      activeTurn = undefined
      terminalCount += 1
      if (code === 'ERROR') fatalError = true
    }

    let lastSeen: TimedEvent | undefined
    let sandboxErrorBeforeThread: string | undefined
    let sandboxEnd: { readonly label: string; readonly time: string } | undefined
    const threadScope: ActiveTurn = {
      index: -1,
      spanId: '',
      startTime: fallbackTime,
      step: -1,
      pendingTools: new Map(),
      completedItemIds: new Set(),
    }
    for await (const raw of readJsonl<unknown>(ref.path, sessionJsonlOptions(ref, options))) {
      const record = objectValue(raw)
      const unwrapped = record ? unwrap(record) : undefined
      if (unwrapped?.kind === 'foreign-envelope') {
        envelopeCount += 1
        ignoredEventCount += 1
        continue
      }
      if (unwrapped?.kind === 'sandbox-end') {
        envelopeCount += 1
        ignoredEventCount += 1
        // An error envelope that follows names why; the turn is closed at the end of the stream otherwise.
        sandboxEnd ??= { label: unwrapped.label, time: unwrapped.envelopeTime }
        continue
      }
      if (unwrapped?.kind === 'sandbox-error' && !root) {
        // The execution failed before Codex started a thread: nothing of Codex's to keep.
        sandboxErrorBeforeThread ??= stringValue(unwrapped.event.message)
        envelopeCount += 1
        ignoredEventCount += 1
        continue
      }
      const event = unwrapped?.event
      const type = unwrapped?.kind === 'sandbox-error' ? 'error' : event ? stringValue(event.type) : undefined
      if (!event || !type || !SUPPORTED_EVENT_TYPES.has(type)) {
        ignoredEventCount += 1
        continue
      }
      if (event !== record) {
        envelopeCount += 1
        const sandboxId = stringValue(objectValue(record!.data)?.sandboxId)
        if (sandboxId && !ref.environment) ref.environment = { sandboxId, cwd: null }
      }
      recognizedEventCount += 1
      const timed = eventTime(event, unwrapped.envelopeTime, fallbackTime)
      lastSeen = timed

      if (type === 'thread.started') {
        if (root) fail('thread.started appeared more than once')
        threadId = requireString(event.thread_id, ref.path, 'thread.started.thread_id')
        ref.sessionId = threadId
        root = span({
          traceId: threadId,
          spanId: `root:${threadId}`,
          parentSpanId: null,
          name: 'session',
          kind: 'AGENT',
          startTime: timed.time,
          status: 'UNSET',
          service: SERVICE,
          agent: SERVICE,
          extra: {
            'tangle.sessionId': threadId,
            'traces.codex.stream_format': 'exec-jsonl',
            'traces.session.role': 'operator',
          },
        })
        spans.push(root)
        touchRoot(timed)
        continue
      }

      touchRoot(timed)
      requireRoot(type)

      if (type === 'turn.started') {
        if (activeTurn) fail('turn.started appeared before the prior turn reached a terminal event')
        activeTurn = {
          index: turnIndex,
          spanId: `llm:${turnIndex}`,
          startTime: timed.time,
          step: step++,
          pendingTools: new Map(),
          completedItemIds: new Set(),
        }
        turnIndex += 1
        continue
      }

      if (type === 'item.started') {
        const turn = requireTurn(type)
        const item = requireObject(event.item, ref.path, 'item.started.item')
        const toolType = toolItemType(item)
        if (!toolType) {
          ignoredItemCount += 1
          continue
        }
        const id = requireString(item.id, ref.path, `${toolType}.id`)
        if (turn.pendingTools.has(id) || turn.completedItemIds.has(id)) {
          fail(`item ${id} started more than once`)
        }
        const status = stringValue(item.status)
        if (status !== undefined && status !== 'in_progress') {
          fail(`${toolType}.status on item.started must be "in_progress" when present`)
        }
        turn.pendingTools.set(id, createTool(turn, item, toolType, timed.time, 'paired'))
        continue
      }

      if (type === 'item.completed') {
        const item = requireObject(event.item, ref.path, 'item.completed.item')
        const completedType = itemType(item)
        // Codex reports configuration warnings as error items before the first turn.
        const turn = !activeTurn && completedType === 'error' ? threadScope : requireTurn(type)
        if (toolItemType(item)) {
          completeTool(turn, item, timed.time)
        } else if (completedType === 'agent_message') {
          const id = requireString(item.id, ref.path, 'agent_message.id')
          if (turn.completedItemIds.has(id)) fail(`item ${id} completed more than once`)
          const text = typeof item.text === 'string' ? capText(item.text) : ''
          if (text) {
            spans.push(span({
              traceId: threadId!,
              spanId: `message:${turn.index}:${id}`,
              parentSpanId: turn.spanId,
              name: 'message.assistant',
              kind: 'CHAIN',
              startTime: timed.time,
              service: SERVICE,
              agent: SERVICE,
              step: step++,
              content: text,
              contentSource: textSources(item, 'text'),
              extra: {
                'traces.codex.exec_item_id': id,
                'traces.codex.exec_item_type': completedType,
              },
            }))
          }
          turn.completedItemIds.add(id)
        } else if (completedType === 'error') {
          const id = requireString(item.id, ref.path, 'error.id')
          if (turn.completedItemIds.has(id)) fail(`item ${id} completed more than once`)
          const message = requireString(item.message, ref.path, 'error.message')
          spans.push(span({
            traceId: threadId!,
            spanId: turn === threadScope ? `error:thread:${id}` : `error:${turn.index}:${id}`,
            parentSpanId: turn === threadScope ? root!.span_id : turn.spanId,
            name: 'error.codex_item',
            kind: 'CHAIN',
            startTime: timed.time,
            status: 'ERROR',
            statusMessage: message,
            service: SERVICE,
            agent: SERVICE,
            step: step++,
            content: capText(message),
            contentSource: textSources(item, 'message'),
            extra: {
              'traces.codex.exec_item_id': id,
              'traces.codex.exec_item_type': completedType,
            },
          }))
          turn.completedItemIds.add(id)
        } else {
          ignoredItemCount += 1
        }
        continue
      }

      if (type === 'turn.completed') {
        const usage = event.usage === undefined
          ? undefined
          : requireObject(event.usage, ref.path, 'turn.completed.usage')
        closeTurn('OK', timed.time, usage)
        continue
      }

      if (type === 'turn.failed') {
        const error = requireObject(event.error, ref.path, 'turn.failed.error')
        const message = requireString(error.message, ref.path, 'turn.failed.error.message')
        closeTurn('ERROR', timed.time, undefined, message)
        continue
      }

      const message = requireString(event.message, ref.path, 'error.message')
      spans.push(span({
        traceId: threadId!,
        spanId: `error:stream:${step}`,
        parentSpanId: activeTurn?.spanId ?? root!.span_id,
        name: 'error.codex_stream',
        kind: 'CHAIN',
        startTime: timed.time,
        status: 'ERROR',
        statusMessage: message,
        service: SERVICE,
        agent: SERVICE,
        step: step++,
        content: capText(message),
        contentSource: textSources(event, 'message'),
      }))
      if (activeTurn) closeTurn('ERROR', timed.time, undefined, message)
      else if (unwrapped.kind === 'sandbox-error' && terminalCount > 0) {
        // A Sandbox error after Codex finished its turns (a late cancel) does not undo them.
        root!.attributes['traces.codex.sandbox_error_after_completion'] = message
      } else {
        fatalError = true
        terminalCount += 1
      }
    }

    if (recognizedEventCount === 0 && sandboxErrorBeforeThread) {
      throw new CodexExecStreamError(ref.path, `the Sandbox execution ended before Codex started: ${sandboxErrorBeforeThread}`)
    }
    if (recognizedEventCount === 0) {
      throw new CodexExecStreamError(
        ref.path,
        'no supported events found; expected codex exec --json output beginning with thread.started',
      )
    }
    if (!root || !threadId) {
      throw new CodexExecStreamError(ref.path, 'thread.started was not found')
    }
    if (activeTurn && sandboxEnd) {
      // Codex never closed the turn, and the execution will write nothing more to it.
      closeTurn('ERROR', sandboxEnd.time, undefined, `the Sandbox execution ended (${sandboxEnd.label}) before turn.completed`)
    }
    const openTurn = activeTurn
    if (openTurn) {
      // The stream is still being written: keep what happened, mark what has not finished.
      const lastTime = lastSeen?.time ?? openTurn.startTime
      for (const pending of openTurn.pendingTools.values()) {
        pending.span.attributes['traces.codex.exec_item_status'] = IN_PROGRESS
      }
      spans.push(span({
        traceId: threadId,
        spanId: openTurn.spanId,
        parentSpanId: root.span_id,
        name: 'llm.turn',
        kind: 'LLM',
        startTime: openTurn.startTime,
        endTime: later(openTurn.startTime, lastTime),
        status: 'UNSET',
        service: SERVICE,
        agent: SERVICE,
        step: openTurn.step,
        extra: {
          'traces.codex.exec_turn_status': IN_PROGRESS,
          'traces.codex.exec_open_item_count': openTurn.pendingTools.size,
        },
      }))
      activeTurn = undefined
    } else if (terminalCount === 0) {
      throw new CodexExecStreamError(ref.path, 'stream has no terminal turn.completed, turn.failed, or error event')
    }

    root.status = fatalError
      ? { code: 'ERROR', message: 'Codex exec stream failed' }
      : openTurn ? { code: 'UNSET' } : { code: 'OK' }
    root.attributes['traces.codex.exec_stream_status'] = fatalError ? 'failed' : openTurn ? IN_PROGRESS : 'completed'
    if (envelopeCount > 0) root.attributes['traces.codex.stream_envelope'] = 'sandbox-live-stream'
    if (sandboxEnd) root.attributes['traces.codex.sandbox_end'] = sandboxEnd.label
    // A reader tells a stalled stream from a live one by how long ago it last moved.
    if (lastSeen) root.attributes['traces.codex.exec_last_event_at'] = lastSeen.time
    root.attributes['traces.codex.exec_event_count'] = recognizedEventCount
    root.attributes['traces.codex.exec_ignored_event_count'] = ignoredEventCount
    root.attributes['traces.codex.exec_ignored_item_count'] = ignoredItemCount
    root.attributes['traces.codex.exec_event_timestamp_count'] = timeSourceCounts.event
    root.attributes['traces.codex.exec_envelope_timestamp_count'] = timeSourceCounts.envelope
    const usedSources = (Object.keys(timeSourceCounts) as TimeSource[]).filter((key) => timeSourceCounts[key] > 0)
    root.attributes['traces.codex.exec_time_source'] = usedSources.length === 1 ? usedSources[0] : usedSources.length === 0 ? 'file_mtime' : 'mixed'
    return spans
  }
}
