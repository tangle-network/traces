/**
 * Skill usage across coding-agent session stores: deterministic, incremental, no model call.
 *
 * `analyze` parses whole sessions into spans. That costs seconds per few dozen
 * sessions and stops on one malformed transcript, while skill usage is a
 * question over every session on the machine (tens of gigabytes). This module
 * reads raw session bytes, parses only the lines that carry a skill record, and
 * keeps a byte cursor per file. A refresh reads only bytes appended since the
 * previous refresh; a query reads the stored events, never the transcripts.
 *
 * What counts:
 * - Claude Code `model`: a Skill tool result that loaded a skill. A main session records
 *   `toolUseResult.commandName`; subagent and workflow transcripts carry only the result
 *   text (`Launching skill: <name>`, or `Skill "<name>" launched (forked execution…`).
 * - Claude Code `slash`: a user `/name` command whose next record is its expanded
 *   prompt (`isMeta`). Built-in commands such as /clear expand to nothing and are skipped.
 * - Codex `read`: a completed shell command that reads `<skill>/SKILL.md`. Codex has
 *   no dedicated skill event, so reading the document is the closest observable act;
 *   a read is not evidence that the skill shaped the outcome. One command that reads
 *   several skills at once is a catalog sweep (an audit or a survey), counted apart.
 * - Kimi Code `read`: a successful ReadFile call or shell command that reads a skill
 *   document. Kimi streams tool arguments, so a call is counted after its result.
 *
 * Each event is keyed by its record ID, so a resumed session that copies earlier
 * records, or a file reread after truncation, never counts an event twice. The
 * store keeps events after a harness deletes old transcripts.
 */

import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { STORES } from '@tangle-network/harness-sessions/catalog'

export type SkillUsageHarness = 'claude-code' | 'codex' | 'kimi-code'
export type SkillUsageKind = 'model' | 'slash' | 'read'

export interface SkillUsageEvent {
  harness: SkillUsageHarness
  kind: SkillUsageKind
  skill: string
  /** Directory holding the skill folder, when the record names it. */
  root: string | null
  /** Record timestamp; null when the record carries none. */
  ts: string | null
  session: string
  /** Record identity that keeps each event counted once. */
  id: string
}

export interface SkillUsageSources {
  /** Claude Code projects directory (`~/.claude/projects`). */
  claudeProjects: string
  /** Codex session directories (`~/.codex/sessions`, `~/.codex/archived_sessions`). */
  codexSessions: readonly string[]
  /** Kimi session directory (`~/.kimi/sessions`); only wire.jsonl is scanned. */
  kimiSessions?: string
}

export interface SkillUsageRefresh {
  harness: SkillUsageHarness
  files: number
  filesRead: number
  bytesRead: number
  eventsAdded: number
}

interface PendingSlash {
  uuid: string
  skill: string
  ts: string | null
  session: string
  /** Lines already inspected for the expansion record. */
  seen: number
}

interface FileCursor {
  ino: number
  size: number
  /** Byte offset just past the last complete line read. */
  offset: number
  pending?: PendingSlash[]
  kimiCalls?: Record<string, { name: string; args: string; ts: string | null }>
  kimiLastCall?: string
}

type StoredEvent = [SkillUsageHarness, SkillUsageKind, string, string | null, string | null, string, string]

interface StoreV1 {
  version: 1
  files: Record<string, FileCursor>
  events: StoredEvent[]
}

const CHUNK_BYTES = 8 * 1024 * 1024
const NEWLINE = 0x0a
/** A slash command's expansion is its next record; attachments can sit between. */
const SLASH_LOOKAHEAD_LINES = 8
const MAX_PENDING = 16
const READ_CONCURRENCY = 8

const CLAUDE_NEEDLES = [
  '"commandName":"',
  'Launching skill: ',
  ' (forked execution',
  '<command-name>',
  'Base directory for this skill: ',
].map((n) => Buffer.from(n))
const SKILL_RESULT_TEXT = /^(?:Launching skill: (\S+)|Skill "([^"]+)" (?:launched|completed) \(forked execution)/
const CODEX_NEEDLE = Buffer.from('SKILL.md')
const KIMI_NEEDLES = ['"type": "ToolCall"', '"type":"ToolCall"', '"type": "ToolCallPart"', '"type":"ToolCallPart"', '"type": "ToolResult"', '"type":"ToolResult"'].map((n) => Buffer.from(n))
const BASE_DIRECTORY = 'Base directory for this skill: '
const SLASH_COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/
const SKILL_READ_VERB = /(?:^|[\s;&|(`'"])(?:cat|sed|head|tail|less|more|awk|nl|bat)\s/
const SKILL_DOCUMENT = /(?:^|[\s'"=:(`])((?:[^\s'"`;|&()]*\/)?([A-Za-z0-9][A-Za-z0-9._-]*))\/SKILL\.md\b/g
const SESSION_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export function defaultSkillUsageSources(): SkillUsageSources {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  return {
    claudeProjects: join(homedir(), STORES['claude-code.projects-jsonl'].root),
    codexSessions: [join(codexHome, ...STORES['codex.rollout-jsonl'].root.split('/').slice(1)), join(codexHome, 'archived_sessions')],
    kimiSessions: join(homedir(), STORES['kimi.session-dir'].root),
  }
}

export function defaultSkillUsageStorePath(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(state, 'traces', 'skill-usage.json')
}

function eventKey(e: { harness: string; id: string }): string {
  return `${e.harness}\u0000${e.id}`
}

/** The stored events and per-file cursors. Load, refresh, then query. */
export class SkillUsageStore {
  private readonly events = new Map<string, SkillUsageEvent>()
  private files: Record<string, FileCursor> = {}

  private constructor(readonly path: string) {}

  static async load(path: string): Promise<SkillUsageStore> {
    const store = new SkillUsageStore(path)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store
      throw error
    }
    const parsed = JSON.parse(raw) as Partial<StoreV1>
    if (parsed.version !== 1 || !Array.isArray(parsed.events) || typeof parsed.files !== 'object') {
      throw new Error(`skill usage store ${path} has an unknown format; move it aside to rebuild from transcripts`)
    }
    store.files = parsed.files ?? {}
    for (const [harness, kind, skill, root, ts, session, id] of parsed.events) {
      store.add({ harness, kind, skill, root, ts, session, id })
    }
    return store
  }

  get size(): number {
    return this.events.size
  }

  list(): SkillUsageEvent[] {
    return [...this.events.values()]
  }

  private add(event: SkillUsageEvent): boolean {
    const key = eventKey(event)
    if (this.events.has(key)) return false
    this.events.set(key, event)
    return true
  }

  private setRoot(harness: SkillUsageHarness, id: string, root: string): void {
    const event = this.events.get(eventKey({ harness, id }))
    if (event && event.root === null) event.root = root
  }

  async save(): Promise<void> {
    const body: StoreV1 = {
      version: 1,
      files: this.files,
      events: this.list().map((e) => [e.harness, e.kind, e.skill, e.root, e.ts, e.session, e.id]),
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(body))
    await rename(temporary, this.path)
  }

  /** Read bytes appended since the previous refresh. Cost is proportional to new bytes. */
  async refresh(sources: SkillUsageSources = defaultSkillUsageSources()): Promise<SkillUsageRefresh[]> {
    const claude = await this.refreshHarness('claude-code', await jsonlFiles([sources.claudeProjects]))
    const codex = await this.refreshHarness('codex', await jsonlFiles(sources.codexSessions))
    const kimi = await this.refreshHarness('kimi-code', await jsonlFiles(sources.kimiSessions ? [sources.kimiSessions] : [], 'wire.jsonl'))
    return [claude, codex, kimi]
  }

  private async refreshHarness(harness: SkillUsageHarness, paths: string[]): Promise<SkillUsageRefresh> {
    const summary: SkillUsageRefresh = { harness, files: paths.length, filesRead: 0, bytesRead: 0, eventsAdded: 0 }
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const path = paths[next++]!
        const read = await this.refreshFile(harness, path)
        if (read === null) continue
        summary.filesRead += 1
        summary.bytesRead += read.bytes
        summary.eventsAdded += read.events
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
    return summary
  }

  private async refreshFile(harness: SkillUsageHarness, path: string): Promise<{ bytes: number; events: number } | null> {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const previous = this.files[path]
    if (previous && previous.ino === info.ino && previous.size === info.size) return null
    // A replaced or truncated file is read again from the start; record IDs keep the count exact.
    const cursor: FileCursor = previous && previous.ino === info.ino && previous.offset <= info.size
      ? { ...previous }
      : { ino: info.ino, size: 0, offset: 0 }
    const session = sessionFromPath(path)
    let events = 0
    let bytes = 0
    const handle = await open(path, 'r')
    try {
      let carry = Buffer.alloc(0)
      let position = cursor.offset
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(0, info.size - position)))
      while (position < info.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position)
        if (bytesRead === 0) break
        position += bytesRead
        bytes += bytesRead
        const buffer = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        const end = buffer.lastIndexOf(NEWLINE) + 1
        if (end > 0) {
          const complete = buffer.subarray(0, end)
          events += harness === 'claude-code'
            ? this.scanClaude(complete, cursor, session)
            : harness === 'codex'
              ? this.scanCodex(complete, session)
              : this.scanKimi(complete, cursor, kimiSessionFromPath(path))
          cursor.offset += end
        }
        carry = Buffer.from(buffer.subarray(end))
      }
    } finally {
      await handle.close()
    }
    cursor.ino = info.ino
    cursor.size = info.size
    if (cursor.pending?.length === 0) delete cursor.pending
    this.files[path] = cursor
    return { bytes, events }
  }

  private scanClaude(buffer: Buffer, cursor: FileCursor, fileSession: string): number {
    let added = 0
    const pending = cursor.pending ?? []
    cursor.pending = []
    const lines = new LineIndex(buffer)
    // Expansions for commands that ended the previous read are among this read's first lines.
    for (const command of pending) {
      const outcome = this.resolveSlash(buffer, lines, 0, command)
      if (outcome === 'confirmed') added += 1
      else if (outcome === 'pending') cursor.pending.push(command)
    }
    for (const start of hitLineStarts(buffer, CLAUDE_NEEDLES)) {
      const end = lines.endOf(start)
      const record = parseLine(buffer, start, end)
      if (!record || record.type !== 'user') continue
      const session = typeof record.sessionId === 'string' ? record.sessionId : fileSession
      const ts = typeof record.timestamp === 'string' ? record.timestamp : null
      const loaded = loadedSkill(record)
      if (loaded) {
        if (this.add({ harness: 'claude-code', kind: 'model', skill: skillName(loaded.skill), root: null, ts, session, id: loaded.id })) added += 1
        continue
      }
      const text = messageText(record)
      if (record.isMeta === true && text.startsWith(BASE_DIRECTORY)) {
        if (typeof record.sourceToolUseID === 'string') {
          this.setRoot('claude-code', record.sourceToolUseID, rootOf(text))
        }
        continue
      }
      const content = (record.message as Record<string, unknown> | undefined)?.content
      if (typeof content !== 'string' || !content.startsWith('<command-')) continue
      const name = SLASH_COMMAND.exec(content)?.[1]
      if (!name || typeof record.uuid !== 'string') continue
      const command: PendingSlash = { uuid: record.uuid, skill: skillName(name), ts, session, seen: 0 }
      const outcome = this.resolveSlash(buffer, lines, end + 1, command)
      if (outcome === 'confirmed') added += 1
      else if (outcome === 'pending' && cursor.pending.length < MAX_PENDING) cursor.pending.push(command)
    }
    return added
  }

  /** Confirm a slash command by its expansion: the first later record whose parent it is. */
  private resolveSlash(buffer: Buffer, lines: LineIndex, from: number, command: PendingSlash): 'confirmed' | 'rejected' | 'pending' {
    const at = buffer.indexOf(`"parentUuid":"${command.uuid}"`, from)
    let start = from
    while (command.seen < SLASH_LOOKAHEAD_LINES) {
      if (start >= buffer.length) return 'pending'
      const end = lines.endOf(start)
      command.seen += 1
      if (at !== -1 && at >= start && at < end) {
        const record = parseLine(buffer, start, end)
        const text = record ? messageText(record) : ''
        if (!record || record.type !== 'user' || record.isMeta !== true || text.length === 0) return 'rejected'
        const added = this.add({
          harness: 'claude-code',
          kind: 'slash',
          skill: command.skill,
          root: text.startsWith(BASE_DIRECTORY) ? rootOf(text) : null,
          ts: command.ts,
          session: command.session,
          id: command.uuid,
        })
        return added ? 'confirmed' : 'rejected'
      }
      start = end + 1
    }
    return 'rejected'
  }

  private scanCodex(buffer: Buffer, fileSession: string): number {
    let added = 0
    const lines = new LineIndex(buffer)
    for (const start of hitLineStarts(buffer, [CODEX_NEEDLE])) {
      const record = parseLine(buffer, start, lines.endOf(start))
      const payload = record?.payload as Record<string, unknown> | undefined
      const item = payload?.item as Record<string, unknown> | undefined
      if (payload?.type !== 'item_completed' || item?.type !== 'CommandExecution' || typeof item.id !== 'string') continue
      const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '')
      if (!command.includes('SKILL.md') || !SKILL_READ_VERB.test(command)) continue
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : String(item.stdout ?? '')
      const ts = typeof record?.timestamp === 'string' ? record.timestamp : null
      for (const match of command.matchAll(SKILL_DOCUMENT)) {
        const directory = match[1]!
        if (output.includes(`${directory}/SKILL.md: No such file`)) continue
        const slash = directory.lastIndexOf('/')
        const event: SkillUsageEvent = {
          harness: 'codex',
          kind: 'read',
          skill: match[2]!,
          root: slash > 0 ? directory.slice(0, slash) : null,
          ts,
          session: fileSession,
          id: `${item.id}#${directory}`,
        }
        if (this.add(event)) added += 1
      }
    }
    return added
  }

  private scanKimi(buffer: Buffer, cursor: FileCursor, session: string): number {
    let added = 0
    const calls = cursor.kimiCalls ?? {}
    const lines = new LineIndex(buffer)
    for (const start of hitLineStarts(buffer, KIMI_NEEDLES)) {
      const record = parseLine(buffer, start, lines.endOf(start))
      const message = record?.message as Record<string, unknown> | undefined
      const payload = message?.payload as Record<string, unknown> | undefined
      if (!payload) continue
      if (message?.type === 'ToolCall') {
        const fn = payload.function as Record<string, unknown> | undefined
        const id = payload.id
        cursor.kimiLastCall = typeof id === 'string' ? id : undefined
        if (typeof id === 'string' && (fn?.name === 'ReadFile' || fn?.name === 'Shell')) {
          calls[id] = { name: fn.name, args: typeof fn.arguments === 'string' ? fn.arguments : '', ts: kimiTimestamp(record?.timestamp) }
        }
      } else if (message?.type === 'ToolCallPart') {
        const call = cursor.kimiLastCall ? calls[cursor.kimiLastCall] : undefined
        if (call && typeof payload.arguments_part === 'string') call.args += payload.arguments_part
      } else if (message?.type === 'ToolResult' && typeof payload.tool_call_id === 'string') {
        const id = payload.tool_call_id
        const call = calls[id]
        delete calls[id]
        if (!call) continue
        const result = payload.return_value as Record<string, unknown> | undefined
        if (result?.is_error !== false) continue
        let args: Record<string, unknown>
        try { args = JSON.parse(call.args) as Record<string, unknown> } catch { continue }
        const paths = call.name === 'ReadFile' && typeof args.path === 'string'
          ? [args.path]
          : call.name === 'Shell' && typeof args.command === 'string' && SKILL_READ_VERB.test(args.command)
            ? [...args.command.matchAll(SKILL_DOCUMENT)].map((match) => `${match[1]}/SKILL.md`)
            : []
        for (const path of paths) {
          const match = SKILL_DOCUMENT.exec(path)
          SKILL_DOCUMENT.lastIndex = 0
          if (!match || !path.endsWith('/SKILL.md')) continue
          const directory = match[1]!
          const slash = directory.lastIndexOf('/')
          if (typeof result.output === 'string' && result.output.includes(`${directory}/SKILL.md: No such file`)) continue
          if (this.add({ harness: 'kimi-code', kind: 'read', skill: match[2]!, root: slash > 0 ? directory.slice(0, slash) : null,
            ts: call.ts, session, id: `${session}:${id}#${directory}` })) added += 1
        }
      }
    }
    cursor.kimiCalls = calls
    return added
  }
}

/** Line boundaries in a buffer of complete lines, found on demand. */
class LineIndex {
  constructor(private readonly buffer: Buffer) {}

  endOf(start: number): number {
    const end = this.buffer.indexOf(NEWLINE, start)
    return end === -1 ? this.buffer.length : end
  }
}

/** Start offsets of lines containing any needle, ascending and unique. */
function hitLineStarts(buffer: Buffer, needles: readonly Buffer[]): number[] {
  const starts = new Set<number>()
  for (const needle of needles) {
    let at = buffer.indexOf(needle)
    while (at !== -1) {
      const start = buffer.lastIndexOf(NEWLINE, at) + 1
      starts.add(start)
      const end = buffer.indexOf(NEWLINE, at)
      if (end === -1) break
      at = buffer.indexOf(needle, end + 1)
    }
  }
  return [...starts].sort((a, b) => a - b)
}

function parseLine(buffer: Buffer, start: number, end: number): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8', start, end))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    // A malformed line is not a skill record; the rest of the file still counts.
    return null
  }
}

function messageText(record: Record<string, unknown>): string {
  const content = (record.message as Record<string, unknown> | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const first = content[0] as Record<string, unknown> | undefined
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : ''
}

/** The skill a Skill tool result loaded, keyed by its tool_use ID; null for any other record. */
function loadedSkill(record: Record<string, unknown>): { skill: string; id: string } | null {
  const content = (record.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(content)) return null
  const result = record.toolUseResult as Record<string, unknown> | undefined
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string' || part.is_error === true) continue
    if (result?.success === true && typeof result.commandName === 'string') return { skill: result.commandName, id: part.tool_use_id }
    const text = typeof part.content === 'string'
      ? part.content
      : Array.isArray(part.content) ? String((part.content[0] as Record<string, unknown> | undefined)?.text ?? '') : ''
    const match = SKILL_RESULT_TEXT.exec(text)
    if (match) return { skill: (match[1] ?? match[2])!, id: part.tool_use_id }
  }
  return null
}

function skillName(value: string): string {
  return value.replace(/^\//, '')
}

function rootOf(baseDirectoryText: string): string {
  const directory = baseDirectoryText.slice(BASE_DIRECTORY.length).split('\n', 1)[0]!.trim()
  return dirname(directory)
}

function sessionFromPath(path: string): string {
  return SESSION_UUID.exec(path)?.[1] ?? path
}

function kimiSessionFromPath(path: string): string {
  const match = /\/([0-9a-f-]{36})(?:\/subagents\/([^/]+))?\/wire\.jsonl$/.exec(path)
  return match ? `${match[1]}${match[2] ? `:${match[2]}` : ''}` : path
}

function kimiTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

async function jsonlFiles(roots: readonly string[], name?: string): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (entry.isFile() && (name ? entry.name === name : entry.name.endsWith('.jsonl'))) files.push(join(entry.parentPath, entry.name))
    }
  }
  return files.sort()
}

// ── Installed catalog ───────────────────────────────────────────────

export interface InstalledSkill {
  name: string
  harness: SkillUsageHarness
  /** Folder holding SKILL.md, as installed (links not resolved). */
  path: string
}

export interface SkillCatalogRoots {
  /** Claude Code home (`~/.claude`): `skills/` plus enabled plugins' skills. */
  claudeHome: string
  /** Folders Codex lists skills from (`~/.codex/skills`, its `.system`, `~/.agents/skills`). */
  codexSkillDirs: readonly string[]
}

export function defaultSkillCatalogRoots(): SkillCatalogRoots {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  return {
    claudeHome: join(homedir(), '.claude'),
    codexSkillDirs: [join(codexHome, 'skills'), join(codexHome, 'skills', '.system'), join(homedir(), '.agents', 'skills')],
  }
}

async function skillFolders(directory: string, prefix = ''): Promise<Array<{ name: string; path: string }>> {
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return []
  }
  const found: Array<{ name: string; path: string }> = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const path = join(directory, entry)
    try {
      await stat(join(path, 'SKILL.md'))
      found.push({ name: `${prefix}${entry}`, path })
    } catch {
      // Not a skill folder, or a link whose target is gone.
    }
  }
  return found
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Skills each harness would list now. Claude plugin skills are named `<plugin>:<skill>`. */
export async function readInstalledSkills(roots: SkillCatalogRoots = defaultSkillCatalogRoots()): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = []
  for (const skill of await skillFolders(join(roots.claudeHome, 'skills'))) {
    installed.push({ ...skill, harness: 'claude-code' })
  }
  const settings = await readJsonObject(join(roots.claudeHome, 'settings.json'))
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>
  const plugins = await readJsonObject(join(roots.claudeHome, 'plugins', 'installed_plugins.json'))
  const pluginEntries = (plugins?.plugins ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(pluginEntries)) {
    if (enabled[key] !== true) continue
    const plugin = key.split('@', 1)[0]!
    for (const install of (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>) {
      if (typeof install?.installPath !== 'string') continue
      for (const skill of await skillFolders(join(install.installPath, 'skills'), `${plugin}:`)) {
        installed.push({ ...skill, harness: 'claude-code' })
      }
    }
  }
  for (const directory of roots.codexSkillDirs) {
    for (const skill of await skillFolders(directory)) installed.push({ ...skill, harness: 'codex' })
  }
  return installed
}

// ── Report ──────────────────────────────────────────────────────────

export interface SkillUsageRow {
  skill: string
  model: number
  slash: number
  read: number
  sessions: number
  firstUsed: string | null
  lastUsed: string | null
  /** Harnesses whose catalog lists this skill now; empty for built-in or removed skills. */
  installedIn: SkillUsageHarness[]
}

export interface SkillUsageReport {
  since: string | null
  storePath: string
  refresh: SkillUsageRefresh[] | null
  storedEvents: number
  firstEvent: string | null
  lastEvent: string | null
  rows: SkillUsageRow[]
  /** Installed skills with no counted event in the window, by name. */
  unused: Array<{ skill: string; installedIn: SkillUsageHarness[] }>
  /** One Codex or Kimi command reading at least `sweepThreshold` skills is a catalog sweep, not use. */
  sweepThreshold: number
  sweepCommands: number
  sweepReadsExcluded: number
  /** Harnesses whose skill records this command does not read. */
  notIndexed: string[]
}

export interface SkillUsageReportOptions {
  /** Epoch ms; events before it are excluded. Events without a timestamp are excluded from a window. */
  since?: number
  sweepThreshold?: number
  refresh?: SkillUsageRefresh[] | null
}

export const DEFAULT_SWEEP_THRESHOLD = 3

/** The command that produced a read: its ID without the per-skill suffix. */
function commandOf(event: SkillUsageEvent): string {
  const hash = event.id.indexOf('#')
  return hash === -1 ? event.id : event.id.slice(0, hash)
}

export function buildSkillUsageReport(
  events: readonly SkillUsageEvent[],
  installed: readonly InstalledSkill[],
  storePath: string,
  options: SkillUsageReportOptions = {},
): SkillUsageReport {
  const sweepThreshold = options.sweepThreshold ?? DEFAULT_SWEEP_THRESHOLD
  const readsByCommand = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'read') readsByCommand.set(commandOf(event), (readsByCommand.get(commandOf(event)) ?? 0) + 1)
  }
  const sweeps = new Set([...readsByCommand].filter(([, reads]) => reads >= sweepThreshold).map(([command]) => command))

  const since = options.since
  const sinceIso = since === undefined ? null : new Date(since).toISOString()
  const inWindow = (event: SkillUsageEvent): boolean => sinceIso === null || (event.ts !== null && event.ts >= sinceIso)
  const rows = new Map<string, SkillUsageRow & { sessionSet: Set<string> }>()
  let sweepReadsExcluded = 0
  for (const event of events) {
    if (!inWindow(event)) continue
    if (event.kind === 'read' && sweeps.has(commandOf(event))) {
      sweepReadsExcluded += 1
      continue
    }
    const row = rows.get(event.skill) ?? {
      skill: event.skill, model: 0, slash: 0, read: 0, sessions: 0, firstUsed: null, lastUsed: null, installedIn: [], sessionSet: new Set<string>(),
    }
    row[event.kind] += 1
    row.sessionSet.add(`${event.harness}\u0000${event.session}`)
    if (event.ts !== null) {
      if (row.firstUsed === null || event.ts < row.firstUsed) row.firstUsed = event.ts
      if (row.lastUsed === null || event.ts > row.lastUsed) row.lastUsed = event.ts
    }
    rows.set(event.skill, row)
  }

  const installedBySkill = new Map<string, Set<SkillUsageHarness>>()
  for (const skill of installed) {
    const harnesses = installedBySkill.get(skill.name) ?? new Set<SkillUsageHarness>()
    harnesses.add(skill.harness)
    installedBySkill.set(skill.name, harnesses)
  }
  const result: SkillUsageRow[] = []
  for (const { sessionSet, ...row } of rows.values()) {
    result.push({ ...row, sessions: sessionSet.size, installedIn: [...(installedBySkill.get(row.skill) ?? [])].sort() })
  }
  result.sort((a, b) => b.sessions - a.sessions || (b.model + b.slash + b.read) - (a.model + a.slash + a.read) || a.skill.localeCompare(b.skill))
  const unused = [...installedBySkill]
    .filter(([skill]) => !rows.has(skill))
    .map(([skill, harnesses]) => ({ skill, installedIn: [...harnesses].sort() }))
    .sort((a, b) => a.skill.localeCompare(b.skill))

  let firstEvent: string | null = null
  let lastEvent: string | null = null
  for (const event of events) {
    if (event.ts === null) continue
    if (firstEvent === null || event.ts < firstEvent) firstEvent = event.ts
    if (lastEvent === null || event.ts > lastEvent) lastEvent = event.ts
  }
  return {
    since: sinceIso,
    storePath,
    refresh: options.refresh ?? null,
    storedEvents: events.length,
    firstEvent,
    lastEvent,
    rows: result,
    unused,
    sweepThreshold,
    sweepCommands: sweeps.size,
    sweepReadsExcluded,
    notIndexed: ['opencode', 'pi', 'gemini', 'factory', 'other harnesses'],
  }
}

function day(ts: string | null): string {
  return ts === null ? '-' : ts.slice(0, 10)
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function renderSkillUsage(report: SkillUsageReport): string {
  const lines: string[] = []
  const refresh = report.refresh
    ? report.refresh.map((r) => `${r.harness} ${r.files} files, read ${megabytes(r.bytesRead)} from ${r.filesRead}, +${r.eventsAdded} events`).join('; ')
    : 'not refreshed'
  lines.push(`skill usage · ${report.storedEvents} stored events ${day(report.firstEvent)} → ${day(report.lastEvent)} · ${refresh}`)
  lines.push(`window: ${report.since === null ? 'all stored events' : `since ${report.since.slice(0, 10)}`}`
    + ` · reads exclude ${report.sweepReadsExcluded} from ${report.sweepCommands} commands that read ${report.sweepThreshold}+ skills at once`)
  lines.push('')
  const width = Math.max(5, ...report.rows.map((r) => r.skill.length))
  lines.push(`${'skill'.padEnd(width)}  model  slash   read  sessions  last        installed`)
  for (const row of report.rows) {
    lines.push(
      `${row.skill.padEnd(width)}  ${String(row.model).padStart(5)}  ${String(row.slash).padStart(5)}  ${String(row.read).padStart(5)}`
      + `  ${String(row.sessions).padStart(8)}  ${day(row.lastUsed)}  ${row.installedIn.join(',') || '-'}`,
    )
  }
  lines.push('')
  lines.push(`installed, no use in window (${report.unused.length}): ${report.unused.map((u) => u.skill).join(', ') || 'none'}`)
  lines.push(`not indexed: ${report.notIndexed.join(', ')}`)
  return lines.join('\n')
}
