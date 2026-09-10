/**
 * Claude Code adapter — `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
 *
 * Each line is one transcript event: `user`, `assistant`, `attachment`,
 * plus metadata events we ignore. Assistant events carry `message.usage`
 * (token trajectory) and `message.content[]` tool_use blocks; tool results
 * arrive as `tool_result` blocks in the following user message or as a
 * `tool_result` attachment. Subagent runs live in a sibling
 * nested `<session>/subagents/.../agent-*.jsonl` files. Ordinary subagent
 * metadata carries the spawning `toolUseId`. Workflow subagents instead live
 * under `workflows/<runId>` and bind to the exact run ID and transcript
 * directory returned by the parent `Workflow` call.
 *
 * Shared by the claudish / openclaw / nanoclaw forks via aliases — they
 * write the same transcript shape.
 */

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import {
  applyLlmSpanOtlpAttributes,
  LLM_CACHED_TOKENS,
  LLM_CACHE_WRITE_TOKENS,
  LLM_INPUT_TOKENS,
  LLM_OUTPUT_TOKENS,
} from '@tangle-network/agent-eval/trace-attributes'
import { deriveHexId } from '@tangle-network/agent-trace-contract'
import { sessionJsonlOptions } from '../integrity.js'
import { appendAll } from '../arrays.js'
import { isMissingJsonSource, isMissingPathError, readJsonFile } from '../json.js'
import { readJsonl } from '../jsonl.js'
import type { OtlpSpan, OtlpStatusCode } from '../otlp.js'
import { span } from '../otlp.js'
import type { HarnessTraceAdapter, LocateOptions, ParseOptions, SessionRef } from '../types.js'
import { claudeActor, claudePromptStartsTask } from './actor.js'
import { collectClaudeSubagentSources } from './claude-subagent-sources.js'
import {
  bindWorkflowRuns,
  bindWorkflowSubagent,
  ClaudeTaskScopeError,
  createWorkflowProjectionIndex,
  indexWorkflowResults,
  indexWorkflowTools,
  resolveWorkflowRunReference,
  selectWorkflowBinding,
  structuredWorkflowRunReference,
  type WorkflowProjectionIndex,
  type WorkflowRunBinding,
  type WorkflowRunReference,
} from './claude-workflow.js'
import { ACTOR_ATTR, capText, userPromptSpan, type Actor } from './conversation.js'
import {
  SUBAGENT_SPAN_ATTR,
  SUBAGENT_SPAN_COUNT_ATTR,
  SUBAGENT_SPAWN_ATTR,
  SUBAGENT_SPAWN_TASK_ATTR,
  SUBAGENT_TASK_ATTR,
  SYNTHESIZED_SOURCE_ATTR,
  SYNTHESIZED_SPAN_ATTR,
  isSubagentSpan,
} from './provenance.js'
import { toolIoAttributes } from './tool-io.js'
import { appendSourceAttributes, sourceOf, textSources, SOURCE_ATTRIBUTE_PREFIX, type SourceReferences } from '../source-location.js'

const SERVICE = 'claude-code'
const EPOCH = new Date(0).toISOString()

/**
 * Claude Code's own label for who produced a record: `human` for a person at
 * the keyboard, and a namespaced kind for everything the harness or another
 * agent put in the conversation (`task-notification`, `peer`, …).
 *
 * This is the structural signal, so it decides on its own — it is what the
 * harness recorded, not what the text looks like. A transcript that stamps it
 * at all stamps it on every record a person produced, so inside such a
 * transcript a user record WITHOUT it is not a human turn however human its
 * text reads: `[Request interrupted by user]` is written by the CLI, and
 * `<command-name>/login</command-name>` is the CLI's record of a session
 * command rather than a message to the agent. {@link ORIGIN_EVIDENCE_ATTR}
 * marks each turn the second rule reclassified, so the reading is checkable.
 * Older transcripts carry no `origin` at all and the text heuristics in
 * `actor.ts` answer instead.
 */
const HUMAN_ORIGIN = 'human'

/** Why a turn that reads human was not counted as one. */
const ORIGIN_EVIDENCE_ATTR = 'traces.claude.actor_evidence'

/** `true` on a `user.prompt` span whose record carried a recorded origin. */
const ORIGIN_RECORDED_ATTR = 'traces.claude.origin_recorded'

/** Claude Code's own name for the kind of record an origin describes. */
const ORIGIN_KIND_ATTR = 'traces.claude.origin_kind'

/**
 * A slash command as the transcript stores it: the CLI wraps the line a person
 * typed in `<command-name>` and `<command-args>` (plus a `<command-message>`
 * display label it did not type). Rejoining the two recovers the typed line,
 * which is what a reader counting human turns is looking for.
 */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/**
 * The tool input field with which Claude Code's Task tool selects the agent to
 * run. A tool call carrying it spawned a subagent, whatever the tool is named:
 * the field is the harness's own signal, so no allowlist of tool names decides
 * what counts as a spawn.
 */
const SPAWN_TYPE_KEY = 'subagent_type'

/** The Task tool's short name for the work it hands the child. */
const SPAWN_DESCRIPTION_KEY = 'description'

const SPAWN_TYPE_ATTR = 'traces.claude.subagent_type'
const SUBAGENT_TRANSCRIPT_ATTR = 'traces.claude.subagent_transcript'
const SUBAGENT_AGENT_ID_ATTR = 'traces.claude.subagent_agent_id'

const CLAUDE_SOURCE_TRACE_ID = 'traces.claude.source_trace_id'
const CLAUDE_SOURCE_SPAN_ID = 'traces.claude.source_span_id'
const CLAUDE_SOURCE_PARENT_SPAN_ID = 'traces.claude.source_parent_span_id'

/** Convert Claude's readable transcript identities to fixed-width OTLP IDs. */
function normalizeClaudeIds(spans: OtlpSpan[]): void {
  for (const item of spans) {
    const sourceTraceId = item.trace_id
    const sourceSpanId = item.span_id
    const sourceParentSpanId = item.parent_span_id
    item.attributes[CLAUDE_SOURCE_TRACE_ID] = sourceTraceId
    item.attributes[CLAUDE_SOURCE_SPAN_ID] = sourceSpanId
    if (sourceParentSpanId !== null) {
      item.attributes[CLAUDE_SOURCE_PARENT_SPAN_ID] = sourceParentSpanId
    }
    item.trace_id = deriveHexId(sourceTraceId, 16)
    item.span_id = deriveHexId(`${sourceTraceId}:${sourceSpanId}`, 8)
    item.parent_span_id = sourceParentSpanId === null
      ? null
      : deriveHexId(`${sourceTraceId}:${sourceParentSpanId}`, 8)
  }
}

interface ClaudeEvent {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  isSidechain?: boolean
  isMeta?: boolean
  userType?: string
  origin?: { kind?: string }
  /** `file-history-delta`: the path the harness backed up before changing it. */
  trackingPath?: string
  message?: {
    id?: string
    role?: string
    model?: string
    content?: unknown
    stop_reason?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  attachment?: {
    type?: string
    toolUseID?: string
    toolName?: string
    exitCode?: number
    stderr?: string
    /** `queued_command`: the message a person sent while the turn was running. */
    prompt?: string
    origin?: { kind?: string }
    timestamp?: string
  }
  toolUseResult?: {
    runId?: unknown
    transcriptDir?: unknown
  }
}

interface BlockText {
  type?: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function asBlocks(content: unknown): BlockText[] {
  return Array.isArray(content) ? (content as BlockText[]) : []
}

/** Join a message's `text` blocks (the human's prompt or the assistant's prose)
 *  into one capped string. A string body (some events) is taken verbatim. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return capText(content)
  return capText(
    asBlocks(content)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n'),
  )
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as BlockText).text ?? '') : ''))
      .join('')
  }
  return ''
}

export interface ParsedStream {
  spans: OtlpSpan[]
  /** Maps a tool_use id → the TOOL span id, so results can backfill status. */
  toolSpanByUseId: Map<string, OtlpSpan>
  nextStep: number
}

interface ClaudeStreamContext {
  traceId: string
  agent: string
  startStep: number
  idPrefix: string
  rootParent: string | null
}

interface ClaudeStreamState {
  spans: OtlpSpan[]
  toolSpanByUseId: Map<string, OtlpSpan>
  llmSpanByMessageId: Map<string, OtlpSpan>
  llmContentByMessageId: Map<string, Set<string>>
  toolCountByMessageId: Map<string, number>
  messageSpanByMessageId: Map<string, OtlpSpan>
  step: number
  sawUserTurn: boolean
  /** `user.prompt` spans, so the origin rule can be applied once at the end. */
  promptSpans: OtlpSpan[]
  /** Whether any record in this stream carried Claude Code's `origin`. */
  sawRecordedOrigin: boolean
  /** Earliest and latest record timestamp consumed, span-producing or not. */
  firstRecordAt: string | null
  lastRecordAt: string | null
}

function createClaudeStream(startStep: number): ClaudeStreamState {
  return {
    spans: [],
    toolSpanByUseId: new Map(),
    llmSpanByMessageId: new Map(),
    llmContentByMessageId: new Map(),
    toolCountByMessageId: new Map(),
    messageSpanByMessageId: new Map(),
    step: startStep,
    sawUserTurn: false,
    promptSpans: [],
    sawRecordedOrigin: false,
    firstRecordAt: null,
    lastRecordAt: null,
  }
}

type SeenClaudeEvents = Map<string, string>

class ClaudeEventConflictError extends Error {
  readonly sourcePath: string
  readonly eventId: string

  constructor(sourcePath: string, eventId: string) {
    super(`${sourcePath}: Claude transcript event ${JSON.stringify(eventId)} has conflicting payloads`)
    this.name = 'ClaudeEventConflictError'
    this.sourcePath = sourcePath
    this.eventId = eventId
  }
}

interface ToolResultProjection {
  toolUseId: string
  isError: boolean
  attributes: Record<string, unknown>
  message: string
  workflowRun?: WorkflowRunReference
}

type ClaudeEventProjection =
  | {
      kind: 'assistant'
      timestamp: string
      messageId: string | null
      model: string | null
      inputTokens: number | null
      outputTokens: number | null
      cachedInputTokens: number | null
      cacheWriteInputTokens: number | null
      content: string | null
      contentSource?: SourceReferences
      tools: Array<{
        id: string | null
        name: string
        attributes: Record<string, unknown>
        /** The task a spawn call named. Absent when the call spawned nothing. */
        spawnTask?: string | null
      }>
    }
  | {
      kind: 'user'
      timestamp: string
      prompt: string | null
      contentSource?: SourceReferences
      isSidechain?: boolean
      isMeta?: boolean
      userType?: string | null
      originKind?: string | null
      results: ToolResultProjection[]
    }
  | { kind: 'attachment'; timestamp: string; result: ToolResultProjection }
  | {
      /**
       * A message a person sent while a turn was running. Claude Code does not
       * open a conversation turn for it — it surfaces the text inside the
       * running turn as an attachment — so it is a human turn the transcript
       * records nowhere else, and a reader counting turns misses it entirely.
       */
      kind: 'queued-prompt'
      timestamp: string
      prompt: string
      originKind: string | null
      contentSource?: SourceReferences
    }
  | { kind: 'file-change'; timestamp: string; path: string; contentSource?: SourceReferences }
  | { kind: 'ignored' }

function projectToolResult(
  toolUseId: string,
  isError: boolean,
  output: unknown,
  structuredWorkflowRun?: WorkflowRunReference,
  outputSource?: SourceReferences,
): ToolResultProjection {
  const outputText = stringifyToolResult(output)
  const workflowRun = resolveWorkflowRunReference(
    toolUseId,
    outputText,
    structuredWorkflowRun,
  )
  return {
    toolUseId,
    isError,
    attributes: toolIoAttributes({ output, outputSource }),
    message: outputText.slice(0, 500),
    ...(workflowRun ? { workflowRun } : {}),
  }
}

function projectClaudeEvent(event: ClaudeEvent): ClaudeEventProjection {
  const timestamp = event.timestamp ?? EPOCH
  if (event.type === 'assistant' && event.message) {
    const tools: Array<{
      id: string | null
      name: string
      attributes: Record<string, unknown>
      spawnTask?: string | null
    }> = []
    for (const block of asBlocks(event.message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue
      tools.push({
        id: block.id || null,
        name: block.name,
        attributes: toolIoAttributes({ input: block.input, inputSource: sourceOf(block, 'input') }),
        ...(spawnsSubagent(block.input) ? { spawnTask: spawnTaskName(block.input) } : {}),
      })
    }
    return {
      kind: 'assistant',
      timestamp,
      messageId: event.message.id ?? null,
      model: event.message.model ?? null,
      inputTokens: event.message.usage?.input_tokens ?? null,
      outputTokens: event.message.usage?.output_tokens ?? null,
      cachedInputTokens: event.message.usage?.cache_read_input_tokens ?? null,
      cacheWriteInputTokens: event.message.usage?.cache_creation_input_tokens ?? null,
      content: textOf(event.message.content) || null,
      contentSource: textSources(event.message, 'content'),
      tools,
    }
  }
  if (event.type === 'user' && event.message) {
    const results: ToolResultProjection[] = []
    const resultBlocks = asBlocks(event.message.content).filter(
      (block) => block.type === 'tool_result' && Boolean(block.tool_use_id),
    )
    const structuredWorkflowRun = structuredWorkflowRunReference(event.toolUseResult)
    if (structuredWorkflowRun && resultBlocks.length !== 1) {
      throw new ClaudeTaskScopeError(
        'Claude Workflow result metadata does not identify exactly one tool result',
      )
    }
    for (const block of resultBlocks) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      results.push(projectToolResult(
        block.tool_use_id,
        block.is_error === true,
        block.content,
        structuredWorkflowRun,
        sourceOf(block, 'content'),
      ))
    }
    const prompt = textOf(event.message.content)
    return {
      kind: 'user',
      timestamp,
      prompt: prompt || null,
      contentSource: textSources(event.message, 'content'),
      ...(prompt
        ? {
            isSidechain: event.isSidechain === true,
            isMeta: event.isMeta === true,
            userType: event.userType ?? null,
            originKind: event.origin?.kind ?? null,
          }
        : {}),
      results,
    }
  }
  if (event.type === 'attachment' && event.attachment?.type === 'tool_result' && event.attachment.toolUseID) {
    return {
      kind: 'attachment',
      timestamp,
      result: projectToolResult(
        event.attachment.toolUseID,
        typeof event.attachment.exitCode === 'number' && event.attachment.exitCode !== 0,
        event.attachment.stderr ?? '',
        undefined,
        sourceOf(event.attachment, 'stderr'),
      ),
    }
  }
  if (event.type === 'attachment' && event.attachment?.type === 'queued_command') {
    const prompt = capText(event.attachment.prompt ?? '')
    if (prompt) {
      return {
        kind: 'queued-prompt',
        // The queue records when the person sent it, which is earlier than the
        // turn that absorbed it; the sent time is the time of the turn.
        timestamp: event.attachment.timestamp ?? timestamp,
        prompt,
        originKind: event.attachment.origin?.kind ?? null,
        contentSource: sourceOf(event.attachment, 'prompt'),
      }
    }
  }
  // The harness's own record of a file it changed: it backs the file up before
  // the edit lands, so the path here is the one the edit reached rather than
  // the one a tool argument asked for. Claude Code states no change kind, so
  // the span states none either.
  if (event.type === 'file-history-delta' && typeof event.trackingPath === 'string' && event.trackingPath.length > 0) {
    return {
      kind: 'file-change',
      timestamp,
      path: event.trackingPath,
      contentSource: sourceOf(event, 'trackingPath'),
    }
  }
  return { kind: 'ignored' }
}

/**
 * Who produced a user-role record, preferring the harness's own label.
 *
 * `recorded` is Claude Code's `origin.kind`. When it is present it decides:
 * `human` is a person, and any other kind is the harness or another agent
 * putting text in the conversation. Without it the text heuristics answer, as
 * they did before Claude Code recorded an origin at all.
 */
function claudeActorFromOrigin(
  recorded: string | null | undefined,
  fallback: () => Actor,
): Actor {
  if (typeof recorded === 'string' && recorded.length > 0) {
    return recorded === HUMAN_ORIGIN ? 'human' : 'injected'
  }
  return fallback()
}

/**
 * The line a person typed, for a turn stored as a slash-command wrapper.
 *
 * Applied only to a turn the harness attributed to a person: the wrapper is
 * how the CLI stores what they typed, so `<command-name>` plus `<command-args>`
 * IS the text, and reporting the tags instead reports the harness's storage
 * format as the human's words. Text carrying no wrapper is returned unchanged,
 * and so is a wrapper with no command name.
 */
function typedPromptText(text: string): string {
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  if (!name) return text
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

/** The task name a spawn call gave its child, when the call named one. */
function spawnTaskName(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const described = record[SPAWN_DESCRIPTION_KEY]
  if (typeof described === 'string' && described.trim().length > 0) return described.trim()
  const type = record[SPAWN_TYPE_KEY]
  return typeof type === 'string' && type.trim().length > 0 ? type.trim() : null
}

/** Whether a tool call selected an agent to run, i.e. spawned a subagent. */
function spawnsSubagent(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  const type = (input as Record<string, unknown>)[SPAWN_TYPE_KEY]
  return typeof type === 'string' && type.trim().length > 0
}

function indexWorkflowProjection(
  projection: ClaudeEventProjection,
  index: WorkflowProjectionIndex,
): void {
  if (projection.kind === 'assistant') {
    indexWorkflowTools(index, projection.timestamp, projection.tools)
    return
  }
  if (projection.kind !== 'user' && projection.kind !== 'attachment') return
  const results = projection.kind === 'user' ? projection.results : [projection.result]
  indexWorkflowResults(index, results)
}

function fingerprintClaudeEvent(event: ClaudeEventProjection): string {
  // Duplicate events can occupy different byte ranges without changing their meaning.
  return createHash('sha256').update(JSON.stringify(event, (key, value: unknown) =>
    key === 'contentSource' || key.startsWith(SOURCE_ATTRIBUTE_PREFIX) ? undefined : value,
  )).digest('hex')
}

function startsClaudeTask(projection: ClaudeEventProjection): boolean {
  if (projection.kind !== 'user' || projection.prompt === null) return false
  return claudePromptStartsTask({
    text: projection.prompt,
    isSidechain: projection.isSidechain,
    userType: projection.userType,
  })
}

/**
 * Claude occasionally persists the same event twice. A repeated UUID with the
 * same span-producing fields is one logical event; a changed emitted field is
 * corruption that must remain visible to callers.
 */
function distinctClaudeEvent(
  event: ClaudeEvent,
  seen: SeenClaudeEvents,
  sourcePath: string,
  fallbackUid: string,
): { projection: ClaudeEventProjection; uid: string } | undefined {
  const projection = projectClaudeEvent(event)
  if (event.uuid) {
    const fingerprint = fingerprintClaudeEvent(projection)
    const previous = seen.get(event.uuid)
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new ClaudeEventConflictError(sourcePath, event.uuid)
      }
      return undefined
    }
    seen.set(event.uuid, fingerprint)
  }
  return { projection, uid: event.uuid ?? fallbackUid }
}

function consumeDistinctClaudeEvent(
  event: ClaudeEvent,
  ctx: ClaudeStreamContext,
  state: ClaudeStreamState,
  seen: SeenClaudeEvents,
  sourcePath: string,
): boolean {
  const accepted = distinctClaudeEvent(event, seen, sourcePath, `step${state.step}`)
  if (!accepted) return false
  consumeClaudeEvent(accepted.projection, accepted.uid, ctx, state)
  return true
}

function consumeClaudeEvent(
  event: ClaudeEventProjection,
  uid: string,
  ctx: ClaudeStreamContext,
  state: ClaudeStreamState,
): void {
  if (event.kind === 'assistant') {
    const messageId = event.messageId ?? uid
    let llmSpan = state.llmSpanByMessageId.get(messageId)
    if (!llmSpan) {
      llmSpan = span({
        traceId: ctx.traceId,
        spanId: `${ctx.idPrefix}${uid}`,
        parentSpanId: ctx.rootParent,
        name: 'llm.turn',
        kind: 'LLM',
        startTime: event.timestamp,
        service: SERVICE,
        agent: ctx.agent,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        cacheWriteInputTokens: event.cacheWriteInputTokens,
        step: state.step,
      })
      state.spans.push(llmSpan)
      state.llmSpanByMessageId.set(messageId, llmSpan)
      state.step += 1
    } else {
      includeSpanTimestamp(llmSpan, event.timestamp)
    }

    // Claude repeats cumulative usage as a response streams; preserve the highest captured total.
    applyLlmSpanOtlpAttributes(llmSpan.attributes, {
      model: event.model ?? undefined,
      inputTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_INPUT_TOKENS],
        event.inputTokens,
      ),
      outputTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_OUTPUT_TOKENS],
        event.outputTokens,
      ),
      cachedTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_CACHED_TOKENS],
        event.cachedInputTokens,
      ),
      cacheWriteTokens: maxCapturedUsage(
        llmSpan.attributes[LLM_CACHE_WRITE_TOKENS],
        event.cacheWriteInputTokens,
      ),
    })
    mergeMessageContent(llmSpan, messageId, event.content, state)
    if (event.content) appendSourceAttributes(llmSpan.attributes, 'content', event.contentSource)
    if (event.content) mergeAssistantMessage(event, messageId, llmSpan, ctx, state)

    for (const tool of event.tools) {
      const existingTool = tool.id ? state.toolSpanByUseId.get(tool.id) : undefined
      if (existingTool) {
        Object.assign(existingTool.attributes, tool.attributes)
        includeSpanTimestamp(existingTool, event.timestamp)
        continue
      }
      const toolIdx = state.toolCountByMessageId.get(messageId) ?? 0
      const toolSpan = span({
        traceId: ctx.traceId,
        spanId: `${llmSpan.span_id}:tool:${toolIdx}`,
        parentSpanId: llmSpan.span_id,
        name: `tool.${tool.name}`,
        kind: 'TOOL',
        startTime: event.timestamp,
        service: SERVICE,
        agent: ctx.agent,
        tool: tool.name,
        step: state.step,
        extra: {
          ...tool.attributes,
          ...(tool.spawnTask === undefined
            ? {}
            : {
                [SUBAGENT_SPAWN_ATTR]: true,
                ...(tool.spawnTask ? { [SUBAGENT_SPAWN_TASK_ATTR]: tool.spawnTask } : {}),
              }),
        },
      })
      state.spans.push(toolSpan)
      if (tool.id) state.toolSpanByUseId.set(tool.id, toolSpan)
      state.toolCountByMessageId.set(messageId, toolIdx + 1)
      state.step += 1
    }
  } else if (event.kind === 'user') {
    if (event.prompt) {
      const actor = claudeActorFromOrigin(event.originKind, () => claudeActor({
        text: event.prompt ?? '',
        isSidechain: event.isSidechain,
        isMeta: event.isMeta,
        userType: event.userType ?? null,
        isFirstUserTurn: !state.sawUserTurn,
      }))
      state.sawUserTurn = true
      if (event.originKind) state.sawRecordedOrigin = true
      const prompt = userPromptSpan({
        traceId: ctx.traceId,
        spanId: `${ctx.idPrefix}${uid}:user`,
        parentSpanId: ctx.rootParent,
        startTime: event.timestamp,
        service: SERVICE,
        agent: ctx.agent,
        step: state.step,
        content: actor === 'human' ? typedPromptText(event.prompt) : event.prompt,
        contentSource: event.contentSource,
        actor,
      })
      if (event.originKind) {
        prompt.attributes[ORIGIN_RECORDED_ATTR] = true
        prompt.attributes[ORIGIN_KIND_ATTR] = event.originKind
      }
      state.spans.push(prompt)
      state.promptSpans.push(prompt)
      state.step += 1
    }
    for (const result of event.results) {
      backfillResult(state.toolSpanByUseId.get(result.toolUseId), event.timestamp, result)
    }
  } else if (event.kind === 'attachment') {
    backfillResult(state.toolSpanByUseId.get(event.result.toolUseId), event.timestamp, event.result)
  } else if (event.kind === 'queued-prompt') {
    const actor = claudeActorFromOrigin(event.originKind, () => 'injected')
    if (event.originKind) state.sawRecordedOrigin = true
    const prompt = userPromptSpan({
      traceId: ctx.traceId,
      spanId: `${ctx.idPrefix}${uid}:queued`,
      parentSpanId: ctx.rootParent,
      startTime: event.timestamp,
      service: SERVICE,
      agent: ctx.agent,
      step: state.step,
      content: actor === 'human' ? typedPromptText(event.prompt) : event.prompt,
      contentSource: event.contentSource,
      actor,
    })
    prompt.attributes['traces.claude.queued'] = true
    if (event.originKind) {
      prompt.attributes[ORIGIN_RECORDED_ATTR] = true
      prompt.attributes[ORIGIN_KIND_ATTR] = event.originKind
    }
    state.spans.push(prompt)
    state.promptSpans.push(prompt)
    state.step += 1
  } else if (event.kind === 'file-change') {
    state.spans.push(span({
      traceId: ctx.traceId,
      spanId: `${ctx.idPrefix}${uid}:file-change`,
      parentSpanId: ctx.rootParent,
      name: 'file.change',
      kind: 'CHAIN',
      startTime: event.timestamp,
      endTime: event.timestamp,
      service: SERVICE,
      agent: ctx.agent,
      step: state.step,
      extra: toolIoAttributes({ input: { path: event.path }, inputSource: event.contentSource }),
    }))
    state.step += 1
  }
}

/**
 * The assistant's prose as its own span, alongside the `llm.turn` that carries
 * the call's tokens.
 *
 * One assistant message arrives as several records while it streams, so the
 * span is created once per message id and its content merged, exactly as the
 * `llm.turn` above is. A reader asking what the agent said last wants the last
 * message, not the last call that happened to carry text.
 */
function mergeAssistantMessage(
  event: Extract<ClaudeEventProjection, { kind: 'assistant' }>,
  messageId: string,
  llmSpan: OtlpSpan,
  ctx: ClaudeStreamContext,
  state: ClaudeStreamState,
): void {
  const existing = state.messageSpanByMessageId.get(messageId)
  if (existing) {
    includeSpanTimestamp(existing, event.timestamp)
    existing.attributes.content = llmSpan.attributes.content
    return
  }
  const messageSpan = span({
    traceId: ctx.traceId,
    spanId: `${llmSpan.span_id}:message`,
    parentSpanId: llmSpan.span_id,
    name: 'message.assistant',
    kind: 'CHAIN',
    startTime: event.timestamp,
    endTime: event.timestamp,
    service: SERVICE,
    agent: ctx.agent,
    step: state.step,
    content: typeof llmSpan.attributes.content === 'string' ? llmSpan.attributes.content : '',
    contentSource: event.contentSource,
  })
  state.spans.push(messageSpan)
  state.messageSpanByMessageId.set(messageId, messageSpan)
  state.step += 1
}

/**
 * Apply Claude Code's own origin labelling across a finished stream.
 *
 * A transcript that records `origin` records it on every message a person
 * sent, so inside such a transcript a user record without one is not a human
 * turn — however human its text reads. The reclassification is stamped so a
 * reader can see which turns it moved and disagree with it span by span.
 */
function applyRecordedOrigins(state: ClaudeStreamState): void {
  if (!state.sawRecordedOrigin) return
  for (const prompt of state.promptSpans) {
    if (prompt.attributes[ACTOR_ATTR] !== 'human') continue
    if (prompt.attributes[ORIGIN_RECORDED_ATTR] === true) continue
    prompt.attributes[ACTOR_ATTR] = 'injected'
    prompt.attributes[ORIGIN_EVIDENCE_ATTR] = 'no_human_origin'
  }
}

function maxCapturedUsage(current: unknown, next: number | null | undefined): number | undefined {
  const captured = typeof current === 'number' && Number.isFinite(current) ? current : undefined
  if (next == null) return captured
  return captured === undefined ? next : Math.max(captured, next)
}

function includeSpanTimestamp(target: OtlpSpan, timestamp: string | undefined): void {
  if (!timestamp) return
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return
  const start = Date.parse(target.start_time)
  const end = Date.parse(target.end_time)
  if (!Number.isFinite(start) || time < start) target.start_time = timestamp
  if (!Number.isFinite(end) || time > end) target.end_time = timestamp
}

function mergeMessageContent(
  llmSpan: OtlpSpan,
  messageId: string,
  content: string | null,
  state: ClaudeStreamState,
): void {
  if (!content) return
  const parts = state.llmContentByMessageId.get(messageId) ?? new Set<string>()
  if (parts.has(content)) return
  parts.add(content)
  state.llmContentByMessageId.set(messageId, parts)
  llmSpan.attributes.content = capText([...parts].join('\n'))
}

function finishClaudeStream(state: ClaudeStreamState): ParsedStream {
  applyRecordedOrigins(state)
  return { spans: state.spans, toolSpanByUseId: state.toolSpanByUseId, nextStep: state.step }
}

/**
 * Widen the stream's record window to include one record's timestamp.
 *
 * The window is over RECORDS, not spans: a session's first and last record are
 * often ones that produce no span — the file-history snapshot the CLI writes
 * when the session opens, the `continued-in` marker it writes when the session
 * ends. Reporting the first span instead reports when the agent started, which
 * is a different question and a different answer.
 */
function includeRecordTimestamp(state: ClaudeStreamState, timestamp: string | undefined): void {
  if (!timestamp) return
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time)) return
  if (state.firstRecordAt === null || time < Date.parse(state.firstRecordAt)) state.firstRecordAt = timestamp
  if (state.lastRecordAt === null || time > Date.parse(state.lastRecordAt)) state.lastRecordAt = timestamp
}

/**
 * The session's own record window, on the root span.
 *
 * A subagent's spans are folded into this trace but belong to the child's
 * transcript, so they are not records of this session and do not move its
 * window: one measured session ran for 3 h 28 m and its last subagent finished
 * 8 minutes later, which is the subagent's end, not the session's.
 * `recordWindow` is the window over the session's own records, including the
 * ones that produce no span; the spans only widen it when it is absent.
 */
function setRootTimeBounds(
  root: OtlpSpan,
  spans: readonly OtlpSpan[],
  recordWindow: { first: string | null; last: string | null },
): void {
  let firstTimestamp: { value: number; source: string } | undefined
  let lastTimestamp: { value: number; source: string } | undefined

  for (const source of [recordWindow.first, recordWindow.last]) {
    if (!source) continue
    const value = Date.parse(source)
    if (!Number.isFinite(value)) continue
    if (!firstTimestamp || value < firstTimestamp.value) firstTimestamp = { value, source }
    if (!lastTimestamp || value > lastTimestamp.value) lastTimestamp = { value, source }
  }

  for (const item of spans) {
    if (item === root || isSubagentSpan(item.attributes)) continue
    for (const source of [item.start_time, item.end_time]) {
      if (!source) continue
      const value = Date.parse(source)
      if (!Number.isFinite(value)) continue
      if (!firstTimestamp || value < firstTimestamp.value) firstTimestamp = { value, source }
      if (!lastTimestamp || value > lastTimestamp.value) lastTimestamp = { value, source }
    }
  }

  if (firstTimestamp) root.start_time = firstTimestamp.source
  if (lastTimestamp) root.end_time = lastTimestamp.source
}

function orderClaudeSpans(root: OtlpSpan, spans: readonly OtlpSpan[]): OtlpSpan[] {
  const indexed = spans
    .filter((item) => item !== root)
    .map((item, index) => ({
      item,
      index,
      startMs: Date.parse(item.start_time),
      localStep: typeof item.attributes.step === 'number'
        ? item.attributes.step
        : Number.MAX_SAFE_INTEGER,
    }))
  indexed.sort((left, right) =>
    (Number.isFinite(left.startMs) ? left.startMs : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(right.startMs) ? right.startMs : Number.MAX_SAFE_INTEGER)
    || left.localStep - right.localStep
    || left.item.span_id.localeCompare(right.item.span_id)
    || left.index - right.index)

  const byId = new Map<string, OtlpSpan>()
  for (const { item } of indexed) {
    if (byId.has(item.span_id)) {
      throw new ClaudeTaskScopeError(`Claude trace contains duplicate span ${item.span_id}`)
    }
    byId.set(item.span_id, item)
  }

  const emitted = new Set<string>()
  const active = new Set<string>()
  const ordered: OtlpSpan[] = []
  const emit = (item: OtlpSpan): void => {
    if (emitted.has(item.span_id)) return
    if (active.has(item.span_id)) {
      throw new ClaudeTaskScopeError(`Claude trace contains a parent cycle at ${item.span_id}`)
    }
    active.add(item.span_id)
    const parent = item.parent_span_id ? byId.get(item.parent_span_id) : undefined
    if (parent) emit(parent)
    active.delete(item.span_id)
    emitted.add(item.span_id)
    ordered.push(item)
  }
  for (const { item } of indexed) emit(item)
  for (const [step, item] of ordered.entries()) item.attributes.step = step
  return [root, ...ordered]
}

/**
 * Project one event stream (a main session or a subagent sidechain) onto
 * spans. `idPrefix` keeps span ids unique when folding subagents into the
 * parent trace.
 */
export function parseClaudeStream(events: readonly ClaudeEvent[], ctx: ClaudeStreamContext): ParsedStream {
  const state = createClaudeStream(ctx.startStep)
  const seen = new Map<string, string>()
  for (const event of events) consumeDistinctClaudeEvent(event, ctx, state, seen, '<stream>')
  return finishClaudeStream(state)
}

function backfillResult(s: OtlpSpan | undefined, endTime: string, result: ToolResultProjection): void {
  if (!s) return
  s.end_time = endTime
  const code: OtlpStatusCode = result.isError ? 'ERROR' : 'OK'
  s.status = { code }
  Object.assign(s.attributes, result.attributes)
  if (result.isError && result.message) s.status.message = result.message
}

interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  parentAgentId?: string
}

interface ClaudeSubagentFile {
  file: string
  sourceKey: string
  agentId: string
  meta: SubagentMeta
  parentToolUseId?: string
  parsed?: ParsedStream
}

async function readClaudeWorkflowBindings(
  ref: SessionRef,
  options: Pick<ParseOptions, 'signal'>,
): Promise<Map<string, WorkflowRunBinding[]>> {
  const index = createWorkflowProjectionIndex()
  const seen = new Map<string, string>()
  let row = 0
  for await (const event of readJsonl<ClaudeEvent>(
    ref.path,
    sessionJsonlOptions(ref, options),
  )) {
    options.signal?.throwIfAborted()
    const accepted = distinctClaudeEvent(event, seen, ref.path, `source${row}`)
    row += 1
    if (accepted) indexWorkflowProjection(accepted.projection, index)
  }
  return bindWorkflowRuns(index)
}

async function parseClaudeSubagent(
  ref: SessionRef,
  traceId: string,
  agent: ClaudeSubagentFile,
  options: ParseOptions,
): Promise<ParsedStream> {
  if (agent.parsed) return agent.parsed
  const ctx: ClaudeStreamContext = {
    traceId,
    agent: agent.meta.agentType ? `subagent:${agent.meta.agentType}` : 'subagent',
    startStep: 0,
    idPrefix: `${agent.sourceKey}:`,
    rootParent: `root:${traceId}`,
  }
  const state = createClaudeStream(ctx.startStep)
  const seen = new Map<string, string>()
  for await (const event of readJsonl<ClaudeEvent>(
    agent.file,
    sessionJsonlOptions(ref, options),
  )) {
    options.signal?.throwIfAborted()
    consumeDistinctClaudeEvent(event, ctx, state, seen, agent.file)
  }
  options.signal?.throwIfAborted()
  agent.parsed = finishClaudeStream(state)
  return agent.parsed
}

function firstSubagentTimestamp(agent: ClaudeSubagentFile, parsed: ParsedStream): string {
  let earliest: { timestamp: string; milliseconds: number } | undefined
  for (const item of parsed.spans) {
    const milliseconds = Date.parse(item.start_time)
    if (!Number.isFinite(milliseconds)) {
      throw new ClaudeTaskScopeError(
        `Cannot link Claude Workflow subagent ${agent.file}: child start time is invalid`,
      )
    }
    if (!earliest || milliseconds < earliest.milliseconds) {
      earliest = { timestamp: item.start_time, milliseconds }
    }
  }
  if (!earliest) {
    throw new ClaudeTaskScopeError(
      `Cannot link Claude Workflow subagent ${agent.file}: child produced no spans`,
    )
  }
  return earliest.timestamp
}

function stampSkippedSubagents(root: OtlpSpan, agentIds: readonly string[]): void {
  if (agentIds.length === 0) return
  const captured = [...agentIds].sort().slice(0, 100)
  root.attributes['traces.claude.skipped_subagent_count'] = agentIds.length
  root.attributes['traces.claude.skipped_subagent_ids'] = JSON.stringify(captured)
  root.attributes['traces.claude.skipped_subagent_ids_omitted'] =
    Math.max(0, agentIds.length - captured.length)
}

export class ClaudeAdapter implements HarnessTraceAdapter {
  readonly harness = 'claude-code'
  readonly aliases = ['claude', 'claudish', 'openclaw', 'nanoclaw'] as const

  private root(): string {
    return join(homedir(), '.claude', 'projects')
  }

  async sourcePaths(
    ref: SessionRef,
    options: Pick<ParseOptions, 'signal'> = {},
  ): Promise<readonly string[]> {
    const bindings = await readClaudeWorkflowBindings(ref, options)
    const sources = await collectClaudeSubagentSources(ref, bindings, options.signal)
    const metadataFiles: string[] = []
    for (const file of sources.files) {
      options.signal?.throwIfAborted()
      const path = file.replace(/\.jsonl$/, '.meta.json')
      try {
        const source = await stat(path)
        if (source.isFile()) metadataFiles.push(path)
      } catch (error) {
        if (!isMissingPathError(error)) throw error
      }
    }
    options.signal?.throwIfAborted()
    return [ref.path, ...sources.files, ...metadataFiles].sort()
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    const root = this.root()
    let projectDirs: string[]
    try {
      projectDirs = await readdir(root)
    } catch (error) {
      if (isMissingPathError(error)) return []
      throw error
    }
    const refs: SessionRef[] = []
    for (const dir of projectDirs) {
      const dirPath = join(root, dir)
      let files: string[]
      try {
        files = await readdir(dirPath)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const path = join(dirPath, f)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path)
        } catch (error) {
          if (isMissingPathError(error)) continue
          throw error
        }
        if (!st.isFile()) continue
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue
        // Encoded cwd: leading dashes for path separators. Decode best-effort.
        const cwd = `/${dir.replace(/^-/, '').replace(/-/g, '/')}`
        if (opts.cwd && !cwd.startsWith(opts.cwd)) continue
        refs.push({ harness: this.harness, sessionId: basename(f, '.jsonl'), path, cwd, mtimeMs: st.mtimeMs })
      }
    }
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    options.signal?.throwIfAborted()
    const taskScope = options.taskScope ?? 'all'
    if (taskScope === 'turn' && !options.taskTurnId) {
      throw new ClaudeTaskScopeError('Claude taskScope "turn" requires a stable taskTurnId')
    }
    const sourceTraceId = ref.sessionId
    const sourceRootId = `root:${sourceTraceId}`
    const ctx: ClaudeStreamContext = {
      traceId: sourceTraceId,
      agent: SERVICE,
      startStep: 0,
      idPrefix: '',
      rootParent: sourceRootId,
    }
    let state = createClaudeStream(ctx.startStep)
    let discoveredTraceId: string | undefined
    const seen = new Map<string, string>()
    const workflowIndex = createWorkflowProjectionIndex()
    let selectedTurnId: string | undefined
    let selectedTurnFound = false
    let active = taskScope === 'all'

    for await (const event of readJsonl<ClaudeEvent>(ref.path, sessionJsonlOptions(ref, options))) {
      options.signal?.throwIfAborted()
      if (!discoveredTraceId && event.sessionId) discoveredTraceId = event.sessionId
      const accepted = distinctClaudeEvent(event, seen, ref.path, `step${state.step}`)
      if (!accepted) continue
      indexWorkflowProjection(accepted.projection, workflowIndex)
      const startsTask = startsClaudeTask(accepted.projection)
      if (startsTask && taskScope === 'latest') {
        if (!event.uuid) {
          throw new ClaudeTaskScopeError(
            `Cannot select Claude's latest task because a user task in ${ref.path} has no stable UUID`,
          )
        }
        state = createClaudeStream(ctx.startStep)
        selectedTurnId = event.uuid
        selectedTurnFound = true
        active = true
      } else if (startsTask && taskScope === 'turn') {
        active = event.uuid === options.taskTurnId
        if (active) {
          state = createClaudeStream(ctx.startStep)
          selectedTurnId = event.uuid
          selectedTurnFound = true
        }
      }
      if (active) {
        includeRecordTimestamp(state, event.timestamp)
        consumeClaudeEvent(accepted.projection, accepted.uid, ctx, state)
      }
    }
    options.signal?.throwIfAborted()
    if (taskScope === 'latest' && !selectedTurnFound) {
      throw new ClaudeTaskScopeError(`Cannot select Claude's latest task because ${ref.path} has no user task`)
    }
    if (taskScope === 'turn' && !selectedTurnFound) {
      throw new ClaudeTaskScopeError(
        `Claude task turn ${JSON.stringify(options.taskTurnId)} was not found in ${ref.path}`,
      )
    }

    const main = finishClaudeStream(state)
    const workflowBindings = bindWorkflowRuns(workflowIndex)
    const traceId = discoveredTraceId ?? sourceTraceId
    const rootId = `root:${traceId}`
    for (const item of main.spans) {
      item.trace_id = traceId
      if (item.parent_span_id === sourceRootId) item.parent_span_id = rootId
    }
    const root = span({
      traceId,
      spanId: rootId,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      startTime: new Date(0).toISOString(),
      service: SERVICE,
      agent: SERVICE,
    })
    const spans: OtlpSpan[] = [root]
    appendAll(spans, main.spans)

    await this.foldSubagents(
      ref,
      traceId,
      main,
      workflowBindings,
      spans,
      {
        ...options,
        taskScope,
        ...(selectedTurnId ? { taskTurnId: selectedTurnId } : {}),
      },
    )
    options.signal?.throwIfAborted()
    const ordered = orderClaudeSpans(root, spans)
    setRootTimeBounds(root, ordered, { first: state.firstRecordAt, last: state.lastRecordAt })
    const subagentSpans = ordered.filter((item) => isSubagentSpan(item.attributes)).length
    if (subagentSpans > 0) root.attributes[SUBAGENT_SPAN_COUNT_ATTR] = subagentSpans
    normalizeClaudeIds(ordered)
    return ordered
  }

  /** Parse nested `subagents/.../agent-*.jsonl`, parenting each under its Agent call. */
  private async foldSubagents(
    ref: SessionRef,
    traceId: string,
    main: ParsedStream,
    workflowBindings: ReadonlyMap<string, readonly WorkflowRunBinding[]>,
    out: OtlpSpan[],
    options: ParseOptions,
  ): Promise<void> {
    const subDir = join(ref.path.replace(/\.jsonl$/, ''), 'subagents')
    const sources = await collectClaudeSubagentSources(
      ref,
      workflowBindings,
      options.signal,
    )
    const scoped = options.taskScope !== undefined && options.taskScope !== 'all'
    const agents: ClaudeSubagentFile[] = []
    for (const file of sources.files) {
      options.signal?.throwIfAborted()
      const sourceKey = relative(subDir, file)
        .replace(/\.jsonl$/, '')
        .split(/[\\/]/)
        .map((segment) => encodeURIComponent(segment))
        .join(':')
      const metaPath = file.replace(/\.jsonl$/, '.meta.json')
      let meta: SubagentMeta = {}
      try {
        meta = await readJsonFile<SubagentMeta>(metaPath)
      } catch (error) {
        if (!isMissingJsonSource(error)) throw error
      }
      options.signal?.throwIfAborted()
      const workflowLocation = sources.workflowByFile.get(file)
      const workflowRunId = workflowLocation?.runId
      const agent: ClaudeSubagentFile = {
        file,
        sourceKey,
        agentId: basename(file, '.jsonl').replace(/^agent-/, ''),
        meta,
        ...(meta.toolUseId ? { parentToolUseId: meta.toolUseId } : {}),
      }
      if (workflowRunId) {
        const runBindings = bindWorkflowSubagent(
          file,
          workflowRunId,
          workflowLocation.transcriptDir,
          workflowBindings,
        )
        const parsed = await parseClaudeSubagent(ref, traceId, agent, options)
        const binding = selectWorkflowBinding(
          basename(file),
          runBindings,
          firstSubagentTimestamp(agent, parsed),
          meta.toolUseId,
        )
        agent.parentToolUseId = binding.toolUseId
      }
      agents.push(agent)
    }

    const agentsById = new Map<string, ClaudeSubagentFile>()
    /** Ids carried by more than one transcript, so any parent reference to them is unresolvable. */
    const ambiguousAgentIds = new Set<string>()
    const childrenByParent = new Map<string, ClaudeSubagentFile[]>()
    for (const agent of agents) {
      // `agentId` is a FILE BASENAME, so the same id legitimately reaches one parse from two
      // directories — two workflow transcript dirs, or a subagent continued across sessions.
      // Three such collisions exist on one developer machine, and this used to THROW, taking the
      // whole tool down before it printed anything.
      //
      // Throwing was protecting a real invariant: a `parentAgentId` pointing at a duplicated id is
      // genuinely ambiguous, and picking one silently attaches a transcript under the wrong
      // parent. That must not happen. But refusing to start is not the only way to avoid it, and
      // it is the worst one — an observability tool that crashes on the data it exists to read
      // helps nobody, and the ambiguity is in TWO agents' parentage, not in the whole run.
      //
      // So: record the collision, keep every transcript, and refuse only the thing that is
      // actually unresolvable — the parent EDGE. A child pointing at an ambiguous id is left to
      // default parenting rather than bound to a guess. Nothing is silently mis-parented and
      // nothing is lost.
      if (agentsById.has(agent.agentId)) ambiguousAgentIds.add(agent.agentId)
      else agentsById.set(agent.agentId, agent)
      // An edge into an ambiguous id names two possible parents, so it names none. Skipping it
      // here is what keeps "never silently assign the wrong parent" true without a crash.
      if (agent.meta.parentAgentId && !ambiguousAgentIds.has(agent.meta.parentAgentId)) {
        const siblings = childrenByParent.get(agent.meta.parentAgentId) ?? []
        siblings.push(agent)
        childrenByParent.set(agent.meta.parentAgentId, siblings)
      }
    }

    const selectedAgentIds = new Set<string>()
    if (!scoped) {
      for (const agent of agents) {
        await parseClaudeSubagent(ref, traceId, agent, options)
        selectedAgentIds.add(agent.agentId)
      }
    } else {
      const pending: ClaudeSubagentFile[] = []
      for (const agent of agents) {
        if (
          !agent.meta.parentAgentId
          && agent.parentToolUseId
          && main.toolSpanByUseId.has(agent.parentToolUseId)
        ) pending.push(agent)
      }
      for (let cursor = 0; cursor < pending.length; cursor += 1) {
        options.signal?.throwIfAborted()
        const agent = pending[cursor]
        if (!agent || selectedAgentIds.has(agent.agentId)) continue
        const parsed = await parseClaudeSubagent(ref, traceId, agent, options)
        selectedAgentIds.add(agent.agentId)
        for (const child of childrenByParent.get(agent.agentId) ?? []) {
          if (
            child.parentToolUseId
            && parsed.toolSpanByUseId.has(child.parentToolUseId)
          ) pending.push(child)
        }
      }
      const skipped = agents
        .filter((agent) => !selectedAgentIds.has(agent.agentId))
        .map((agent) => agent.agentId)
      const root = out[0]
      if (root) stampSkippedSubagents(root, skipped)
    }

    const selectedAgents = agents.filter((agent) => selectedAgentIds.has(agent.agentId))
    const parsedByAgentId = new Map<string, ParsedStream>()
    for (const agent of selectedAgents) {
      if (agent.parsed) parsedByAgentId.set(agent.agentId, agent.parsed)
    }
    for (const agent of selectedAgents) {
      const parsed = agent.parsed
      if (!parsed) {
        throw new ClaudeTaskScopeError(`Claude subagent ${agent.agentId} was not parsed`)
      }
      const parentTools = agent.meta.parentAgentId
        ? parsedByAgentId.get(agent.meta.parentAgentId)?.toolSpanByUseId
        : main.toolSpanByUseId
      const parentSpan = agent.parentToolUseId
        ? parentTools?.get(agent.parentToolUseId)
        : undefined
      const parent = parentSpan?.span_id ?? `root:${traceId}`
      const parentAgentMissing = Boolean(
        agent.meta.parentAgentId && !parsedByAgentId.has(agent.meta.parentAgentId),
      )
      const task = subagentTaskName(agent)
      const lifecycle = subagentLifecycleSpan(agent, parsed, traceId, parent, task, subDir)
      for (const item of [...parsed.spans, ...(lifecycle ? [lifecycle] : [])]) {
        if (item.parent_span_id === `root:${traceId}`) item.parent_span_id = parent
        // Every span here came from the CHILD's transcript. Marking it says so,
        // which is what keeps the parent's tool count, changed files, human
        // turns and record window from absorbing work the parent never did.
        item.attributes[SUBAGENT_SPAN_ATTR] = true
        if (task) item.attributes[SUBAGENT_TASK_ATTR] = task
        if (agent.parentToolUseId && !parentSpan) {
          item.attributes['traces.claude.parent_tool_missing'] = true
          item.attributes['traces.claude.parent_tool_use_id'] = agent.parentToolUseId
        }
        if (parentAgentMissing) {
          item.attributes['traces.claude.parent_agent_missing'] = true
          item.attributes['traces.claude.parent_agent_id'] = agent.meta.parentAgentId
        }
      }
      appendAll(out, parsed.spans)
      if (lifecycle) out.push(lifecycle)
    }
  }
}

/** The task the parent's spawn call gave this child, as the harness recorded it. */
function subagentTaskName(agent: ClaudeSubagentFile): string | null {
  const described = agent.meta.description?.trim()
  if (described) return described
  const type = agent.meta.agentType?.trim()
  return type ? type : null
}

/**
 * One span standing for a child transcript, so the parent's `Task` call has
 * something to point at.
 *
 * It is synthesized — no model issued it — and it belongs to the subagent's
 * scope, so neither the parent's tool count nor the parent's record window
 * absorbs it. Its value is evidence: it names the transcript the child's spans
 * came from and the window they cover, which is what a reader checking "which
 * subagents ran" needs and what the parent's TOOL span alone cannot say.
 */
function subagentLifecycleSpan(
  agent: ClaudeSubagentFile,
  parsed: ParsedStream,
  traceId: string,
  parentSpanId: string,
  task: string | null,
  subDir: string,
): OtlpSpan | undefined {
  let first: string | undefined
  let last: string | undefined
  for (const item of parsed.spans) {
    for (const stamp of [item.start_time, item.end_time]) {
      const value = Date.parse(stamp)
      if (!Number.isFinite(value)) continue
      if (first === undefined || value < Date.parse(first)) first = stamp
      if (last === undefined || value > Date.parse(last)) last = stamp
    }
  }
  if (first === undefined || last === undefined) return undefined
  return span({
    traceId,
    // Same prefix as every other span from this transcript, so a reader
    // grouping spans by source keeps the anchor with the spans it stands for.
    spanId: `${agent.sourceKey}:lifecycle`,
    parentSpanId,
    name: 'subagent.lifecycle',
    kind: 'AGENT',
    startTime: first,
    endTime: last,
    // The transcript records what the child did, not whether the parent
    // accepted it; the parent's own tool span carries that status.
    status: 'UNSET',
    service: SERVICE,
    agent: agent.meta.agentType ? `subagent:${agent.meta.agentType}` : 'subagent',
    extra: {
      ...toolIoAttributes({
        input: {
          agent_id: agent.agentId,
          ...(agent.meta.agentType ? { subagent_type: agent.meta.agentType } : {}),
          ...(task ? { task } : {}),
        },
      }),
      [SYNTHESIZED_SPAN_ATTR]: true,
      [SYNTHESIZED_SOURCE_ATTR]: 'claude.subagent_transcript',
      [SUBAGENT_SPAN_ATTR]: true,
      ...(task ? { [SUBAGENT_TASK_ATTR]: task } : {}),
      ...(agent.meta.agentType ? { [SPAWN_TYPE_ATTR]: agent.meta.agentType } : {}),
      [SUBAGENT_AGENT_ID_ATTR]: agent.agentId,
      [SUBAGENT_TRANSCRIPT_ATTR]: relative(subDir, agent.file),
    },
  })
}
