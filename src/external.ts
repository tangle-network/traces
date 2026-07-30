/**
 * External-tool adapters: run analysis engines and PII scrubbers that `traces`
 * does NOT bundle. Each is a thin command adapter over a shared subprocess
 * runner — install the tool yourself (HALO, openai/privacy-filter, anything),
 * point an adapter at it, and it composes with the built-in pipeline.
 *
 *   - ExternalAnalyzer — run an engine over the emitted OTLP-JSONL artifact and
 *     fold its output into the report (HALO and friends).
 *   - Redactor — scrub free-form prompt/response text via an external model that
 *     catches what the regex pass can't (names, addresses).
 */

import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import type { AnalystFinding } from '@tangle-network/agent-eval/analyst'
import {
  decodeExternalAnalysisPayload,
  decodeExternalAnalysisResult,
  spanEvidenceUri,
} from './external-analysis-validation.js'
import { readJsonl } from './jsonl.js'
import type { OtlpSpan } from './otlp.js'

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

type SpawnedProcess = ReturnType<typeof spawn>

function forceKill(child: SpawnedProcess): void {
  try {
    child.kill('SIGKILL')
  } catch {
    // The process already exited.
  }
}

function terminateWindowsProcessTree(child: SpawnedProcess): Promise<void> {
  if (child.pid === undefined) {
    forceKill(child)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      forceKill(child)
      resolve()
    }
    let killer: SpawnedProcess
    try {
      killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      )
    } catch {
      finish()
      return
    }
    killer.once('error', finish)
    killer.once('close', finish)
  })
}

interface PosixProcess {
  pid: number
  parentPid: number
  depth: number
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function readProcessTableWithPs(): Promise<Array<{ pid: number; parentPid: number }>> {
  return new Promise((resolve, reject) => {
    let child: SpawnedProcess
    try {
      child = spawn('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (
      action: () => void,
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      forceKill(child)
      finish(() => reject(new Error('ps: timed out while enumerating analyzer descendants')))
    }, 2_000)
    child.stdout?.on('data', (data) => {
      stdout += String(data)
      if (stdout.length > 4 * 1024 * 1024) {
        forceKill(child)
        finish(() => reject(new Error('ps: process table exceeded 4 MiB')))
      }
    })
    child.stderr?.on('data', (data) => {
      stderr += String(data)
      if (stderr.length > 1024 * 1024) {
        forceKill(child)
        finish(() => reject(new Error('ps: stderr exceeded 1 MiB')))
      }
    })
    child.once('error', (error) => {
      finish(() => reject(error))
    })
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `ps: exited ${code}`))
          return
        }
        const rows = stdout
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => parts.length >= 2)
          .map(([pid, parentPid]) => ({
            pid: Number(pid),
            parentPid: Number(parentPid),
          }))
          .filter(({ pid, parentPid }) =>
            Number.isSafeInteger(pid) && pid > 0 &&
            Number.isSafeInteger(parentPid) && parentPid >= 0)
        if (rows.length === 0) {
          reject(new Error('ps: returned no process records'))
          return
        }
        resolve(rows)
      })
    })
  })
}

async function readLinuxProcProcessTable(): Promise<
  Array<{ pid: number; parentPid: number }>
> {
  const entries = await readdir('/proc', { withFileTypes: true })
  const rows = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const stat = await readFile(`/proc/${entry.name}/stat`, 'utf8')
          const commandEnd = stat.lastIndexOf(')')
          if (commandEnd < 0) return undefined
          const fields = stat.slice(commandEnd + 1).trim().split(/\s+/)
          const pid = Number(entry.name)
          const parentPid = Number(fields[1])
          if (
            !Number.isSafeInteger(pid) ||
            pid < 1 ||
            !Number.isSafeInteger(parentPid) ||
            parentPid < 0
          ) {
            return undefined
          }
          return { pid, parentPid }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'EACCES' || code === 'ESRCH') return undefined
          throw error
        }
      }),
  )
  const table = rows.filter(
    (row): row is { pid: number; parentPid: number } => row !== undefined,
  )
  if (table.length === 0) throw new Error('/proc returned no process records')
  return table
}

async function readPosixProcessTable(): Promise<
  Array<{ pid: number; parentPid: number }>
> {
  try {
    return await readProcessTableWithPs()
  } catch (psError) {
    if (process.platform !== 'linux') throw psError
    try {
      return await readLinuxProcProcessTable()
    } catch (procError) {
      throw new Error(
        `could not enumerate analyzer descendants: ps: ${
          psError instanceof Error ? psError.message : String(psError)
        }; /proc: ${procError instanceof Error ? procError.message : String(procError)}`,
        { cause: procError },
      )
    }
  }
}

function descendantsOf(
  rootPid: number,
  table: readonly { pid: number; parentPid: number }[],
): PosixProcess[] {
  const children = new Map<number, number[]>()
  for (const row of table) {
    const siblings = children.get(row.parentPid) ?? []
    siblings.push(row.pid)
    children.set(row.parentPid, siblings)
  }
  const descendants: PosixProcess[] = []
  const seen = new Set<number>([rootPid])
  const visit = (parentPid: number, depth: number): void => {
    for (const pid of children.get(parentPid) ?? []) {
      if (seen.has(pid)) continue
      seen.add(pid)
      descendants.push({ pid, parentPid, depth })
      visit(pid, depth + 1)
    }
  }
  visit(rootPid, 1)
  return descendants
}

async function terminatePosixProcessTree(child: SpawnedProcess): Promise<void> {
  if (child.pid === undefined) {
    forceKill(child)
    return
  }
  const rootPid = child.pid
  const descendants = new Map<number, PosixProcess>()
  let failure: unknown
  try {
    signalProcess(-rootPid, 'SIGSTOP')
    signalProcess(rootPid, 'SIGSTOP')
    let previous = ''
    for (let pass = 0; pass < 4; pass += 1) {
      const current = descendantsOf(rootPid, await readPosixProcessTable())
      for (const processEntry of current) {
        if (signalProcess(processEntry.pid, 'SIGSTOP')) {
          descendants.set(processEntry.pid, processEntry)
        }
      }
      const signature = [...descendants.keys()].sort((left, right) => left - right).join(',')
      if (signature === previous) break
      previous = signature
    }
  } catch (error) {
    failure = error
  } finally {
    for (const processEntry of [...descendants.values()].sort(
      (left, right) => right.depth - left.depth,
    )) {
      try {
        signalProcess(processEntry.pid, 'SIGKILL')
      } catch (error) {
        failure ??= error
      }
    }
    try {
      signalProcess(-rootPid, 'SIGKILL')
    } catch (error) {
      failure ??= error
    }
    forceKill(child)
  }
  if (failure) {
    throw failure instanceof Error ? failure : new Error(String(failure))
  }
}

function terminateProcessTree(child: SpawnedProcess): Promise<void> {
  if (process.platform === 'win32') return terminateWindowsProcessTree(child)
  return terminatePosixProcessTree(child)
}

function abortError(signal: AbortSignal): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  const withCause = error as Error & { cause?: unknown }
  withCause.cause = signal.reason
  return error
}

/** Spawn `command args`, optionally write `input` to stdin, and collect output.
 *  Rejects on spawn error, timeout, or output exceeding `maxBuffer`. */
export function runCommand(
  command: string,
  args: readonly string[] = [],
  opts: { input?: string; signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
    throw new RangeError('maxBuffer must be a positive safe integer')
  }
  if (opts.signal?.aborted) return Promise.reject(abortError(opts.signal))

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { detached: process.platform !== 'win32' })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let out = ''
    let err = ''
    let outputBytes = 0
    let closed = false
    let closeCode: number | null = null
    let spawnError: Error | undefined
    let terminationError: Error | undefined
    let terminationComplete = true
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => requestTermination(abortError(opts.signal!))
    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (): void => {
      if (settled || !closed || (terminationError && !terminationComplete)) return
      settled = true
      cleanup()
      if (terminationError) {
        reject(terminationError)
      } else if (spawnError) {
        reject(spawnError)
      } else {
        resolve({ stdout: out, stderr: err, code: closeCode })
      }
    }
    function requestTermination(error: Error): void {
      if (settled || terminationError) return
      terminationError = error
      clearTimeout(timer)
      child.stdin?.destroy()
      if (closed) {
        settle()
        return
      }
      terminationComplete = false
      void terminateProcessTree(child).then(
        () => {
          terminationComplete = true
          settle()
        },
        (cause) => {
          terminationError = new Error(
            `${terminationError?.message ?? error.message}; process-tree termination failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          )
          terminationComplete = true
          settle()
        },
      )
    }

    timer = setTimeout(() => {
      requestTermination(new Error(`${command}: timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const cap = (add: Buffer | string, buf: string): string => {
      if (terminationError) return buf
      outputBytes += Buffer.isBuffer(add) ? add.byteLength : Buffer.byteLength(add)
      if (outputBytes > maxBuffer) {
        requestTermination(new Error(`${command}: output exceeded ${maxBuffer} bytes`))
        return buf
      }
      return buf + String(add)
    }
    child.stdout?.on('data', (d) => {
      out = cap(d, out)
    })
    child.stderr?.on('data', (d) => {
      err = cap(d, err)
    })
    child.on('error', (e) => {
      spawnError = e
    })
    child.on('close', (code) => {
      closed = true
      closeCode = code
      settle()
    })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    child.stdin?.on('error', () => {}) // ignore EPIPE if the tool closes stdin early
    if (!terminationError) child.stdin?.end(opts.input)
  })
}

// ─────────────────────────── external analyzers ────────────────────────────

export interface ExternalAnalysisResult {
  analyzer: string
  kind: ExternalAnalysisKind
  ok: boolean
  /** Raw text the engine produced. */
  output: string
  /** Confirmed findings with exact evidence. Only valid when kind is findings. */
  findings?: readonly AnalystFinding[]
  /** Distinctive actions that still need review. Only valid when kind is discovery. */
  candidates?: readonly ExternalDiscoveryCandidate[]
  error?: string
}

export type ExternalAnalysisKind = 'report' | 'findings' | 'discovery'

export interface ExternalDiscoveryCandidate {
  engine: string
  engineVersion: string
  status: 'needs_review'
  group: string
  rank: number
  groupSize: number
  traceId: string
  spanId: string
  evidenceUri: string
  summary: string
  actionText: string
  metadata?: Record<string, unknown>
}

export type ExternalAnalysisPayload =
  | { kind: 'report' }
  | { kind: 'findings'; findings: readonly AnalystFinding[] }
  | { kind: 'discovery'; candidates: readonly ExternalDiscoveryCandidate[] }

export interface ExternalAnalyzerOptions {
  prompt?: string
  signal?: AbortSignal
  /** Supplied by runExternalAnalyzers to avoid rereading the OTLP artifact. */
  knownSpanUris?: ReadonlySet<string>
}

/** An analysis engine that runs over the emitted OTLP-JSONL artifact — a peer to
 *  the built-in analysts, so you get many analyzers beyond our own. */
export interface ExternalAnalyzer {
  name: string
  analyze(otlpPath: string, opts?: ExternalAnalyzerOptions): Promise<ExternalAnalysisResult>
}

async function spanUrisFromArtifact(
  otlpPath: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const uris = new Set<string>()
  let index = 0
  for await (const value of readJsonl<unknown>(otlpPath, { signal })) {
    const label = `${otlpPath}:${index + 1}`
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} must contain an object`)
    }
    const row = value as Record<string, unknown>
    if (typeof row.trace_id !== 'string' || row.trace_id.trim().length === 0) {
      throw new TypeError(`${label}.trace_id must be a non-empty string`)
    }
    if (typeof row.span_id !== 'string' || row.span_id.trim().length === 0) {
      throw new TypeError(`${label}.span_id must be a non-empty string`)
    }
    uris.add(spanEvidenceUri(row.trace_id, row.span_id))
    index += 1
  }
  return uris
}

/** Wrap any CLI that reads the OTLP file and prints analysis to stdout. `args`
 *  builds the argv from the artifact path + optional prompt. Non-zero exit →
 *  `ok:false` with stderr in `error` (fail-soft: one engine never breaks a run). */
export function commandAnalyzer(spec: {
  name: string
  command: string
  args: (otlpPath: string, prompt?: string) => string[]
  /** Explicitly classify structured output; omit to keep a raw report. */
  parse?: (stdout: string) => ExternalAnalysisPayload
  timeoutMs?: number
}): ExternalAnalyzer {
  return {
    name: spec.name,
    async analyze(otlpPath, opts = {}) {
      try {
        const res = await runCommand(spec.command, spec.args(otlpPath, opts.prompt), {
          signal: opts.signal,
          timeoutMs: spec.timeoutMs,
        })
        if (res.code !== 0) {
          return {
            analyzer: spec.name,
            kind: 'report',
            ok: false,
            output: res.stdout,
            error: res.stderr.trim() || `exit ${res.code}`,
          }
        }
        const output = res.stdout.trim()
        let payload: ExternalAnalysisPayload
        try {
          payload = spec.parse
            ? decodeExternalAnalysisPayload(spec.parse(res.stdout))
            : { kind: 'report' }
        } catch (error) {
          return {
            analyzer: spec.name,
            kind: 'report',
            ok: false,
            output,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        if (payload.kind === 'report') {
          return { analyzer: spec.name, kind: payload.kind, ok: true, output }
        }
        const result = payload.kind === 'findings'
          ? {
              analyzer: spec.name,
              kind: payload.kind,
              ok: true,
              output,
              findings: payload.findings,
            }
          : {
              analyzer: spec.name,
              kind: payload.kind,
              ok: true,
              output,
              candidates: payload.candidates,
            }
        try {
          const knownSpanUris =
            opts.knownSpanUris ?? (await spanUrisFromArtifact(otlpPath, opts.signal))
          return decodeExternalAnalysisResult(result, spec.name, knownSpanUris)
        } catch (error) {
          return {
            analyzer: spec.name,
            kind: 'report',
            ok: false,
            output,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      } catch (e) {
        return {
          analyzer: spec.name,
          kind: 'report',
          ok: false,
          output: '',
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
  }
}

/** HALO (github.com/context-labs/halo) over the OTLP artifact: `halo <file> -p
 *  <prompt> [-m <model>]`. Our `serializeSpans` already emits canonical
 *  OpenInference, so HALO reads the artifact directly — no conversion. Install
 *  HALO yourself and configure its LLM provider (it uses the OpenAI client —
 *  `OPENAI_BASE_URL` / `OPENAI_API_KEY`); this just drives it. */
export type HaloReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface HaloAnalyzerOptions {
  command?: string
  defaultPrompt?: string
  model?: string
  maxDepth?: number
  maxTurns?: number
  maxParallel?: number
  instructions?: string
  reasoningEffort?: HaloReasoningEffort
  telemetry?: boolean
  timeoutMs?: number
}

function assertIntegerOption(name: string, value: number | undefined, minimum: number): void {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`)
  }
}

export function haloAnalyzer(opts: HaloAnalyzerOptions = {}): ExternalAnalyzer {
  const maxDepth = opts.maxDepth ?? 0
  const maxTurns = opts.maxTurns ?? 3
  const maxParallel = opts.maxParallel ?? 1
  assertIntegerOption('maxDepth', maxDepth, 0)
  assertIntegerOption('maxTurns', maxTurns, 1)
  assertIntegerOption('maxParallel', maxParallel, 1)
  const defaultPrompt = opts.defaultPrompt ?? 'diagnose'
  return commandAnalyzer({
    name: 'halo',
    command: opts.command ?? 'halo',
    args: (otlpPath, prompt) => {
      const args = [otlpPath, '-p', prompt ?? defaultPrompt]
      if (opts.model) args.push('-m', opts.model)
      args.push('--max-depth', String(maxDepth))
      args.push('--max-turns', String(maxTurns))
      args.push('--max-parallel', String(maxParallel))
      if (opts.instructions) args.push('--instructions', opts.instructions)
      if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort)
      if (opts.telemetry) args.push('--telemetry')
      return args
    },
    timeoutMs: opts.timeoutMs,
  })
}

/** Run external analyzers over one OTLP artifact, concurrently. Never throws —
 *  a failing engine returns `ok:false`. */
export function runExternalAnalyzers(
  otlpPath: string,
  analyzers: readonly ExternalAnalyzer[],
  opts: {
    prompt?: string
    signal?: AbortSignal
    spans?: readonly OtlpSpan[]
  } = {},
): Promise<ExternalAnalysisResult[]> {
  const knownSpanUris = opts.spans
    ? new Set(opts.spans.map((span) => spanEvidenceUri(span.trace_id, span.span_id)))
    : undefined
  return Promise.all(analyzers.map(async (analyzer) => {
    try {
      const raw = await analyzer.analyze(otlpPath, {
        prompt: opts.prompt,
        signal: opts.signal,
        knownSpanUris,
      })
      return decodeExternalAnalysisResult(raw, analyzer.name, knownSpanUris)
    } catch (error) {
      return {
        analyzer: analyzer.name,
        kind: 'report',
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))
}

// ──────────────────────────────── redactors ────────────────────────────────

/** An external PII/secret scrubber for free-form text — catches what regex
 *  can't (names, addresses). Use to harden upload beyond the built-in rules. */
export interface Redactor {
  name: string
  /** Scrub a batch of texts; returns one scrubbed string per input, in order. */
  redactText(texts: readonly string[]): Promise<string[]>
}

/** Wrap any CLI that speaks the redaction protocol: read a JSON array of strings
 *  on stdin, write a same-length JSON array of scrubbed strings on stdout.
 *  (A 3-line wrapper adapts tools like `opf`/openai-privacy-filter.) */
export function commandRedactor(spec: { name?: string; command: string; args?: string[]; timeoutMs?: number }): Redactor {
  const name = spec.name ?? spec.command
  return {
    name,
    async redactText(texts) {
      if (texts.length === 0) return []
      const res = await runCommand(spec.command, spec.args ?? [], {
        input: JSON.stringify(texts),
        timeoutMs: spec.timeoutMs,
      })
      if (res.code !== 0) throw new Error(`redactor ${name}: exit ${res.code}: ${res.stderr.trim()}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(res.stdout)
      } catch {
        throw new Error(`redactor ${name}: stdout was not JSON`)
      }
      if (!Array.isArray(parsed) || parsed.length !== texts.length) {
        throw new Error(`redactor ${name}: expected a JSON array of ${texts.length} strings`)
      }
      return parsed.map(String)
    },
  }
}
