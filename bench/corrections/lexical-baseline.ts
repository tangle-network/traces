/**
 * The baseline arm of `bench/corrections`: a frozen copy of the lexical
 * reaction classifier traces 0.23.1 shipped (`src/adapters/actor.ts:263-293` at
 * `4da187f`). The analyze "user reactions" section counted a human turn as
 * corrective when it matched any of {@link CORRECTIVE_REACTIONS}.
 *
 * Nothing in `src` imports this file, and it is never edited: it is the number
 * the 1.0 signals are measured against.
 */

// ── reaction classification (extract.py classify(), verbatim regexes) ────────

export type Reaction = 'correction' | 'frustration' | 'praise' | 'jargon' | 'structure'

const JARGON_COMPLAINT =
  /\b(jargon|plain english|plain language|eli5|explain like|in plain|what does that mean|what does .* mean|i don'?t (understand|get)|gibberish|english please|too technical|speak (plainly|english)|dumb(ed)? it down|simpler|simplify your|no buzzwords?)\b/
const STRUCTURE_COMPLAINT =
  /\b(too long|tl;?dr|get to the point|bluf|lead with|bullet|bulletpoint|wall of text|too verbose|shorter|be concise|stop (yapping|rambling)|less words?|fewer words?|just (the|tell me)|cut the)\b/
const CORRECTION =
  /(\bno[,. ]|^no\b|\bstop\b|\bdon'?t\b|you keep|i (said|told you|asked)|that'?s not (what|right|it)|not what i|didn'?t ask|incorrect|that'?s wrong|you'?re wrong|why are you|why did you|that'?s not the|missed the|not the point|ur wrong|thats not)/
const FRUSTRATION =
  /(ugh|wtf|wth|come on|seriously|again\?|for the (last|nth) time|are you kidding|jesus|christ|frustrat|annoying|wasting|waste of)/
const PRAISE =
  /\b(perfect|exactly|nailed it|love (it|this)|beautiful|great work|ship it|clean|nice work|excellent|that'?s it|yes!+|amazing|chef'?s kiss|brilliant)\b/

/** Label a human turn with every reaction signal it matches. Mirrors
 *  extract.py classify() — lowercased match, multi-label. */
export function classifyReaction(text: string): Reaction[] {
  const t = text.toLowerCase()
  const hits: Reaction[] = []
  if (JARGON_COMPLAINT.test(t)) hits.push('jargon')
  if (STRUCTURE_COMPLAINT.test(t)) hits.push('structure')
  if (CORRECTION.test(t)) hits.push('correction')
  if (FRUSTRATION.test(t)) hits.push('frustration')
  if (PRAISE.test(t)) hits.push('praise')
  return hits
}

/** Reactions that signal the agent did something wrong (the numerator of the
 *  corrective-to-positive ratio). `praise` is the positive denominator. */
export const CORRECTIVE_REACTIONS: readonly Reaction[] = ['correction', 'frustration', 'jargon', 'structure']
