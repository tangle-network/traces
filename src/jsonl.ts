import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** Stream valid JSONL rows without retaining the source file or malformed rows. */
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      try {
        yield JSON.parse(line) as T
      } catch {
        // A malformed row must not discard the remaining trace.
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

export async function collectJsonl<T>(path: string): Promise<T[]> {
  const rows: T[] = []
  for await (const row of readJsonl<T>(path)) rows.push(row)
  return rows
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
