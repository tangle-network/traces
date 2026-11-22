/** Turn export over the shared facts fold, without computing unrelated full-sheet measurements. */
import { isRecordSpan, SESSION_CWD_ATTR } from './attributes.js'
import { byTraceOrder, type SessionFactsWindow, type UnreadSessionFact } from './session-facts.js'
import { groupByTrace } from './session-scopes.js'
import { stringAttr, typedTurnsOf } from './session-turns.js'
import { hasWorkInWindow, insideWindow, windowBounds } from './session-window.js'
import { readRecordLines } from './record-lines.js'
import type { OtlpSpan } from './otlp.js'
import { turnWorkOf } from './turn-work.js'

export interface TurnSource {
  readonly spans: readonly OtlpSpan[]
  readonly source: string | null
}

/**
 * Each session in `spans` with work in the window: its spans in trace order,
 * every typed turn (the work before a turn just inside the window starts
 * outside it), and the turns inside the window.
 */
function readSessionTurnGroups(spans: readonly OtlpSpan[], window?: SessionFactsWindow) {
  const bounds = windowBounds(window)
  return groupByTrace(spans).flatMap((group) => {
    const records = group.spans.filter(isRecordSpan)
    if (records.length > 0 && bounds !== null && !hasWorkInWindow(records, bounds)) return []
    const ordered = [...group.spans].sort(byTraceOrder)
    const typed = typedTurnsOf(ordered).turns
    return [{
      sessionId: group.sessionId,
      records: records.length,
      harness: ordered.map((span) => stringAttr(span, 'service.name')).find((value) => value !== null) ?? null,
      cwd: ordered.map((span) => stringAttr(span, SESSION_CWD_ATTR)).find((value) => value !== null) ?? null,
      spans: ordered,
      typed,
      turns: typed.filter((turn) => insideWindow(bounds, turn.at)),
    }]
  })
}

/**
 * Each batch holds one session's spans. Every row carries the turn's `work`,
 * the agent's work since the person's previous turn. With `includeContent`,
 * a row also carries the turn's text, the messages around it, the session's cwd
 * and a native file/line citation when available; without it, none of those.
 */
export async function turnFactsJsonl(
  sources: AsyncIterable<TurnSource>,
  host: string,
  window?: SessionFactsWindow,
  includeContent = true,
): Promise<{ text: string; sessions: number; turns: number; unread: UnreadSessionFact[] }> {
  const rows: string[] = []
  let sessions = 0
  const unread: UnreadSessionFact[] = []
  for await (const { spans, source } of sources) {
    for (const group of readSessionTurnGroups(spans, window)) {
      if (group.records === 0) {
        unread.push({ sessionId: group.sessionId, traceId: null, source, reason: 'no record could be read' })
        continue
      }
      sessions += 1
      const work = turnWorkOf(group.spans, group.typed)
      const lines = !includeContent || source === null ? null : await readRecordLines([source], { callIds: new Set(), turns: group.turns })
      for (const turn of group.turns) {
        const row = {
          host, harness: group.harness, session: group.sessionId, at: turn.at, author: turn.author,
          interrupted: turn.interrupted, signals: turn.signals, spanId: turn.spanId, work: work.get(turn.spanId) ?? null,
        }
        if (!includeContent) {
          rows.push(JSON.stringify(row))
          continue
        }
        const record = lines?.turn(turn.at, turn.text) ?? null
        rows.push(JSON.stringify({
          ...row, cwd: group.cwd, text: turn.text, answered: turn.answered, reply: turn.reply,
          recordFile: source, record: record === null ? null : { file: record.file, line: record.line },
        }))
      }
    }
  }
  return { text: rows.length === 0 ? '' : `${rows.join('\n')}\n`, sessions, turns: rows.length, unread }
}
