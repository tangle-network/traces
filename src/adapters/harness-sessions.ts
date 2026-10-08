/** Native-session adapter for formats owned by @tangle-network/harness-sessions.
 * Traces keeps selection and trace-specific presentation here; the shared reader
 * alone interprets the harness's records, model calls, tools, and token usage. */
import { homedir } from 'node:os'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  claudeCodeRefForFile,
  codexRefForFile,
  factoryRefForFile,
  kimiRefForFile,
  opencodeSessionsInStore,
  piRefForFile,
  readerFor,
  toOtlpSpans,
  type HarnessSession,
  type SessionRef as NativeRef,
} from '@tangle-network/harness-sessions'
import { contractSpan, deriveHexId } from '@tangle-network/agent-trace-contract'
import { applyLlmSpanOtlpAttributes } from '@tangle-network/agent-eval/trace-attributes'
import type { OtlpSpan } from '../otlp.js'
import { takeJsonl } from '../jsonl.js'
import type { HarnessTraceAdapter, LocateOptions, ParentTaskResolution, ParseOptions, SessionRef, SpawnedChildResolution } from '../types.js'
import { ClaudeAdapter } from './claude.js'
import { CodexAdapter } from './codex.js'
import { multiAgentOperation, spawnedSessionIds, targetedSessionIds } from './codex-format.js'
import { OpencodeAdapter } from './opencode.js'

type SupportedHarness = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'kimi-code' | 'factory-droids'

function nativeRef(harness: SupportedHarness, ref: SessionRef): NativeRef {
  const unattributed = ref.sessionId.startsWith('unattributed:')
  const selected = (native: NativeRef): NativeRef => unattributed
    ? { ...native, nativeSessionId: ref.sessionId }
    : native
  switch (harness) {
    case 'claude-code': return selected(claudeCodeRefForFile(ref.path))
    case 'codex': return selected(codexRefForFile(ref.path))
    case 'pi': return selected(piRefForFile(ref.path))
    case 'kimi-code': return selected(kimiRefForFile(ref.path.endsWith('wire.jsonl') ? ref.path : join(ref.path, 'wire.jsonl')))
    case 'factory-droids': return selected(factoryRefForFile(ref.path))
    case 'opencode': throw new Error('OpenCode SQLite sessions must be selected from its session catalog')
  }
}

async function isClaudeStreamJson(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n').slice(0, 20)) {
      if (!line || line.length > 60000) continue
      try {
        const row = JSON.parse(line) as { type?: string; subtype?: string }
        if (row.type === 'system' && row.subtype === 'init') return true
      } catch {
        // A torn head is the shared reader's integrity decision.
      }
    }
    return false
  } finally {
    await file.close()
  }
}

function tracesRef(ref: NativeRef, harness: string): SessionRef {
  return {
    harness,
    sessionId: ref.nativeSessionId,
    path: ref.path,
    cwd: ref.cwd,
    mtimeMs: ref.mtimeMs,
  }
}

function status(code: string): OtlpSpan['status']['code'] {
  return code === 'STATUS_CODE_OK' ? 'OK' : code === 'STATUS_CODE_ERROR' ? 'ERROR' : 'UNSET'
}

function stringTooLong(error: unknown): boolean {
  return error instanceof Error && /Cannot create a string longer than/u.test(error.message)
}

function asTracesSpan(item: ReturnType<typeof toOtlpSpans>[number]): OtlpSpan {
  const attributes: Record<string, unknown> = { ...item.attributes }
  if (item.kind === 'LLM') {
    applyLlmSpanOtlpAttributes(attributes, {
      model: typeof attributes['gen_ai.request.model'] === 'string' ? attributes['gen_ai.request.model'] : undefined,
      inputTokens: typeof attributes['gen_ai.usage.input_tokens'] === 'number' ? attributes['gen_ai.usage.input_tokens'] : undefined,
      outputTokens: typeof attributes['gen_ai.usage.output_tokens'] === 'number' ? attributes['gen_ai.usage.output_tokens'] : undefined,
      reasoningTokens: typeof attributes['gen_ai.usage.reasoning_tokens'] === 'number' ? attributes['gen_ai.usage.reasoning_tokens'] : undefined,
      cachedTokens: typeof attributes['gen_ai.usage.cache_read.input_tokens'] === 'number' ? attributes['gen_ai.usage.cache_read.input_tokens'] : undefined,
      cacheWriteTokens: typeof attributes['gen_ai.usage.cache_creation.input_tokens'] === 'number' ? attributes['gen_ai.usage.cache_creation.input_tokens'] : undefined,
    })
  }
  if (item.kind === 'TOOL' && typeof attributes['gen_ai.tool.name'] === 'string') {
    attributes['tool.name'] = attributes['gen_ai.tool.name']
  }
  return {
    trace_id: item.trace_id,
    span_id: item.span_id,
    parent_span_id: item.parent_span_id,
    name: item.name,
    start_time: item.start_time,
    end_time: item.end_time,
    status: { code: status(item.status.code), ...(item.status.message ? { message: item.status.message } : {}) },
    attributes,
    ...(item.links ? { links: [...item.links] } : {}),
  }
}

function messageText(message: HarnessSession['messages'][number]): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function presentationSpans(session: HarnessSession, root: OtlpSpan): OtlpSpan[] {
  const spans = new Map<string, OtlpSpan>()
  for (const message of session.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!message.at) continue
    const text = messageText(message)
    if (!text) continue
    const isPrompt = message.role === 'user'
    const item = contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`${session.harness}:${session.nativeSessionId}:message:${message.id}`, 8),
      parentSpanId: root.span_id,
      name: isPrompt ? 'user.prompt' : 'message.assistant',
      kind: 'CHAIN',
      startTime: message.at,
      endTime: message.at,
      attributes: {
        'service.name': session.harness,
        'tangle.actor': message.actor,
        content: text.slice(0, 8000),
      },
    })
    // Claude can re-emit a message with the same native ID after a resumed
    // subagent turn. The later copy can carry stronger actor attribution.
    spans.set(item.span_id, asTracesSpan(item))
  }
  return [...spans.values()]
}

/** Codex's `exec` is a JavaScript envelope around one or more actual tools. */
function nestedToolName(input: string | null): string | null {
  if (!input) return null
  const names = [...new Set([...input.matchAll(/\btools\.([A-Za-z][A-Za-z0-9_]*)\s*\(/gu)].map((match) => match[1]!))]
  return names.length === 1 ? names[0]! : null
}

function decorateCodexTools(session: HarnessSession, spans: OtlpSpan[]): void {
  const byCallId = new Map(session.toolCalls.map((call) => [call.id, call]))
  for (const item of spans) {
    if (item.attributes['openinference.span.kind'] !== 'TOOL') continue
    const callId = item.attributes['gen_ai.tool.call.id']
    if (typeof callId !== 'string') continue
    const call = byCallId.get(callId)
    if (!call) continue
    const nested = call.name === 'exec' ? nestedToolName(call.inputText) : null
    const name = nested ?? call.name
    if (nested) {
      item.attributes['traces.codex.outer_tool_name'] = call.name
      item.attributes['traces.codex.nested_tool_name'] = nested
      item.attributes['tool.name'] = nested
      item.name = `tool.${nested}`
    }
    const operation = multiAgentOperation(name)
    if (!operation) continue
    item.attributes['traces.codex.agent_operation'] = operation
    const children = session.children
      .filter((child) => child.toolCallId === callId)
      .map((child) => child.nativeSessionId)
    const ids = operation === 'spawn_agent'
      ? [...new Set([...children, ...spawnedSessionIds(call.result?.output)])]
      : targetedSessionIds(operation, call.inputText ?? call.input)
    if (ids.length > 0) item.attributes['traces.codex.agent_session_ids'] = JSON.stringify(ids)
    if (operation === 'spawn_agent') item.attributes['traces.agent.spawn'] = true
  }
}

function lifecycleSpans(session: HarnessSession, root: OtlpSpan, spans: readonly OtlpSpan[]): OtlpSpan[] {
  if (session.harness !== 'codex') return []
  const tools = new Map(spans
    .filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    .map((item) => [item.attributes['gen_ai.tool.call.id'], item]))
  const result: OtlpSpan[] = []
  for (const child of session.children) {
    const tool = child.toolCallId ? tools.get(child.toolCallId) : undefined
    if (!tool) continue
    const marker = contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`${session.harness}:${session.nativeSessionId}:child:${child.nativeSessionId}`, 8),
      parentSpanId: tool.span_id,
      name: 'subagent.lifecycle',
      kind: 'AGENT',
      startTime: tool.start_time,
      endTime: tool.end_time,
      attributes: {
        'service.name': session.harness,
        'traces.codex.subagent_thread_id': child.nativeSessionId,
        'traces.span.synthesized': true,
        'traces.span.synthesized_from': 'harness-session.child',
      },
    })
    result.push(asTracesSpan(marker))
  }
  return result
}

type CodexHead = { timestamp?: string; type?: string; payload?: {
  type?: string; role?: string; content?: unknown; id?: string; agent_nickname?: string;
  agent_role?: string; source?: { subagent?: { thread_spawn?: {
    depth?: number; agent_nickname?: string; agent_role?: string; agent_path?: string
  } } }
} }

async function decorateCodexMetadata(path: string, session: HarnessSession, root: OtlpSpan, spans: OtlpSpan[]): Promise<void> {
  const head = await takeJsonl<CodexHead>(path, 40, { mode: 'recover', onCorruption: () => {} })
  const meta = head.find((row) => row.type === 'session_meta')?.payload
  const spawn = meta?.source?.subagent?.thread_spawn
  if (typeof spawn?.depth === 'number') root.attributes['traces.codex.agent_depth'] = spawn.depth
  const nickname = meta?.agent_nickname ?? spawn?.agent_nickname
  if (nickname) root.attributes['traces.codex.agent_nickname'] = nickname
  const role = meta?.agent_role ?? spawn?.agent_role
  if (role) root.attributes['traces.codex.agent_role'] = role
  if (spawn?.agent_path) root.attributes['traces.codex.agent_path'] = spawn.agent_path

  // Older Codex rollouts can put a plain string in a user message. The shared
  // reader's 0.1.0 normalized parts omit it; retain the visible subject here.
  if (session.messages.some((message) => message.role === 'user' && messageText(message))) return
  for (const row of head) {
    if (row.type !== 'response_item' || row.payload?.type !== 'message'
      || row.payload.role !== 'user' || typeof row.payload.content !== 'string'
      || !row.timestamp) continue
    spans.push(asTracesSpan(contractSpan({
      traceId: root.trace_id,
      spanId: deriveHexId(`codex:${session.nativeSessionId}:legacy-prompt:${row.payload.id ?? row.timestamp}`, 8),
      parentSpanId: root.span_id,
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: row.timestamp,
      endTime: row.timestamp,
      attributes: { 'service.name': 'codex', 'tangle.actor': session.parentNativeSessionId ? 'subagent-spawn' : 'human', content: row.payload.content },
    })))
  }
}

function stampNativeProvenance(session: HarnessSession, spans: OtlpSpan[]): void {
  const prefix = session.harness === 'codex' ? 'traces.codex' : 'traces.claude'
  if (session.harness !== 'codex' && session.harness !== 'claude-code') return
  for (const item of spans) item.attributes[`${prefix}.source_trace_id`] = session.nativeSessionId
  const tools = new Map(spans.filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
    .map((item) => [item.attributes['gen_ai.tool.call.id'], item]))
  const counts = new Map<string, number>()
  for (const call of session.toolCalls) {
    const item = tools.get(call.id)
    if (!item) continue
    const key = call.messageId ?? ''
    const index = counts.get(key) ?? 0
    counts.set(key, index + 1)
    item.attributes[`${prefix}.source_span_id`] = session.harness === 'codex'
      ? `tool:${call.id}` : `${key}:tool:${index}`
  }
}

/** The compatibility boundary between traces' session selection and the shared native reader. */
export class HarnessSessionsAdapter implements HarnessTraceAdapter {
  readonly harness: string
  readonly aliases: readonly string[]
  private readonly reader
  private readonly refs = new Map<string, NativeRef>()
  private readonly legacyOpencode: OpencodeAdapter | undefined
  private readonly scopedAdapter: ClaudeAdapter | CodexAdapter | undefined

  constructor(readonly nativeHarness: SupportedHarness, displayHarness?: string, aliases: readonly string[] = []) {
    this.reader = readerFor(nativeHarness)
    this.harness = displayHarness ?? nativeHarness
    this.aliases = aliases
    this.legacyOpencode = nativeHarness === 'opencode' ? new OpencodeAdapter() : undefined
    this.scopedAdapter = nativeHarness === 'claude-code' ? new ClaudeAdapter()
      : nativeHarness === 'codex' ? new CodexAdapter() : undefined
  }

  async locate(opts: LocateOptions = {}): Promise<SessionRef[]> {
    // Keep traces' established filesystem selection, including CODEX_HOME and
    // rollouts whose filename does not contain the metadata's session ID.
    if (this.scopedAdapter) return this.scopedAdapter.locate(opts)
    const found = await this.reader.locate(homedir(), { sinceMs: opts.sinceMs, cwd: opts.cwd })
    const refs = found.filter((native) => this.nativeHarness !== 'claude-code' || native.parentNativeSessionId === null).map((native) => {
      const ref = tracesRef(native, this.harness)
      this.refs.set(`${ref.sessionId}\0${ref.path}`, native)
      return ref
    })
    // OpenCode's earlier JSON store is a different native format from the
    // current SQLite store. Keep those historical sessions addressable.
    if (this.legacyOpencode) refs.push(...await this.legacyOpencode.locate(opts))
    return refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async locateBySessionId(sessionId: string, opts: LocateOptions = {}): Promise<SessionRef[]> {
    if (this.scopedAdapter instanceof CodexAdapter) {
      return this.scopedAdapter.locateBySessionId(sessionId, opts)
    }
    if (this.scopedAdapter instanceof ClaudeAdapter) {
      return (await this.scopedAdapter.locate(opts)).filter((ref) => ref.sessionId === sessionId)
    }
    const refs = await this.reader.locate(homedir(), { nativeSessionId: sessionId, sinceMs: opts.sinceMs, cwd: opts.cwd })
    const selected = refs.map((native) => {
      const ref = tracesRef(native, this.harness)
      this.refs.set(`${ref.sessionId}\0${ref.path}`, native)
      return ref
    })
    if (this.legacyOpencode) {
      selected.push(...(await this.legacyOpencode.locate(opts)).filter((ref) => ref.sessionId === sessionId))
    }
    return selected
  }

  async sourcePaths(ref: SessionRef): Promise<readonly string[]> {
    if (this.legacyOpencode && !ref.path.endsWith('.db')) return this.legacyOpencode.sourcePaths(ref)
    const paths = (await this.resolveNativeRef(ref))?.files ?? [ref.path]
    if (this.nativeHarness !== 'factory-droids') return paths
    const settings = ref.path.replace(/\.jsonl$/u, '.settings.json')
    if (paths.includes(settings)) return paths
    try {
      await stat(settings)
      return [...paths, settings]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return paths
      throw error
    }
  }

  private async resolveNativeRef(ref: SessionRef): Promise<NativeRef | undefined> {
    const key = `${ref.sessionId}\0${ref.path}`
    const cached = this.refs.get(key)
    if (cached) return cached
    if (this.scopedAdapter instanceof ClaudeAdapter) {
      const native = claudeCodeRefForFile(ref.path)
      let files: readonly string[]
      try {
        files = await this.scopedAdapter.sourcePaths(ref)
      } catch (error) {
        if (!stringTooLong(error)) throw error
        files = [ref.path]
      }
      const found = {
        ...native,
        // A retained capture's filename cannot establish native identity.
        // The shared fold replaces this sentinel only when records name one.
        nativeSessionId: ref.sessionId.startsWith('unattributed:') ? ref.sessionId : native.nativeSessionId,
        files: files.filter((path) => path.endsWith('.jsonl')),
      }
      this.refs.set(key, found)
      return found
    }
    return undefined
  }

  async parse(ref: SessionRef, options: ParseOptions = {}): Promise<OtlpSpan[]> {
    if (this.legacyOpencode && !ref.path.endsWith('.db')) return this.legacyOpencode.parse(ref, options)
    // Task-turn selection and source-byte citations are traces-specific views
    // that the normalized session schema does not yet carry. Preserve their
    // existing explicit path while ordinary session reads use the shared fold.
    if (this.scopedAdapter && (options.taskScope === 'latest' || options.taskScope === 'turn' || options.captureSources)) {
      return this.scopedAdapter.parse(ref, options)
    }
    if (this.scopedAdapter instanceof ClaudeAdapter && await isClaudeStreamJson(ref.path)) {
      return this.scopedAdapter.parse(ref, options)
    }
    options.signal?.throwIfAborted()
    let source = await this.resolveNativeRef(ref)
    if (!source && this.nativeHarness === 'opencode') {
      const matches = await opencodeSessionsInStore(ref.path, null, {
        ...(ref.sessionId.startsWith('ses_') ? { nativeSessionId: ref.sessionId } : {}),
      })
      if (matches.length !== 1) {
        throw new Error(`OpenCode store ${ref.path} contains ${matches.length} matching sessions; select one native session ID`)
      }
      source = matches[0]!
    }
    source ??= nativeRef(this.nativeHarness, ref)
    let session: HarnessSession
    try {
      session = await this.reader.read(source, {
        signal: options.signal,
        corruption: options.corruptionMode,
      })
    } catch (error) {
      // The 0.1.0 shared JSONL reader materializes each record as one string.
      // Preserve traces' bounded-row recovery for an over-limit Claude row.
      if (this.scopedAdapter instanceof ClaudeAdapter && stringTooLong(error)) {
        return this.scopedAdapter.parse(ref, options)
      }
      throw error
    }
    // A missing timestamp is not epoch work. Exclude it rather than allowing the
    // projection's display fallback to enter measured totals.
    if (!session.startedAt) return []
    const spans = toOtlpSpans(session).map(asTracesSpan)
    const root = spans[0]!
    root.attributes['service.name'] = this.harness
    root.attributes['traces.session.role'] = session.parentNativeSessionId ? 'child' : 'operator'
    if (session.parentNativeSessionId) root.attributes['traces.parent_session_id'] = session.parentNativeSessionId
    if (session.children.length > 0) {
      root.attributes['traces.child_session_ids'] = JSON.stringify(session.children.map((child) => child.nativeSessionId))
    }
    root.attributes['traces.session.corruption_count'] = session.integrity.unparsedRecords
    root.attributes['traces.session.integrity'] = session.integrity.unparsedRecords > 0
      || session.integrity.truncated || session.integrity.gaps.length > 0
      ? 'degraded_not_lossless' : 'complete'
    if (session.integrity.unparsedRecords > 0) {
      root.attributes['traces.source.unreadable_rows'] = session.integrity.unparsedRecords
    }
    // The session-total counter is distinct from a sum of individual calls.
    if ((session.harness === 'codex' || session.harness === 'factory-droids')
      && session.usage?.input != null && session.usage.output != null) {
      root.attributes['traces.session.total_tokens'] = session.usage.input + session.usage.output
        + (session.usage.cacheRead ?? 0) + (session.usage.cacheWrite ?? 0)
      root.attributes['traces.session.total_input_tokens'] = session.usage.input
      root.attributes['traces.session.total_output_tokens'] = session.usage.output
      root.attributes['traces.session.total_tokens_source'] = '@tangle-network/harness-sessions'
    }
    spans.push(...presentationSpans(session, root))
    if (session.harness === 'codex') {
      decorateCodexTools(session, spans)
      await decorateCodexMetadata(ref.path, session, root, spans)
    }
    stampNativeProvenance(session, spans)
    spans.push(...lifecycleSpans(session, root, spans))
    if (session.harness === 'claude-code' && source.parentNativeSessionId === null) {
      const childPaths = source.files.filter((path) => path !== source.path && path.endsWith('.jsonl'))
      const toolByCallId = new Map(spans
        .filter((item) => item.attributes['openinference.span.kind'] === 'TOOL')
        .map((item) => [item.attributes['gen_ai.tool.call.id'], item]))
      let childSpanCount = 0
      const childIds = new Set(session.children.map((child) => child.nativeSessionId))
      for (const path of childPaths) {
        const childRef = claudeCodeRefForFile(path, session.nativeSessionId)
        const child = await this.reader.read(childRef, { signal: options.signal, corruption: options.corruptionMode })
        childIds.add(child.nativeSessionId)
        if (!child.startedAt) continue
        const binding = session.children.find((item) => item.nativeSessionId === child.nativeSessionId)
        const parent = binding?.toolCallId ? toolByCallId.get(binding.toolCallId) : undefined
        const projected = toOtlpSpans(child).map(asTracesSpan)
        stampNativeProvenance(child, projected)
        projected[0]!.parent_span_id = parent?.span_id ?? root.span_id
        for (const item of [...projected, ...presentationSpans(child, projected[0]!)]) {
          item.trace_id = root.trace_id
          item.attributes['traces.span.subagent'] = true
          item.attributes['service.name'] = this.harness
          spans.push(item)
          childSpanCount += 1
        }
      }
      if (childIds.size > 0) root.attributes['traces.child_session_ids'] = JSON.stringify([...childIds])
      if (childSpanCount > 0) root.attributes['traces.session.subagent_span_count'] = childSpanCount
    }
    if (session.harness === 'claude-code') {
      const traceId = deriveHexId(session.nativeSessionId, 16)
      for (const item of spans) item.trace_id = traceId
    }
    for (const item of spans) item.attributes['service.name'] ??= this.harness
    return spans
  }

  async resolveParentTask(ref: SessionRef, childSessionId: string, options?: Pick<ParseOptions, 'corruptionMode' | 'signal'>): Promise<ParentTaskResolution> {
    if (this.scopedAdapter instanceof CodexAdapter) {
      return this.scopedAdapter.resolveParentTask(ref, childSessionId, options)
    }
    return { kind: 'unavailable', reason: 'parent-turn-metadata-missing' }
  }

  async locateSpawnedChildren(parentSessionId: string, agentPaths: readonly string[], options?: LocateOptions & Pick<ParseOptions, 'corruptionMode' | 'signal'>): Promise<readonly SpawnedChildResolution[]> {
    if (this.scopedAdapter instanceof CodexAdapter) {
      return this.scopedAdapter.locateSpawnedChildren(parentSessionId, agentPaths, options)
    }
    return agentPaths.map((agentPath) => ({ agentPath, reason: 'not-found' }))
  }
}

export const SHARED_SESSION_ADAPTERS: readonly HarnessTraceAdapter[] = [
  new HarnessSessionsAdapter('claude-code', 'claude-code', ['claude', 'claudish', 'openclaw', 'nanoclaw']),
  new HarnessSessionsAdapter('codex', 'codex', ['codex-acp']),
  new HarnessSessionsAdapter('opencode'),
  new HarnessSessionsAdapter('pi'),
  new HarnessSessionsAdapter('kimi-code', 'kimi', ['kimi-code']),
  new HarnessSessionsAdapter('factory-droids', 'factory', ['factory-droids', 'droid']),
]
