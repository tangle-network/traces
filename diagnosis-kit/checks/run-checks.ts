/**
 * The measurable half of a diagnosis: `traces analyze <spans> --format json`,
 * mapped onto the fields `templates/findings.schema.json` names. What the
 * trace cannot support (`conformance`) becomes `coverage.capabilities`; every
 * question it cannot answer (`cannotAnswer`, unread sessions included) and
 * every row it could not read becomes `coverage.skipped`; the stuck loops,
 * failing tool calls and blind retries (`measures`) become observed findings,
 * each with its number and span ids.
 *
 * Deterministic and model-free, so it runs unchanged for a customer who refuses
 * third-party model processing, and the customer re-runs the same command.
 * Run it on the prepared bundle (`prepare-bundle.ts`), which holds metadata
 * only; `--content` records an engagement that opted in to content.
 *
 * Usage:
 *   tsx diagnosis-kit/checks/run-checks.ts <spans.otlp.jsonl|dir> [--content] [--label TEXT]
 */

import { reason, traces } from './traces.js'

interface Analysis {
  facts: { sessions: Array<{ firstRecordAt: { value: string | null }; lastRecordAt: { value: string | null } }> }
  measures: {
    stuckLoops: { findings: Array<{ toolName: string; occurrences: number; spanIds: string[]; windowMs: number }> }
    toolErrors: Array<{ sessionId: string; calls: number; clusters: Array<{ tool: string; count: number; spanIds: string[] }> }>
    failureFollowUps?: { followed: number; blind: number; items: Array<{ kind: string; failedSpanId: string; followUpSpanId: string | null }> }
  }
  conformance: {
    capabilities: Array<{ name: string; available: boolean; reason?: string }>
    findings: Array<{ severity: string; code: string; message: string }>
  }
  cannotAnswer: Array<{ analysis: string; reason: string; sessionId?: string }>
}

interface Finding {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  claim: string
  consequence: string
  measure: { name: string; value: number; unit: string; denominator?: string }
  evidence: string[]
  reproduce: string
  confidence: 'observed'
}

function usage(): never {
  console.error('usage: run-checks.ts <spans.otlp.jsonl|dir> [--content] [--label TEXT]')
  process.exit(2)
}

function parseArgs(argv: readonly string[]): { input: string; content: boolean; label: string } {
  let input: string | undefined
  let content = false
  let label = 'agent traces'
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '--content') content = true
    else if (word === '--label' && argv[i + 1] !== undefined) label = argv[++i]!
    else if (!word.startsWith('-') && input === undefined) input = word
    else usage()
  }
  return input === undefined ? usage() : { input, content, label }
}

/** The window the runs span, as an ISO interval; empty when no run records a time. */
function windowOf(analysis: Analysis): string {
  const starts = analysis.facts.sessions.flatMap((s) => (s.firstRecordAt.value ? [s.firstRecordAt.value] : [])).sort()
  const ends = analysis.facts.sessions.flatMap((s) => (s.lastRecordAt.value ? [s.lastRecordAt.value] : [])).sort()
  return starts.length > 0 && ends.length > 0 ? `${starts[0]}/${ends.at(-1)}` : ''
}

function findingsOf(analysis: Analysis, reproduce: string): Finding[] {
  const findings: Finding[] = []
  analysis.measures.stuckLoops.findings.forEach((loop, i) => findings.push({
    id: `stuck-loop-${i + 1}`,
    severity: 'high',
    claim: `${loop.toolName} ran ${loop.occurrences} times in a row with the same arguments.`,
    consequence: `${loop.occurrences} identical calls in ${Math.round(loop.windowMs / 1000)} s, none of which could change the result.`,
    measure: { name: 'identical consecutive calls', value: loop.occurrences, unit: 'calls' },
    evidence: loop.spanIds,
    reproduce,
    confidence: 'observed',
  }))
  for (const run of analysis.measures.toolErrors) {
    run.clusters.forEach((cluster, i) => findings.push({
      id: `failing-calls-${run.sessionId}-${i + 1}`,
      severity: 'medium',
      claim: `${cluster.count} ${cluster.tool} call(s) failed the same way.`,
      consequence: `${cluster.count} of ${run.calls} tool calls in this run failed with one error.`,
      measure: { name: 'failed tool calls', value: cluster.count, unit: 'calls', denominator: `${run.calls} tool calls` },
      evidence: cluster.spanIds,
      reproduce,
      confidence: 'observed',
    }))
  }
  const followUps = analysis.measures.failureFollowUps
  const blind = followUps?.items.filter((item) => item.kind === 'blind') ?? []
  if (followUps && blind.length > 0) {
    findings.push({
      id: 'blind-retries',
      severity: 'medium',
      claim: `${blind.length} failed call(s) were retried with identical arguments.`,
      consequence: `${blind.length} of ${followUps.followed} retried failures repeated the call that had just failed.`,
      measure: { name: 'blind retries', value: blind.length, unit: 'retries', denominator: `${followUps.followed} retried failures` },
      evidence: blind.flatMap((item) => [item.failedSpanId, ...(item.followUpSpanId ? [item.followUpSpanId] : [])]),
      reproduce,
      confidence: 'observed',
    })
  }
  return findings.filter((finding) => finding.evidence.length > 0)
}

function main(): void {
  const { input, content, label } = parseArgs(process.argv.slice(2))
  const run = traces(['analyze', input, '--format', 'json'])
  if (run.code !== 0) throw new Error(`traces analyze could not answer: ${reason(run)}`)
  const analysis = JSON.parse(run.stdout) as Analysis
  const unreadable = analysis.conformance.findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => ({ analysis: `conformance: ${finding.code}`, reason: finding.message }))
  console.log(JSON.stringify({
    schemaVersion: 1,
    subject: { label, runCount: analysis.facts.sessions.length, window: windowOf(analysis), contentIncluded: content },
    coverage: {
      capabilities: Object.fromEntries(analysis.conformance.capabilities.map((capability) => [
        capability.name,
        capability.available ? { available: true } : { available: false, reason: capability.reason ?? 'no reason recorded' },
      ])),
      skipped: [...analysis.cannotAnswer.map(({ analysis: what, reason: why }) => ({ analysis: what, reason: why })), ...unreadable],
    },
    findings: findingsOf(analysis, `traces analyze ${input} --format json`),
  }, null, 2))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
