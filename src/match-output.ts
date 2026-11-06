/** `traces facts --match` output: the hits as text, or with `--count` the hits per value of the pattern's first capture group. */
import type { RecordLine } from './record-lines.js'
import type { SessionMatch } from './session-facts.js'

/** A match row, the file its session was read from, and for a command its record and output's last line (see `citeFacts`). */
export type SourcedMatch = SessionMatch & { readonly source: string | null; readonly record?: RecordLine | null; readonly lastLine?: string | null }

/** `facts --match` as text: one line per hit, oldest first; a command's line says `ok`, `failed`, or `?` when its call's status is not its own. */
export function renderMatches(pattern: string, sessions: number, matches: readonly SourcedMatch[]): string {
  const lines = [`${matches.length} match(es) for /${pattern}/ in ${sessions} session(s), deterministic, $0`]
  for (const match of matches) {
    const outcome = match.kind !== 'command' ? '' : `${(match.failed === true ? 'failed' : match.failed === false ? 'ok' : '?').padEnd(6)}  `
    lines.push(`${match.at}  ${(match.sessionId ?? '?').slice(0, 8)}  ${match.kind.padEnd(7)}  ${outcome}${match.text}`)
    // The record to cite, and the output's last line, which no clipped row shows.
    if (match.record) lines.push(`  ${match.record.file}:${match.record.line}${match.lastLine == null ? '' : `  last: ${match.lastLine.slice(0, 300)}`}`)
  }
  return `${lines.join('\n')}\n`
}

/** `facts --match --count` over hits oldest first: per value of the pattern's first capture group (else per hit), its hits and their first and last time, most hits first. */
export function renderMatchCounts(pattern: string, sessions: number, matches: readonly SourcedMatch[], format: string): { rendered: string; groups: number } {
  const re = new RegExp(pattern)
  const groups = new Map<string, { group: string; count: number; first: string; last: string }>()
  for (const { text, at } of matches) {
    const hit = re.exec(text)
    const group = hit?.[1] ?? hit?.[0] ?? text
    const entry = groups.get(group) ?? groups.set(group, { group, count: 0, first: at, last: at }).get(group)!
    entry.count += 1
    entry.last = at
  }
  const rows = [...groups.values()].sort((left, right) => right.count - left.count || left.group.localeCompare(right.group))
  const rendered = format === 'json'
    ? `${JSON.stringify({ schemaVersion: 1, kind: 'traces.match_counts', pattern, sessions, groups: rows }, null, 2)}\n`
    : format === 'jsonl'
      ? rows.map((row) => `${JSON.stringify(row)}\n`).join('')
      : `${[`${matches.length} match(es) for /${pattern}/ in ${rows.length} group(s), ${sessions} session(s), $0`, ...rows.map((row) => `${String(row.count).padStart(7)}  ${row.first}  ${row.last}  ${row.group}`)].join('\n')}\n`
  return { rendered, groups: rows.length }
}
