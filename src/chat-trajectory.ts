import { createHash } from 'node:crypto'
import { capText } from './adapters/conversation.js'
import type { OtlpSpan, OtlpSpanKind } from './otlp.js'
import { span } from './otlp.js'
import { validateOtlpSpans } from './span-validation.js'

type JsonObject = Record<string, unknown>

export interface ChatTrajectoryMessage {
  role: string
  content: string
  timestamp?: string | number
  name?: string
  extra?: JsonObject
}

export interface ChatTrajectory {
  messages: readonly ChatTrajectoryMessage[]
  trajectory_id?: string | number
  traj_id?: string
  instance_id?: string
  trajectory_format?: string
  info?: JsonObject
}

export interface ChatTrajectoryOptions {
  traceId?: string
  service?: string
  /** Use every message for datasets whose labels count transcript rows. */
  stepMode?: 'assistant' | 'message'
  sourcePath?: string
}

export function isChatTrajectoryMessage(value: unknown): value is ChatTrajectoryMessage {
  return isObject(value) && typeof value.role === 'string' && typeof value.content === 'string'
}

export function isChatTrajectory(value: unknown): value is ChatTrajectory {
  return (
    isObject(value) &&
    Array.isArray(value.messages) &&
    value.messages.length > 0 &&
    value.messages.every(isChatTrajectoryMessage)
  )
}

/** Convert a generic chat trajectory into stable OpenInference-ready spans. */
export function chatTrajectoryToSpans(
  input: ChatTrajectory | readonly ChatTrajectoryMessage[],
  options: ChatTrajectoryOptions = {},
): OtlpSpan[] {
  const trajectory: ChatTrajectory = Array.isArray(input)
    ? { messages: input }
    : (input as ChatTrajectory)
  if (trajectory.messages.length === 0) throw new Error('chat trajectory contains no messages')
  if (!trajectory.messages.every(isChatTrajectoryMessage)) {
    throw new TypeError('chat trajectory messages require string role and content fields')
  }

  const traceId = options.traceId ?? trajectoryId(trajectory)
  const service = options.service ?? trajectory.trajectory_format ?? 'chat-trajectory'
  const stepMode = options.stepMode ?? 'assistant'
  const times = messageTimes(trajectory.messages)
  const actionCount = trajectory.messages.filter((message) => messageKind(message.role) === 'LLM').length
  const root = span({
    traceId,
    spanId: 'root',
    name: 'trajectory',
    kind: 'AGENT',
    startTime: times[0]!,
    endTime: times.at(-1)!,
    service,
    costUsd: finiteNumber(trajectory.info?.model_stats, 'instance_cost'),
    extra: compactAttributes({
      'traces.source_format': 'chat-trajectory',
      'trajectory.format': trajectory.trajectory_format,
      'trajectory.message_count': trajectory.messages.length,
      'trajectory.action_count': actionCount,
      'trajectory.source_path': options.sourcePath,
      'trajectory.api_calls': finiteNumber(trajectory.info?.model_stats, 'api_calls'),
      'trajectory.timestamps_synthetic': trajectory.messages.some(
        (message) => message.timestamp === undefined,
      ),
    }),
  })

  const spans: OtlpSpan[] = [root]
  let assistantStep = 0
  for (const [index, message] of trajectory.messages.entries()) {
    const kind = messageKind(message.role)
    if (kind === 'LLM') assistantStep += 1
    const step = stepMode === 'message' ? index + 1 : kind === 'LLM' ? assistantStep : undefined
    const spanId = step === undefined ? `message-${index + 1}` : `step-${step}`
    const response = isObject(message.extra?.response) ? message.extra.response : undefined
    const usage = isObject(response?.usage) ? response.usage : undefined
    const completionDetails = isObject(usage?.completion_tokens_details)
      ? usage.completion_tokens_details
      : undefined
    const promptDetails = isObject(usage?.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined
    spans.push(
      span({
        traceId,
        spanId,
        parentSpanId: 'root',
        name: messageName(kind, message),
        kind,
        startTime: times[index]!,
        service,
        agent: messageAgent(message.role),
        model: stringValue(response?.model),
        inputTokens: finiteNumber(usage, 'prompt_tokens'),
        outputTokens: finiteNumber(usage, 'completion_tokens'),
        reasoningTokens: finiteNumber(completionDetails, 'reasoning_tokens'),
        cachedInputTokens: finiteNumber(promptDetails, 'cached_tokens'),
        step,
        content: capText(message.content),
        extra: compactAttributes({
          'traces.source_format': 'chat-trajectory',
          'trajectory.message_index': index + 1,
          'trajectory.action_index': kind === 'LLM' ? assistantStep : undefined,
          'trajectory.role': message.role,
        }),
      }),
    )
  }
  return validateOtlpSpans(spans, 'chat trajectory output')
}

function trajectoryId(trajectory: ChatTrajectory): string {
  const value =
    trajectory.trajectory_id ?? trajectory.traj_id ?? trajectory.instance_id
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return `trajectory-${createHash('sha256')
    .update(JSON.stringify(trajectory.messages))
    .digest('hex')
    .slice(0, 24)}`
}

function messageKind(role: string): OtlpSpanKind {
  const normalized = role.trim().toLowerCase()
  if (normalized === 'assistant' || normalized === 'agent') return 'LLM'
  if (normalized === 'tool' || normalized === 'function' || normalized === 'observation') {
    return 'TOOL'
  }
  return 'CHAIN'
}

function messageName(kind: OtlpSpanKind, message: ChatTrajectoryMessage): string {
  if (kind === 'LLM') return 'message.assistant'
  if (kind === 'TOOL') return `tool.${message.name?.trim() || 'result'}`
  const role = message.role.trim().toLowerCase()
  if (role === 'system') return 'system.prompt'
  if (role === 'user' || role === 'human') return 'user.prompt'
  return 'message.other'
}

function messageAgent(role: string): string | undefined {
  const normalized = role.trim().toLowerCase()
  return ['system', 'user', 'human', 'tool', 'function', 'observation'].includes(normalized)
    ? undefined
    : role.trim()
}

function messageTimes(messages: readonly ChatTrajectoryMessage[]): string[] {
  const supplied = messages.filter((message) => message.timestamp !== undefined).length
  if (supplied === 0) return messages.map((_, index) => new Date(index).toISOString())
  if (supplied !== messages.length) {
    throw new TypeError('chat trajectory timestamps must be present on every message or none')
  }

  const times = messages.map((message, index) => messageTime(message.timestamp, index))
  for (let index = 1; index < times.length; index += 1) {
    if (Date.parse(times[index]!) < Date.parse(times[index - 1]!)) {
      throw new RangeError(
        `chat trajectory message ${index + 1} timestamp precedes message ${index}`,
      )
    }
  }
  return times
}

function messageTime(value: string | number | undefined, index: number): string {
  const parsed = parseTime(value)
  if (!parsed) {
    throw new TypeError(`chat trajectory message ${index + 1} has an invalid timestamp`)
  }
  return parsed
}

function parseTime(value: string | number | undefined): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value
    const date = new Date(millis)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined
}

function finiteNumber(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined
  const number = value[key]
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function compactAttributes(values: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
