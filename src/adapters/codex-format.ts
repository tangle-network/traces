export interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

export interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    id?: string
    session_id?: string
    cwd?: string
    timestamp?: string
    cli_version?: string
    model?: string
    role?: string
    name?: string
    content?: unknown
    arguments?: unknown
    input?: unknown
    call_id?: string
    output?: unknown
    is_error?: boolean
    isError?: boolean
    error?: unknown
    event_id?: string
    turn_id?: string
    occurred_at_ms?: number
    started_at?: number
    started_at_ms?: number
    completed_at_ms?: number
    agent_thread_id?: string
    agent_path?: string
    kind?: string
    parent_thread_id?: string
    thread_source?: string
    agent_nickname?: string
    agent_role?: string
    author?: string
    recipient?: string
    namespace?: string
    /** `user_message` event text, and the summary on a `compacted` record. */
    message?: unknown
    /**
     * Conversation history a `compacted` record retained, in response-item
     * shape. Codex writes the pre-compaction turns here and nowhere else, so
     * this is the only surviving copy of what the human typed before the
     * context was replaced.
     */
    replacement_history?: ReadonlyArray<{
      type?: string
      id?: string
      role?: string
      content?: unknown
      internal_chat_message_metadata_passthrough?: {
        content_item_kinds?: readonly unknown[]
      }
    }>
    window_id?: string
    previous_window_id?: string
    first_window_id?: string
    window_number?: number
    item?: {
      type?: string
      id?: string
      kind?: string
      agent_thread_id?: string
      agent_path?: string
      occurred_at_ms?: number
      started_at_ms?: number
      completed_at_ms?: number
    }
    internal_chat_message_metadata_passthrough?: {
      turn_id?: string
      /** What each content item of a user-role message is: `user.text` for the
       *  person's own words, a namespaced kind for anything the harness added. */
      content_item_kinds?: readonly unknown[]
    }
    source?: {
      subagent?: {
        thread_spawn?: {
          parent_thread_id?: string
          depth?: number
          agent_path?: string | null
          agent_nickname?: string
          agent_role?: string
        }
      }
    }
    info?: {
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
      model_context_window?: number
    }
  }
}

/** Stable fields shared by the legacy and current nested subagent events. */
export interface CodexSubagentActivity {
  readonly eventId?: string
  readonly kind?: string
  readonly agentThreadId?: string
  readonly agentPath?: string
  readonly occurredAtMs?: number
  readonly turnId?: string
}

/** Normalize Codex's legacy flat and current item-wrapped subagent events. */
export function codexSubagentActivity(line: CodexLine): CodexSubagentActivity | undefined {
  if (line.type !== 'event_msg' || !line.payload) return undefined
  const payload = line.payload
  const turnId = payload.turn_id
    ?? payload.internal_chat_message_metadata_passthrough?.turn_id
  if (payload.type === 'sub_agent_activity') {
    return {
      eventId: payload.event_id,
      kind: payload.kind,
      agentThreadId: payload.agent_thread_id,
      agentPath: payload.agent_path,
      occurredAtMs: payload.occurred_at_ms,
      turnId,
    }
  }
  if (payload.type !== 'item_completed' || payload.item?.type !== 'SubAgentActivity') {
    return undefined
  }
  const item = payload.item
  return {
    eventId: item.id,
    kind: item.kind,
    agentThreadId: item.agent_thread_id,
    agentPath: item.agent_path,
    occurredAtMs: item.completed_at_ms
      ?? item.occurred_at_ms
      ?? item.started_at_ms
      ?? payload.completed_at_ms
      ?? payload.started_at_ms
      ?? payload.occurred_at_ms,
    turnId,
  }
}

/** A command Codex ran, from an `item_completed` event whose item is `CommandExecution`. */
export interface CodexCommandExecution {
  readonly itemId: string
  /** Recorded argv (current builds) or command string, verbatim. */
  readonly command: readonly string[] | string
  readonly cwd?: string
  readonly processId?: string
  readonly source?: string
  readonly status?: string
  readonly exitCode?: number
  readonly output?: string | { readonly stdout?: string; readonly stderr?: string }
  readonly outputFields: readonly string[]
  readonly startedAtMs?: number
  readonly completedAtMs?: number
}

export interface CodexFileChangeEntry {
  readonly path: string
  /** Codex's change type (`add`, `delete`, `update`), verbatim. */
  readonly kind: string
  readonly movePath?: string
}

/** Files a patch changed, from an `item_completed` event whose item is `FileChange`. */
export interface CodexFileChange {
  readonly itemId: string
  readonly changes: readonly CodexFileChangeEntry[]
  readonly status?: string
  readonly startedAtMs?: number
  readonly completedAtMs?: number
}

/** A turn a client submitted, from an `item_completed` event whose item is `UserMessage`. */
export interface CodexUserMessage {
  readonly itemId: string
  readonly text: string
}

/**
 * One `item_completed` event, normalized.
 *
 * `skipped` separates the two reasons an item produces no span, because they
 * carry opposite meanings for a reader counting facts:
 *
 * - `unmodeled` — the adapter builds no span from this item type. The rollout
 *   records the same work as a `response_item` (reasoning, assistant messages,
 *   tool calls), and that record is what becomes a span, so the count is a
 *   census of item types, not missing facts.
 * - `dropped` — an item of a modeled type produced no span: a required field
 *   was missing or mistyped, the item repeats one already recorded, or a user
 *   message carried no text. This count is the one that reads as lost facts.
 */
export type CodexCompletedItem =
  | { readonly type: 'CommandExecution'; readonly item: object; readonly command: CodexCommandExecution }
  | { readonly type: 'FileChange'; readonly item: object; readonly fileChange: CodexFileChange }
  | { readonly type: 'UserMessage'; readonly item: object; readonly userMessage: CodexUserMessage }
  | { readonly type: 'skipped'; readonly reason: 'unmodeled' | 'dropped'; readonly label: string }

type JsonRecord = Record<string, unknown>

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Codex defaults a missing `completed_at_ms` to 0, so only a positive time is a recorded time. */
function epochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function commandValue(value: unknown): readonly string[] | string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.every((part) => typeof part === 'string') ? value as string[] : undefined
}

function commandOutput(item: JsonRecord): Pick<CodexCommandExecution, 'output' | 'outputFields'> {
  if (typeof item.aggregated_output === 'string') {
    return { output: item.aggregated_output, outputFields: ['aggregated_output'] }
  }
  const stdout = typeof item.stdout === 'string' ? item.stdout : undefined
  const stderr = typeof item.stderr === 'string' ? item.stderr : undefined
  if (stdout === undefined && stderr === undefined) return { outputFields: [] }
  return {
    output: { ...(stdout === undefined ? {} : { stdout }), ...(stderr === undefined ? {} : { stderr }) },
    outputFields: [...(stdout === undefined ? [] : ['stdout']), ...(stderr === undefined ? [] : ['stderr'])],
  }
}

/** The rollout records a map keyed by path; `codex exec --json` records an array of `{path, kind}`. */
function fileChangeEntries(value: unknown): CodexFileChangeEntry[] | undefined {
  const entries: CodexFileChangeEntry[] = []
  if (Array.isArray(value)) {
    for (const raw of value) {
      const change = recordValue(raw)
      const path = nonEmptyString(change?.path)
      const kind = nonEmptyString(change?.kind) ?? nonEmptyString(change?.type)
      if (!path || !kind) return undefined
      const movePath = nonEmptyString(change?.move_path)
      entries.push({ path, kind, ...(movePath ? { movePath } : {}) })
    }
  } else {
    const changes = recordValue(value)
    if (!changes) return undefined
    for (const [path, raw] of Object.entries(changes)) {
      const change = recordValue(raw)
      const kind = nonEmptyString(change?.type) ?? nonEmptyString(change?.kind)
      if (path.length === 0 || !kind) return undefined
      const movePath = nonEmptyString(change?.move_path)
      entries.push({ path, kind, ...(movePath ? { movePath } : {}) })
    }
  }
  if (entries.length === 0) return undefined
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/** The text a `UserMessage` item carries; other input parts (images, audio) have no text. */
function userMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const entry = recordValue(part)
      return entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : ''
    })
    .join('')
}

/**
 * Normalize Codex's `item_completed` event for the command, file-change and
 * user-message items.
 *
 * Field names follow `CommandExecutionItem`, `FileChangeItem`, `UserMessageItem`
 * and `ItemCompletedEvent` in openai/codex `codex-rs/protocol`. The format drifts,
 * so a required field that is missing or mistyped yields a counted `skipped`
 * label rather than a span built from guessed values.
 */
export function codexCompletedItem(line: CodexLine): CodexCompletedItem | undefined {
  if (line.type !== 'event_msg' || line.payload?.type !== 'item_completed') return undefined
  const payload = line.payload as JsonRecord
  const item = recordValue(payload.item)
  const type = nonEmptyString(item?.type) ?? 'unknown'
  if (!item || (type !== 'CommandExecution' && type !== 'FileChange' && type !== 'UserMessage')) {
    return { type: 'skipped', reason: 'unmodeled', label: type }
  }
  const itemId = nonEmptyString(item.id)
  if (type === 'UserMessage') {
    const text = userMessageText(item.content)
    // An image-only or audio-only turn carries no text to record as a turn span.
    if (!itemId || !text) return { type: 'skipped', reason: 'dropped', label: `${type}:${itemId ? 'no_text' : 'malformed'}` }
    return { type, item, userMessage: { itemId, text } }
  }
  const startedAtMs = epochMs(payload.started_at_ms) ?? epochMs(item.started_at_ms)
  const completedAtMs = epochMs(payload.completed_at_ms) ?? epochMs(item.completed_at_ms)
  const status = nonEmptyString(item.status)
  const times = {
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  }
  if (type === 'FileChange') {
    const changes = fileChangeEntries(item.changes)
    if (!itemId || !changes) return { type: 'skipped', reason: 'dropped', label: `${type}:malformed` }
    return { type, item, fileChange: { itemId, changes, ...(status ? { status } : {}), ...times } }
  }
  const command = commandValue(item.command)
  if (!itemId || !command) return { type: 'skipped', reason: 'dropped', label: `${type}:malformed` }
  const cwd = nonEmptyString(item.cwd)
  const processId = typeof item.process_id === 'number' && Number.isSafeInteger(item.process_id)
    ? String(item.process_id)
    : nonEmptyString(item.process_id)
  const source = nonEmptyString(item.source)
  const exitCode = typeof item.exit_code === 'number' && Number.isSafeInteger(item.exit_code) ? item.exit_code : undefined
  return {
    type,
    item,
    command: {
      itemId,
      command,
      ...(cwd ? { cwd } : {}),
      ...(processId ? { processId } : {}),
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...commandOutput(item),
      ...times,
    },
  }
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => (
        item && typeof item === 'object' && 'text' in item
          ? String((item as { text?: unknown }).text ?? '')
          : ''
      ))
      .join('')
  }
  return ''
}

/** Each text block of a message, unjoined, so a per-block classifier sees block boundaries. */
export function contentTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => (
    item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
      ? [(item as { text: string }).text]
      : []
  ))
}

export function timestampFromEpochMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

export function latestTimestamp(
  current: string | undefined,
  candidate: unknown,
): string | undefined {
  const validCandidate = validTimestamp(candidate)
  if (!validCandidate) return current
  if (!current || Date.parse(validCandidate) > Date.parse(current)) return validCandidate
  return current
}

const CODEX_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function structuredValue(value: unknown, depth = 3): unknown {
  if (depth < 0) return undefined
  if (typeof value === 'string') {
    try {
      return structuredValue(JSON.parse(value) as unknown, depth - 1)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    const text = contentToString(value)
    if (text) {
      const parsed = structuredValue(text, depth - 1)
      if (parsed !== undefined) return parsed
    }
    return value
  }
  return value
}

function sessionIdValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && CODEX_SESSION_ID.test(candidate),
  )
}

const TARGET_FIELDS_BY_OPERATION: Readonly<Record<string, readonly string[]>> = {
  close_agent: ['target'],
  followup_task: ['target', 'recipient', 'agent_id', 'agentId', 'session_id', 'sessionId'],
  interrupt_agent: ['target', 'agent_id', 'agentId'],
  resume_agent: ['id'],
  send_input: ['target'],
  send_message: ['target', 'recipient', 'recipients'],
  wait_agent: ['targets'],
}

function sourceTargetSessionIds(fields: readonly string[], value: unknown): string[] {
  const source = contentToString(value)
  if (!source) return []
  const ids = new Set<string>()
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const scalar = new RegExp(
      `\\b${escaped}\\s*:\\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']`,
      'gi',
    )
    for (const match of source.matchAll(scalar)) ids.add(match[1]!)
    const array = new RegExp(`\\b${escaped}\\s*:\\s*\\[([^\\]]*)\\]`, 'gi')
    for (const match of source.matchAll(array)) {
      const values = match[1] ?? ''
      for (
        const idMatch of values.matchAll(
          /["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/gi,
        )
      ) {
        ids.add(idMatch[1]!)
      }
    }
  }
  return [...ids]
}

/** Extract stable agent IDs only from fields defined as targets by that operation. */
export function targetedSessionIds(operation: string, input: unknown): string[] {
  const fields = TARGET_FIELDS_BY_OPERATION[operation] ?? []
  const parsed = structuredValue(input)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    return [...new Set(fields.flatMap((field) => sessionIdValues(record[field])))]
  }
  return sourceTargetSessionIds(fields, input)
}

function collectSpawnedSessionIds(value: unknown, depth: number, ids: Set<string>): void {
  if (depth < 0) return
  const parsed = structuredValue(value)
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectSpawnedSessionIds(item, depth - 1, ids)
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  for (const [key, child] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'agent_id' || key === 'agentId') {
      for (const id of sessionIdValues(child)) ids.add(id)
      continue
    }
    collectSpawnedSessionIds(child, depth - 1, ids)
  }
}

export function spawnedSessionIds(output: unknown): string[] {
  const ids = new Set<string>()
  collectSpawnedSessionIds(output, 4, ids)
  return [...ids]
}

const DIRECT_AGENT_OPERATIONS = new Set([
  'spawn_agent',
  'close_agent',
  'resume_agent',
  'send_message',
  'send_input',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
])

export function multiAgentOperation(name: string): string | null {
  const prefix = 'multi_agent_v1__'
  if (name.startsWith(prefix)) return name.slice(prefix.length)
  return DIRECT_AGENT_OPERATIONS.has(name) ? name : null
}
