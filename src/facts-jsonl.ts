/** Turn export over the shared facts fold, without computing unrelated full-sheet measurements. */
import { readSessionTurnGroups, type SessionFactsWindow, type UnreadSessionFact } from './session-facts.js'
import { readRecordLines } from './record-lines.js'
import type { OtlpSpan } from './otlp.js'

export interface TurnSource {
  readonly spans: readonly OtlpSpan[]
  readonly source: string | null
}

/** Each batch holds one session's spans; each row carries a native file/line citation when available. */
export async function turnFactsJsonl(
  sources: AsyncIterable<TurnSource>,
  host: string,
  window?: SessionFactsWindow,
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
      const lines = source === null ? null : await readRecordLines([source], { callIds: new Set(), turns: group.turns })
      for (const turn of group.turns) {
        const record = lines?.turn(turn.at, turn.text) ?? null
        rows.push(JSON.stringify({
          host, harness: group.harness, session: group.sessionId, cwd: group.cwd,
          at: turn.at, author: turn.author, text: turn.text,
          answered: turn.answered, reply: turn.reply, interrupted: turn.interrupted,
          signals: turn.signals, spanId: turn.spanId,
          recordFile: source, record: record === null ? null : { file: record.file, line: record.line },
        }))
      }
    }
  }
  return { text: rows.length === 0 ? '' : `${rows.join('\n')}\n`, sessions, turns: rows.length, unread }
}
