/**
 * `traces check`: the one gate. It needs at least one gate and answers 0
 * pass, 1 fail, 2 could not decide, in a form CI reads.
 *
 * - `--contract FILE`: a trace contract over the run's spans (agent-eval's
 *   engine; repeatable).
 * - `--contract conformance`: what the trace can answer at all, the contract
 *   package's own conformance verdict.
 * - `--share-safe`: whether each path is safe to share, read as bytes and
 *   never as a trace (`verify-safe.ts`).
 *
 * Combined, any failing gate fails the check; otherwise any gate that could
 * not decide makes it undecided. The verdict goes to stdout as text, JSON,
 * JUnit XML or GitHub annotations; `--out DIR` receives evidence for each gate
 * that did not pass, and without it nothing is written.
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
import type { TraceValidation } from '@tangle-network/agent-trace-contract'
import { toolArgumentsFromAttributes } from './adapters/tool-io.js'
import type { OtlpSpan } from './otlp.js'
import { redactSpans } from './redact.js'
import { parseIsoToEpochMs } from './time.js'
import { formatVerdict, type VerifySafeResult } from './verify-safe.js'

/** The built-in contract: the trace's conformance, named where a contract file would be. */
export const CONFORMANCE = 'conformance'

/**
 * Exit codes, the CLI's 0 yes, 1 no, 2 could not answer. CI scripts branch on
 * these, so they never change meaning; the JSON error's `code` says which
 * could-not-answer case it was.
 */
export const CHECK_EXIT = Object.freeze({
  pass: 0,
  fail: 1,
  /** A rule or verdict could not run, the contract is malformed, or the trace is unreadable or ambiguous. */
  couldNotDecide: 2,
})

/** A trace reference that names more than one input. */
export class AmbiguousTraceInputError extends Error {
  override name = 'AmbiguousTraceInputError'
}

/** A contract file that cannot be used. */
class ContractFileError extends Error {
  override name = 'ContractFileError'
}

export interface LoadedContract {
  /** The file it was read from, as the command line named it. */
  path: string
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
      path,
      contract: compileTraceContractSpec(json),
      warnings: findings.map((f) => `${f.path}: ${f.message} [${f.code}]`),
    }
  } catch (error) {
    if (error instanceof ContractFileError) throw error
    throw new ContractFileError(`contract ${path}: ${errorText(error)}`)
  }
}

// ── Span mapping ──────────────────────────────────────────────────────

/** The spans of one trace in the shape a contract reads. A timestamp that
 *  does not parse is left missing, so an ordering rule that needs it fails. */
function contractSpansFromOtlp(spans: readonly OtlpSpan[]): ContractSpan[] {
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
function groupByTrace(spans: readonly OtlpSpan[]): Array<{ traceId: string; spans: OtlpSpan[] }> {
  const groups = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const list = groups.get(span.trace_id) ?? []
    list.push(span)
    groups.set(span.trace_id, list)
  }
  return [...groups].map(([traceId, list]) => ({ traceId, spans: list }))
}

// ── Evaluation and reports ────────────────────────────────────────────

interface TraceCheck {
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
  /** Where evidence for each trace that does not pass goes. Omitted, no evidence is written. */
  evidenceRoot?: string
}

/** Evaluate the contract over every trace in the input and, when `evidenceRoot`
 *  is given, write evidence for each trace that does not pass. */
export async function runCheck(
  contract: TraceContract,
  spans: readonly OtlpSpan[],
  opts: RunCheckOptions = {},
): Promise<CheckReport> {
  const traces: TraceCheck[] = []
  for (const group of groupByTrace(spans)) {
    const verdict = evaluateTraceContract(contract, contractSpansFromOtlp(group.spans))
    const check: TraceCheck = { traceId: group.traceId, spanCount: group.spans.length, verdict }
    if (verdict.status !== 'pass' && opts.evidenceRoot !== undefined) {
      check.evidenceDir = await writeEvidence(opts.evidenceRoot, contract, group.traceId, group.spans, verdict)
    }
    traces.push(check)
  }
  const status = traces.some((t) => t.verdict.status === 'error')
    ? 'error'
    : traces.every((t) => t.verdict.status === 'pass')
      ? 'pass'
      : 'fail'
  const exitCode = status === 'pass' ? CHECK_EXIT.pass : status === 'fail' ? CHECK_EXIT.fail : CHECK_EXIT.couldNotDecide
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
function renderCheckText(report: CheckReport): string {
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

/** JUnit test suites of one contract: one suite per trace, one test case per rule. */
function contractSuites(report: CheckReport): string[] {
  return report.traces.map((t) => {
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
}

/** GitHub workflow commands: one `::error` per failed or errored rule. */
function renderGithubAnnotations(report: CheckReport): string {
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

// ── Gates ─────────────────────────────────────────────────────────────

/** What one gate decided. */
export type GateStatus = 'pass' | 'fail' | 'unknown'

export type Gate =
  | { readonly gate: 'contract'; readonly status: GateStatus; readonly report: CheckReport }
  | {
    readonly gate: 'conformance'
    readonly status: GateStatus
    readonly subject: string
    readonly validation: TraceValidation
    /** The conformance report as `traces check --contract conformance` prints it. */
    readonly text: string
  }
  | { readonly gate: 'share-safe'; readonly status: GateStatus; readonly verdict: VerifySafeResult }

export interface CheckVerdict {
  readonly status: GateStatus
  readonly exitCode: number
  readonly gates: readonly Gate[]
}

export function contractGate(report: CheckReport): Gate {
  return { gate: 'contract', status: report.status === 'error' ? 'unknown' : report.status, report }
}

/**
 * Conformance fails on exactly one condition: the input is not a trace, because
 * not one entry could be read as a span (`TraceValidation.ok`). A degraded
 * trace passes on purpose: every real trace is thin somewhere, and a gate that
 * fails on `flat-hierarchy` or `no-usage` is one a producer learns to ignore.
 * What a missing field costs is stated per capability in the report.
 */
export function conformanceGate(subject: string, validation: TraceValidation, text: string): Gate {
  return { gate: 'conformance', status: validation.ok ? 'pass' : 'fail', subject, validation, text }
}

/** SAFE and SAFE_WITH_WARNINGS pass, UNSAFE fails, UNKNOWN cannot decide. */
export function shareSafeGate(verdict: VerifySafeResult): Gate {
  const status = verdict.status === 'UNSAFE' ? 'fail' : verdict.status === 'UNKNOWN' ? 'unknown' : 'pass'
  return { gate: 'share-safe', status, verdict }
}

/** Every gate together: 1 if any fails, else 2 if any could not decide, else 0. */
export function combineGates(gates: readonly Gate[]): CheckVerdict {
  const status: GateStatus = gates.some((gate) => gate.status === 'fail')
    ? 'fail'
    : gates.some((gate) => gate.status === 'unknown') ? 'unknown' : 'pass'
  const exitCode = status === 'pass' ? CHECK_EXIT.pass : status === 'fail' ? CHECK_EXIT.fail : CHECK_EXIT.couldNotDecide
  return { status, exitCode, gates }
}

/**
 * Evidence for each gate that did not pass, under `root`: a contract's per
 * trace directories (written by {@link runCheck}), the conformance report,
 * and the share verdict, which names paths and detectors and never a value.
 */
export async function writeGateEvidence(root: string, verdict: CheckVerdict): Promise<void> {
  for (const gate of verdict.gates) {
    if (gate.status === 'pass' || gate.gate === 'contract') continue
    await mkdir(root, { recursive: true })
    if (gate.gate === 'conformance') await writeFile(join(root, 'conformance.md'), `${gate.text}\n`)
    else await writeFile(join(root, 'share-safe.json'), `${JSON.stringify(gate.verdict, null, 2)}\n`)
  }
}

/** What `--contract conformance` checks, for `check --contract conformance` with no ref. */
export const CONFORMANCE_EXPLAINED = [
  'conformance: whether the input can be read as a trace at all, and which analyses its spans can support.',
  '  fail  not one entry could be read as a span (an empty export, or every line unreadable)',
  '  pass  spans were read; each capability a field they lack costs is listed with what it empties',
].join('\n')

/** Text: one block per gate, in the order given. */
export function renderVerdictText(verdict: CheckVerdict): string {
  return verdict.gates.map((gate) => {
    if (gate.gate === 'contract') return renderCheckText(gate.report)
    if (gate.gate === 'conformance') return gate.text
    return formatVerdict(gate.verdict)
  }).join('\n\n')
}

/** JUnit XML: a suite per contract trace, one for conformance, one per shared path. */
export function renderVerdictJUnit(verdict: CheckVerdict): string {
  const suites = verdict.gates.flatMap((gate): string[] => {
    if (gate.gate === 'contract') return contractSuites(gate.report)
    if (gate.gate === 'conformance') {
      const readable = gate.validation.ok
        ? '    <testcase classname="conformance" name="readable"></testcase>'
        : `    <testcase classname="conformance" name="readable">\n      <failure message="not one entry could be read as a span"/>\n    </testcase>`
      const capabilities = gate.validation.capabilities.map((capability) => capability.available
        ? `    <testcase classname="conformance" name="${xml(capability.name)}"></testcase>`
        : `    <testcase classname="conformance" name="${xml(capability.name)}">\n      <skipped message="${xml(capability.reason ?? 'unavailable')}"/>\n    </testcase>`)
      const unavailable = gate.validation.capabilities.filter((capability) => !capability.available).length
      return [[
        `  <testsuite name="${xml(`conformance @ ${gate.subject}`)}" tests="${capabilities.length + 1}" failures="${gate.validation.ok ? 0 : 1}" errors="0" skipped="${unavailable}">`,
        readable,
        ...capabilities,
        '  </testsuite>',
      ].join('\n')]
    }
    const result = gate.verdict
    const findings = result.findings.map((finding) => `${finding.severity} ${finding.category}/${finding.detector} x${finding.count} at ${finding.paths.join(', ')}`)
    const body = gate.status === 'fail'
      ? `\n      <failure message="${xml(`${result.status}: ${findings[0] ?? ''}`)}">${xml(findings.join('\n'))}</failure>\n    `
      : gate.status === 'unknown'
        ? `\n      <error message="${xml(`UNKNOWN: ${result.unreadable[0] ?? 'part of the input could not be read'}`)}">${xml(result.unreadable.join('\n'))}</error>\n    `
        : findings.length > 0 ? `\n      <system-out>${xml(findings.join('\n'))}</system-out>\n    ` : ''
    return [[
      `  <testsuite name="${xml(`share-safe @ ${result.target}`)}" tests="1" failures="${gate.status === 'fail' ? 1 : 0}" errors="${gate.status === 'unknown' ? 1 : 0}" skipped="0">`,
      `    <testcase classname="share-safe" name="${xml(result.target)}">${body}</testcase>`,
      '  </testsuite>',
    ].join('\n')]
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="traces check">\n${suites.join('\n')}\n</testsuites>\n`
}

/** GitHub workflow commands: `::error` for each failed or undecided rule and gate, `::warning` for each share warning. */
export function renderVerdictGithub(verdict: CheckVerdict): string {
  const lines: string[] = []
  for (const gate of verdict.gates) {
    if (gate.gate === 'contract') {
      const annotations = renderGithubAnnotations(gate.report)
      if (annotations) lines.push(annotations)
    } else if (gate.gate === 'conformance') {
      if (!gate.validation.ok) lines.push(`::error title=${ghProperty('conformance')}::${ghData(`${gate.subject}: not one entry could be read as a span`)}`)
    } else {
      const result = gate.verdict
      for (const finding of result.findings) {
        const kind = finding.severity === 'error' ? 'error' : 'warning'
        lines.push(`::${kind} title=${ghProperty(`share-safe: ${finding.category}/${finding.detector}`)}::${ghData(`${result.target}: x${finding.count} at ${finding.paths.join(', ')}`)}`)
      }
      for (const entry of result.unreadable) lines.push(`::error title=${ghProperty('share-safe: unreadable')}::${ghData(entry)}`)
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
