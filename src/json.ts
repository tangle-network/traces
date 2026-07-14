import { readdir, readFile } from 'node:fs/promises'

export type JsonSourceErrorKind = 'read' | 'parse'

export class JsonSourceError extends Error {
  readonly sourcePath: string
  readonly kind: JsonSourceErrorKind
  readonly code?: string

  constructor(sourcePath: string, kind: JsonSourceErrorKind, cause: unknown) {
    super(
      kind === 'parse' ? `Invalid JSON at ${sourcePath}` : `Unable to read JSON source at ${sourcePath}`,
      { cause },
    )
    this.name = 'JsonSourceError'
    this.sourcePath = sourcePath
    this.kind = kind
    this.code = errorCode(cause)
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function pathSafeParseCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause
  const location = cause.message.match(/(?:at position \d+(?: \(line \d+ column \d+\))?|line \d+ column \d+)/i)?.[0]
  cause.message = location ? `JSON parse failed ${location}` : 'JSON parse failed'
  cause.stack = `${cause.name}: ${cause.message}`
  return cause
}

export function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

export function isMissingJsonSource(error: unknown): error is JsonSourceError {
  return error instanceof JsonSourceError && error.kind === 'read' && isMissingPathError(error)
}

export async function readJsonFile<T>(path: string): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    throw new JsonSourceError(path, 'read', error)
  }

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new JsonSourceError(path, 'parse', pathSafeParseCause(error))
  }
}

export async function listJsonFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((file) => file.endsWith('.json'))
  } catch (error) {
    throw new JsonSourceError(path, 'read', error)
  }
}
