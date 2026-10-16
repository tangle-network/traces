/**
 * The incremental turn index: what `traces list` shows and what `traces facts
 * --match` searches over a window, kept under `$XDG_STATE_HOME/traces/turn-index`
 * so a warm run reads only what sessions appended since the last one.
 *
 * Each session file has a byte cursor, the same per-file cursor the skills
 * store keeps (`resumeOffset`, `readCompleteLines`): keyed by inode, read
 * again from 0 when the file shrinks or its inode changes. Claude Code and
 * Codex files are read a piece at a time: the records past the cursor go
 * through the shared reader's fold and traces' projection (`readPiece`), and
 * their rows come from the functions a whole read uses (`readSessionIndex`,
 * `sessionRows`), never a second classifier. A piece ends before the last
 * response, which may still be streaming (`pieceBoundary`); that response is
 * read again with the next piece. Every other session (OpenCode's SQLite
 * store, Pi, Kimi, Factory, `claude -p` stream-json, a Codex fork) is read
 * whole whenever it changes, so its rows are a whole read's by construction.
 *
 * The index is lazy: a command refreshes only the sessions its selection
 * names, so the first `--since 30d` search builds 30 days and no more.
 * `tests/turn-index.test.ts` holds it to the rule that its answer equals a
 * whole read's, row for row, however a file was appended.
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type HarnessSessionsAdapter, type PieceCarry, type PieceRecord, PIECE_START, pieceBoundary, readsStoreRoots } from './adapters/harness-sessions.js'
import {
  readSessionIndex,
  TURN_FOLD_START,
  type SessionIndexRead,
  type SessionMatchKind,
  type SessionRow,
  type TurnFoldState,
} from './session-facts.js'
import { readSessionSpans, validateOtlpSpans } from './session-source.js'
import { stampSessionIdentity } from './attributes.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

// ── The per-file byte cursor, shared with the skills store ─────────────

/** How far a file was read: its inode, its size then, and the offset just past the last line consumed. */
export interface ByteCursor {
  readonly ino: number
  readonly size: number
  readonly offset: number
}

/**
 * Where to resume reading a file `previous` described: its offset, or 0 when
 * the file was replaced (another inode) or truncated (it shrank). Null when it
 * is unchanged, so there is nothing to read.
 */
export function resumeOffset(previous: ByteCursor | undefined, info: { readonly ino: number; readonly size: number }): number | null {
  if (!previous) return 0
  if (previous.ino === info.ino && previous.size === info.size) return null
  return previous.ino === info.ino && info.size >= previous.size && previous.offset <= info.size ? previous.offset : 0
}

const CHUNK_BYTES = 8 * 1024 * 1024
const NEWLINE = 0x0a

/**
 * Read `path` from byte `from` to `to` in chunks, handing `consume` each run
 * of complete lines (a buffer that ends in a newline) with the file offset it
 * starts at. A line longer than a chunk is read whole. The bytes after the
 * last newline, a line still being written, are returned in `rest`.
 */
export async function readCompleteLines(
  path: string,
  from: number,
  to: number,
  consume: (lines: Buffer, at: number) => void | Promise<void>,
): Promise<{ bytes: number; end: number; rest: Buffer }> {
  const handle = await open(path, 'r')
  let bytes = 0
  let end = from
  let carry = Buffer.alloc(0)
  try {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(0, to - from)))
    let position = from
    while (position < to) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, to - position), position)
      if (bytesRead === 0) break
      position += bytesRead
      bytes += bytesRead
      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const complete = buffer.lastIndexOf(NEWLINE) + 1
      if (complete > 0) {
        await consume(Buffer.from(buffer.subarray(0, complete)), end)
        end += complete
      }
      carry = Buffer.from(buffer.subarray(complete))
    }
  } finally {
    await handle.close()
  }
  return { bytes, end, rest: carry }
}

// ── The index ──────────────────────────────────────────────────────────

/** A session as the index holds it: what `list` prints and what a search needs to choose it. */
export interface IndexedSession {
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly cwd: string | null
  readonly firstAt: string | null
  readonly lastAt: string | null
  /** Spans read from its records; 0 means nothing in it could be read. */
  readonly records: number
  /** The span ids of its human turns, in order. */
  readonly humanTurns: readonly string[]
  readonly firstPrompt: string | null
}

/** A row on disk: kind, start, span id, its place among the span's rows of that kind, text. */
type StoredRow = [SessionMatchKind, string, string, number, string]

interface FileEntry {
  readonly key: string
  readonly harness: string
  readonly path: string
  readonly sessionId: string
  /** `pieces`: read from `offset` a piece at a time. `whole`: read whole when `version` changes. */
  mode: 'pieces' | 'whole'
  ino: number
  size: number
  version: string
  /** Pieces: bytes whose rows are committed; the next read starts here. */
  offset: number
  carry: PieceCarry | null
  turn: TurnFoldState
  /** The session as the committed rows describe it. */
  session: IndexedSession
  /** Read past `offset` and not committed: the last response, which may still be written. */
  tail: { readonly session: IndexedSession; readonly rows: StoredRow[] } | null
  /** Why the session could not be read, when it could not. */
  unread: string | null
}

interface StoreV1 {
  version: 1
  files: Record<string, FileEntry>
}

/** What one refresh did, as `selection.index` reports it. */
export interface TurnIndexStats {
  readonly path: string
  /** Sessions the selection named. */
  readonly sessions: number
  /** Sessions that had changed, and were read. */
  readonly sessionsRead: number
  /** Bytes read from session files by byte cursor. */
  readonly bytesRead: number
  /** Sessions read whole: a store the index cannot read by byte cursor, or a session that changed shape. */
  readonly wholeReads: number
  readonly rowsAdded: number
}

const EMPTY_SESSION: IndexedSession = {
  sessionId: null, parentSessionId: null, cwd: null, firstAt: null, lastAt: null, records: 0, humanTurns: [], firstPrompt: null,
}

const PIECE_WORKERS = 4

export function defaultTurnIndexDir(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(state, 'traces', 'turn-index')
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(right) > Date.parse(left) ? right : left
}

function earlier(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(right) < Date.parse(left) ? right : left
}

/** `session` with one more read of the same session after it. */
function extend(session: IndexedSession, read: SessionIndexRead): IndexedSession {
  const human = [...session.humanTurns]
  for (const id of read.humanTurns) if (!human.includes(id)) human.push(id)
  return {
    sessionId: session.sessionId ?? read.sessionId,
    parentSessionId: session.parentSessionId ?? read.parentSessionId,
    cwd: session.cwd ?? read.cwd,
    firstAt: earlier(session.firstAt, read.firstAt),
    lastAt: later(session.lastAt, read.lastAt),
    records: session.records + read.records,
    humanTurns: human,
    firstPrompt: session.firstPrompt ?? read.firstPrompt,
  }
}

function storedRows(rows: readonly SessionRow[]): StoredRow[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const key = `${row.kind}\0${row.spanId}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return [row.kind, row.at, row.spanId, n, row.text]
  })
}

function serialize(rows: readonly StoredRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('')
}

/** One line per record of a run of complete lines, with each line's bytes (newline included). */
function parseLines(buffer: Buffer): { records: PieceRecord[]; bytes: number[] } {
  const records: PieceRecord[] = []
  const bytes: number[] = []
  let start = 0
  while (start < buffer.length) {
    let end = buffer.indexOf(NEWLINE, start)
    if (end === -1) end = buffer.length
    records.push(parseRecord(buffer.toString('utf8', start, end)))
    bytes.push(end + 1 - start)
    start = end + 1
  }
  return { records, bytes }
}

function parseRecord(line: string): PieceRecord {
  const text = line.replace(/\r$/u, '')
  if (text.trim().length === 0) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The selection's sessions, as the index knows them. Open, `refresh`, read, then `close`. */
export class TurnIndex {
  private files: Record<string, FileEntry> = {}
  private whole: Promise<void> = Promise.resolve()

  private constructor(readonly dir: string) {}

  /** Open the index at `dir`, waiting while another traces process is refreshing it. */
  static async open(dir: string = defaultTurnIndexDir()): Promise<TurnIndex> {
    const index = new TurnIndex(dir)
    await mkdir(join(dir, 'rows'), { recursive: true })
    await index.lock()
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as Partial<StoreV1>
      if (parsed.version === 1 && typeof parsed.files === 'object' && parsed.files !== null) index.files = parsed.files
    } catch {
      // No index yet, or one this version cannot read: it is rebuilt from the sessions.
    }
    return index
  }

  /** Open the index, run `use` on it, and close it whatever `use` does. */
  static async with<T>(use: (index: TurnIndex) => Promise<T>, dir?: string): Promise<T> {
    const index = await TurnIndex.open(dir)
    try {
      return await use(index)
    } finally {
      await index.close()
    }
  }

  private get lockPath(): string {
    return join(this.dir, 'lock')
  }

  private async lock(): Promise<void> {
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx')
        await handle.writeFile(String(process.pid))
        await handle.close()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (await this.lockIsStale()) {
        await unlink(this.lockPath).catch(() => {})
        continue
      }
      await sleep(100)
    }
  }

  /** A lock whose process is gone was left by one that died holding it. */
  private async lockIsStale(): Promise<boolean> {
    try {
      const [text, info] = await Promise.all([readFile(this.lockPath, 'utf8'), stat(this.lockPath)])
      const pid = Number(text)
      // A lock with no pid yet is being written; one that stays so was left half-written.
      if (!Number.isInteger(pid) || pid <= 0) return Date.now() - info.mtimeMs > 60_000
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    } catch {
      // Removed between the attempt and this read: try again.
      return true
    }
  }

  /** Save what was read and let the next process in. */
  async close(): Promise<void> {
    try {
      const temporary = join(this.dir, `index.json.${process.pid}.tmp`)
      await writeFile(temporary, JSON.stringify({ version: 1, files: this.files } satisfies StoreV1))
      await rename(temporary, join(this.dir, 'index.json'))
    } finally {
      await unlink(this.lockPath).catch(() => {})
    }
  }

  private rowsPath(entry: { readonly key: string }): string {
    return join(this.dir, 'rows', `${createHash('sha256').update(entry.key).digest('hex').slice(0, 24)}.jsonl`)
  }

  private static keyOf(adapter: HarnessTraceAdapter, ref: SessionRef): string {
    return `${adapter.harness}\0${ref.path}\0${ref.sessionId}`
  }

  /**
   * Bring each session up to date: read what it appended since the last
   * refresh, or all of it the first time. A session that cannot be read is
   * recorded with its reason, never dropped.
   */
  async refresh(sessions: ReadonlyArray<{ readonly adapter: HarnessTraceAdapter; readonly ref: SessionRef }>): Promise<TurnIndexStats> {
    const stats = { path: this.dir, sessions: sessions.length, sessionsRead: 0, bytesRead: 0, wholeReads: 0, rowsAdded: 0 }
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < sessions.length) {
        const { adapter, ref } = sessions[next++]!
        const read = await this.refreshOne(adapter, ref)
        if (read === null) continue
        stats.sessionsRead += 1
        stats.bytesRead += read.bytes
        stats.rowsAdded += read.rows
        if (read.whole) stats.wholeReads += 1
      }
    }
    await Promise.all(Array.from({ length: PIECE_WORKERS }, worker))
    return stats
  }

  private async refreshOne(adapter: HarnessTraceAdapter, ref: SessionRef): Promise<{ bytes: number; rows: number; whole: boolean } | null> {
    const key = TurnIndex.keyOf(adapter, ref)
    let info: { ino: number; size: number; mtimeMs: number }
    try {
      info = await stat(ref.path)
    } catch (error) {
      const entry = this.blank(key, adapter, ref, { ino: 0, size: 0, mtimeMs: ref.mtimeMs }, 'whole')
      entry.unread = errorText(error)
      this.files[key] = entry
      return { bytes: 0, rows: 0, whole: false }
    }
    const previous = this.files[key]
    const pieces = readsStoreRoots(adapter) && adapter.readsPieces(ref) && previous?.mode !== 'whole'
    if (pieces) {
      try {
        return await this.readPieces(key, adapter as HarnessSessionsAdapter, ref, info, previous)
      } catch {
        // A piece the shared reader or the projection refused: read the session whole,
        // which decides whether it can be read at all.
      }
    }
    // A shared store changes with every session in it; its own update time says whether this one did.
    const version = ref.path.endsWith('.db') ? `m${ref.mtimeMs}` : `${info.ino}:${info.size}:${info.mtimeMs}`
    if (previous?.mode === 'whole' && previous.version === version) return null
    return this.readWhole(key, adapter, ref, info, version)
  }

  private blank(key: string, adapter: HarnessTraceAdapter, ref: SessionRef, info: { ino: number; size: number }, mode: FileEntry['mode']): FileEntry {
    return {
      key, harness: adapter.harness, path: ref.path, sessionId: ref.sessionId, mode, ino: info.ino, size: info.size, version: '',
      offset: 0, carry: null, turn: TURN_FOLD_START, session: EMPTY_SESSION, tail: null, unread: null,
    }
  }

  /** Read a session whole, as `facts <ref>` reads it, replacing every row it had. */
  private async readWhole(key: string, adapter: HarnessTraceAdapter, ref: SessionRef, info: { ino: number; size: number }, version: string): Promise<{ bytes: number; rows: number; whole: boolean }> {
    const entry = this.blank(key, adapter, ref, info, 'whole')
    entry.version = version
    // One whole read at a time: a large session's spans are the largest thing a refresh holds.
    const turn = this.whole.then(async () => {
      let rows: StoredRow[] = []
      try {
        const read = readSessionIndex(await readSessionSpans(adapter, ref), { sessionId: ref.sessionId })
        entry.session = extend(EMPTY_SESSION, read)
        entry.turn = read.state
        rows = storedRows(read.rows)
        if (read.records === 0) entry.unread = 'no record could be read'
      } catch (error) {
        entry.unread = errorText(error)
      }
      await writeFile(this.rowsPath(entry), serialize(rows))
      this.files[key] = entry
      return rows.length
    })
    this.whole = turn.then(() => {}, () => {})
    return { bytes: 0, rows: await turn, whole: true }
  }

  /**
   * Read what a Claude Code or Codex file appended since `previous`: commit
   * the rows of every piece up to the last response, and keep that response's
   * rows as the uncommitted tail, read again next time.
   */
  private async readPieces(
    key: string,
    adapter: HarnessSessionsAdapter,
    ref: SessionRef,
    info: { ino: number; size: number },
    previous: FileEntry | undefined,
  ): Promise<{ bytes: number; rows: number; whole: boolean } | null> {
    const from = resumeOffset(previous?.mode === 'pieces' ? previous : undefined, info)
    if (from === null) return null
    const entry: FileEntry = from === 0 || !previous
      ? this.blank(key, adapter, ref, info, 'pieces')
      : { ...previous, session: previous.session, tail: null }
    let carry = entry.carry ?? PIECE_START
    let pending: { records: PieceRecord[]; bytes: number[] } = { records: [], bytes: [] }
    const committed: StoredRow[] = []
    const piece = async (records: readonly PieceRecord[]): Promise<SessionIndexRead> => {
      const read = await adapter.readPiece(ref, records, carry)
      carry = read.carry
      const spans = validateOtlpSpans(read.spans, `${adapter.harness} piece of ${ref.path}`)
      if (spans.length > 0) stampSessionIdentity(spans, ref.sessionId)
      return readSessionIndex(spans, { state: entry.turn })
    }
    const read = await readCompleteLines(ref.path, from, info.size, async (buffer) => {
      const lines = parseLines(buffer)
      const records = [...pending.records, ...lines.records]
      const bytes = [...pending.bytes, ...lines.bytes]
      if (carry.lines === 0 && !adapter.readsPieces(ref, records)) throw new Error('read whole')
      const cut = pieceBoundary(adapter.nativeHarness, records, carry)
      if (cut > 0) {
        const result = await piece(records.slice(0, cut))
        entry.session = extend(entry.session, result)
        entry.turn = result.state
        committed.push(...storedRows(result.rows))
        entry.offset += bytes.slice(0, cut).reduce((sum, value) => sum + value, 0)
        entry.carry = carry
      }
      pending = { records: records.slice(cut), bytes: bytes.slice(cut) }
    })
    // A last line with no newline yet is read when it is already a whole record.
    const last = read.rest.length > 0 ? parseRecord(read.rest.toString('utf8')) : null
    const tailRecords = last ? [...pending.records, last] : pending.records
    if (entry.offset === 0 && tailRecords.length > 0 && !adapter.readsPieces(ref, tailRecords)) throw new Error('read whole')
    if (tailRecords.length > 0) {
      const saved = carry
      const result = await piece(tailRecords)
      carry = saved
      entry.tail = { session: extend(EMPTY_SESSION, result), rows: storedRows(result.rows) }
    }
    entry.ino = info.ino
    entry.size = info.size
    if (from === 0) await writeFile(this.rowsPath(entry), serialize(committed))
    else if (committed.length > 0) await appendFile(this.rowsPath(entry), serialize(committed))
    this.files[key] = entry
    return { bytes: read.bytes, rows: committed.length + (entry.tail?.rows.length ?? 0), whole: false }
  }

  /** The session as the index holds it: its committed rows' facts and its tail's, or why it could not be read. */
  session(adapter: HarnessTraceAdapter, ref: SessionRef): { readonly session: IndexedSession; readonly unread: string | null } | null {
    const entry = this.files[TurnIndex.keyOf(adapter, ref)]
    if (!entry) return null
    const tail = entry.tail?.session
    const session = tail
      ? {
          ...entry.session,
          sessionId: entry.session.sessionId ?? tail.sessionId,
          parentSessionId: entry.session.parentSessionId ?? tail.parentSessionId,
          cwd: entry.session.cwd ?? tail.cwd,
          firstAt: earlier(entry.session.firstAt, tail.firstAt),
          lastAt: later(entry.session.lastAt, tail.lastAt),
          records: entry.session.records + tail.records,
          humanTurns: [...new Set([...entry.session.humanTurns, ...tail.humanTurns])],
          firstPrompt: entry.session.firstPrompt ?? tail.firstPrompt,
        }
      : entry.session
    return { session, unread: entry.unread ?? (session.records === 0 ? 'no record could be read' : null) }
  }

  /**
   * A session's rows in the order a whole read lists them: its human turns,
   * then its agent messages and commands, each in trace order. A row read
   * twice (a harness that writes a record again) is listed once.
   */
  async rows(adapter: HarnessTraceAdapter, ref: SessionRef): Promise<SessionRow[]> {
    const entry = this.files[TurnIndex.keyOf(adapter, ref)]
    if (!entry) return []
    let text = ''
    try {
      text = await readFile(this.rowsPath(entry), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const seen = new Set<string>()
    const human: SessionRow[] = []
    const other: SessionRow[] = []
    const take = ([kind, at, spanId, n, body]: StoredRow): void => {
      const key = `${kind}\0${spanId}\0${n}`
      if (seen.has(key)) return
      seen.add(key)
      ;(kind === 'human' ? human : other).push({ kind, at, spanId, text: body })
    }
    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end === -1) end = text.length
      if (end > start) take(JSON.parse(text.slice(start, end)) as StoredRow)
      start = end + 1
    }
    for (const row of entry.tail?.rows ?? []) take(row)
    return [...human, ...other]
  }
}
