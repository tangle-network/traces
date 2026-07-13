import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlParseError, readJsonl, takeJsonl } from '../src/jsonl.js'

describe('readJsonl', () => {
  it('streams valid rows and skips blank lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'events.jsonl')
    await writeFile(path, '{"id":1}\n\n{"id":2,"text":"café"}\n', 'utf8')

    const rows: Array<{ id: number; text?: string }> = []
    for await (const row of readJsonl<{ id: number; text?: string }>(path)) rows.push(row)

    expect(rows).toEqual([{ id: 1 }, { id: 2, text: 'café' }])
    await expect(takeJsonl(path, 1)).resolves.toEqual([{ id: 1 }])
    await expect(takeJsonl(path, 0)).resolves.toEqual([])
    await expect(takeJsonl(path, -1)).rejects.toThrow('limit must be a non-negative integer')
  })

  it('throws a typed location-only error for malformed JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'events.jsonl')
    const rawSecret = 'secret-token-that-must-not-leak'
    await writeFile(path, `{"id":1}\n\n${rawSecret}\n{"id":2}\n`, 'utf8')

    const rows: Array<{ id: number }> = []
    const error = await (async () => {
      try {
        for await (const row of readJsonl<{ id: number }>(path)) rows.push(row)
      } catch (cause) {
        return cause
      }
      return undefined
    })()

    expect(rows).toEqual([{ id: 1 }])
    expect(error).toBeInstanceOf(JsonlParseError)
    expect(error).toMatchObject({
      name: 'JsonlParseError',
      message: `Invalid JSONL at ${path}:3`,
      sourcePath: path,
      lineNumber: 3,
    })
    expect(String(error)).not.toContain(rawSecret)
    expect(JSON.stringify(error)).not.toContain(rawSecret)
    expect((error as Error).stack).not.toContain(rawSecret)
  })

  it('propagates missing-file errors', async () => {
    const path = join(tmpdir(), `traces-jsonl-missing-${process.pid}-${Date.now()}.jsonl`)
    const read = async () => {
      for await (const _row of readJsonl(path)) {
        // The missing source must fail before yielding a row.
      }
    }

    await expect(read()).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
