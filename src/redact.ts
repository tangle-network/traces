/**
 * Privacy redaction for trace spans before upload.
 *
 * Reuses agent-eval's `redactValue` + `DEFAULT_REDACTION_RULES` (email, IPs,
 * generic secret keys, …) and layers on coding-session-specific rules that the
 * defaults miss — GitHub tokens, cloud keys, JWTs, bearer headers, private-key
 * blocks, `key=secret` assignments, and credentials embedded in URLs. Redaction
 * runs over every span attribute + status message (including captured prompt /
 * response `content`), so what leaves the machine is already scrubbed.
 *
 * Scope, stated honestly: this is **best-effort regex** for *structured* secrets
 * and credentials. It does NOT catch free-form PII — names, postal addresses,
 * phone numbers, account numbers in prose — which need a context-aware model.
 * For that assurance, run an ML PII scrubber (e.g. openai/privacy-filter) on the
 * ingest side of the platform, or upload metadata-only with `--no-content`.
 */

import { DEFAULT_REDACTION_RULES, redactValue } from '@tangle-network/agent-eval/traces'
import type { RedactionReport, RedactionRule } from '@tangle-network/agent-eval/traces'
import type { Redactor } from './external.js'
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
  // Credentials embedded in URLs — common when a prompt pastes a curl/clone line.
  { id: 'url-userinfo', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  {
    id: 'url-secret-param',
    pattern:
      /[?&](?:access[_-]?token|api[_-]?key|apikey|auth|token|secret|password|sig|signature)=[^&\s"'#)]+/gi,
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

/** Defense-in-depth: run an external {@link Redactor} (e.g. an ML PII model) over
 *  every span's captured `content` (prompt/response prose), catching free-form
 *  PII the regex pass misses. Compose AFTER `redactSpans`. Returns scrubbed spans
 *  and the number of `content` fields the model changed. */
export async function applyRedactor(
  spans: readonly OtlpSpan[],
  redactor: Redactor,
): Promise<{ spans: OtlpSpan[]; changed: number }> {
  const idx: number[] = []
  const texts: string[] = []
  spans.forEach((s, i) => {
    const c = s.attributes['content']
    if (typeof c === 'string' && c.length > 0) {
      idx.push(i)
      texts.push(c)
    }
  })
  const out = spans.map((s) => ({ ...s, attributes: { ...s.attributes } }))
  if (texts.length === 0) return { spans: out, changed: 0 }
  const scrubbed = await redactor.redactText(texts)
  let changed = 0
  idx.forEach((spanI, k) => {
    if (scrubbed[k] !== texts[k]) {
      out[spanI]!.attributes['content'] = scrubbed[k]
      changed += 1
    }
  })
  return { spans: out, changed }
}
