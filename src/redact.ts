/**
 * Redaction for trace spans before they leave the machine.
 *
 * The patterns, field-name rules and profiles live in agent-eval's redaction
 * core (`@tangle-network/agent-eval/traces`, docs/redaction.md). This module
 * applies the core to OTLP spans: source-location attributes are removed, every
 * span attribute and status message is redacted in one pass (so a pseudonym
 * under the `share` profile is the same on every span), and tool I/O
 * attributes are normalized again afterwards.
 *
 * Scope: the core finds credentials by field name and value shape, and email,
 * card, SSN and phone values. It does not find names, postal addresses or
 * account numbers written in prose. For that, pass an external `Redactor`
 * (`applyRedactor`) or upload metadata-only with `--no-content`.
 */

import {
  assessShareSafety,
  combineVerdicts,
  type RedactionProfile,
  type RedactionReport,
  redact,
  type ShareSafetyVerdict,
} from '@tangle-network/agent-eval/traces'
import { normalizeToolIoAttributes, TOOL_IO_VALUE_KEYS } from './adapters/tool-io.js'
import type { Redactor } from './external.js'
import type { OtlpSpan } from './otlp.js'
import { stripSourceAttributes } from './source-location.js'

export interface SpanRedaction {
  spans: OtlpSpan[]
  report: RedactionReport
}

export interface RedactSpansOptions {
  /** Default `default`. */
  profile?: RedactionProfile
  /** Exact secret values to remove in any encoding, such as the API key the run used. */
  knownSecrets?: readonly string[]
}

/**
 * Redact every string field that leaves the machine: name, attributes, and
 * status message. `assessSpans` below (and the MCP search tools built on this
 * store) all read `span.name`, so a secret left there is as reachable as one
 * in an attribute — a search for it just works, defeating redaction.
 */
export function redactSpans(spans: readonly OtlpSpan[], options: RedactSpansOptions = {}): SpanRedaction {
  const parts = spans.map((span) => ({
    name: span.name,
    attributes: stripSourceAttributes(span.attributes),
    message: span.status.message,
  }))
  const { value, report } = redact(parts, options)
  const out = spans.map((span, index) => {
    const part = value[index]!
    normalizeToolIoAttributes(part.attributes)
    const status =
      part.message !== undefined && part.message !== span.status.message
        ? { ...span.status, message: part.message }
        : span.status
    return { ...span, name: part.name, attributes: part.attributes, status }
  })
  return { spans: out, report }
}

/**
 * The share-safety verdict for spans as they would be sent. UNSAFE and UNKNOWN
 * refuse. Finding paths start with the span id.
 */
export function assessSpans(spans: readonly OtlpSpan[], profile: RedactionProfile = 'default'): ShareSafetyVerdict {
  return combineVerdicts(
    profile,
    spans.map((span) => {
      const verdict = assessShareSafety({ name: span.name, attributes: span.attributes, status: span.status }, { profile })
      return {
        ...verdict,
        findings: verdict.findings.map((finding) => ({
          ...finding,
          paths: finding.paths.map((path) => `span:${span.span_id}${path}`),
        })),
        unreadable: verdict.unreadable.map((entry) => `span:${span.span_id}${entry}`),
      }
    }),
  )
}

/** Defense-in-depth: run an external {@link Redactor} over captured conversation
 *  and tool values, catching free-form PII the core misses. Compose AFTER
 *  `redactSpans`. Returns scrubbed spans and the number of fields changed. */
export async function applyRedactor(
  spans: readonly OtlpSpan[],
  redactor: Redactor,
): Promise<{ spans: OtlpSpan[]; changed: number }> {
  const capturedKeys = ['content', ...TOOL_IO_VALUE_KEYS] as const
  const fields: Array<
    | { spanIndex: number; key: (typeof capturedKeys)[number] }
    | { spanIndex: number; key: 'status.message' }
  > = []
  const texts: string[] = []
  spans.forEach((s, i) => {
    for (const key of capturedKeys) {
      const value = s.attributes[key]
      if (typeof value === 'string' && value.length > 0) {
        fields.push({ spanIndex: i, key })
        texts.push(value)
      }
    }
    if (s.status.message) {
      fields.push({ spanIndex: i, key: 'status.message' })
      texts.push(s.status.message)
    }
  })
  const out = spans.map((s) => ({ ...s, attributes: stripSourceAttributes(s.attributes) }))
  if (texts.length === 0) {
    for (const span of out) normalizeToolIoAttributes(span.attributes)
    return { spans: out, changed: 0 }
  }
  const scrubbed = await redactor.redactText(texts)
  if (scrubbed.length !== texts.length) {
    throw new Error(`redactor ${redactor.name}: expected ${texts.length} values, received ${scrubbed.length}`)
  }
  let changed = 0
  fields.forEach(({ spanIndex, key }, k) => {
    if (scrubbed[k] !== texts[k]) {
      if (key === 'status.message') {
        out[spanIndex]!.status = { ...out[spanIndex]!.status, message: scrubbed[k] }
      } else {
        out[spanIndex]!.attributes[key] = scrubbed[k]
      }
      changed += 1
    }
  })
  for (const span of out) normalizeToolIoAttributes(span.attributes)
  return { spans: out, changed }
}
