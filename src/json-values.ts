/**
 * Every JSON value in a file, in order: one per line (JSONL), or one document
 * across many lines, read in bounded memory.
 *
 * Bytes are read into one reused buffer and parsed as they arrive, so no line
 * is ever held whole, and a string longer than {@link MAX_STRING_BYTES} is
 * kept as its prefix and a `[truncated N bytes]` marker without the rest ever
 * becoming a string. Memory then follows the values kept, not the bytes read:
 * an OpenTelemetry collector's spool, whose single lines can outgrow the
 * largest string V8 can hold, reads like any other file.
 *
 * The file's first value decides its layout. If it ends on its first line,
 * the file is JSONL: a line that ends inside a value is reported with its line
 * number and reading resumes on the next line. Otherwise it is one document,
 * and newlines are whitespace.
 */

import { open } from 'node:fs/promises'
import { TOOL_IO_VALUE_MAX_BYTES } from './adapters/tool-io.js'

/** The longest string kept whole; a longer one keeps a prefix, marker included, within this many bytes. */
export const MAX_STRING_BYTES = TOOL_IO_VALUE_MAX_BYTES
const READ_BYTES = 1 << 20

export interface JsonValue {
  readonly value: unknown
  /** The one-based line the value starts on. */
  readonly line: number
}

const enum State {
  /** Before a value: whitespace, or the start of one. */
  Value,
  /** After a value inside a container: `,` or the container's close. */
  AfterValue,
  /** Inside an object, before a key: a string, or `}` right after `{`. */
  Key,
  /** After a key: `:`. */
  Colon,
  String,
  /** A number or a literal (`true`, `false`, `null`): its characters. */
  Bare,
  /** After an error: everything up to the next line. */
  SkipLine,
}

interface Container {
  readonly value: Record<string, unknown> | unknown[]
  key?: string
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const NEWLINE = 0x0a
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/** Digits, signs, a decimal point, an exponent, and the letters of `true`, `false` and `null`. */
function isBareByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2b || byte === 0x2e ||
    (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a)
}

/**
 * The longest prefix, at most `limit` bytes, of a string's raw JSON bytes that
 * ends on a whole escape and a whole UTF-8 character, so it decodes alone.
 */
function wholePrefix(raw: Buffer, limit: number): number {
  let end = Math.min(limit, raw.length)
  for (let i = 0; i < end;) {
    if (raw[i] !== BACKSLASH) {
      i += 1
      continue
    }
    const length = raw[i + 1] === 0x75 ? 6 : 2
    if (i + length > end) {
      end = i
      break
    }
    i += length
  }
  if (end > 0) {
    let start = end - 1
    while (start > 0 && (raw[start]! & 0xc0) === 0x80) start -= 1
    const first = raw[start]!
    const size = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
    if (start + size > end) end = start
  }
  return end
}

function decode(raw: Buffer): string {
  return raw.includes(BACKSLASH) ? (JSON.parse(`"${raw.toString('utf8')}"`) as string) : raw.toString('utf8')
}

/** Parses JSON values from bytes fed to it in any pieces. */
class ValueParser {
  private state = State.Value
  private readonly stack: Container[] = []
  private line = 1
  private valueLine = 1
  private values = 0
  /** Unknown until the first value ends or crosses a line: true for one document, false for JSONL. */
  private document: boolean | undefined
  /** The string being read: its raw bytes up to the cap, its length in all, whether it is a key. */
  private stringParts: Buffer[] = []
  private stringKept = 0
  private stringTotal = 0
  private stringIsKey = false
  /** Backslashes that ended the previous piece of the string being read. */
  private carriedBackslashes = 0
  private bare = ''
  private readonly done: JsonValue[] = []

  constructor(private readonly onError: (line: number, detail: string) => void) {}

  /** Parse `bytes`, which the caller may reuse once this returns, and take the values it completed. */
  feed(bytes: Buffer): JsonValue[] {
    let i = 0
    while (i < bytes.length) {
      if (this.state === State.String) {
        i = this.readString(bytes, i)
      } else if (this.state === State.Bare) {
        const start = i
        while (i < bytes.length && isBareByte(bytes[i]!)) i += 1
        this.bare += bytes.toString('latin1', start, i)
        if (i < bytes.length) this.endBare()
      } else if (this.state === State.SkipLine) {
        const newline = bytes.indexOf(NEWLINE, i)
        if (newline === -1) break
        this.line += 1
        this.state = State.Value
        i = newline + 1
      } else {
        i = this.readStructure(bytes, i)
      }
    }
    return this.done.splice(0)
  }

  /** The values the input completed; a value it left open is reported. */
  end(): JsonValue[] {
    if (this.state === State.Bare) this.endBare()
    if (this.state !== State.SkipLine && (this.state !== State.Value || this.stack.length > 0)) {
      this.onError(this.valueLine, 'the input ended inside a value')
    }
    return this.done.splice(0)
  }

  private reset(): void {
    this.stack.length = 0
    this.stringParts = []
    this.bare = ''
  }

  /** A value that cannot be JSON: report it, and resume on the next line. */
  private fail(detail: string): void {
    this.onError(this.valueLine, detail)
    this.reset()
    this.state = State.SkipLine
  }

  /** A newline: whitespace in a document; in JSONL, the end of a value left open on its line. */
  private newline(): void {
    const open = this.state !== State.Value || this.stack.length > 0
    if (open && this.document === undefined && this.values === 0) this.document = true
    if (open && this.document === false) {
      this.onError(this.valueLine, 'the line ended inside a value')
      this.reset()
      this.state = State.Value
    }
    this.line += 1
  }

  private readStructure(bytes: Buffer, at: number): number {
    const byte = bytes[at]!
    if (isWhitespace(byte)) {
      if (byte === NEWLINE) this.newline()
      return at + 1
    }
    if (this.state === State.Value && this.stack.length === 0) this.valueLine = this.line
    if (this.state === State.Value) return this.startValue(byte, at)
    if (this.state === State.Key) {
      if (byte === QUOTE) return this.startString(true, at)
      if (byte === 0x7d && this.closeEmptyObject()) return at + 1
      this.fail('an object key must be a string')
      return at
    }
    if (this.state === State.Colon) {
      if (byte === 0x3a) {
        this.state = State.Value
        return at + 1
      }
      this.fail('a key must be followed by :')
      return at
    }
    // After a value inside a container.
    const top = this.stack.at(-1)!
    if (byte === 0x2c) {
      this.state = Array.isArray(top.value) ? State.Value : State.Key
      return at + 1
    }
    if ((byte === 0x5d && Array.isArray(top.value)) || (byte === 0x7d && !Array.isArray(top.value))) {
      this.stack.pop()
      this.complete(top.value)
      return at + 1
    }
    this.fail('a value must be followed by , or the end of its container')
    return at
  }

  private startValue(byte: number, at: number): number {
    if (byte === QUOTE) return this.startString(false, at)
    if (byte === 0x7b || byte === 0x5b) {
      this.stack.push({ value: byte === 0x7b ? {} : [] })
      this.state = byte === 0x7b ? State.Key : State.Value
      return at + 1
    }
    // `]` right after `[`: an empty array.
    const top = this.stack.at(-1)
    if (byte === 0x5d && top && Array.isArray(top.value) && top.value.length === 0) {
      this.stack.pop()
      this.complete(top.value)
      return at + 1
    }
    if (isBareByte(byte)) {
      this.bare = ''
      this.state = State.Bare
      return at
    }
    this.fail(`unexpected ${JSON.stringify(String.fromCharCode(byte))}`)
    return at
  }

  /** `}` in the key state closes the object only when it has no key yet: `{}`, not `{"a":1,}`. */
  private closeEmptyObject(): boolean {
    const top = this.stack.at(-1)!
    if (Array.isArray(top.value) || Object.keys(top.value).length > 0) return false
    this.stack.pop()
    this.complete(top.value)
    return true
  }

  private startString(isKey: boolean, at: number): number {
    this.stringParts = []
    this.stringKept = 0
    this.stringTotal = 0
    this.stringIsKey = isKey
    this.carriedBackslashes = 0
    this.state = State.String
    return at + 1
  }

  /**
   * Read string bytes from `at` to the closing quote, or to the end of
   * `bytes`. A quote closes the string when an even number of backslashes
   * precede it, so each quote is looked at once, however long the string.
   */
  private readString(bytes: Buffer, at: number): number {
    // In JSONL a raw newline cannot be inside a string: the line ended inside a value.
    const lineEnd = this.document === false ? bytes.indexOf(NEWLINE, at) : -1
    const limit = lineEnd === -1 ? bytes.length : lineEnd
    let from = at
    for (;;) {
      const quote = bytes.indexOf(QUOTE, from)
      if (quote === -1 || quote >= limit) break
      let backslashes = 0
      let j = quote - 1
      while (j >= at && bytes[j] === BACKSLASH) {
        backslashes += 1
        j -= 1
      }
      if (j < at) backslashes += this.carriedBackslashes
      if (backslashes % 2 === 0) {
        this.keep(bytes, at, quote)
        this.endString()
        return quote + 1
      }
      from = quote + 1
    }
    this.keep(bytes, at, limit)
    if (lineEnd !== -1) {
      this.newline()
      return lineEnd + 1
    }
    let run = 0
    for (let j = limit - 1; j >= at && bytes[j] === BACKSLASH; j -= 1) run += 1
    this.carriedBackslashes = run === limit - at ? this.carriedBackslashes + run : run
    return limit
  }

  /** Keep the string's raw bytes in `[from, to)` up to the cap, and count them all. */
  private keep(bytes: Buffer, from: number, to: number): void {
    const length = to - from
    this.stringTotal += length
    const take = Math.min(MAX_STRING_BYTES - this.stringKept, length)
    if (take <= 0) return
    // A copy: the caller reuses `bytes` for its next read.
    this.stringParts.push(Buffer.from(bytes.subarray(from, from + take)))
    this.stringKept += take
  }

  private endString(): void {
    const raw = this.stringParts.length === 1 ? this.stringParts[0]! : Buffer.concat(this.stringParts)
    this.stringParts = []
    let text: string
    try {
      if (this.stringTotal <= MAX_STRING_BYTES) {
        text = decode(raw)
      } else {
        const longest = `\n[truncated ${this.stringTotal} bytes]`
        const kept = wholePrefix(raw, MAX_STRING_BYTES - Buffer.byteLength(longest))
        text = `${decode(raw.subarray(0, kept))}\n[truncated ${this.stringTotal - kept} bytes]`
      }
    } catch {
      this.fail('a string holds an invalid escape')
      return
    }
    if (this.stringIsKey) {
      this.stack.at(-1)!.key = text
      this.state = State.Colon
    } else {
      this.complete(text)
    }
  }

  private endBare(): void {
    const text = this.bare
    this.bare = ''
    if (text === 'true' || text === 'false' || text === 'null') {
      this.complete(text === 'null' ? null : text === 'true')
    } else if (NUMBER.test(text)) {
      this.complete(Number(text))
    } else {
      this.fail(`${JSON.stringify(text.slice(0, 20))} is not a JSON value`)
    }
  }

  private complete(value: unknown): void {
    const top = this.stack.at(-1)
    if (top) {
      if (Array.isArray(top.value)) top.value.push(value)
      // As JSON.parse does, a `__proto__` key is an own property, never the object's prototype.
      else if (top.key === '__proto__') Object.defineProperty(top.value, top.key, { value, enumerable: true, writable: true, configurable: true })
      else top.value[top.key!] = value
      this.state = State.AfterValue
      return
    }
    this.done.push({ value, line: this.valueLine })
    this.values += 1
    this.document ??= false
    this.state = State.Value
  }
}

/** Every JSON value in the file at `path`, read through one reused buffer. */
export async function* readJsonValues(path: string, onError: (line: number, detail: string) => void): AsyncGenerator<JsonValue> {
  const parser = new ValueParser(onError)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(READ_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      yield* parser.feed(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead))
    }
    yield* parser.end()
  } finally {
    await handle.close()
  }
}
