/** Typed-turn facts, shared by full sheets, the incremental index and JSONL turn exports. */
import { OPENINFERENCE_SPAN_KIND } from '@tangle-network/agent-eval/trace-attributes'
import { authorOfTypedTurn, INTERRUPT_TEXT, isHarnessCommand } from './adapters/actor.js'
import { ACTOR_ATTR, capText } from './adapters/conversation.js'
import { INHERITED_SOURCE_ATTR, INHERITED_SPAN_ATTR, isSubagentSpan } from './adapters/provenance.js'
import type { OtlpSpan } from './otlp.js'

function stringAttr(span: OtlpSpan, key: string): string | null {
  const value = span.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Max characters of message or prompt text kept per fact entry. */
export const FACT_TEXT_CAP = 2000

/** Max characters of the agent message kept in {@link SessionTurnFact.answered}. */
export const ANSWERED_TEXT_CAP = 1500

/**
 * A signal on a typed turn, counted since the person's previous
 * human turn (a fleet or relay turn in between does not reset it):
 *   - `interrupt`      the person interrupted the agent
 *   - `rejected-tool`  the person rejected a tool call
 *   - `after-claim`    the agent wrote since then, and its last message claims completion
 */
export type TurnSignal = 'interrupt' | 'rejected-tool' | 'after-claim'

/** Who typed a turn: a person, another agent or session relaying in (`fleet`), or a person pasting agent output (`relay`). */
export type TurnAuthor = 'human' | 'fleet' | 'relay'

/** One `user.prompt` turn, with the actor the adapter classified it as. */
export interface SessionTurnFact {
  readonly actor: string
  /** Who typed it. Always `human` in {@link SessionFacts.humanTurns}. */
  readonly author: TurnAuthor
  readonly at: string
  readonly text: string
  readonly spanId: string
  /**
   * The text of the last message this session's own agent wrote before the
   * turn: what the person was answering. Clipped to {@link ANSWERED_TEXT_CAP}
   * characters with a visible `… [+N chars]` marker. Null when the agent had
   * written no text before the turn.
   */
  readonly answered: string | null
  /** The `message.assistant` span `answered` was read from. */
  readonly answeredSpanId: string | null
  /**
   * The first message this session's own agent wrote after the turn, clipped
   * like `answered`. Null when it wrote none.
   */
  readonly reply: string | null
  /** The `message.assistant` span `reply` was read from. */
  readonly replySpanId: string | null
  /** The person interrupted the agent's work on this turn, before the next typed turn. */
  readonly interrupted: boolean
  /** The signals since the person's previous human turn; none on a `fleet` turn. */
  readonly signals: readonly TurnSignal[]
}

/**
 * Why a `user.prompt` turn is not a human turn of this session.
 *
 * The actors come from the adapters, which classify each turn from the
 * harness's own signals; the reasons here say, in the sheet's own voice, what
 * each classification means for the count. They match the audit rule a person
 * would apply by hand: a user message is one the human typed, and instruction
 * files, environment-context blocks, system reminders, tool results, subagent
 * notifications, turn-aborted markers and skill or slash-command expansions are
 * the harness feeding the model.
 */
const TURN_EXCLUSION_REASONS: Readonly<Record<string, string>> = {
  injected:
    'harness-injected content rather than typed text: an instruction file, an environment-context block, ' +
    'a system reminder, a task or subagent notification, an interrupt or turn-aborted marker, or a skill or ' +
    'slash-command expansion',
  agent: 'a parent agent sent this prompt to this session; no person typed it',
  'subagent-spawn': 'the brief that spawned this run, written by the agent that spawned it',
  'tool-result': 'a tool result the harness surfaced as a user turn',
  fleet:
    'another agent or session sent this turn in: a fleet message, a session-to-session message, an ' +
    'operator handoff, or a lane brief (a first turn over 1,500 characters); no person typed it here',
  relay: "a person pasted another agent's output: a long, markdown-heavy turn after the session's first",
  unclassified: 'the span carries no actor, so whether a person typed it cannot be read from the spans',
}

const INHERITED_TURN_REASON =
  'context this session carries but did not receive: history copied from the parent when the session forked, ' +
  'or the turns a compaction retained. The person typed it into the parent thread, not into this session'

const DUPLICATE_TURN_REASON =
  'a second record of the turn before it: the same text at the same instant, with no model call, tool call ' +
  'or assistant message between them'

const SUBAGENT_TURN_REASON =
  'a turn inside a subagent this session spawned, not a turn of this session: the person addressed the ' +
  'session, and the brief and notifications the subagent received are the parent agent talking to it'

const HARNESS_COMMAND_REASON =
  'a command the person gave the harness (/model, /clear, …), not a message to the agent'

/**
 * An agent message that opens by claiming the work is done. A person's turn
 * right after one is the `after-claim` signal.
 *
 * Only the opening sentence is read, with markdown marks removed, and a denial
 * or a question there is no claim. A status report that names a merged PR in
 * its fourth paragraph does not claim the work is done. Matching the word
 * anywhere put the signal on 57% of the Claude Code turns people typed, and on
 * a blind sample of flagged agent messages 44% were claims; reading the
 * opening sentence puts it on 17%, and 73% are claims (`bench/corrections/README.md`).
 */
const CLAIM_WORD =
  /\b(?:done|fixed|complete|completed|finished|implemented|merged|shipped|landed|resolved|verified|all green|tests pass(?:ed)?|ready|works now)\b/i
const CLAIM_DENIED =
  /\b(?:not|no|never|yet|still|cannot|can['’]?t|won['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|didn['’]?t|doesn['’]?t|hasn['’]?t|haven['’]?t|fail(?:s|ed|ing)?|broken|blocked)\b/i

/** A message's first sentence, without markdown marks or a leading list marker, at most 200 characters. */
function openingSentence(text: string): string {
  const plain = text.trimStart().replace(/[*_`#>]/g, '').replace(/^\s*(?:[-•→]|\d+[.)])\s+/u, '')
  const end = /[.!?:;](?=\s|$)|\n/.exec(plain)
  return (end ? plain.slice(0, end.index + end[0].length) : plain).slice(0, 200).trim()
}

/** True when an agent message's opening sentence claims completion, correctness or verification. */
export function isCompletionClaim(text: string): boolean {
  const opening = openingSentence(text)
  return CLAIM_WORD.test(opening) && !CLAIM_DENIED.test(opening) && !opening.endsWith('?')
}

/** A tool result saying the person refused the call (Claude Code's refusal text, Codex's rejection). */
const REJECTED_TOOL_TEXT =
  /The user doesn't want to proceed with this tool use|tool use was rejected|rejected by (?:the )?user|user (?:rejected|declined|denied) (?:this|the)/iu

/** Spans that mean the agent acted: a person cannot have typed twice across one. */
function isAgentActivity(span: OtlpSpan): boolean {
  if (span.name === 'user.prompt') return false
  const kind = span.attributes[OPENINFERENCE_SPAN_KIND]
  return kind === 'TOOL' || kind === 'LLM' || span.name === 'message.assistant' || span.name.startsWith('message.agent.')
}

export function rawContent(span: OtlpSpan): string {
  return typeof span.attributes.content === 'string' ? span.attributes.content : ''
}

function turnText(span: OtlpSpan): string {
  return capText(rawContent(span), FACT_TEXT_CAP)
}

function normalizedTurnText(span: OtlpSpan): string {
  return turnText(span).replace(/\s+/g, ' ').trim()
}

/** The `… [+N chars]` marker an adapter appends when it cut a message at capture. */
const CAPTURE_CUT_MARKER = /… \[\+(\d+) chars\]$/

/**
 * Clip an agent message to {@link ANSWERED_TEXT_CAP}. The marker counts every
 * character the reader does not see, including any the adapter already cut
 * when it captured the message.
 */
function clipAnswered(raw: string): string {
  const text = raw.trim()
  const marker = CAPTURE_CUT_MARKER.exec(text)
  const body = marker ? text.slice(0, marker.index) : text
  if (body.length <= ANSWERED_TEXT_CAP) return text
  // A cut between the halves of a surrogate pair leaves a lone high surrogate; drop it and count it hidden.
  const lastKept = body.charCodeAt(ANSWERED_TEXT_CAP - 1)
  const keep = lastKept >= 0xd800 && lastKept <= 0xdbff ? ANSWERED_TEXT_CAP - 1 : ANSWERED_TEXT_CAP
  const hidden = body.length - keep + (marker ? Number(marker[1]) : 0)
  return `${body.slice(0, keep)}… [+${hidden} chars]`
}

/** A message this session's own agent wrote, with text a person could have read. */
export function isOwnAgentMessage(span: OtlpSpan): boolean {
  return (
    span.name === 'message.assistant' &&
    span.attributes[INHERITED_SPAN_ATTR] !== true &&
    rawContent(span).trim().length > 0
  )
}

/** A tool call of this session's agent that the person refused. */
function isRejectedTool(span: OtlpSpan): boolean {
  if (span.attributes[OPENINFERENCE_SPAN_KIND] !== 'TOOL' || span.status.code !== 'ERROR' || span.attributes[INHERITED_SPAN_ATTR] === true) return false
  const output = span.attributes['output.value']
  return REJECTED_TOOL_TEXT.test(`${span.status.message ?? ''}\n${typeof output === 'string' ? output.slice(0, 2000) : ''}`)
}

/** One excluded `user.prompt` span, with the time the window test reads. */
export interface ExcludedTurn {
  readonly spanId: string
  readonly at: string
}

type MutableTurn = { -readonly [K in keyof SessionTurnFact]: SessionTurnFact[K] }

/** The typed turns of one session, and every `user.prompt` span left out of them. */
export interface TypedTurns {
  /** Turns a person typed, or another agent or a pasted relay sent: `human`, `fleet` and `relay`. */
  readonly turns: readonly SessionTurnFact[]
  /** Excluded spans by `reason\0author`. */
  readonly excluded: ReadonlyMap<string, readonly ExcludedTurn[]>
  /** What the next span of the same session needs to be classified as if read in one piece. */
  readonly state: TurnFoldState
}

/**
 * What deciding a turn's author needs from the spans before it, so a session
 * read in pieces (the turn index reads only appended bytes) classifies each
 * turn exactly as one read of the whole session does.
 */
export interface TurnFoldState {
  /** A typed turn came before: the next one is not the session's first. */
  readonly typed: boolean
  /** The last human turn kept, for the second-record test: its start and normalized text. */
  readonly kept: { readonly at: string; readonly text: string } | null
  /** The agent acted after {@link TurnFoldState.kept}. */
  readonly activity: boolean
}

export const TURN_FOLD_START: TurnFoldState = { typed: false, kept: null, activity: false }

/**
 * The typed turns of one session, and every `user.prompt` span left out of them.
 *
 * Filters, in order: a turn of a subagent folded into this trace, a turn the
 * session inherited rather than received, a turn whose actor is not a person,
 * harness text the reader still called human, a harness command, and a second
 * record of the turn before it. A `fleet` or `relay` turn is a typed turn but
 * not a human one: it is listed with its author and excluded from the count.
 * `spans` is the whole trace in order, because the duplicate test, the reply
 * and the signals ask what happened between two turns. A session read in
 * pieces passes the `state` the previous piece returned.
 */
export function typedTurnsOf(spans: readonly OtlpSpan[], start: TurnFoldState = TURN_FOLD_START): TypedTurns {
  const excluded = new Map<string, ExcludedTurn[]>()
  const drop = (reason: string, author: string, span: OtlpSpan): void => {
    const key = `${reason}\0${author}`
    excluded.set(key, [...(excluded.get(key) ?? []), { spanId: span.span_id, at: span.start_time }])
  }
  const turns: MutableTurn[] = []
  // The last human turn kept, and whether the agent acted since: a person cannot have typed twice across that.
  let kept = start.kept
  let activity = start.activity
  // The last message this session's agent wrote so far: what a turn answers.
  // Tracked over every span, so a turn just inside a time window still names
  // the message it answered when that message fell just outside it.
  let lastAgentMessage: OtlpSpan | null = null
  let lastTurn: MutableTurn | null = null
  // Turns the agent has not written a message after yet: its next one is their reply.
  let awaitingReply: MutableTurn[] = []
  // Signals since the person's previous human turn, and whether the agent wrote since it.
  let pending = new Set<TurnSignal>()
  let agentWroteSinceHuman = false
  for (const span of spans) {
    // A subagent's records are not this session's: its prompts are not turns
    // here, and its activity does not separate two turns of this session.
    if (isSubagentSpan(span.attributes)) {
      if (span.name === 'user.prompt') drop(SUBAGENT_TURN_REASON, stringAttr(span, ACTOR_ATTR) ?? 'unclassified', span)
      continue
    }
    if (span.name !== 'user.prompt') {
      if (isOwnAgentMessage(span)) {
        lastAgentMessage = span
        agentWroteSinceHuman = true
        for (const turn of awaitingReply) {
          turn.reply = clipAnswered(rawContent(span))
          turn.replySpanId = span.span_id
        }
        awaitingReply = []
      }
      if (isRejectedTool(span)) pending.add('rejected-tool')
      if (isAgentActivity(span)) activity = true
      continue
    }
    const actor = stringAttr(span, ACTOR_ATTR) ?? 'unclassified'
    if (span.attributes[INHERITED_SPAN_ATTR] === true) {
      const source = stringAttr(span, INHERITED_SOURCE_ATTR)
      drop(source === null ? INHERITED_TURN_REASON : `${INHERITED_TURN_REASON} (${source})`, actor, span)
      continue
    }
    const text = rawContent(span)
    if (INTERRUPT_TEXT.test(text.trim())) {
      pending.add('interrupt')
      if (lastTurn) lastTurn.interrupted = true
    }
    if (actor !== 'human') {
      drop(TURN_EXCLUSION_REASONS[actor] ?? `the adapter classified this turn as "${actor}", not as a person typing`, actor, span)
      continue
    }
    const author = authorOfTypedTurn(text, { firstTurn: !start.typed && turns.length === 0 })
    if (author === 'injected') {
      drop(TURN_EXCLUSION_REASONS.injected!, 'injected', span)
      continue
    }
    if (author === 'human' && isHarnessCommand(text)) {
      drop(HARNESS_COMMAND_REASON, 'human', span)
      continue
    }
    // Two records of ONE submission describe one instant, so they carry the
    // same start time; a person who sends the same short message twice is
    // seconds apart. Pairing records that are merely close is the adapter's
    // job, where the records themselves say which log each came from — a sheet
    // that guessed from the spans collapsed a measured "continue, continue"
    // typed 1.8 s apart into one turn.
    const normalized = normalizedTurnText(span)
    const duplicate =
      author === 'human' &&
      kept !== null &&
      kept.at === span.start_time &&
      kept.text === normalized &&
      normalized.length > 0 &&
      !activity
    if (duplicate) {
      drop(DUPLICATE_TURN_REASON, 'human', span)
      continue
    }
    const answered = lastAgentMessage ? rawContent(lastAgentMessage) : null
    if (agentWroteSinceHuman && answered !== null && isCompletionClaim(answered)) pending.add('after-claim')
    const turn: MutableTurn = {
      actor: 'human',
      author,
      at: span.start_time,
      text: turnText(span),
      spanId: span.span_id,
      answered: answered === null ? null : clipAnswered(answered),
      answeredSpanId: lastAgentMessage?.span_id ?? null,
      reply: null,
      replySpanId: null,
      interrupted: false,
      // A fleet message is another agent talking: a signal is a person's.
      signals: author === 'fleet' ? [] : SIGNAL_ORDER.filter((signal) => pending.has(signal)),
    }
    turns.push(turn)
    lastTurn = turn
    awaitingReply.push(turn)
    if (author === 'human') {
      kept = { at: span.start_time, text: normalized }
      activity = false
      pending = new Set()
      agentWroteSinceHuman = false
    } else {
      drop(TURN_EXCLUSION_REASONS[author]!, author, span)
    }
  }
  return { turns, excluded, state: { typed: start.typed || turns.length > 0, kept, activity } }
}

const SIGNAL_ORDER: readonly TurnSignal[] = ['interrupt', 'rejected-tool', 'after-claim']

