/**
 * User-reaction analyst — deterministic, $0, no API key.
 *
 * For every real human turn (`actor === 'human'` on a `user.prompt` span) that
 * FOLLOWS an assistant turn, classify the human's reaction (correction /
 * frustration / praise / jargon / structure complaint) with the trace-audit
 * classifier, then roll up:
 *   - per-session + corpus signal counts
 *   - the corrective-to-positive ratio (how often the human pushed back vs
 *     praised)
 *   - the top "trigger pairs": the assistant prose that drew the strongest
 *     human reaction
 *
 * Findings only consider `actor === 'human'` turns — that's why the actor tag
 * (feature 1) is a hard dependency. An agent-to-agent or injected prompt is not
 * a human reaction and must not pollute the counts.
 */

import { classifyReaction, CORRECTIVE_REACTIONS, type Reaction } from './adapters/actor.js'
import { ACTOR_ATTR } from './adapters/conversation.js'
import type { OtlpSpan } from './otlp.js'

/** Reaction labels in stable render order. */
export const REACTIONS: readonly Reaction[] = ['correction', 'frustration', 'jargon', 'structure', 'praise']

export interface TriggerPair {
  /** The assistant prose immediately preceding the human reaction. */
  assistant: string
  /** The human's reacting turn. */
  human: string
  /** Signals matched on the human turn. */
  reactions: Reaction[]
  sessionId: string
}

export interface ReactionSessionReport {
  sessionId: string
  /** Human turns that followed an assistant turn (the denominator). */
  humanReactionTurns: number
  signals: Record<Reaction, number>
}

export interface ReactionReport {
  sessions: ReactionSessionReport[]
  /** Corpus signal totals. */
  signals: Record<Reaction, number>
  /** Human turns that followed an assistant turn, corpus-wide. */
  humanReactionTurns: number
  /** corrective signals / praise signals. Infinity when praise is 0 but
   *  corrective > 0; NaN-safe (null) when there are no signals at all. */
  correctiveToPositiveRatio: number | null
  /** Highest-signal assistant→reaction pairs, most-corrective first. */
  triggerPairs: TriggerPair[]
}

function emptySignals(): Record<Reaction, number> {
  return { correction: 0, frustration: 0, jargon: 0, structure: 0, praise: 0 }
}

function spanStep(s: OtlpSpan): number {
  const v = s.attributes.step
  return typeof v === 'number' ? v : Number.MAX_SAFE_INTEGER
}

/** Order spans the way the otlp emitter intends: by `step`, falling back to
 *  start_time when step is absent. */
function ordered(spans: readonly OtlpSpan[]): OtlpSpan[] {
  return [...spans].sort((a, b) => {
    const ds = spanStep(a) - spanStep(b)
    if (ds !== 0) return ds
    return a.start_time.localeCompare(b.start_time)
  })
}

function isAssistant(s: OtlpSpan): boolean {
  const kind = s.attributes['openinference.span.kind']
  // The assistant's prose lands on LLM turns (llm.turn) and on codex
  // `message.assistant` CHAIN spans. A user.prompt is also a CHAIN, so exclude it.
  if (s.name === 'user.prompt') return false
  return kind === 'LLM' || s.name.startsWith('message.assistant')
}

function isHumanPrompt(s: OtlpSpan): boolean {
  return s.name === 'user.prompt' && s.attributes[ACTOR_ATTR] === 'human'
}

function contentOf(s: OtlpSpan): string {
  const c = s.attributes.content
  return typeof c === 'string' ? c : ''
}

const MAX_PAIRS = 10
/** Pair "strength" for ranking: corrective signals weigh more than praise, so
 *  the top pairs surface the moments the human pushed back hardest. */
function pairStrength(reactions: Reaction[]): number {
  let n = 0
  for (const r of reactions) n += CORRECTIVE_REACTIONS.includes(r) ? 2 : 1
  return n
}

/**
 * Build the user-reaction report from normalized spans. Spans may span multiple
 * sessions (corpus run); reactions are scoped per `trace_id`.
 */
export function analyzeReactions(spans: readonly OtlpSpan[]): ReactionReport {
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const s of spans) {
    const arr = byTrace.get(s.trace_id) ?? []
    arr.push(s)
    byTrace.set(s.trace_id, arr)
  }

  const sessions: ReactionSessionReport[] = []
  const corpus = emptySignals()
  let corpusTurns = 0
  const pairs: TriggerPair[] = []

  for (const [sessionId, traceSpans] of byTrace) {
    const seq = ordered(traceSpans)
    const sessionSignals = emptySignals()
    let humanReactionTurns = 0
    let lastAssistant: string | null = null

    for (const s of seq) {
      if (isAssistant(s)) {
        const text = contentOf(s)
        if (text) lastAssistant = text
        continue
      }
      if (!isHumanPrompt(s)) continue
      // Only a human turn that FOLLOWS an assistant turn is a reaction.
      if (lastAssistant === null) continue
      humanReactionTurns += 1
      const reactions = classifyReaction(contentOf(s))
      if (reactions.length > 0) {
        for (const r of reactions) {
          sessionSignals[r] += 1
          corpus[r] += 1
        }
        pairs.push({ assistant: lastAssistant, human: contentOf(s), reactions, sessionId })
      }
      // A human turn resets the "preceding assistant" — the next reaction must
      // follow a fresh assistant turn.
      lastAssistant = null
    }

    corpusTurns += humanReactionTurns
    sessions.push({ sessionId, humanReactionTurns, signals: sessionSignals })
  }

  const corrective = CORRECTIVE_REACTIONS.reduce((n, r) => n + corpus[r], 0)
  const positive = corpus.praise
  const totalSignals = corrective + positive
  const ratio = totalSignals === 0 ? null : positive === 0 ? Number.POSITIVE_INFINITY : corrective / positive

  pairs.sort((a, b) => pairStrength(b.reactions) - pairStrength(a.reactions))

  return {
    sessions,
    signals: corpus,
    humanReactionTurns: corpusTurns,
    correctiveToPositiveRatio: ratio,
    triggerPairs: pairs.slice(0, MAX_PAIRS),
  }
}
