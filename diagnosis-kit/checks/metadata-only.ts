import { isContentAttribute } from '@tangle-network/agent-eval/diagnosis'
import type { OtlpSpan } from '../../src/otlp.js'

/** These fields are computed from tool payloads and can reveal short inputs. */
const TOOL_IO_DERIVED = /^(?:input|output)\.mime_type$|^traces\.(?:input|output)\.(?:bytes|sha256|truncated)$|^traces\.source_record\.(?:input|output)\.value$/i
const ERROR_PROSE = /(?:^|[._])(?:error|exception|status)(?:[._][a-zA-Z0-9]+)*[._](?:message|stacktrace|stack|description|details|reason)$|^(?:error|exception|status)$|^(?:log|event)[._]message$|^otel\.status_description$|^(?:events?|logs?)$/i

export function stripContent(spans: readonly OtlpSpan[]): { spans: OtlpSpan[]; dropped: string[] } {
  const dropped = new Set<string>()
  const out = spans.map((span) => {
    const attributes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(span.attributes ?? {})) {
      if (isContentAttribute(key) || TOOL_IO_DERIVED.test(key) || ERROR_PROSE.test(key) || /^(?:args|tool_arguments|full_command)$/i.test(key) || key === 'tool.args_captured' || (value !== null && typeof value === 'object')) {
        dropped.add(key)
        continue
      }
      attributes[key] = value
    }
    if (span.status.message) dropped.add('status.message')
    return { ...span, status: { code: span.status.code }, attributes }
  })
  return { spans: out, dropped: [...dropped].sort() }
}
