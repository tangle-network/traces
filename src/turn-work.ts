/**
 * What a session's agent did between a person's turns: one {@link TurnWork}
 * per typed turn, counted over the agent's own records since the person's
 * previous turn.
 *
 * The turn a person types next is an outcome decided outside the agent, so the
 * work before it is what a measure of that turn can read. Every value here is a
 * count, a duration or a flag. The flags read the agent's last message inside
 * this module, and only the flag leaves it: a row built from {@link TurnWork}
 * carries no text.
 *
 * The boundaries are the typed turns `session-turns.ts` classifies, and a fleet
 * or relay turn does not end the person's turn, as with the turn signals. The
 * counts reuse the sheet's own classifiers: tool calls and their kinds from
 * `pipelines.ts`, commands, changed files and subagents from `session-facts.ts`,
 * tokens from `execution.ts`.
 */
import { OPENINFERENCE_SPAN_KIND } from '@tangle-network/agent-eval/trace-attributes'
import { INHERITED_SOURCE_ATTR } from './adapters/provenance.js'
import { isRecordSpan } from './attributes.js'
import { modelCallContextTokens, sessionTokens } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { classifyLiveActions, isOwnAct } from './pipelines.js'
import { changedFilesOf, commandsOf, subagentsOf } from './session-facts.js'
import { isAgentActivity, isCompletionClaim, isOwnAgentMessage, isRejectedTool, rawContent, type SessionTurnFact } from './session-turns.js'

/** The shape of the agent's last message before a turn: what the person read when they typed it. */
export interface ReplyShape {
  /** Words in the captured text. An adapter keeps at most 8,000 characters of a message. */
  readonly words: number
  /** Characters, including those the adapter cut at capture. */
  readonly chars: number
  /** Lines that hold text. */
  readonly lines: number
  /** Its last line ends with a question mark. */
  readonly endsWithQuestion: boolean
  /** It offers more work or asks leave to act: "should I", "want me to", "let me know", "if you'd like". */
  readonly asksPermission: boolean
  /** Its opening sentence claims the work is done, fixed or verified (the `after-claim` rule). */
  readonly claimsDone: boolean
  /** Numbers written in it, not counting digits inside a word or identifier. */
  readonly numbers: number
  /** `http(s)://` links. */
  readonly links: number
  /** Fenced code blocks. */
  readonly codeBlocks: number
  /** Bulleted or numbered list lines. */
  readonly bullets: number
  /** Markdown heading lines. */
  readonly headings: number
  /** Sentences, and sentences that end in a question mark. */
  readonly sentences: number
  readonly questions: number
  /** Words in its first line, and in its last paragraph. */
  readonly firstLineWords: number
  readonly lastParagraphWords: number
  /** Its last paragraph offers more work or asks leave (the `asksPermission` phrases). */
  readonly endsWithOffer: boolean
  /** `**bold**` spans, markdown table rows, and inline code spans outside fenced blocks. */
  readonly boldSpans: number
  readonly tableRows: number
  readonly inlineCode: number
  /** Words that name a path (`src/a.ts`, `~/x/y`), and issue or pull request references (`#123`, `/pull/123`). */
  readonly paths: number
  readonly issueRefs: number
  /** Status marks: ✅ ❌ ✓ ✗ ⚠ and the words PASS, FAIL, GREEN, RED. */
  readonly statusMarks: number
  /** Phrases of each kind, counted: see {@link PHRASES}. */
  readonly hedges: number
  readonly apologies: number
  readonly intentions: number
  readonly blockers: number
  readonly recommendations: number
  readonly options: number
  readonly waiting: number
  readonly verifications: number
}

/** The agent's work since the person's previous turn, or since the session's first record for its first turn. */
export interface TurnWork {
  /** Turns the person typed into this session before this one. */
  readonly index: number
  /** From the session's first record to this turn. */
  readonly sessionMs: number | null
  /** From the person's previous turn (the session's first record, for the first turn) to this one. */
  readonly durationMs: number | null
  /** From the start of the interval to the end of the agent's last act in it; 0 when it did nothing. */
  readonly workingMs: number | null
  /** From the end of the agent's last act (the start of the interval, when it did nothing) to this turn. */
  readonly waitingMs: number | null
  /** Model calls, and the tokens they report: `input` is the whole prompt, cache included. Null when calls report no usage. */
  readonly modelCalls: number
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  /** The whole prompt of the interval's last model call: how full the context was when the agent stopped. */
  readonly contextTokens: number | null
  /** Messages the agent wrote with text, and their words. */
  readonly agentMessages: number
  readonly agentWords: number
  readonly toolCalls: number
  readonly toolCallsByName: Readonly<Record<string, number>>
  /** Tool calls that ended in error. */
  readonly failedToolCalls: number
  /** Tool calls the person refused. */
  readonly rejectedToolCalls: number
  /** The longest run of consecutive tool calls that ended in error. */
  readonly longestFailingRun: number
  /** Tool calls that read, edited the work (scratch files aside), or ran a check (a test, build, typecheck, lint or gate). */
  readonly reads: number
  readonly edits: number
  readonly checks: number
  readonly failedChecks: number
  /** Distinct files the agent changed. */
  readonly filesChanged: number
  /** Simple commands the agent ran, and those known to have failed; null when no call kept its arguments. */
  readonly commands: number | null
  readonly failedCommands: number | null
  readonly subagents: number
  readonly compactions: number
  readonly noToolCall: boolean
  /** The agent's last message in the interval; null when it wrote none. */
  readonly reply: ReplyShape | null
  /** That message claims completion, and no check ran in the interval. */
  readonly claimWithoutCheck: boolean
  /** Tool calls after the agent's last message (all of them when it wrote none), and messages after its last tool call. */
  readonly toolCallsAfterReply: number
  readonly messagesAfterLastTool: number
  /** The interval's last tool call ended in error; its last check ended in error. */
  readonly lastToolFailed: boolean
  readonly lastCheckFailed: boolean
  /** Edits after the interval's last check (all of them when no check ran). */
  readonly editsAfterLastCheck: number
  /** Reads before the interval's first edit; null when it made none. */
  readonly readsBeforeFirstEdit: number | null
  /** Tool calls that repeat an earlier call of the interval exactly: the same tool with the same recorded arguments. */
  readonly repeatedToolCalls: number
  /** The longest gap between two consecutive acts of the agent in the interval. */
  readonly longestPauseMs: number
  /** The whole prompt of the interval's last model call minus its first's; null without a model call that reports one. */
  readonly contextGrowth: number | null
  /** How much `reply` repeats the last reply before the person's previous turn: Jaccard over words of 3+ letters; null without both. */
  readonly replyOverlap: number | null
}

const PERMISSION =
  new RegExp(String.raw`\b(?:${[
    'should I', 'shall I', 'do you want(?: me)? to', 'want me to', 'would you like(?: me)? to', 'let me know',
    "if you(?:['’]d| would)? (?:like|want|prefer)", 'happy to', '(?:ok(?:ay)?|fine) (?:to|if I) (?:proceed|go ahead|continue)',
    'may I', 'can I (?:proceed|go ahead|continue)', 'or should I', 'say the word', 'your call',
  ].join('|')})\b`, 'iu')
const NUMBER = /(?<![\p{L}\p{N}_.#/-])\d+(?:[.,]\d+)*(?![\p{L}\p{N}_])/gu
const LINK = /https?:\/\/\S+/gu
const FENCE = /^\s*(?:```|~~~)/u
const BULLET = /^\s*(?:[-*•+]|\d+[.)])\s+\S/u
const HEADING = /^\s*#{1,6}\s+\S/u
const CAPTURE_CUT = /… \[\+(\d+) chars\]$/u
const SENTENCE_END = /[.!?](?=\s|$)/gu
const QUESTION_END = /\?(?=[\s)*_]|$)/gu
const BOLD = /\*\*[^*\n]+\*\*/gu
const TABLE_ROW = /^\s*\|.*\|\s*$/u
const INLINE_CODE = /`[^`\n]+`/gu
const PATH = /^[`'"(]*(?:~|\.{1,2})?\/?[\w.@-]+\/[\w.@/-]+[`'",.:;)]*$/u
const LETTER = /\p{L}/u
const ISSUE_REF = /(?<![\w&])#\d+\b|\/pull\/\d+/gu
const STATUS_MARK = /[✅❌✓✗⚠]|\b(?:PASS|FAIL|GREEN|RED)\b/gu

/** Phrase families counted in a reply. Each is a plain-language marker of what the message does. */
const PHRASES = {
  hedges: /\b(?:might|maybe|perhaps|probably|likely|possibly|seems?|appears? to|I think|I believe|not sure|unclear)\b/giu,
  apologies: /\b(?:sorry|apologi[sz]e|my mistake|my bad|you['’]re right|I was wrong)\b/giu,
  intentions: /\b(?:I['’]ll|I will|I['’]m going to|let me|next,? I|now I)\b/giu,
  blockers: /\b(?:blocked|cannot|can['’]t|unable|could not|couldn['’]t|failed|failing|not possible|denied|refused)\b/giu,
  recommendations: /\b(?:recommend|suggest|propose|I['’]d)\b/giu,
  options: /\b(?:option [a-d1-4]|alternatives?|either\b[^.?!\n]{1,80}\bor)\b/giu,
  waiting: /\b(?:waiting|in the background|still running|running now|will (?:report|notify|update)|once it (?:finishes|completes|lands)|pending)\b/giu,
  verifications: /\b(?:tests? pass(?:ed|es)?|verified|confirmed|green|exit 0|reproduced)\b/giu,
} as const

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function words(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length
}

/** The shape of one agent message, read from its text; the text itself does not leave. */
export function replyShape(raw: string): ReplyShape {
  const trimmed = raw.trim()
  const cut = CAPTURE_CUT.exec(trimmed)
  const text = cut ? trimmed.slice(0, cut.index) : trimmed
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const last = (lines.at(-1) ?? '').replace(/[*_`>]/gu, '').trim()
  const lastParagraph = text.split(/\n\s*\n/u).filter((part) => part.trim().length > 0).at(-1) ?? ''
  // Prose: the text without its fenced blocks, where a path or inline code is something the reader is told.
  const prose = text.replace(/^\s*(?:```|~~~)[\s\S]*?^\s*(?:```|~~~)\s*$/gmu, '')
  return {
    words: words(text),
    chars: text.length + (cut ? Number(cut[1]) : 0),
    lines: lines.length,
    endsWithQuestion: /\?\)?$/u.test(last),
    asksPermission: PERMISSION.test(text),
    claimsDone: isCompletionClaim(text),
    numbers: text.match(NUMBER)?.length ?? 0,
    links: text.match(LINK)?.length ?? 0,
    codeBlocks: Math.floor(lines.filter((line) => FENCE.test(line)).length / 2),
    bullets: lines.filter((line) => BULLET.test(line)).length,
    headings: lines.filter((line) => HEADING.test(line)).length,
    sentences: count(text, SENTENCE_END) + (/[.!?]\s*$/u.test(text) || text.length === 0 ? 0 : 1),
    questions: count(text, QUESTION_END),
    firstLineWords: words(lines[0] ?? ''),
    lastParagraphWords: words(lastParagraph),
    endsWithOffer: PERMISSION.test(lastParagraph),
    boldSpans: count(text, BOLD),
    tableRows: lines.filter((line) => TABLE_ROW.test(line)).length,
    inlineCode: count(prose, INLINE_CODE),
    paths: prose.split(/\s+/u).filter((word) => PATH.test(word) && LETTER.test(word) && !word.includes('://')).length,
    issueRefs: count(text, ISSUE_REF),
    statusMarks: count(text, STATUS_MARK),
    hedges: count(text, PHRASES.hedges),
    apologies: count(text, PHRASES.apologies),
    intentions: count(text, PHRASES.intentions),
    blockers: count(text, PHRASES.blockers),
    recommendations: count(text, PHRASES.recommendations),
    options: count(text, PHRASES.options),
    waiting: count(text, PHRASES.waiting),
    verifications: count(text, PHRASES.verifications),
  }
}

/** Lowercase words of three or more letters: what {@link TurnWork.replyOverlap} compares. */
function wordSet(raw: string): Set<string> {
  return new Set(raw.replace(CAPTURE_CUT, '').toLowerCase().match(/\p{L}{3,}/gu) ?? [])
}

function jaccard(left: Set<string>, right: Set<string>): number | null {
  if (left.size === 0 || right.size === 0) return null
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

function time(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function minus(later: number | null, earlier: number | null): number | null {
  return later === null || earlier === null ? null : Math.max(0, later - earlier)
}

interface Interval {
  readonly at: number | null
  readonly from: number | null
  readonly sessionStart: number | null
  readonly index: number
  /** The words of the last reply before the person's previous turn. */
  readonly previousReply: Set<string> | null
}

/** The position of each span in the interval's trace order, so "after" means what the trace says. */
function positions(spans: readonly OtlpSpan[]): (span: OtlpSpan | undefined) => number {
  const at = new Map(spans.map((span, index) => [span, index]))
  return (span) => (span === undefined ? -1 : at.get(span) ?? -1)
}

/** The longest gap between consecutive acts, each act from its start to its end. */
function longestPause(acts: readonly OtlpSpan[]): number {
  const spans = acts.map((span) => [time(span.start_time), time(span.end_time) ?? time(span.start_time)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null)
    .sort((left, right) => left[0] - right[0])
  let longest = 0
  let reached = spans[0]?.[1] ?? 0
  for (const [start, end] of spans) {
    longest = Math.max(longest, start - reached)
    reached = Math.max(reached, end)
  }
  return longest
}

/** The work in one interval, and the words of its reply: `spans` are the session's records between its two turns, in trace order. */
function measure(spans: readonly OtlpSpan[], interval: Interval): { work: TurnWork; replyWords: Set<string> | null } {
  const own = spans.filter(isOwnAct)
  const actions = classifyLiveActions(own)
  const tools = actions.filter((action) => action.toolName !== undefined)
  const toolSpans = tools.map((action) => action.span)
  const byName: Record<string, number> = {}
  let run = 0
  let longestFailingRun = 0
  for (const tool of tools) {
    byName[tool.toolName!] = (byName[tool.toolName!] ?? 0) + 1
    run = tool.errored ? run + 1 : 0
    longestFailingRun = Math.max(longestFailingRun, run)
  }
  const checks = tools.filter((tool) => tool.kind === 'verify')
  const models = own.filter((span) => span.attributes[OPENINFERENCE_SPAN_KIND] === 'LLM')
  const tokens = models.length === 0 ? null : sessionTokens(models, false)
  const lastModel = models.at(-1)
  const messages = own.filter(isOwnAgentMessage)
  const lastMessage = messages.at(-1)
  const reply = lastMessage === undefined ? null : replyShape(rawContent(lastMessage))
  const commands = commandsOf(toolSpans).value
  const lastAct = own.filter(isAgentActivity).reduce<number | null>((latest, span) => {
    const end = time(span.end_time) ?? time(span.start_time)
    return end === null ? latest : latest === null ? end : Math.max(latest, end)
  }, null)
  // A span that ends after the turn (a call still running when the person typed) stops the clock at the turn.
  const stopped = lastAct === null ? interval.from : Math.min(lastAct, interval.at ?? lastAct)
  const at = positions(own)
  const last = <T extends { span: OtlpSpan }>(list: readonly T[]): T | undefined =>
    list.reduce<T | undefined>((latest, item) => (latest === undefined || at(item.span) > at(latest.span) ? item : latest), undefined)
  const lastTool = last(tools)
  const lastCheck = last(checks)
  const edits = tools.filter((tool) => tool.kind === 'edit')
  const firstEdit = edits.reduce<number | null>((first, tool) => (first === null ? at(tool.span) : Math.min(first, at(tool.span))), null)
  const seen = new Set<string>()
  let repeated = 0
  for (const tool of tools) {
    // A call that kept no arguments cannot be told apart from another: it is never counted as a repeat.
    const input = tool.span.attributes['input.value']
    if (typeof input !== 'string') continue
    const call = `${tool.toolName}\u0000${input}`
    if (seen.has(call)) repeated += 1
    seen.add(call)
  }
  const contexts = models.map(modelCallContextTokens).filter((value): value is number => value !== null)
  const replyWords = lastMessage === undefined ? null : wordSet(rawContent(lastMessage))
  const work: TurnWork = {
    index: interval.index,
    sessionMs: minus(interval.at, interval.sessionStart),
    durationMs: minus(interval.at, interval.from),
    workingMs: minus(stopped, interval.from),
    waitingMs: minus(interval.at, stopped === null ? null : Math.max(stopped, interval.from ?? stopped)),
    modelCalls: models.length,
    tokensIn: tokens === null ? 0 : tokens.input,
    tokensOut: tokens === null ? 0 : tokens.output,
    contextTokens: lastModel === undefined ? null : modelCallContextTokens(lastModel),
    agentMessages: messages.length,
    agentWords: messages.reduce((total, span) => total + words(rawContent(span).replace(CAPTURE_CUT, '')), 0),
    toolCalls: tools.length,
    toolCallsByName: byName,
    failedToolCalls: tools.filter((tool) => tool.errored).length,
    rejectedToolCalls: toolSpans.filter(isRejectedTool).length,
    longestFailingRun,
    reads: tools.filter((tool) => tool.kind === 'read').length,
    edits: edits.length,
    checks: checks.length,
    failedChecks: checks.filter((tool) => tool.errored).length,
    filesChanged: changedFilesOf(toolSpans, own).files.length,
    commands: commands === null ? null : commands.reduce((total, row) => total + row.runs, 0),
    failedCommands: commands === null ? null : commands.reduce((total, row) => total + row.failed, 0),
    subagents: subagentsOf(own, spans).length,
    compactions: spans.filter((span) => span.name === 'session.compacted' && span.attributes[INHERITED_SOURCE_ATTR] !== 'pre-task-prefix').length,
    noToolCall: tools.length === 0,
    reply,
    claimWithoutCheck: reply !== null && reply.claimsDone && checks.length === 0,
    toolCallsAfterReply: toolSpans.filter((span) => at(span) > at(lastMessage)).length,
    messagesAfterLastTool: messages.filter((span) => at(span) > at(lastTool?.span)).length,
    lastToolFailed: lastTool?.errored ?? false,
    lastCheckFailed: lastCheck?.errored ?? false,
    editsAfterLastCheck: edits.filter((tool) => at(tool.span) > at(lastCheck?.span)).length,
    readsBeforeFirstEdit: firstEdit === null ? null : tools.filter((tool) => tool.kind === 'read' && at(tool.span) < firstEdit).length,
    repeatedToolCalls: repeated,
    longestPauseMs: longestPause(own.filter(isAgentActivity)),
    contextGrowth: contexts.length === 0 ? null : contexts.at(-1)! - contexts[0]!,
    replyOverlap: replyWords === null || interval.previousReply === null ? null : jaccard(replyWords, interval.previousReply),
  }
  return { work, replyWords }
}

/**
 * The work before each of `turns`, by the turn's span id. `spans` is one
 * session in trace order and `turns` its typed turns, as `typedTurnsOf` read
 * them from those spans.
 */
export function turnWorkOf(spans: readonly OtlpSpan[], turns: readonly SessionTurnFact[]): ReadonlyMap<string, TurnWork> {
  const turnBySpan = new Map(turns.map((turn) => [turn.spanId, turn]))
  const records = spans.filter(isRecordSpan)
  const sessionStart = records.reduce<number | null>((first, span) => {
    const start = time(span.start_time)
    return start === null ? first : first === null ? start : Math.min(first, start)
  }, null)
  const work = new Map<string, TurnWork>()
  let interval: OtlpSpan[] = []
  let from = sessionStart
  let index = 0
  let previousReply: Set<string> | null = null
  for (const span of records) {
    const turn = turnBySpan.get(span.span_id)
    if (turn === undefined) {
      interval.push(span)
      continue
    }
    const at = time(turn.at)
    const measured = measure(interval, { at, from, sessionStart, index, previousReply })
    work.set(turn.spanId, measured.work)
    if (turn.author === 'human') {
      interval = []
      from = at
      index += 1
      previousReply = measured.replyWords ?? previousReply
    }
  }
  return work
}
