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
 * account numbers written in prose. For that, run your own scrubber on a
 * converted file (`traces convert X --out f`, scrub `f`, `traces upload f`) or
 * upload metadata-only with `--no-content`.
 */

import {
  assessShareSafety,
  combineVerdicts,
  type RedactionProfile,
  type RedactionReport,
  redact,
  type ShareSafetyVerdict,
} from '@tangle-network/agent-eval/traces'
import { normalizeToolIoAttributes } from './adapters/tool-io.js'
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
 * Redact every string field that leaves the machine: name, attributes, status
 * message, and each causal link's own attributes. `assessSpans` below (and
 * the MCP search tools built on this store) all read `span.name` and
 * `span.links[].attributes` — a secret left in either is as reachable as one
 * in an attribute — a search for it just works, defeating redaction. The core
 * redacts nested object keys as well as values (a credential shape glued into
 * a key name, such as an env-style attribute key carrying a token, is renamed
 * the same as a credential-shaped value), so link attributes get that same
 * coverage once they are part of what `redact` walks.
 */
export function redactSpans(spans: readonly OtlpSpan[], options: RedactSpansOptions = {}): SpanRedaction {
  const parts = spans.map((span) => ({
    name: span.name,
    attributes: stripSourceAttributes(span.attributes),
    message: span.status.message,
    links: span.links?.map((link) => ({
      ...link,
      ...(link.attributes ? { attributes: stripSourceAttributes(link.attributes) } : {}),
    })),
  }))
  const { value, report } = redact(parts, options)
  const out = spans.map((span, index) => {
    const part = value[index]!
    normalizeToolIoAttributes(part.attributes)
    const status =
      part.message !== undefined && part.message !== span.status.message
        ? { ...span.status, message: part.message }
        : span.status
    return {
      ...span,
      name: part.name,
      attributes: part.attributes,
      status,
      ...(part.links ? { links: part.links } : {}),
    }
  })
  return { spans: out, report }
}

/**
 * The share-safety verdict for spans as they would be sent. UNSAFE and UNKNOWN
 * refuse. Finding paths start with the span id. Covers `links[].attributes`
 * for the same reason {@link redactSpans} does: a secret reachable through a
 * causal link is as live as one on the span itself.
 */
export function assessSpans(spans: readonly OtlpSpan[], profile: RedactionProfile = 'default'): ShareSafetyVerdict {
  return combineVerdicts(
    profile,
    spans.map((span) => {
      const verdict = assessShareSafety(
        { name: span.name, attributes: span.attributes, status: span.status, links: span.links },
        { profile },
      )
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
