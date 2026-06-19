/**
 * Privacy redaction for trace spans before upload.
 *
 * Reuses agent-eval's `redactValue` + `DEFAULT_REDACTION_RULES` (email, IPs,
 * generic secret keys, …) and layers on coding-session-specific rules that the
 * defaults miss — GitHub tokens, cloud keys, JWTs, bearer headers, private-key
 * blocks, and `key=secret` assignments common in shell/tool output. Redaction
 * runs over every span attribute + status message, so what leaves the machine
 * is already scrubbed.
 */

import { DEFAULT_REDACTION_RULES, redactValue } from '@tangle-network/agent-eval/traces'
import type { RedactionReport, RedactionRule } from '@tangle-network/agent-eval/traces'
import type { OtlpSpan } from './otlp.js'

/** Secrets common in coding-agent traces that the substrate defaults don't cover. */
export const CODING_REDACTION_RULES: RedactionRule[] = [
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { id: 'aws-akid', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi },
  {
    id: 'private-key',
    pattern: /-----BEGIN(?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END(?:[A-Z ]+)?PRIVATE KEY-----/g,
  },
  {
    id: 'assigned-secret',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]{12,}["']?/gi,
  },
]

/** Defaults + coding-session rules — the rule set used for upload. */
export const TRACES_REDACTION_RULES: RedactionRule[] = [...DEFAULT_REDACTION_RULES, ...CODING_REDACTION_RULES]

export interface SpanRedaction {
  spans: OtlpSpan[]
  report: RedactionReport
}

/** Redact every span's attributes + status message. Returns scrubbed spans and
 *  an aggregate report (count + per-rule breakdown) over the whole set. */
export function redactSpans(
  spans: readonly OtlpSpan[],
  rules: RedactionRule[] = TRACES_REDACTION_RULES,
): SpanRedaction {
  const report: RedactionReport = { redactionCount: 0, byRule: {} }
  const out = spans.map((s) => {
    const attributes = redactValue(s.attributes, rules, report).value as Record<string, unknown>
    let status = s.status
    if (status.message) {
      const m = redactValue(status.message, rules, report).value
      if (typeof m === 'string' && m !== status.message) status = { ...status, message: m }
    }
    return { ...s, attributes, status }
  })
  return { spans: out, report }
}
