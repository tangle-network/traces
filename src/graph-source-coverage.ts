/** Source quality is metadata from maintained readers, never a transcript parser. */
import { SOURCE_UNREADABLE_FILES_ATTR, SOURCE_UNREADABLE_ROWS_ATTR } from './source-unreadable.js'
import type { OtlpSpan } from './otlp.js'

export function sourceCoverage(spans: readonly OtlpSpan[]): Array<{ kind: string; reason: string }> {
  const issues = spans.flatMap((span) => {
    const value = span.attributes['traces.source.unknowns']
    if (typeof value !== 'string') return []
    try {
      const reasons: unknown = JSON.parse(value)
      return Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string').map((reason) => ({ kind: 'source-coverage', reason })) : []
    } catch { return [{ kind: 'source-coverage', reason: 'source coverage metadata was unreadable' }] }
  })
  if (spans.some((span) => span.attributes['traces.source.partial_tail'] === true)) issues.push({ kind: 'partial-source-tail', reason: 'Source journal ends in an incomplete record' })
  if (spans.some((span) => typeof span.attributes[SOURCE_UNREADABLE_ROWS_ATTR] === 'number' && Number(span.attributes[SOURCE_UNREADABLE_ROWS_ATTR]) > 0)) issues.push({ kind: 'unread-source-records', reason: 'Normalized source reports unreadable rows; accounting is incomplete' })
  const unreadableFiles = spans.reduce((count, span) => {
    const value = span.attributes[SOURCE_UNREADABLE_FILES_ATTR]
    return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(count, value) : count
  }, 0)
  if (unreadableFiles) issues.push({ kind: 'source-coverage', reason: `${unreadableFiles} source file(s) could not be read. Their row count is unknown.` })
  const uncertain = new Set(spans.map((span) => span.attributes['agent.parent.confidence']).filter((value) => value === 'heuristic' || value === 'unknown'))
  for (const confidence of uncertain) issues.push({ kind: 'source-coverage', reason: `Recorded parent binding confidence is ${confidence}; topology includes uncertain source containment` })
  return issues
}

