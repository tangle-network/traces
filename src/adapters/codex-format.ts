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
