import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlParseError, readJsonl, takeJsonl } from '../src/jsonl.js'

describe('readJsonl', () => {
  it('streams valid rows and skips blank lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'events.jsonl')
    await writeFile(path, '{"id":1}\n\n  \t\r\n{"id":2,"text":"café"}\n', 'utf8')

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
      byteOffset: Buffer.byteLength('{"id":1}\n\n'),
      byteLength: Buffer.byteLength(rawSecret),
      sha256: createHash('sha256').update(rawSecret).digest('hex'),
    })
    expect(String(error)).not.toContain(rawSecret)
    expect(JSON.stringify(error)).not.toContain(rawSecret)
    expect((error as Error).stack).not.toContain(rawSecret)
  })

  it('recovers valid records around a malformed middle record with an exact fingerprint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'middle.jsonl')
    const malformed = 'secret-middle-record'
    const prefix = '{"id":1}\n'
    await writeFile(path, `${prefix}${malformed}\n{"id":2}\n`, 'utf8')
    const receipts: import('../src/jsonl.js').JsonlCorruptionReceipt[] = []
    const rows: Array<{ id: number }> = []

    for await (const row of readJsonl<{ id: number }>(path, {
      mode: 'recover',
      onCorruption: (receipt) => receipts.push(receipt),
    })) rows.push(row)

    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    expect(receipts).toEqual([{
      receiptVersion: 1,
      kind: 'jsonl_corruption',
      status: 'degraded_not_lossless',
      sourcePath: path,
      lineNumber: 2,
      byteOffset: Buffer.byteLength(prefix),
      byteLength: Buffer.byteLength(malformed),
      sha256: createHash('sha256').update(malformed).digest('hex'),
      rawBytes: 'local_source_only',
    }])
    expect(JSON.stringify(receipts)).not.toContain(malformed)
  })

  it('receipts a malformed final record without a trailing newline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'final.jsonl')
    const malformed = 'secret-final-record'
    const prefix = '{"id":1}\n'
    await writeFile(path, `${prefix}${malformed}`, 'utf8')
    const receipts: import('../src/jsonl.js').JsonlCorruptionReceipt[] = []
    const rows: Array<{ id: number }> = []

    for await (const row of readJsonl<{ id: number }>(path, {
      mode: 'recover',
      onCorruption: (receipt) => receipts.push(receipt),
    })) rows.push(row)

    expect(rows).toEqual([{ id: 1 }])
    expect(receipts[0]).toMatchObject({
      lineNumber: 2,
      byteOffset: Buffer.byteLength(prefix),
      byteLength: Buffer.byteLength(malformed),
      sha256: createHash('sha256').update(malformed).digest('hex'),
    })
  })

  it('reports multiple corrupt records in physical-line order with byte offsets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'multiple.jsonl')
    const first = 'secret-first'
    const valid = '{"id":1,"text":"café"}'
    const second = 'secret-second\r'
    await writeFile(path, `${first}\n${valid}\n${second}\n{"id":2}\n`, 'utf8')
    const receipts: import('../src/jsonl.js').JsonlCorruptionReceipt[] = []
    const rows: Array<{ id: number; text?: string }> = []

    for await (const row of readJsonl<{ id: number; text?: string }>(path, {
      mode: 'recover',
      onCorruption: (receipt) => receipts.push(receipt),
    })) rows.push(row)

    expect(rows).toEqual([{ id: 1, text: 'café' }, { id: 2 }])
    expect(receipts.map(({ lineNumber, byteOffset, byteLength, sha256 }) => ({
      lineNumber,
      byteOffset,
      byteLength,
      sha256,
    }))).toEqual([
      {
        lineNumber: 1,
        byteOffset: 0,
        byteLength: Buffer.byteLength(first),
        sha256: createHash('sha256').update(first).digest('hex'),
      },
      {
        lineNumber: 3,
        byteOffset: Buffer.byteLength(`${first}\n${valid}\n`),
        byteLength: Buffer.byteLength(second),
        sha256: createHash('sha256').update(second).digest('hex'),
      },
    ])
  })

  it('receipts invalid UTF-8 before decoding and hashes the exact source bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'invalid-utf8.jsonl')
    const malformed = Buffer.concat([
      Buffer.from('{"value":"', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('"}', 'utf8'),
    ])
    await writeFile(path, Buffer.concat([malformed, Buffer.from('\n{"id":2}\n', 'utf8')]))
    const receipts: import('../src/jsonl.js').JsonlCorruptionReceipt[] = []
    const rows: Array<{ id: number }> = []

    for await (const row of readJsonl<{ id: number }>(path, {
      mode: 'recover',
      onCorruption: (receipt) => receipts.push(receipt),
    })) rows.push(row)

    expect(rows).toEqual([{ id: 2 }])
    expect(receipts).toMatchObject([{
      lineNumber: 1,
      byteOffset: 0,
      byteLength: malformed.length,
      sha256: createHash('sha256').update(malformed).digest('hex'),
    }])
    expect(JSON.stringify(receipts)).not.toContain('\ufffd')

    const strictError = await (async () => {
      try {
        for await (const _row of readJsonl(path)) {
          // Strict mode stops at the invalid record.
        }
      } catch (cause) {
        return cause
      }
    })()
    expect(strictError).toBeInstanceOf(JsonlParseError)
    expect(strictError).toMatchObject({
      byteLength: malformed.length,
      sha256: createHash('sha256').update(malformed).digest('hex'),
    })
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

  it('requires a receipt callback in recovery mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'traces-jsonl-'))
    const path = join(directory, 'events.jsonl')
    await writeFile(path, '{"id":1}\n', 'utf8')
    const read = async () => {
      for await (const _row of readJsonl(path, { mode: 'recover' } as never)) {
        // Runtime validation protects JavaScript callers that bypass the TypeScript union.
      }
    }

    await expect(read()).rejects.toThrow('JSONL recover mode requires an onCorruption callback')
  })
})
