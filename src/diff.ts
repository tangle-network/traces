/**
 * `traces diff <a> <b>`: where two runs of the same task stop agreeing.
 *
 * The diff is agent-eval's (`diffSteps` in `/pipelines`): steps pair by span id,
 * then by position with the same name and kind, then by name and kind anywhere,
 * and the first divergence is classified as changed, replaced, only-in-a,
 * only-in-b or reordered. This module reads the two runs and prints the result.
 */

import { stat } from 'node:fs/promises'
import { ingestSpans } from '@tangle-network/agent-eval/diagnosis'
import { type DiffStep, diffSteps, diffStepsFromSpans, type StepDiff } from '@tangle-network/agent-eval/pipelines'
import { exportTraceEvidenceFile } from './file-export.js'
import type { OtlpSpan } from './otlp.js'
import { readOtlpInput } from './otlp-input.js'

export interface RunDiffSide {
  /** The path as given, without a `#trace` selector. */
  readonly path: string
  readonly traceId: string
  readonly spans: number
  readonly steps: readonly DiffStep[]
}

export interface RunDiffReport {
  readonly kind: 'traces.run_diff'
  /** The span kinds the steps were limited to; absent when every step was kept. */
  readonly kinds?: readonly string[]
  readonly a: RunDiffSide
  readonly b: RunDiffSide
  readonly diff: StepDiff
}

/**
 * Spans of one input. OTLP (a file, or a directory of OTLP files) is read by
 * the OTLP reader; any other trace file goes through the same importer
 * `traces convert` uses, so a Sandbox SDK event stream diffs directly.
 */
async function readSpans(path: string): Promise<OtlpSpan[]> {
  const otlp = await readOtlpInput(path)
  if (otlp.spans.length > 0) return [...otlp.spans]
  if (!(await stat(path)).isFile()) {
    throw new Error(`${path}: no OTLP spans found (${otlp.issues.length} unusable row(s))`)
  }
  return (await exportTraceEvidenceFile(path)).spans
}

export interface RunDiffOptions {
  /** Keep only steps of these span kinds (e.g. TOOL), so event noise does not mark a divergence. */
  readonly kinds?: readonly string[]
}

/** Read one side: `path` or `path#traceId` when the input holds several runs. */
export async function readRunSide(ref: string, options: RunDiffOptions = {}): Promise<RunDiffSide> {
  const hash = ref.lastIndexOf('#')
  const path = hash > 0 ? ref.slice(0, hash) : ref
  const wanted = hash > 0 ? ref.slice(hash + 1) : undefined
  const byTrace = new Map<string, OtlpSpan[]>()
  for (const span of await readSpans(path)) {
    const list = byTrace.get(span.trace_id)
    if (list) list.push(span)
    else byTrace.set(span.trace_id, [span])
  }
  let traceId = wanted
  if (traceId === undefined) {
    if (byTrace.size !== 1) {
      throw new Error(
        `${path} holds ${byTrace.size} runs; pick one with ${path}#<trace id>: ${[...byTrace.keys()].slice(0, 10).join(', ')}`,
      )
    }
    traceId = [...byTrace.keys()][0]!
  }
  const spans = byTrace.get(traceId)
  if (!spans) throw new Error(`${path} holds no run with trace id ${traceId}`)
  // Metadata only: the diff compares name, kind, status, tool and model.
  const { spans: ingested } = ingestSpans(spans, { contentIncluded: false })
  const kinds = options.kinds?.length ? new Set(options.kinds.map((kind) => kind.toUpperCase())) : null
  const steps = diffStepsFromSpans(ingested).filter((step) => kinds === null || kinds.has(step.kind))
  return { path, traceId, spans: spans.length, steps }
}

export async function diffRuns(a: string, b: string, options: RunDiffOptions = {}): Promise<RunDiffReport> {
  const [left, right] = await Promise.all([readRunSide(a, options), readRunSide(b, options)])
  return {
    kind: 'traces.run_diff',
    ...(options.kinds?.length ? { kinds: options.kinds.map((kind) => kind.toUpperCase()) } : {}),
    a: left,
    b: right,
    diff: diffSteps(left.steps, right.steps),
  }
}

/** Steps listed in text output before the rest are counted. */
const TEXT_STEP_LIMIT = 40

function label(step: DiffStep): string {
  return `${step.kind} ${JSON.stringify(step.name)}`
}

export function renderRunDiff(report: RunDiffReport): string {
  const { a, b, diff } = report
  const byPairing = { id: 0, position: 0, name: 0 }
  for (const pair of diff.pairs) byPairing[pair.pairedBy] += 1
  const lines = [
    ...(report.kinds ? [`steps limited to kind ${report.kinds.join(', ')}`] : []),
    `A: ${a.path} (trace ${a.traceId}, ${a.steps.length} steps)`,
    `B: ${b.path} (trace ${b.traceId}, ${b.steps.length} steps)`,
    `paired ${diff.pairs.length} (by id ${byPairing.id}, position ${byPairing.position}, name ${byPairing.name}), ` +
      `only in A ${diff.onlyInA.length}, only in B ${diff.onlyInB.length}, common prefix ${diff.commonPrefixLen}`,
  ]
  const first = diff.firstDivergence
  if (!first) {
    lines.push('no divergence: the runs agree step for step')
    return `${lines.join('\n')}\n`
  }
  lines.push(`first divergence [${first.kind}] at step ${first.index}: ${first.reason}`)
  const details: string[] = []
  for (const pair of diff.pairs) {
    if (pair.differences.length === 0) continue
    const changes = pair.differences.map((d) => `${d.field} ${String(d.a)} -> ${String(d.b)}`).join('; ')
    details.push(`  changed    A[${pair.a}]~B[${pair.b}] ${label(a.steps[pair.a]!)}: ${changes}`)
  }
  for (const index of diff.onlyInA) details.push(`  only in A  A[${index}] ${label(a.steps[index]!)}`)
  for (const index of diff.onlyInB) details.push(`  only in B  B[${index}] ${label(b.steps[index]!)}`)
  lines.push(...details.slice(0, TEXT_STEP_LIMIT))
  if (details.length > TEXT_STEP_LIMIT) {
    lines.push(`  … ${details.length - TEXT_STEP_LIMIT} more (use --format json for all)`)
  }
  return `${lines.join('\n')}\n`
}
