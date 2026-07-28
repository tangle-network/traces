/**
 * Ephemeral `codex exec --json` adapter.
 *
 * Unlike Codex rollout files under `~/.codex/sessions`, this stream has no
 * durable discovery path and normally carries no timestamps, model name, or
 * user prompt. Callers select it explicitly with `--session`; event order is
 * preserved with `step`, and missing timestamps use the source file mtime
 * without inventing durations.
 */

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
type ToolItemType = 'command_execution' | 'file_change'

interface TimedEvent {
  readonly time: string
  readonly source: 'event' | 'file_mtime'
}

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

function eventTime(event: JsonObject, fallback: string): TimedEvent {
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
  return { time: fallback, source: 'file_mtime' }
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
  return { changes: fileChanges(item, sourcePath) }
}

function completedStatus(
  itemType: ToolItemType,
  item: JsonObject,
  sourcePath: string,
): { code: 'OK' | 'ERROR'; message?: string; exitCode?: number } {
  const status = requireString(item.status, sourcePath, `${itemType}.status`)
  if (status !== 'completed' && status !== 'failed') {
    throw new CodexExecStreamError(
      sourcePath,
      `${itemType}.status on item.completed must be "completed" or "failed"`,
    )
  }
  const code = itemType === 'command_execution' ? exitCode(item, sourcePath) : undefined
  const failed = status === 'failed' || (code !== undefined && code !== 0)
  return {
    code: failed ? 'ERROR' : 'OK',
    ...(failed ? { message: code === undefined ? `${itemType} failed` : `command exited ${code}` } : {}),
    ...(code === undefined ? {} : { exitCode: code }),
  }
}

function itemType(item: JsonObject): string | undefined {
  return stringValue(item.type)
}

function toolItemType(item: JsonObject): ToolItemType | undefined {
  const type = itemType(item)
  return type === 'command_execution' || type === 'file_change' ? type : undefined
}

function toolName(type: ToolItemType): string {
  return type === 'command_execution' ? 'exec_command' : 'apply_patch'
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
    let eventTimestampCount = 0
    let terminalCount = 0
    let fatalError = false

    const fail = (message: string): never => {
      throw new CodexExecStreamError(ref.path, message)
    }

    const touchRoot = (timed: TimedEvent): void => {
      if (!root) return
      root.start_time = earlier(root.start_time, timed.time)
      root.end_time = later(root.end_time, timed.time)
      if (timed.source === 'event') eventTimestampCount += 1
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

    const createTool = (
      turn: ActiveTurn,
      item: JsonObject,
      type: ToolItemType,
      time: string,
      lifecycle: 'paired' | 'completed_only',
    ): PendingTool => {
      const id = requireString(item.id, ref.path, `${type}.id`)
      const name = toolName(type)
      const input = toolInput(type, item, ref.path)
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
          ...toolIoAttributes({ input, argsCaptured: true }),
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
      pending.span.attributes['traces.codex.exec_item_status'] = item.status
      if (result.exitCode !== undefined) {
        pending.span.attributes['traces.codex.exec_exit_code'] = result.exitCode
      }
      if (type === 'command_execution') {
        recordToolOutput(pending.span, typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined)
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
      if (code === 'OK' && turn.pendingTools.size > 0) {
        fail(`turn.completed left ${turn.pendingTools.size} item(s) without item.completed`)
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
      }))
      activeTurn = undefined
      terminalCount += 1
      if (code === 'ERROR') fatalError = true
    }

    for await (const raw of readJsonl<unknown>(ref.path, sessionJsonlOptions(ref, options))) {
      const event = objectValue(raw)
      const type = event ? stringValue(event.type) : undefined
      if (!event || !type || !SUPPORTED_EVENT_TYPES.has(type)) {
        ignoredEventCount += 1
        continue
      }
      recognizedEventCount += 1
      const timed = eventTime(event, fallbackTime)

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
        const turn = requireTurn(type)
        const item = requireObject(event.item, ref.path, 'item.completed.item')
        const completedType = itemType(item)
        if (completedType === 'command_execution' || completedType === 'file_change') {
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
            spanId: `error:${turn.index}:${id}`,
            parentSpanId: turn.spanId,
            name: 'error.codex_item',
            kind: 'CHAIN',
            startTime: timed.time,
            status: 'ERROR',
            statusMessage: message,
            service: SERVICE,
            agent: SERVICE,
            step: step++,
            content: capText(message),
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
      }))
      if (activeTurn) closeTurn('ERROR', timed.time, undefined, message)
      else {
        fatalError = true
        terminalCount += 1
      }
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
    if (activeTurn) {
      throw new CodexExecStreamError(ref.path, 'stream ended before turn.completed, turn.failed, or error')
    }
    if (terminalCount === 0) {
      throw new CodexExecStreamError(ref.path, 'stream has no terminal turn.completed, turn.failed, or error event')
    }

    root.status = fatalError ? { code: 'ERROR', message: 'Codex exec stream failed' } : { code: 'OK' }
    root.attributes['traces.codex.exec_event_count'] = recognizedEventCount
    root.attributes['traces.codex.exec_ignored_event_count'] = ignoredEventCount
    root.attributes['traces.codex.exec_ignored_item_count'] = ignoredItemCount
    root.attributes['traces.codex.exec_event_timestamp_count'] = eventTimestampCount
    root.attributes['traces.codex.exec_time_source'] = eventTimestampCount === 0
      ? 'file_mtime'
      : eventTimestampCount === recognizedEventCount
        ? 'event'
        : 'mixed'
    return spans
  }
}
