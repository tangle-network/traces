/**
 * Which Claude transcript events are one logical event. Claude Code can write
 * an event more than once; a repeat that means the same thing is consumed once,
 * and a repeat that says something different is corruption the caller sees.
 */

import { createHash } from 'node:crypto'
import { SOURCE_ATTRIBUTE_PREFIX } from '../source-location.js'
import type { ClaudeEventProjection } from './claude.js'

/** What {@link distinctClaudeEvent} decided about one transcript event. */
export type DistinctClaudeEvent =
  | { readonly projection: ClaudeEventProjection; readonly uid: string }
  /** A repeat of an already-consumed event whose only new information is the
   * `origin` label Claude Code added when it re-emitted it. */
  | { readonly originEnrichment: string; readonly uid: string }

interface SeenClaudeEvent {
  /** Fingerprint of the span-producing fields, origin attribution and billed counts excluded. */
  readonly fingerprint: string
  /** `origin.kind` the first copy carried, null when it carried none. */
  readonly originKind: string | null
  /** The billed counts the first copy carried, null for an event that bills nothing. */
  readonly usage: string | null
}

export type SeenClaudeEvents = Map<string, SeenClaudeEvent>

export class ClaudeEventConflictError extends Error {
  readonly sourcePath: string
  readonly eventId: string

  constructor(sourcePath: string, eventId: string) {
    super(`${sourcePath}: Claude transcript event ${JSON.stringify(eventId)} has conflicting payloads`)
    this.name = 'ClaudeEventConflictError'
    this.sourcePath = sourcePath
    this.eventId = eventId
  }
}

const BILLED_COUNTS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'] as const

function fingerprintClaudeEvent(event: ClaudeEventProjection): string {
  // Duplicate events can occupy different byte ranges without changing their
  // meaning, and a re-emission can ADD an origin label to an event that lacked
  // one, so origin attribution is compared outside the fingerprint. So are the
  // billed counts: a resumed transcript re-emits an event with them zeroed.
  return createHash('sha256').update(JSON.stringify(event, (key, value: unknown) =>
    key === 'contentSource'
      || key === 'originKind'
      || key.startsWith(SOURCE_ATTRIBUTE_PREFIX)
      || (BILLED_COUNTS as readonly string[]).includes(key)
      ? undefined
      : value,
  )).digest('hex')
}

/** The billed counts of an assistant event, or null when it bills nothing. */
function billedCounts(event: ClaudeEventProjection): string | null {
  if (event.kind !== 'assistant') return null
  const counts = BILLED_COUNTS.map((key) => event[key])
  return counts.some((count) => count !== null && count !== 0) ? JSON.stringify(counts) : null
}

/**
 * Claude occasionally persists the same event twice. A repeated UUID with the
 * same span-producing fields is one logical event; a changed emitted field is
 * corruption that must remain visible to callers.
 *
 * One repeat is NOT corruption: continuing a subagent under a later prompt
 * re-emits its earlier events with the `origin` label that the first copy
 * predates. The re-emission is the same logical event — its span-producing
 * fields match — so it is consumed once and only the origin attribution is
 * enriched (the caller folds it into the first copy's prompt span). A repeat
 * whose origin label conflicts with one already recorded remains an error.
 *
 * Nor is a repeat that bills nothing: a resumed subagent re-emits an earlier
 * assistant event with every usage count zeroed. The first copy's billing
 * stands; a repeat that bills a different nonzero amount remains an error.
 */
export function distinctClaudeEvent(
  eventUuid: string | undefined,
  projection: ClaudeEventProjection,
  seen: SeenClaudeEvents,
  sourcePath: string,
  fallbackUid: string,
): DistinctClaudeEvent | undefined {
  if (eventUuid) {
    const uid = eventUuid
    const fingerprint = fingerprintClaudeEvent(projection)
    const usage = billedCounts(projection)
    const originKind = (projection.kind === 'user' || projection.kind === 'queued-prompt'
      ? projection.originKind
      : null) ?? null
    const previous = seen.get(uid)
    if (previous) {
      if (previous.fingerprint !== fingerprint || (usage !== null && usage !== previous.usage)) {
        throw new ClaudeEventConflictError(sourcePath, uid)
      }
      if (previous.originKind === null && originKind !== null) {
        // Record the enrichment on the seen entry, so a later copy that
        // contradicts the now-recorded label conflicts instead of enriching.
        seen.set(uid, { fingerprint, originKind, usage: previous.usage })
        return { originEnrichment: originKind, uid }
      }
      if (previous.originKind !== null && originKind !== null && previous.originKind !== originKind) {
        throw new ClaudeEventConflictError(sourcePath, uid)
      }
      return undefined
    }
    seen.set(uid, { fingerprint, originKind, usage })
  }
  return { projection, uid: eventUuid ?? fallbackUid }
}
