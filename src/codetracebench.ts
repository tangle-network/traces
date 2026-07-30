import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  assertPathMissing,
  atomicWriteFile,
  claimImportLock,
  containedDirectory,
  publishStagedFiles,
  releaseImportLock,
  sha256,
} from './codetracebench-files.js'
import {
  importTrajectory,
  parseRows,
  validateRows,
} from './codetracebench-trajectory.js'

export interface CodeTraceBenchFileRef {
  readonly path: string
  readonly line_start: number
  readonly line_end: number
  readonly content: string
}

export interface CodeTraceBenchStep {
  readonly step_id: number
  readonly action: string
  readonly observation: string | null
  readonly thinking?: string
  readonly parallel_group?: number
  readonly tool_type?: string
  readonly action_ref: CodeTraceBenchFileRef | null
  readonly observation_ref: CodeTraceBenchFileRef | null
}

export interface CodeTraceBenchImportOptions {
  readonly rowsPath: string
  /** CodeTracer-normalized root containing `<traj_id>/steps.json`. */
  readonly trajectoryDir: string
  /** Must not exist. It is published only after every trajectory succeeds. */
  readonly outDir: string
  /** Full 40-character commit SHA or 64-character hexadecimal digest. */
  readonly revision: string
  readonly concurrency?: number
  readonly signal?: AbortSignal
}

export interface CodeTraceBenchImportedTrace {
  readonly index: number
  readonly traceId: string
  readonly stepCount: number
  readonly spanCount: number
  readonly taskSource: 'task.md' | 'task_name'
  readonly input: {
    readonly stepsPath: string
    readonly stepsSha256: string
    readonly stepsBytes: number
    readonly taskPath?: string
    readonly taskSha256?: string
    readonly taskBytes?: number
  }
  readonly output: {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
  }
}

export interface CodeTraceBenchImportReceipt {
  readonly kind: 'traces.codetracebench-import'
  readonly generatedAt: string
  readonly input: {
    readonly revision: string
    readonly rowsFile: string
    readonly rowsSha256: string
    readonly rowsBytes: number
    readonly trajectoryDirectory: string
    readonly sha256: string
  }
  readonly settings: {
    readonly concurrency: number
    readonly outputLayout: '<traj_id>.otlp.jsonl'
  }
  readonly counts: {
    readonly rows: number
    readonly traces: number
    readonly steps: number
    readonly spans: number
  }
  readonly safety: {
    readonly labelLeakScan: 'passed'
    readonly outputDirectoryCreatedExclusively: true
    readonly filesPublishedAtomically: true
  }
  readonly traces: readonly CodeTraceBenchImportedTrace[]
  readonly outputSha256: string
}

export interface CodeTraceBenchImportResult {
  readonly directory: string
  readonly receiptPath: string
  readonly receipt: CodeTraceBenchImportReceipt
}

const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 64
const IMMUTABLE_REVISION = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

export async function importCodeTraceBench(
  options: CodeTraceBenchImportOptions,
): Promise<CodeTraceBenchImportResult> {
  const concurrency = validateConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY)
  const revision = validateRevision(options.revision)
  const rowsPath = resolve(options.rowsPath)
  const trajectoryPath = resolve(options.trajectoryDir)
  const outputDirectory = resolve(options.outDir)
  const outputBase = basename(outputDirectory)
  if (!outputBase || outputDirectory === dirname(outputDirectory)) {
    throw new Error('CodeTraceBench output directory must not be a filesystem root')
  }

  options.signal?.throwIfAborted()
  await mkdir(dirname(outputDirectory), { recursive: true })
  const lock = await claimImportLock({
    rowsPath,
    trajectoryDirectory: trajectoryPath,
    outputDirectory,
    revision,
    signal: options.signal,
  })

  try {
    return await runCodeTraceBenchImport({
      concurrency,
      revision,
      rowsPath,
      trajectoryPath,
      outputDirectory,
      outputBase,
      signal: options.signal,
    })
  } finally {
    await releaseImportLock(lock)
  }
}

async function runCodeTraceBenchImport(input: {
  concurrency: number
  revision: string
  rowsPath: string
  trajectoryPath: string
  outputDirectory: string
  outputBase: string
  signal?: AbortSignal
}): Promise<CodeTraceBenchImportResult> {
  const {
    concurrency,
    revision,
    rowsPath,
    trajectoryPath,
    outputDirectory,
    outputBase,
    signal: outerSignal,
  } = input
  outerSignal?.throwIfAborted()
  await assertPathMissing(outputDirectory)
  const trajectoryDirectory = await containedDirectory(trajectoryPath)
  const rowsBytes = await readFile(rowsPath, { signal: outerSignal })
  const rows = parseRows(rowsBytes.toString('utf8'), rowsPath)
  const sourceRows = validateRows(rows, rowsPath)

  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${outputBase}.tmp-`),
  )
  const stop = new AbortController()
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, stop.signal])
    : stop.signal
  const imported = new Array<CodeTraceBenchImportedTrace>(sourceRows.length)
  let nextIndex = 0

  try {
    const workerCount = Math.min(concurrency, sourceRows.length)
    const workerResults = await Promise.allSettled(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          signal.throwIfAborted()
          const index = nextIndex
          nextIndex += 1
          if (index >= sourceRows.length) return
          try {
            imported[index] = await importTrajectory({
              index,
              row: sourceRows[index]!,
              trajectoryDirectory,
              stagingDirectory,
              signal,
            })
          } catch (error) {
            stop.abort(error)
            throw error
          }
        }
      }),
    )
    const workerFailure = workerResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (workerFailure) throw workerFailure.reason
    signal.throwIfAborted()

    const rowsSha256 = sha256(rowsBytes)
    const inputSha256 = sha256(
      JSON.stringify({
        revision,
        rowsSha256,
        traces: imported.map((item) => ({
          traceId: item.traceId,
          stepsSha256: item.input.stepsSha256,
          taskSha256: item.input.taskSha256 ?? null,
        })),
      }),
    )
    const outputSha256 = sha256(
      JSON.stringify(
        imported.map((item) => ({
          traceId: item.traceId,
          sha256: item.output.sha256,
        })),
      ),
    )
    const receipt: CodeTraceBenchImportReceipt = {
      kind: 'traces.codetracebench-import',
      generatedAt: new Date().toISOString(),
      input: {
        revision,
        rowsFile: basename(rowsPath),
        rowsSha256,
        rowsBytes: rowsBytes.byteLength,
        trajectoryDirectory: basename(trajectoryDirectory),
        sha256: inputSha256,
      },
      settings: {
        concurrency,
        outputLayout: '<traj_id>.otlp.jsonl',
      },
      counts: {
        rows: sourceRows.length,
        traces: imported.length,
        steps: imported.reduce((sum, item) => sum + item.stepCount, 0),
        spans: imported.reduce((sum, item) => sum + item.spanCount, 0),
      },
      safety: {
        labelLeakScan: 'passed',
        outputDirectoryCreatedExclusively: true,
        filesPublishedAtomically: true,
      },
      traces: imported,
      outputSha256,
    }
    const receiptFile = 'codetracebench-import.json'
    await atomicWriteFile(
      join(stagingDirectory, receiptFile),
      `${JSON.stringify(receipt, null, 2)}\n`,
      signal,
    )
    signal.throwIfAborted()
    await publishStagedFiles(
      stagingDirectory,
      outputDirectory,
      [...imported.map((item) => item.output.path), receiptFile],
      signal,
    )
    await rm(stagingDirectory, { recursive: true, force: true })

    return {
      directory: outputDirectory,
      receiptPath: join(outputDirectory, receiptFile),
      receipt,
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new RangeError(
      `CodeTraceBench concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`,
    )
  }
  return value
}

function validateRevision(value: unknown): string {
  if (typeof value !== 'string' || !IMMUTABLE_REVISION.test(value)) {
    throw new TypeError(
      'CodeTraceBench revision must be a full 40- or 64-character hexadecimal commit or digest',
    )
  }
  return value
}
