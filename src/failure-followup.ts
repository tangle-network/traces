/**
 * Failure follow-up classification — the retry-with-state marker.
 *
 * The tool-use line has long counted "failed calls followed by another
 * same-tool call", but that count cannot separate a blind retry (the same
 * arguments re-sent after a failure, so the failure produced no new state)
 * from an adapted one (the arguments changed, so the failure taught the agent
 * something). Without the split the number reads as pure waste even in a run
 * where every retry adapted — or as healthy adaptation in a run that re-sent
 * the same command 300 times.
 *
 * Arguments are compared by the full-input hash (`traces.input.sha256`) when
 * both sides carry it, because it survives `input.value` truncation, and by
 * the verbatim `input.value` otherwise. A pair whose arguments cannot be
 * compared is counted as unknown, never guessed. Calls marked
 * `traces.expected_blocking` are excluded: re-sending an identical poll after
 * a not-ready failure is the protocol working, not thrash.
 */

import { OPENINFERENCE_SPAN_KIND, TOOL_NAME } from '@tangle-network/agent-eval/trace-attributes'
import type { OtlpSpan } from './otlp.js'

export type FollowUpKind = 'blind' | 'adapted' | 'args-unknown' | 'none'

export interface FailureFollowUp {
  traceId: string
  toolName: string
  failedSpanId: string
  /** Null when the tool was never called again after the failure. */
  followUpSpanId: string | null
  kind: FollowUpKind
  /** Whether the follow-up call ended without an error; null when kind is 'none'. */
  followUpSucceeded: boolean | null
}

export interface FailureFollowUpReport {
  /** Failed TOOL calls classified; expected-blocking failures are excluded. */
  failures: number
  /** Failures with a later call of the same tool in the same trace. */
  followed: number
  /** Follow-up re-sent identical arguments. */
  blind: number
  /** Follow-up changed the arguments. */
  adapted: number
  /** Arguments were not captured or not comparable on one side of the pair. */
  argsUnknown: number
  /** Follow-ups that ended without an error, out of `followed`. */
  followUpSucceeded: number
  /** Blind-retry count per tool, largest offender first when rendered. */
  blindByTool: Record<string, number>
  items: FailureFollowUp[]
}

interface ToolCall {
  span: OtlpSpan
  toolName: string
  argKey: string | null
}

/**
 * One comparable key per call. The scheme prefix keeps a hash from ever
 * equaling a raw value; a cross-scheme pair is reported as not comparable
 * rather than silently classified.
 */
function argKeyOf(span: OtlpSpan): string | null {
  const sha = span.attributes['traces.input.sha256']
  if (typeof sha === 'string' && sha.length > 0) return `sha:${sha}`
  const value = span.attributes['input.value']
  if (typeof value === 'string' && value.length > 0) return `raw:${value}`
  return null
}

function schemeOf(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

export function classifyFailureFollowUps(spans: readonly OtlpSpan[]): FailureFollowUpReport {
  const calls: ToolCall[] = []
  for (const s of spans) {
    if (s.attributes[OPENINFERENCE_SPAN_KIND] !== 'TOOL') continue
    const toolName = s.attributes[TOOL_NAME]
    if (typeof toolName !== 'string' || toolName.length === 0) continue
    calls.push({ span: s, toolName, argKey: argKeyOf(s) })
  }
  calls.sort((a, b) =>
    a.span.start_time.localeCompare(b.span.start_time) ||
    (Number(a.span.attributes.step) || 0) - (Number(b.span.attributes.step) || 0),
  )

  const sequences = new Map<string, ToolCall[]>()
  for (const call of calls) {
    const key = `${call.span.trace_id}|${call.toolName}`
    const seq = sequences.get(key)
    if (seq) seq.push(call)
    else sequences.set(key, [call])
  }

  const items: FailureFollowUp[] = []
  const blindByTool: Record<string, number> = {}
  for (const seq of sequences.values()) {
    for (let i = 0; i < seq.length; i++) {
      const call = seq[i]!
      if (call.span.status.code !== 'ERROR') continue
      if (call.span.attributes['traces.expected_blocking'] === true) continue
      const followUp = seq[i + 1] ?? null
      let kind: FollowUpKind
      if (!followUp) {
        kind = 'none'
      } else if (
        call.argKey !== null &&
        followUp.argKey !== null &&
        schemeOf(call.argKey) === schemeOf(followUp.argKey)
      ) {
        kind = call.argKey === followUp.argKey ? 'blind' : 'adapted'
      } else {
        kind = 'args-unknown'
      }
      if (kind === 'blind') blindByTool[call.toolName] = (blindByTool[call.toolName] ?? 0) + 1
      items.push({
        traceId: call.span.trace_id,
        toolName: call.toolName,
        failedSpanId: call.span.span_id,
        followUpSpanId: followUp?.span.span_id ?? null,
        kind,
        followUpSucceeded: followUp ? followUp.span.status.code !== 'ERROR' : null,
      })
    }
  }

  const followedItems = items.filter((item) => item.kind !== 'none')
  return {
    failures: items.length,
    followed: followedItems.length,
    blind: items.filter((item) => item.kind === 'blind').length,
    adapted: items.filter((item) => item.kind === 'adapted').length,
    argsUnknown: items.filter((item) => item.kind === 'args-unknown').length,
    followUpSucceeded: followedItems.filter((item) => item.followUpSucceeded === true).length,
    blindByTool,
    items,
  }
}
