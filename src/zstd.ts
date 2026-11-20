import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/**
 * Whether this runtime's zstdDecompressSync returns every frame of a multi-frame file. Node 22.23.4 returns only the
 * first frame and no error (Node 24.22.1 returns all), so a check there could call a file clean without reading its
 * later frames. Measured once on a known two-frame value; where it fails, every `.zst` file is unreadable.
 */
let everyFrame: boolean | undefined
export function readsEveryZstdFrame(): boolean {
  if (everyFrame === undefined) {
    try {
      everyFrame = zstdDecompressSync(Buffer.concat([zstdCompressSync('a'), zstdCompressSync('b')])).toString() === 'ab'
    } catch {
      everyFrame = false
    }
  }
  return everyFrame
}
