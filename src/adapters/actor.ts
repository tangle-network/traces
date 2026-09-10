/**
 * Actor + reaction classification — ported from the proven trace-audit
 * `extract.py` classifier so the CLI and the offline audit agree on what
 * counts as a real human turn and how a human reaction is labelled.
 *
 * Two jobs:
 *   1. {@link claudeActor} / {@link textIsSynthetic} — decide whether a "user"
 *      turn is a real human or an injected / agent-spawned prompt. Adapters use
 *      the harness's structural signals first (sidechain / userType) and fall
 *      back to these text heuristics.
 *   2. {@link classifyReaction} — label a human turn as
 *      correction / frustration / praise / jargon / structure complaint, using
 *      extract.py's regexes verbatim. The user-reaction analyst keys off this.
 */

import type { Actor } from './conversation.js'

/** Slash-command / injected-template wrappers Claude Code stamps around a turn. */
const CMD_MARKERS = [
  '<command-name>',
  '<local-command-caveat>',
  '<command-message>',
  '<command-args>',
  '<command-stdout>',
] as const

const INJECT_MARKERS = [
  '<system-reminder>',
  'Caveat: The messages below',
  '<user-memory-input>',
  // Harness-injected wrappers that arrive as `userType: external` user turns —
  // they pass the structural human test but are the harness feeding the model,
  // not a person. (Observed in Claude Code task/loop sessions.)
  '<task-notification>',
  '<task-prompt>',
  // Prefix match: Codex adds attributes such as source="goal" to this tag.
  '<codex_internal_context',
  '<subagent_notification>',
  '# AGENTS.md instructions',
  '<local-command-stdout>',
  'This session is being continued from a previous conversation',
  // Slash-command skill bodies are expanded into a user turn (no <command-name>
  // wrapper) — the skill prompt, not the human.
  'Base directory for this skill:',
] as const

/** Injected synthetic prompts from automated benchmark / agent harnesses —
 *  NOT a human typing. Ported verbatim from extract.py SYNTHETIC_MARKERS. */
const SYNTHETIC_MARKERS = [
  'You are in a development environment with full file system access',
  '## What the user asked for',
  'Build the project described below',
  'Filesystem sandboxing defines',
  '<permissions instructions>',
  'You are an autonomous',
  'You are a coding agent',
  'Your task is to build',
  '## Deliverable',
  '## Acceptance criteria',
  'Return ONLY',
  'respond with JSON',
  '<environment_details>',
  '<task>',
  'Review this change before it is pushed',
  'Complete a security review',
  'Focus on correctness, regressions, security issues',
  'Read-only critical audit',
  'Staff-engineer code review',
] as const

/** A session's first human turn matching this is an agent/subagent spawn
 *  prompt, not a person. Ported verbatim from extract.py AGENT_PROMPT. */
const AGENT_PROMPT =
  /^(you are\b|you're\b|read[- ]only\b|stop now\b|your task\b|your job\b|review the\b|audit\b|analyze the\b|return (only|a |the )|here is the\b|context:|task:|do not (revert|edit|touch)|work only in\b|you have been\b|act as\b|operate the\b|goal:|objective:)/i

export function textIsCmdOrInject(s: string): boolean {
  return CMD_MARKERS.some((m) => s.includes(m)) || INJECT_MARKERS.some((m) => s.includes(m))
}

/** Synthetic harness prompt? (Checks only the head, as extract.py does.) */
export function textIsSynthetic(s: string): boolean {
  const head = s.slice(0, 600)
  return SYNTHETIC_MARKERS.some((m) => head.includes(m))
}

/** First-turn heuristic: does this read like an agent/subagent spawn prompt
 *  (long, or starts with an imperative "you are…/your task…") rather than a
 *  person? Ported from extract.py looks_like_agent_prompt. */
export function looksLikeAgentPrompt(s: string): boolean {
  const t = s.trim()
  if (t.length > 1500) return true
  return AGENT_PROMPT.test(t)
}

const NON_TASK_PROMPT_MARKERS = [
  '<task-notification>',
  '<subagent_notification>',
  '<command-stdout>',
  '<local-command-stdout>',
  '<user-memory-input>',
  'This session is being continued from a previous conversation',
  '[Your previous response had no visible output.',
] as const

const NON_TASK_COMMAND =
  /<command-name>\/(?:clear|copy|effort|exit|login|mcp|model|plugin)<\/command-name>/

/**
 * Decide whether a top-level Claude user event starts a selectable task.
 * Actor identity is intentionally separate: SDK and benchmark tasks are
 * injected prompts, but they still begin a real run.
 */
export function claudePromptStartsTask(args: {
  text: string
  isSidechain?: boolean
  userType?: string | null
}): boolean {
  const text = args.text.trim()
  if (!text || args.isSidechain === true) return false
  if (args.userType != null && args.userType !== 'external') return false
  if (NON_TASK_PROMPT_MARKERS.some((marker) => text.includes(marker))) return false
  if (text.startsWith('[Request interrupted by user')) return false
  if (NON_TASK_COMMAND.test(text)) return false
  if (text.startsWith('Base directory for this skill:')) return false
  if (text.startsWith('# AGENTS.md instructions') && !text.includes('</INSTRUCTIONS>')) {
    return false
  }
  return true
}

/**
 * Derive the actor for a Claude Code user turn from the structural signals the
 * adapter already parses, falling back to the text heuristics above.
 *
 *   isSidechain === true             → subagent-spawn
 *   isMeta === true                  → injected
 *   userType present and !== external → injected
 *   synthetic markers in the text     → injected
 *   first-turn agent-spawn prompt     → subagent-spawn
 *   otherwise                         → human
 */
export function claudeActor(args: {
  text: string
  isSidechain?: boolean
  isMeta?: boolean
  userType?: string | null
  isFirstUserTurn?: boolean
}): Actor {
  if (args.isSidechain === true) return 'subagent-spawn'
  if (args.isMeta === true) return 'injected'
  if (args.userType != null && args.userType !== 'external') return 'injected'
  // Harness-injected wrappers (task notifications, continuation summaries, slash
  // commands) arrive AS `external` user turns, so check the text before trusting
  // the structural "external → human" signal.
  if (textIsCmdOrInject(args.text)) return 'injected'
  if (textIsSynthetic(args.text)) return 'injected'
  // A first human turn that reads like an agent-spawn brief is a spawned run,
  // not a person — matches extract.py's first-turn detection.
  if (args.isFirstUserTurn && looksLikeAgentPrompt(args.text)) return 'subagent-spawn'
  return 'human'
}

/**
 * Context blocks Codex writes as user-role messages and never reports as a user
 * turn. The list mirrors `CONTEXTUAL_USER_FRAGMENT_MATCHERS` (openai/codex
 * `codex-rs/core/src/context/contextual_user_message.rs`); the default matcher
 * accepts a trimmed block that starts with the open marker and ends with the
 * close marker, ignoring ASCII case (openai/codex
 * `codex-rs/context-fragments/src/fragment.rs`).
 */
const CODEX_CONTEXT_BLOCKS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['# AGENTS.md instructions', '</INSTRUCTIONS>'],
  ['<user_instructions>', '</user_instructions>'],
  ['<environment_context>', '</environment_context>'],
  ['<skills_instructions>', '</skills_instructions>'],
  ['<user_shell_command>', '</user_shell_command>'],
  ['<turn_aborted>', '</turn_aborted>'],
  ['<subagent_notification>', '</subagent_notification>'],
  ['<codex_internal_context', '</codex_internal_context>'],
  ['<goal_context>', '</goal_context>'],
  ['<recommended_plugins>', '</recommended_plugins>'],
]

/** Harness warnings Codex also injects as user-role text, matched by prefix. */
const CODEX_CONTEXT_PREFIXES = [
  'Warning: apply_patch was requested via ',
  'Warning: Your account was flagged for potentially high-risk cyber activity',
  'Warning: The maximum number of unified exec processes you can keep open is',
] as const

const CODEX_EXTERNAL_CONTEXT = /^<external_([^>]+)>[\s\S]*<\/external_\1>$/

function startsWithIgnoringCase(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
}

function endsWithIgnoringCase(text: string, suffix: string): boolean {
  return text.slice(-suffix.length).toLowerCase() === suffix.toLowerCase()
}

/** Whether one text block of a Codex user-role message is harness context. */
export function isCodexContextBlock(block: string): boolean {
  const text = block.trim()
  if (CODEX_CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) return true
  if (CODEX_EXTERNAL_CONTEXT.test(text)) return true
  return CODEX_CONTEXT_BLOCKS.some(
    ([open, close]) => startsWithIgnoringCase(text, open) && endsWithIgnoringCase(text, close),
  )
}

/**
 * Codex's own label for each content item of a user-role message, from
 * `internal_chat_message_metadata_passthrough.content_item_kinds`.
 *
 * Codex tags every item it puts in a user message with what the item is:
 * `user.text` for what the person typed, and a namespaced kind for everything
 * the harness added — `agents_md.instructions` for an AGENTS.md file,
 * `environments.environment_context` for the environment block,
 * `goal.internal_context`, `plugins.recommendations`, and so on. A message is
 * one a person typed exactly when every item in it is a `user.` kind.
 *
 * This is the structural signal, so it decides on its own: it is what the
 * harness recorded, not what the text looks like. Returns undefined when the
 * record carries no kinds — older rollouts and event mirrors — and the text
 * heuristics answer instead.
 */
export function codexKindsAreHuman(kinds: readonly unknown[] | undefined): boolean | undefined {
  if (!Array.isArray(kinds) || kinds.length === 0) return undefined
  if (!kinds.every((kind) => typeof kind === 'string')) return undefined
  return kinds.every((kind) => (kind as string).startsWith('user.'))
}

/**
 * Derive the actor for a Codex user message.
 *
 * `kinds` is Codex's own per-item labelling and decides whenever the record
 * carries it. Without it the decision is text-only: a Codex context block →
 * injected, synthetic markers → injected, first-turn agent-spawn brief →
 * injected, otherwise human. `blocks` are the message's separate text blocks;
 * Codex treats the whole message as context when any one block is.
 */
export function codexActor(args: {
  text: string
  blocks?: readonly string[]
  isFirstUserTurn?: boolean
  kinds?: readonly unknown[]
}): Actor {
  const recorded = codexKindsAreHuman(args.kinds)
  if (recorded !== undefined) return recorded ? 'human' : 'injected'
  if ((args.blocks ?? [args.text]).some(isCodexContextBlock)) return 'injected'
  if (textIsCmdOrInject(args.text)) return 'injected'
  if (textIsSynthetic(args.text)) return 'injected'
  if (args.isFirstUserTurn && looksLikeAgentPrompt(args.text)) return 'injected'
  return 'human'
}

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
