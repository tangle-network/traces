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
import { readFile, writeFile } from 'node:fs/promises'
import type { AnalystFinding } from '@tangle-network/agent-eval/analyst'

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
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
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { signal: opts.signal })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let out = ''
    let err = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
      reject(new Error(`${command}: timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const cap = (add: string, buf: string): string => {
      const next = buf + add
      if (next.length > maxBuffer) {
        killed = true
        child.kill('SIGKILL')
        clearTimeout(timer)
        reject(new Error(`${command}: output exceeded ${maxBuffer} bytes`))
      }
      return next
    }
    child.stdout?.on('data', (d) => {
      out = cap(String(d), out)
    })
    child.stderr?.on('data', (d) => {
      err = cap(String(d), err)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (!killed) reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!killed) resolve({ stdout: out, stderr: err, code })
    })
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}) // ignore EPIPE if the tool closes stdin early
      child.stdin?.end(opts.input)
    }
  })
}

// ─────────────────────────── external analyzers ────────────────────────────

export interface ExternalAnalysisResult {
  analyzer: string
  ok: boolean
  /** Raw text the engine produced (markdown/JSON/plain — engine-specific). */
  output: string
  /** Structured findings, when the engine emits parseable JSON. */
  findings?: AnalystFinding[]
  error?: string
}

/** An analysis engine that runs over the emitted OTLP-JSONL artifact — a peer to
 *  the built-in analysts, so you get many analyzers beyond our own. */
export interface ExternalAnalyzer {
  name: string
  analyze(otlpPath: string, opts?: { prompt?: string; signal?: AbortSignal }): Promise<ExternalAnalysisResult>
}

/** Wrap any CLI that reads the OTLP file and prints analysis to stdout. `args`
 *  builds the argv from the artifact path + optional prompt. Non-zero exit →
 *  `ok:false` with stderr in `error` (fail-soft: one engine never breaks a run). */
export function commandAnalyzer(spec: {
  name: string
  command: string
  args: (otlpPath: string, prompt?: string) => string[]
  /** Parse stdout into structured findings; omit to keep raw output only. */
  parse?: (stdout: string) => AnalystFinding[] | undefined
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
          return { analyzer: spec.name, ok: false, output: res.stdout, error: res.stderr.trim() || `exit ${res.code}` }
        }
        return { analyzer: spec.name, ok: true, output: res.stdout.trim(), findings: spec.parse?.(res.stdout) }
      } catch (e) {
        return { analyzer: spec.name, ok: false, output: '', error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/** Convert our OTLP-JSONL (the flat shape our pipeline reads) into the canonical
 *  OpenInference span schema HALO's `SpanRecord` requires: top-level `kind`,
 *  `resource`, `scope`, and a string (never null) `parent_span_id`. Our own
 *  writer keeps the simpler shape for the agent-eval reader; this is the bridge
 *  to OpenInference consumers. Input + output are JSONL strings (one span/line). */
export function toCanonicalOpenInference(otlpJsonl: string, opts: { service?: string; scopeName?: string } = {}): string {
  return otlpJsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const s = JSON.parse(line)
      const a: Record<string, unknown> = s.attributes ?? {}
      const resourceAttrs: Record<string, unknown> = { 'service.name': a['service.name'] ?? opts.service ?? 'traces' }
      if (a['agent.name']) resourceAttrs['agent.name'] = a['agent.name']
      return JSON.stringify({
        trace_id: s.trace_id,
        span_id: s.span_id,
        parent_span_id: s.parent_span_id ?? '',
        trace_state: '',
        name: s.name,
        kind: a['openinference.span.kind'] ?? 'CHAIN',
        start_time: s.start_time,
        end_time: s.end_time,
        status: { code: s.status?.code ?? 'OK', message: s.status?.message ?? '' },
        resource: { attributes: resourceAttrs },
        scope: { name: opts.scopeName ?? 'tangle-traces', version: '' },
        attributes: a,
      })
    })
    .join('\n')
}

/** HALO (github.com/context-labs/halo) over the OTLP artifact. HALO requires
 *  canonical OpenInference, so this converts our OTLP to a `<path>.halo.jsonl`
 *  first, then runs `halo <file> -p <prompt> [-m <model>]`. Install HALO yourself
 *  and configure its LLM provider (it uses the OpenAI client — `OPENAI_BASE_URL`
 *  / `OPENAI_API_KEY`); this just drives it. */
export function haloAnalyzer(opts: { command?: string; defaultPrompt?: string; model?: string; timeoutMs?: number } = {}): ExternalAnalyzer {
  const command = opts.command ?? 'halo'
  const defaultPrompt = opts.defaultPrompt ?? 'diagnose'
  return {
    name: 'halo',
    async analyze(otlpPath, o = {}) {
      try {
        const canonical = toCanonicalOpenInference(await readFile(otlpPath, 'utf8'))
        const canonPath = `${otlpPath}.halo.jsonl`
        await writeFile(canonPath, canonical)
        const args = [canonPath, '-p', o.prompt ?? defaultPrompt]
        if (opts.model) args.push('-m', opts.model)
        const res = await runCommand(command, args, { signal: o.signal, timeoutMs: opts.timeoutMs })
        if (res.code !== 0) {
          return { analyzer: 'halo', ok: false, output: res.stdout, error: res.stderr.trim() || `exit ${res.code}` }
        }
        return { analyzer: 'halo', ok: true, output: res.stdout.trim() }
      } catch (e) {
        return { analyzer: 'halo', ok: false, output: '', error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/** Run external analyzers over one OTLP artifact, concurrently. Never throws —
 *  a failing engine returns `ok:false`. */
export function runExternalAnalyzers(
  otlpPath: string,
  analyzers: readonly ExternalAnalyzer[],
  opts: { prompt?: string; signal?: AbortSignal } = {},
): Promise<ExternalAnalysisResult[]> {
  return Promise.all(analyzers.map((a) => a.analyze(otlpPath, opts)))
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
