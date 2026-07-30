import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

type JsonObject = Record<string, unknown>

interface CodeTraceBenchImportLock {
  readonly path: string
  readonly claimId: string
}

interface CodeTraceBenchImportLockMetadata {
  readonly kind: 'traces.codetracebench-import-lock'
  readonly claimId: string
  readonly pid: number
  readonly hostname: string
  readonly startedAt: string
  readonly revision: string
  readonly rowsPath: string
  readonly trajectoryDirectory: string
  readonly outputDirectory: string
}

export async function claimImportLock(input: {
  rowsPath: string
  trajectoryDirectory: string
  outputDirectory: string
  revision: string
  signal?: AbortSignal
}): Promise<CodeTraceBenchImportLock> {
  const claimId = randomUUID()
  const path = `${input.outputDirectory}.lock`
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${claimId}.tmp`,
  )
  const metadata: CodeTraceBenchImportLockMetadata = {
    kind: 'traces.codetracebench-import-lock',
    claimId,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    revision: input.revision,
    rowsPath: input.rowsPath,
    trajectoryDirectory: input.trajectoryDirectory,
    outputDirectory: input.outputDirectory,
  }

  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      signal: input.signal,
    })
    input.signal?.throwIfAborted()
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }

  try {
    await link(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    if (isErrno(error, 'EEXIST')) {
      throw await importLockConflictError(path, input.outputDirectory)
    }
    throw error
  }

  try {
    await rm(temporary, { force: true })
  } catch (error) {
    await unlink(path)
    throw error
  }

  return { path, claimId }
}

async function importLockConflictError(
  path: string,
  outputDirectory: string,
): Promise<Error> {
  let owner = 'owner metadata is unreadable'
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      isObject(parsed) &&
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.revision === 'string'
    ) {
      owner =
        `PID ${parsed.pid} on ${parsed.hostname}, started ${parsed.startedAt}, ` +
        `revision ${parsed.revision}`
    }
  } catch {
    // The path remains actionable even if an external process changed the lock.
  }
  return new Error(
    `CodeTraceBench import already in progress for ${outputDirectory}. ` +
      `Lock: ${path}. Owner: ${owner}. Wait for it to finish, or remove the ` +
      'lock only after confirming that process is no longer running.',
  )
}

export async function releaseImportLock(lock: CodeTraceBenchImportLock): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(lock.path, 'utf8'))
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw new Error(`Could not read CodeTraceBench import lock: ${lock.path}`, {
      cause: error,
    })
  }
  if (!isObject(parsed) || parsed.claimId !== lock.claimId) {
    throw new Error(
      `CodeTraceBench import lock owner changed; refusing to remove ${lock.path}`,
    )
  }
  await unlink(lock.path)
}

export async function publishStagedFiles(
  stagingDirectory: string,
  outputDirectory: string,
  files: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  try {
    await mkdir(outputDirectory)
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new Error(
        `CodeTraceBench output directory appeared while import was running; ` +
          `refusing to replace it: ${outputDirectory}`,
      )
    }
    throw error
  }

  const published: string[] = []
  try {
    for (const file of files) {
      signal.throwIfAborted()
      const destination = join(outputDirectory, file)
      await link(join(stagingDirectory, file), destination)
      published.push(destination)
    }
  } catch (error) {
    for (const path of published.reverse()) {
      await rm(path, { force: true })
    }
    try {
      await rmdir(outputDirectory)
    } catch (cleanupError) {
      if (!isErrno(cleanupError, 'ENOENT') && !isErrno(cleanupError, 'ENOTEMPTY')) {
        throw new AggregateError(
          [error, cleanupError],
          `CodeTraceBench import failed and could not clean ${outputDirectory}`,
        )
      }
    }
    throw error
  }
}

export async function containedDirectory(path: string): Promise<string> {
  const resolved = resolve(path)
  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch (error) {
    throw new Error(`CodeTraceBench trajectory directory is unavailable: ${resolved}`, {
      cause: error,
    })
  }
  const info = await stat(canonical)
  if (!info.isDirectory()) {
    throw new TypeError(`CodeTraceBench trajectory path is not a directory: ${canonical}`)
  }
  return canonical
}

export async function containedFile(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const path = await optionalContainedFile(root, candidate)
  if (!path) throw new Error(`${label} is missing`)
  return path
}

export async function optionalContainedFile(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
  const fromRoot = relative(root, canonical)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`CodeTraceBench trajectory file escapes its input directory: ${candidate}`)
  }
  const info = await stat(canonical)
  if (!info.isFile()) {
    throw new TypeError(`CodeTraceBench trajectory path is not a file: ${candidate}`)
  }
  return canonical
}

export async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  throw new Error(`CodeTraceBench output directory already exists: ${path}`)
}

export async function atomicWriteFile(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      signal,
    })
    signal.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code
}
