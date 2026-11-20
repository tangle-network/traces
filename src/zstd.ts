import { zstdDecompressSync } from 'node:zlib'

/** RFC 8878 §3.1.1. Locate the end of a data frame, including its optional checksum. */
function dataFrameEnd(bytes: Buffer, start: number): number {
  const descriptor = bytes.readUInt8(start + 4)
  const singleSegment = (descriptor & 0x20) !== 0
  const sizeFlag = descriptor >>> 6
  const contentSizeBytes = sizeFlag === 0 ? Number(singleSegment) : 1 << sizeFlag
  const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 3]!
  let cursor = start + 5 + Number(!singleSegment) + dictionaryIdBytes + contentSizeBytes
  let block: number
  do {
    block = bytes.readUIntLE(cursor, 3)
    const type = (block >>> 1) & 3
    if (type === 3) throw new Error('reserved zstd block type')
    cursor += 3 + (type === 1 ? 1 : block >>> 3)
  } while ((block & 1) === 0)
  return cursor + ((descriptor & 4) === 0 ? 0 : 4)
}

/** Older Node versions silently stop at the first frame or return a prefix for truncated input. */
export function decompressZstd(bytes: Buffer): { content: Buffer; skippedBytes: number } {
  if (bytes.length === 0) throw new Error('empty zstd input')
  const decoded: Buffer[] = []
  let skippedBytes = 0
  for (let start = 0; start < bytes.length;) {
    const magic = bytes.readUInt32LE(start)
    const skippable = magic >= 0x184d2a50 && magic <= 0x184d2a5f
    if (!skippable && magic !== 0xfd2fb528) throw new Error('invalid zstd frame magic')
    const end = skippable ? start + 8 + bytes.readUInt32LE(start + 4) : dataFrameEnd(bytes, start)
    if (end > bytes.length) throw new Error('truncated zstd frame')
    if (skippable) {
      skippedBytes += end - start - 8
    } else {
      const frame = zstdDecompressSync(bytes.subarray(start, end))
      if (start === 0 && end === bytes.length) return { content: frame, skippedBytes: 0 }
      decoded.push(frame)
    }
    start = end
  }
  return { content: decoded.length === 1 ? decoded[0]! : Buffer.concat(decoded), skippedBytes }
}
