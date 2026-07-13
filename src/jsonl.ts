import { createReadStream } from 'node:fs'

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

function parseLine<T>(line: string, path: string, lineNumber: number): T {
  try {
    return JSON.parse(line) as T
  } catch {
    throw new JsonlParseError(path, lineNumber)
  }
}

/** Stream JSONL rows without retaining the source file. */
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  const input = createReadStream(path, { encoding: 'utf8' })
  let lineNumber = 0
  let fragments: string[] = []
  try {
    for await (const chunk of input) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let start = 0
      let newline = text.indexOf('\n')
      while (newline !== -1) {
        const tail = text.slice(start, newline)
        let line = fragments.length > 0 ? fragments.join('') + tail : tail
        fragments = []
        lineNumber += 1
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line) yield parseLine<T>(line, path, lineNumber)
        start = newline + 1
        newline = text.indexOf('\n', start)
      }
      if (start < text.length) fragments.push(text.slice(start))
    }
    if (fragments.length > 0) {
      let line = fragments.join('')
      lineNumber += 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line) yield parseLine<T>(line, path, lineNumber)
    }
  } finally {
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
