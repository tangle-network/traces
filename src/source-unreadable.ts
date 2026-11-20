import type { OtlpSpan } from './otlp.js'
import type { OtlpIngestIssue, OtlpIngestIssueKind, UnreadableSourceRows } from './otlp-input.js'

/** Resource markers repeated on each surviving span. They carry counts and issue kinds only. */
export const SOURCE_UNREADABLE_ROWS_ATTR = 'traces.source.unreadable_rows'
export const SOURCE_UNREADABLE_KINDS_ATTR = 'traces.source.unreadable_row_kinds'
export const SOURCE_UNREADABLE_FILES_ATTR = 'traces.source.unreadable_files'

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** A decoder failure says nothing about how many records the file contains. Paths stay at ingestion. */
export function classifyIngestLoss(issues: readonly OtlpIngestIssue[]) {
  const files = new Set<string>()
  const kinds = new Set<OtlpIngestIssueKind>()
  let rows = 0
  for (const issue of issues) {
    if (issue.unit === 'file') {
      files.add(issue.file)
    } else {
      rows++
      kinds.add(issue.kind)
    }
  }
  return { rows, kinds, files }
}

/** Inherit each repeated export counter once and add losses first observed at this hop. */
export function stampUnreadableSourceRows(
  spans: readonly OtlpSpan[],
  issues: readonly OtlpIngestIssue[],
): UnreadableSourceRows {
  const current = classifyIngestLoss(issues)
  let inherited = 0
  let inheritedFiles = 0
  for (const span of spans) {
    inherited = Math.max(inherited, positiveInteger(span.attributes[SOURCE_UNREADABLE_ROWS_ATTR]))
    inheritedFiles = Math.max(inheritedFiles, positiveInteger(span.attributes[SOURCE_UNREADABLE_FILES_ATTR]))
    const declared = span.attributes[SOURCE_UNREADABLE_KINDS_ATTR]
    if (typeof declared === 'string') {
      for (const kind of declared.split(',')) if (kind.length > 0) current.kinds.add(kind as OtlpIngestIssueKind)
    }
  }
  const rows = inherited + current.rows
  const files = inheritedFiles + current.files.size
  const kinds = [...current.kinds].sort()
  if (rows || files) {
    for (const span of spans) {
      if (rows > 0) {
        span.attributes[SOURCE_UNREADABLE_ROWS_ATTR] = rows
        span.attributes[SOURCE_UNREADABLE_KINDS_ATTR] = kinds.join(',')
      }
      if (files > 0) span.attributes[SOURCE_UNREADABLE_FILES_ATTR] = files
    }
  }
  return { rows, kinds, inherited, ...(files ? { files, inheritedFiles } : {}) }
}
