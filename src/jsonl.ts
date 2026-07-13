import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export class JsonlParseError extends SyntaxError {
  readonly sourcePath: string
  readonly lineNumber: number

  constructor(sourcePath: string, lineNumber: number) {
    super(`Invalid JSONL at ${sourcePath}:${lineNumber}`)
    this.name = 'JsonlParseError'
    this.sourcePath = sourcePath
    this.lineNumber = lineNumber
  }
}

/** Stream JSONL rows without retaining the source file. */
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  try {
    for await (const line of lines) {
      lineNumber += 1
      if (!line) continue
      let row: T
      try {
        row = JSON.parse(line) as T
      } catch {
        throw new JsonlParseError(path, lineNumber)
      }
      yield row
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

export async function takeJsonl<T>(path: string, limit: number): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer')
  const rows: T[] = []
  if (limit === 0) return rows
  for await (const row of readJsonl<T>(path)) {
    rows.push(row)
    if (rows.length === limit) break
  }
  return rows
}
