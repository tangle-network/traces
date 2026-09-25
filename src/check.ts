/**
 * `traces check`: run a trace contract over a recorded run and report in a
 * form CI reads — an exit code, JUnit XML, GitHub annotations, and an
 * evidence directory when a contract does not pass.
 *
 * The contract engine is agent-eval's; this module only resolves the input,
 * maps OTLP spans to the spans a contract reads, and renders the verdicts.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ContractSpan,
  type ContractVerdict,
  compileTraceContractSpec,
  evaluateTraceContract,
  explainTraceContract,
  lintTraceContractSpec,
  type TraceContract,
} from '@tangle-network/agent-eval'
import { toolArgumentsFromAttributes } from './adapters/tool-io.js'
import { readJsonl } from './jsonl.js'
import type { OtlpSpan } from './otlp.js'
import { redactSpans } from './redact.js'
import { parseIsoToEpochMs } from './time.js'

/** Exit codes. CI scripts branch on these, so they never change meaning. */
export const CHECK_EXIT = Object.freeze({
  pass: 0,
  fail: 1,
  /** The contract is malformed or contradicts itself, or a rule could not run. */
  badContract: 2,
  unreadable: 3,
  ambiguous: 4,
})

/** A trace reference that names more than one input. */
export class AmbiguousTraceInputError extends Error {
  override name = 'AmbiguousTraceInputError'
}

/** A contract file that cannot be used. */
export class ContractFileError extends Error {
  override name = 'ContractFileError'
}

export interface LoadedContract {
  contract: TraceContract
  warnings: string[]
}

/** Read, parse, compile, and lint a declarative contract file. Lint errors
 *  reject the contract: a contract that contradicts itself can never pass. */
export async function loadContract(path: string): Promise<LoadedContract> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ContractFileError(`cannot read contract ${path}: ${errorText(error)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new ContractFileError(`contract ${path} is not JSON: ${errorText(error)}`)
  }
  try {
    const findings = lintTraceContractSpec(json)
    const errors = findings.filter((f) => f.level === 'error')
    if (errors.length > 0) {
      throw new ContractFileError(
        `contract ${path} contradicts itself:\n${errors.map((f) => `  ${f.path}: ${f.message} [${f.code}]`).join('\n')}`,
      )
    }
    return {
      contract: compileTraceContractSpec(json),
      warnings: findings.map((f) => `${f.path}: ${f.message} [${f.code}]`),
    }
  } catch (error) {
    if (error instanceof ContractFileError) throw error
    throw new ContractFileError(`contract ${path}: ${errorText(error)}`)
  }
}

// ── Input resolution ──────────────────────────────────────────────────

export type CheckInputKind = 'otlp' | 'claude-code' | 'codex' | 'evidence'

const SNIFF_ROWS = 20

/**
 * Which reader a positional trace file needs. Every reader is tried against
 * the first rows; exactly one must claim the file. None is unreadable, and
 * more than one is ambiguous, so the caller passes `--format`.
 */
export async function sniffCheckInput(path: string): Promise<CheckInputKind> {
  const rows: unknown[] = []
  for await (const row of readJsonl<unknown>(path)) {
    rows.push(row)
    if (rows.length >= SNIFF_ROWS) break
  }
  const objects = rows.filter(isObject)
  if (objects.length === 0) throw new Error(`${path} holds no JSON rows`)
  const kinds: CheckInputKind[] = []
  if (objects.every((r) => typeof r.trace_id === 'string' && typeof r.span_id === 'string')) kinds.push('otlp')
  if (objects.some((r) => typeof r.sessionId === 'string' && typeof r.type === 'string') && !objects.some(hasSpanId)) {
    kinds.push('claude-code')
  }
  if (objects.some((r) => CODEX_LINE_TYPES.has(String(r.type)) && isObject(r.payload))) kinds.push('codex')
  if (objects.every(isEvidenceRow)) kinds.push('evidence')
  if (kinds.length === 1) return kinds[0]!
  if (kinds.length === 0) {
    throw new Error(`${path} is not a trace this command reads (OTLP spans, a Claude Code or Codex session, or trace evidence)`)
  }
  throw new AmbiguousTraceInputError(
    `${path} reads as ${kinds.join(' and ')}; pass --format ${kinds.join(' or --format ')}`,
  )
}

const CODEX_LINE_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context'])

function hasSpanId(row: Record<string, unknown>): boolean {
  return typeof row.span_id === 'string'
}

/** Rows the evidence exporter reads that are not already OTLP spans. */
function isEvidenceRow(row: Record<string, unknown>): boolean {
  if (hasSpanId(row)) return false
  if (row.kind === 'traces.policy_evidence.session') return true
  if (Array.isArray(row.messages) || (typeof row.role === 'string' && 'content' in row)) return true
  return typeof row.trace_id === 'string' && typeof row.name === 'string' && isObject(row.attributes)
}

// ── Span mapping ──────────────────────────────────────────────────────

/** The spans of one trace in the shape a contract reads. A timestamp that
 *  does not parse is left missing, so an ordering rule that needs it fails. */
export function contractSpansFromOtlp(spans: readonly OtlpSpan[]): ContractSpan[] {
  return spans.map((span) => {
    const startedAt = epochMs(span.start_time)
    const endedAt = epochMs(span.end_time)
    const args = toolArgumentsFromAttributes(span.attributes)
    const truncated = span.attributes['traces.input.truncated'] === true
    return {
      spanId: span.span_id,
      parentSpanId: span.parent_span_id,
      name: span.name,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(span.status.code === 'ERROR' ? { status: 'error' } : span.status.code === 'OK' ? { status: 'ok' } : {}),
      // A truncated argument capture is not the call's arguments.
      ...(args.argsCaptured && !truncated ? { args: args.args } : { argsCaptured: false }),
      attributes: span.attributes,
    }
  })
}

function epochMs(value: string): number | undefined {
  try {
    return parseIsoToEpochMs(value)
  } catch {
    return undefined
  }
}

/** Spans grouped by trace id, in first-seen order. One contract verdict per trace. */
export function groupByTrace(spans: readonly OtlpSpan[]): Array<{ traceId: string; spans: OtlpSpan[] }> {
  const groups = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const list = groups.get(span.trace_id) ?? []
    list.push(span)
    groups.set(span.trace_id, list)
  }
  return [...groups].map(([traceId, list]) => ({ traceId, spans: list }))
}

// ── Evaluation and reports ────────────────────────────────────────────

export interface TraceCheck {
  traceId: string
  spanCount: number
  verdict: ContractVerdict
  /** Where the evidence was written, when the verdict did not pass. */
  evidenceDir?: string
}

export interface CheckReport {
  contract: string
  status: 'pass' | 'fail' | 'error'
  exitCode: number
  traces: TraceCheck[]
}

export interface RunCheckOptions {
  /** Written only when a trace does not pass. */
  evidenceRoot: string
}

/** Evaluate the contract over every trace in the input and write evidence for
 *  each trace that does not pass. */
export async function runCheck(
  contract: TraceContract,
  spans: readonly OtlpSpan[],
  opts: RunCheckOptions,
): Promise<CheckReport> {
  const traces: TraceCheck[] = []
  for (const group of groupByTrace(spans)) {
    const verdict = evaluateTraceContract(contract, contractSpansFromOtlp(group.spans))
    const check: TraceCheck = { traceId: group.traceId, spanCount: group.spans.length, verdict }
    if (verdict.status !== 'pass') {
      check.evidenceDir = await writeEvidence(opts.evidenceRoot, contract, group.traceId, group.spans, verdict)
    }
    traces.push(check)
  }
  const status = traces.some((t) => t.verdict.status === 'error')
    ? 'error'
    : traces.every((t) => t.verdict.status === 'pass')
      ? 'pass'
      : 'fail'
  const exitCode = status === 'pass' ? CHECK_EXIT.pass : status === 'fail' ? CHECK_EXIT.fail : CHECK_EXIT.badContract
  return { contract: contract.name, status, exitCode, traces }
}

/**
 * Evidence for one trace that did not pass: the verdict, the contract and its
 * plain statement, and the redacted spans the violations cite. Nothing else
 * of the trace leaves it.
 */
async function writeEvidence(
  root: string,
  contract: TraceContract,
  traceId: string,
  spans: readonly OtlpSpan[],
  verdict: ContractVerdict,
): Promise<string> {
  const dir = join(root, `${safeName(contract.name)}-${safeName(traceId).slice(0, 40)}`)
  await mkdir(dir, { recursive: true })
  const cited = new Set(verdict.violations.map((v) => v.spanId).filter((id): id is string => id !== undefined))
  const redacted = redactSpans(spans.filter((s) => cited.has(s.span_id)))
  await writeFile(join(dir, 'verdict.json'), `${JSON.stringify({ traceId, verdict }, null, 2)}\n`)
  await writeFile(join(dir, 'contract.json'), `${JSON.stringify(contract, null, 2)}\n`)
  await writeFile(join(dir, 'explain.txt'), `${explainTraceContract(contract)}\n`)
  await writeFile(join(dir, 'cited-spans.jsonl'), redacted.spans.map((s) => JSON.stringify(s)).join('\n') + (redacted.spans.length ? '\n' : ''))
  return dir
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}

/** A rule as a report shows it. `skipped`: a rule of an alternative that did
 *  not hold while another alternative did, so it decides nothing. */
interface RuleLine {
  rule: string
  status: 'pass' | 'fail' | 'error' | 'skipped'
  error?: string
  details: string[]
}

function ruleLines(verdict: ContractVerdict): RuleLine[] {
  const branchPassed = new Map<string, boolean>()
  for (const e of verdict.ruleExecutions) {
    if (e.alternative === undefined) continue
    branchPassed.set(e.alternative, (branchPassed.get(e.alternative) ?? true) && e.status === 'pass')
  }
  const anyBranchPassed = [...branchPassed.values()].some(Boolean)
  return verdict.ruleExecutions.map((e) => {
    const rule = e.alternative ? `${e.alternative}/${e.rule}` : e.rule
    const status = e.alternative && anyBranchPassed && !branchPassed.get(e.alternative) ? 'skipped' : e.status
    return {
      rule,
      status,
      ...(e.error === undefined ? {} : { error: e.error }),
      details: verdict.violations.filter((x) => x.rule === rule).map((x) => x.detail),
    }
  })
}

/** Human summary: one line per trace, one line per rule. */
export function renderCheckText(report: CheckReport): string {
  const lines: string[] = []
  for (const t of report.traces) {
    const v = t.verdict
    lines.push(`${v.status.toUpperCase()}  contract ${report.contract}  trace ${t.traceId}  (${t.spanCount} spans, ${v.notes})`)
    for (const r of ruleLines(v)) {
      lines.push(`  ${r.status.padEnd(7)} ${r.rule}${r.error ? `  ${r.error}` : ''}`)
      if (r.status === 'fail') for (const detail of r.details.slice(0, 5)) lines.push(`          ${detail}`)
    }
    if (t.evidenceDir) lines.push(`  evidence → ${t.evidenceDir}`)
  }
  return lines.join('\n')
}

/** JUnit XML: one test suite per trace, one test case per rule. */
export function renderJUnit(report: CheckReport): string {
  const suites = report.traces.map((t) => {
    const rules = ruleLines(t.verdict)
    const count = (status: RuleLine['status']) => rules.filter((r) => r.status === status).length
    const cases = rules.map((r) => {
      const open = `    <testcase classname="${xml(report.contract)}" name="${xml(r.rule)}">`
      if (r.status === 'pass') return `${open}</testcase>`
      if (r.status === 'skipped') return `${open}\n      <skipped message="another alternative passed"/>\n    </testcase>`
      if (r.status === 'error') {
        return `${open}\n      <error message="${xml(r.error ?? 'rule could not be evaluated')}"/>\n    </testcase>`
      }
      return `${open}\n      <failure message="${xml(r.details[0] ?? 'rule failed')}">${xml(r.details.join('\n'))}</failure>\n    </testcase>`
    })
    return [
      `  <testsuite name="${xml(`${report.contract} @ ${t.traceId}`)}" tests="${rules.length}" failures="${count('fail')}" errors="${count('error')}" skipped="${count('skipped')}">`,
      ...cases,
      '  </testsuite>',
    ].join('\n')
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="traces check">\n${suites.join('\n')}\n</testsuites>\n`
}

/** GitHub workflow commands: one `::error` per failed or errored rule. */
export function renderGithubAnnotations(report: CheckReport): string {
  const lines: string[] = []
  for (const t of report.traces) {
    for (const r of ruleLines(t.verdict)) {
      if (r.status === 'pass' || r.status === 'skipped') continue
      const detail = r.status === 'error' ? `could not be evaluated: ${r.error ?? 'unknown'}` : r.details.join('\n')
      lines.push(`::error title=${ghProperty(`${report.contract}: ${r.rule}`)}::${ghData(`trace ${t.traceId}: ${detail}`)}`)
    }
  }
  return lines.join('\n')
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 forbids most control characters even when escaped.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function ghData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function ghProperty(value: string): string {
  return ghData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
