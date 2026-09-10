/**
 * Evidence-gate rejections, counted per analyst and reason.
 *
 * agent-eval's trace analysts drop a submitted finding when its citations do
 * not resolve, and report each drop only as a `finding rejected: ...` log
 * event. A report that shows "0 findings" without those events reads as "the
 * model found nothing" when the truth may be "the gate refused everything it
 * found". This module turns the log events into counts a report can print.
 */

/** Rejection counts by reason, for one analyst or question. */
export type FindingRejectionReasons = Readonly<Record<string, number>>

/** Rejection counts keyed by analyst ID, then by reason. */
export type FindingRejectionCounts = Readonly<Record<string, FindingRejectionReasons>>

const REJECTION_MESSAGE = /^(?:\[([^\]]+)\] )?finding rejected: (.+)$/

/**
 * The analyst and reason behind one `finding rejected:` log event, or
 * undefined for any other event. The registry prefixes each analyst's log
 * message with `[<analyst-id>] `; a direct `runTraceAnalyst` caller does not,
 * so the analyst ID is optional here.
 */
export function findingRejection(
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): { analystId?: string; reason: string } | undefined {
  const match = REJECTION_MESSAGE.exec(message)
  if (!match) return undefined
  const kind = match[2]!.trim()
  // "unresolved evidence" is one message for several causes; the cause is in
  // the fields, and it is the part an operator can act on.
  const reason = kind === 'unresolved evidence' && typeof fields?.reason === 'string' && fields.reason
    ? fields.reason
    : kind
  return match[1] ? { analystId: match[1], reason } : { reason }
}

/**
 * The cause an event carries in its fields: `reason` for the gate's own
 * rejections and the dspy engine's bridge-row rejection, `issues` for a schema
 * failure. Undefined when the event names no cause beyond its kind.
 */
function rejectionCause(fields?: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof fields?.reason === 'string' && fields.reason) return fields.reason
  const issues = fields?.issues
  if (typeof issues === 'string' && issues) return issues
  if (Array.isArray(issues) && issues.length > 0) return issues.map((issue) => String(issue)).join('; ')
  return undefined
}

/**
 * What a rejection log event carries beyond its own message: the cause, the
 * offending URI, the citation counts, the subject. Empty when the message
 * already says everything known — the kind is in the message, so repeating it
 * would print "finding rejected: schema failure — schema failure". Undefined
 * for an event that is not a rejection at all.
 */
export function findingRejectionDetail(
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): string | undefined {
  const rejection = findingRejection(message, fields)
  if (!rejection) return undefined
  // The cause when the fields name one, the kind otherwise — and only when the
  // message does not already end with it.
  const lead = rejectionCause(fields) ?? rejection.reason
  const parts = message.endsWith(lead) ? [] : [lead]
  if (typeof fields?.uri === 'string' && fields.uri) parts.push(`uri ${fields.uri}`)
  if (typeof fields?.required === 'number' && typeof fields?.distinct === 'number') {
    parts.push(`${fields.distinct} of ${fields.required} required distinct citation(s)`)
  }
  if (typeof fields?.subject === 'string' && fields.subject) parts.push(`subject ${fields.subject}`)
  return parts.join('; ')
}

export interface FindingRejectionTally {
  /** Record one log event; events that are not rejections are ignored. */
  record(message: string, fields?: Readonly<Record<string, unknown>>): void
  /** A snapshot of the counts so far. */
  counts(): FindingRejectionCounts
}

/**
 * Count rejections from a log stream. `defaultAnalystId` names the analyst
 * for unprefixed events, as when one tally observes one question.
 */
export function createFindingRejectionTally(defaultAnalystId = 'unknown'): FindingRejectionTally {
  const byAnalyst = new Map<string, Map<string, number>>()
  return {
    record(message, fields) {
      const rejection = findingRejection(message, fields)
      if (!rejection) return
      const analystId = rejection.analystId ?? defaultAnalystId
      const reasons = byAnalyst.get(analystId) ?? new Map<string, number>()
      reasons.set(rejection.reason, (reasons.get(rejection.reason) ?? 0) + 1)
      byAnalyst.set(analystId, reasons)
    },
    counts() {
      return Object.fromEntries(
        [...byAnalyst].map(([analystId, reasons]) => [analystId, Object.fromEntries(reasons)]),
      )
    },
  }
}

/** Total rejections across every reason. */
export function totalFindingRejections(reasons: FindingRejectionReasons | undefined): number {
  return Object.values(reasons ?? {}).reduce((sum, count) => sum + count, 0)
}

/**
 * "2 finding(s) rejected: excerpt is not present in the cited span content ×2".
 * Empty when nothing was rejected. Reasons are ordered by count, then name, so
 * the same counts always render the same text.
 */
export function formatFindingRejections(reasons: FindingRejectionReasons | undefined): string {
  const total = totalFindingRejections(reasons)
  if (total === 0) return ''
  const ordered = Object.entries(reasons ?? {})
    .filter(([, count]) => count > 0)
    .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
    .map(([reason, count]) => `${reason} ×${count}`)
  return `${total} finding(s) rejected: ${ordered.join('; ')}`
}
