import type { OtlpSpan } from './otlp.js'
import type { OtlpIngestIssue, OtlpIngestIssueKind, UnreadableSourceRows } from './otlp-input.js'

/**
 * How many rows of the ORIGINAL source could not be represented as spans, and
 * which kinds — carried on every span of an export so the count survives any
 * number of re-exports.
 *
 * These exist because a dropped row CANNOT be re-emitted. The artifact this
 * package writes is also the store its analysts read, so a line that is not a
 * span would be garbage fed to the analysis, and a repaired one would be
 * invented work. What the artifact can do is refuse to pass itself off as the
 * source: it states, in its own resource attributes, exactly how much of the
 * source is missing from it, so `validate` on a re-export cannot read as a
 * clean bill of health for a file that never was one.
 */
export const SOURCE_UNREADABLE_ROWS_ATTR = 'traces.source.unreadable_rows'
export const SOURCE_UNREADABLE_KINDS_ATTR = 'traces.source.unreadable_row_kinds'

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Record on every span how much of the source is NOT in this set, and return
 * the same fact to the caller.
 *
 * A dropped row cannot be put back. It is not a span, so it cannot go in an
 * export that this package's own analysts read as spans, and repairing it into
 * one would put invented work into every total. This is the other half of the
 * only honest choice left: the export does not claim to be the source. It
 * carries the number of rows it is missing, so `traces check --contract conformance` on a
 * re-export reports the loss instead of handing back the clean bill of health
 * the source never earned.
 *
 * The count ACCUMULATES. An export of an export inherits the earlier hops'
 * total (read off the spans, where the previous export left it) and adds its
 * own, so no chain of re-exports launders a defect by length.
 */
export function stampUnreadableSourceRows(
  spans: readonly OtlpSpan[],
  issues: readonly OtlpIngestIssue[],
): UnreadableSourceRows {
  let inherited = 0
  const kinds = new Set<OtlpIngestIssueKind>()
  for (const span of spans) {
    inherited = Math.max(inherited, positiveInteger(span.attributes[SOURCE_UNREADABLE_ROWS_ATTR]))
    const declared = span.attributes[SOURCE_UNREADABLE_KINDS_ATTR]
    if (typeof declared === 'string') {
      for (const kind of declared.split(',')) if (kind.length > 0) kinds.add(kind as OtlpIngestIssueKind)
    }
  }
  for (const issue of issues) kinds.add(issue.kind)
  const total = inherited + issues.length
  const sortedKinds = [...kinds].sort()
  if (total > 0) {
    for (const span of spans) {
      span.attributes[SOURCE_UNREADABLE_ROWS_ATTR] = total
      span.attributes[SOURCE_UNREADABLE_KINDS_ATTR] = sortedKinds.join(',')
    }
  }
  return { rows: total, kinds: sortedKinds, inherited }
}
