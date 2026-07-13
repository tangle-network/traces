import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectJsonl, readJsonl, takeJsonl } from '../src/jsonl.js'

describe('readJsonl', () => {
  it('streams valid rows and skips malformed rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'events.jsonl')
    await writeFile(path, '{"id":1}\nnot-json\n{"id":2,"text":"café"}\n', 'utf8')

    const rows: Array<{ id: number; text?: string }> = []
    for await (const row of readJsonl<{ id: number; text?: string }>(path)) rows.push(row)

    expect(rows).toEqual([{ id: 1 }, { id: 2, text: 'café' }])
    await expect(collectJsonl(path)).resolves.toEqual(rows)
    await expect(takeJsonl(path, 1)).resolves.toEqual([{ id: 1 }])
    await expect(takeJsonl(path, 0)).resolves.toEqual([])
    await expect(takeJsonl(path, -1)).rejects.toThrow('limit must be a non-negative integer')
  })
})
