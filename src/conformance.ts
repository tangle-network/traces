/**
 * What a trace can and cannot answer, said out loud.
 *
 * `@tangle-network/agent-trace-contract` decides conformance: it reports
 * findings (what is wrong, and the consequence) and capabilities (what a
 * consumer can compute, and why not when it cannot). That package is
 * deliberately generic. This module adds the one thing it cannot know — which
 * section of THIS report each missing capability empties — so a thin report
 * explains its own thinness instead of reading as "the agent did nothing".
 */

import {
  type Capability,
  type ConformanceFinding,
  type ContractSpan,
  type TraceValidation,
  validateTraceSpans,
} from '@tangle-network/agent-trace-contract'
import {
  type OtlpFieldWithheld,
  type OtlpIngestIssue,
  type OtlpInputFile,
  type SkippedInputFile,
  TRACE_ID_MINTED_ATTR,
  type UnreadableSourceRows,
} from './otlp-input.js'
import type { OtlpSpan } from './otlp.js'
import { toOpenInferenceSpan } from './otlp.js'

/** Span ids listed per finding before the rest are summarized as a count. */
const SPAN_ID_SAMPLE = 5
const ISSUE_SAMPLE = 10

const SEVERITY_BADGE: Record<string, string> = {
  error: '🔴 ERROR',
  warn: '🟠 WARN',
  info: 'ℹ️  INFO',
}

/**
 * The analysis each capability gates, named as it appears in the report a
 * reader is holding. Anything not listed here is analysed regardless of
 * conformance — the deterministic loop/thrash/reaction passes need only span
 * names, times and ordering.
 *
 * `built: false` means THIS package has no such analysis yet. It is stated
 * rather than omitted, because listing an analysis a reader will never find is
 * how a capability table starts describing a report that does not exist.
 */
interface CapabilityAnalysis {
  readonly analysis: string
  readonly built: boolean
}

const CAPABILITY_ANALYSES: Record<string, CapabilityAnalysis> = {
  'token-accounting': {
    analysis: 'execution facts → Direct model usage (input/output/reasoning/cache token totals)',
    built: true,
  },
  'cost-attribution': {
    analysis: 'execution facts → Cost coverage (observed vs estimated USD)',
    built: true,
  },
  'tool-usage': {
    analysis: 'tool-usage table + per-tool duplicate/retry/error rates + stuck-loop detection',
    built: true,
  },
  'loop-convergence': {
    analysis: 'round-over-round convergence (did round N+1 improve on N)',
    built: true,
  },
  'tree-comparison': {
    analysis: 'arm-vs-arm comparison across branches of one run — NOT YET IMPLEMENTED in this package',
    built: false,
  },
  'steering-chain': {
    analysis: 'steering chain (which verdict caused which retry)',
    built: true,
  },
  'latency-analysis': {
    analysis: 'latency + critical-path timing distributions',
    built: true,
  },
}

/**
 * Capabilities the trace cannot support, mapped to the trace's own reason.
 *
 * This is what makes the conformance section GATE rather than narrate: the
 * renderer takes it and marks every section whose inputs are incomplete, at the
 * table, so a number and the reason it is wrong cannot end up forty lines
 * apart.
 */
export type UnavailableCapabilities = ReadonlyMap<string, string>

/** The trace's unavailable capabilities, each mapped to the validator's own reason. */
export function unavailableCapabilities(validation: TraceValidation): UnavailableCapabilities {
  return new Map(
    validation.capabilities
      .filter((capability) => !capability.available)
      .map((capability) => [capability.name, capability.reason ?? 'no reason recorded']),
  )
}

/**
 * The inline marker a section carries when its inputs are incomplete. Empty
 * when the capability is available — the caller concatenates unconditionally,
 * so a section can never be marked in one place and silently not in another.
 */
export function incompleteInputsNote(
  unavailable: UnavailableCapabilities | undefined,
  capability: string,
): string {
  const reason = unavailable?.get(capability)
  return reason === undefined
    ? ''
    : `> ⚠️ **Inputs incomplete — \`${capability}\` unavailable:** ${reason}. ` +
      'Whatever appears below was computed from the spans that DID carry the field and describes ' +
      'only those; it is not a measurement of the run.'
}

export interface SpanStructure {
  readonly spans: number
  readonly traces: number
  /** Spans carrying no `parent_span_id` at all. */
  readonly rootless: number
  /**
   * Rootless spans BEYOND the one root each trace is supposed to have. This,
   * not `rootless`, is the number of spans that attribute to nothing: a
   * textbook-correct trace has exactly one root, so `rootless === traces` with
   * one root each is a conforming shape and must read as one.
   */
  readonly extraRoots: number
  /** Traces where every span names a parent, so the trace has no top at all. */
  readonly tracesWithoutRoot: number
  /** Spans naming a parent that is absent from the export. */
  readonly orphans: number
  readonly links: number
}

/**
 * How much of the span tree actually attaches.
 *
 * The contract's `flat-hierarchy` finding is per-trace and all-or-nothing: one
 * parented span anywhere in a trace suppresses it for every other span. A trace
 * where the overwhelming majority of spans have no parent is not flat by that
 * definition and is entirely flat in practice, so this reports the DEGREE the
 * binary finding cannot express. It measures, it does not re-implement — the
 * finding still comes from the validator.
 *
 * Roots are counted PER TRACE, because "has no parent" is the definition of a
 * root, not of a defect. Counting every rootless span as unattributed made a
 * correct one-root trace narrate itself as broken.
 */
export function summarizeSpanStructure(spans: readonly OtlpSpan[]): SpanStructure {
  const ids = new Set(spans.map((span) => span.span_id))
  const rootsByTrace = new Map<string, number>()
  let rootless = 0
  let orphans = 0
  let links = 0
  for (const span of spans) {
    links += span.links?.length ?? 0
    if (!rootsByTrace.has(span.trace_id)) rootsByTrace.set(span.trace_id, 0)
    if (span.parent_span_id === null) {
      rootless += 1
      rootsByTrace.set(span.trace_id, (rootsByTrace.get(span.trace_id) ?? 0) + 1)
    } else if (!ids.has(span.parent_span_id)) orphans += 1
  }
  let extraRoots = 0
  let tracesWithoutRoot = 0
  for (const roots of rootsByTrace.values()) {
    if (roots === 0) tracesWithoutRoot += 1
    else extraRoots += roots - 1
  }
  return {
    spans: spans.length,
    traces: rootsByTrace.size,
    rootless,
    extraRoots,
    tracesWithoutRoot,
    orphans,
    links,
  }
}

function renderStructure(lines: string[], structure: SpanStructure): void {
  const share = structure.spans === 0 ? 0 : (structure.rootless / structure.spans) * 100
  lines.push(
    `**Span structure:** ${structure.spans} spans across ${structure.traces} trace(s); ` +
      `${structure.rootless}/${structure.spans} (${share.toFixed(1)}%) carry no parent edge ` +
      `(${structure.traces} of those are the trace roots); ` +
      `${structure.orphans} name a parent absent from the export; ${structure.links} causal link(s).`,
  )
  lines.push('')
  if (structure.extraRoots === structure.spans - structure.traces && structure.extraRoots > 0) {
    lines.push(
      '> Every span is its own root. Nothing rolls up: there is no run, round or session to attribute ' +
        'cost, tokens or outcomes to, only a list of events.',
    )
    lines.push('')
  } else if (structure.extraRoots > 0) {
    lines.push(
      `> ${structure.extraRoots} span(s) attribute to nothing: beyond the one root each trace is entitled ` +
        'to, their model calls, tool calls and verdicts roll up to no enclosing unit of work, so only the ' +
        `${structure.spans - structure.extraRoots} attached span(s) can be charged to the run that caused them.`,
    )
    lines.push('')
  }
  if (structure.tracesWithoutRoot > 0) {
    lines.push(
      `> ${structure.tracesWithoutRoot} trace(s) have no root at all: every span names a parent, and the ` +
        'top of the tree is absent from the export, so nothing in them can be charged to a run.',
    )
    lines.push('')
  }
  if (structure.links === 0) {
    lines.push(
      '> No causal links. Containment (`parent_span_id`) was recorded; causality (round N\'s verdict ' +
        'CAUSING round N+1) was not, so a steering or retry chain cannot be followed.',
    )
    lines.push('')
  }
}

export interface SkippedAnalysis {
  readonly capability: string
  /** The analysis in this report that the missing capability empties. */
  readonly analysis: string
  /** The trace's own reason, from the contract validator. */
  readonly reason: string
}

/**
 * Conformance of spans this package produced (adapters, importers), measured on
 * the same OpenInference projection that gets written to disk — so the report
 * grades the artifact a consumer would actually receive, not an in-memory shape
 * nobody sees. For spans read from a foreign OTLP file, validate the RAW rows
 * instead (`readOtlpInput` does): that tells the producer what to fix rather
 * than describing our own normalization back to them.
 */
export function conformanceOfSpans(spans: readonly OtlpSpan[]): TraceValidation {
  return validateTraceSpans(spans.map(toOpenInferenceSpan) as unknown as readonly ContractSpan[])
}

/** Unavailable capabilities, paired with the analysis each one empties. */
export function skippedAnalyses(validation: TraceValidation): SkippedAnalysis[] {
  return validation.capabilities
    .filter((capability) => !capability.available)
    .map((capability) => ({
      capability: capability.name,
      analysis: CAPABILITY_ANALYSES[capability.name]?.analysis ?? 'analyses keyed off this capability',
      reason: capability.reason ?? 'no reason recorded',
    }))
}

/** Capabilities the trace supports that this package has no analysis for yet. */
function unbuiltAnalyses(validation: TraceValidation): string[] {
  return validation.capabilities
    .filter((capability) => capability.available && CAPABILITY_ANALYSES[capability.name]?.built === false)
    .map((capability) => capability.name)
}

function tableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim()
}

function spanIdSample(finding: ConformanceFinding): string {
  const ids = finding.spanIds ?? []
  if (ids.length === 0) return ''
  const shown = ids.slice(0, SPAN_ID_SAMPLE).map((id) => `\`${tableCell(id)}\``).join(', ')
  return ids.length > SPAN_ID_SAMPLE ? `${shown} +${ids.length - SPAN_ID_SAMPLE} more` : shown
}

function capabilityRow(capability: Capability): string {
  const entry = CAPABILITY_ANALYSES[capability.name]
  const analysis = entry?.analysis ?? '—'
  if (!capability.available) {
    return `| \`${capability.name}\` | ❌ unavailable | ${tableCell(analysis)} | ${tableCell(capability.reason ?? 'no reason recorded')} |`
  }
  return entry?.built === false
    ? `| \`${capability.name}\` | ⚠️ available, unused | ${tableCell(analysis)} | the trace supports it; this package has no analysis for it yet |`
    : `| \`${capability.name}\` | ✅ available | ${tableCell(analysis)} | — |`
}

export interface ConformanceRenderOptions {
  /** What was validated, e.g. a file path or "spans emitted by the claude-code adapter". */
  readonly subject: string
  /** Files read, when the source was an OTLP file or directory. */
  readonly files?: readonly OtlpInputFile[]
  /** JSONL files in the directory that hold something other than OTLP spans. */
  readonly skipped?: readonly SkippedInputFile[]
  /** Rows that never became spans, when the source was an OTLP file or directory. */
  readonly issues?: readonly OtlpIngestIssue[]
  /** Rows that DID become spans, with one field withheld from them. */
  readonly withheld?: readonly OtlpFieldWithheld[]
  /** Source rows absent from this file — this ingest's, and any earlier export's. */
  readonly unreadable?: UnreadableSourceRows
  /** The spans that were analysed, for the hierarchy summary. */
  readonly spans?: readonly OtlpSpan[]
  /** Markdown heading level for the section title (default 2). */
  readonly headingLevel?: number
}

/**
 * Rows an EARLIER export dropped: absent from this file, so no finding here can
 * be about them.
 *
 * This is what stops a round trip through `traces` from laundering a trace. A
 * dropped row cannot be re-emitted — it is not a span, and the export is also
 * the file this package's analysts read — so the export refuses the equivalence
 * instead: it carries the count of what it is missing, and this is where a
 * reader is told the artifact's clean findings are not the source's.
 */
function renderInheritedLoss(lines: string[], unreadable: UnreadableSourceRows | undefined): void {
  if (unreadable === undefined || unreadable.inherited === 0) return
  lines.push(
    `**${unreadable.inherited} row(s) of the ORIGINAL source are not in this file.** It is a re-export: ` +
      `${unreadable.kinds.join(', ')} row(s) could not be represented as spans and were left behind by an ` +
      'earlier hop, so nothing below is a finding about them. The findings here describe what survived, ' +
      'and this file is NOT a substitute for validating the source.',
  )
  lines.push('')
}

/**
 * Fields this tool wrote into the file that the producer did not.
 *
 * Every substituted field is re-emitted as the producer wrote it, so the
 * findings below are the source's — except `trace_id`, which cannot be: the
 * artifact is also the store `agent-eval` reads, and that store drops any row
 * with no `trace_id` and then fails the whole analysis on the drop. So a span
 * whose producer wrote no trace id carries one this tool minted, and the
 * source's `missing-trace-id` is NOT among the findings below. Saying so is the
 * difference between a copy that is honest about what it is and one that hands
 * back a clean bill of health the source never earned.
 */
function renderMintedFields(lines: string[], spans: readonly OtlpSpan[] | undefined): void {
  const minted = spans?.filter((span) => span.attributes[TRACE_ID_MINTED_ATTR] === true) ?? []
  if (minted.length === 0) return
  const ids = [...new Set(minted.map((span) => span.trace_id))]
  lines.push(
    `**${minted.length} span(s) carry a trace_id this tool minted** (${ids.slice(0, 3).map((id) => `\`${tableCell(id)}\``).join(', ')}` +
      `${ids.length > 3 ? `, +${ids.length - 3} more` : ''}): their producer wrote none, and a file whose rows ` +
      'carry no trace id cannot be read back at all. So `missing-trace-id` is NOT reported below even though ' +
      'the source earns it — the minted id is recorded per span under `traces.raw_attribute.trace_id` / ' +
      '`traces.substituted_fields`, and this file is NOT a substitute for validating the source.',
  )
  lines.push('')
}

function renderIngest(
  lines: string[],
  files: readonly OtlpInputFile[] | undefined,
  skipped: readonly SkippedInputFile[] | undefined,
  issues: readonly OtlpIngestIssue[] | undefined,
  withheld: readonly OtlpFieldWithheld[] | undefined,
): void {
  if (files && files.length > 0) {
    const rows = files.reduce((total, file) => total + file.rows, 0)
    const spans = files.reduce((total, file) => total + file.spans, 0)
    const repeats = files.reduce((total, file) => total + file.repeats, 0)
    lines.push(
      `**Ingested:** ${spans} span(s) from ${rows} row(s) across ${files.length} OTLP file(s)` +
        (repeats > 0 ? `; ${repeats} row(s) re-declared a span already read, identically.` : '.'),
    )
    lines.push('')
    lines.push('| File | Rows | Spans | Identical repeats |')
    lines.push('|---|---:|---:|---:|')
    for (const file of files) {
      lines.push(`| \`${tableCell(file.path)}\` | ${file.rows} | ${file.spans} | ${file.repeats} |`)
    }
    lines.push('')
    if (repeats > 0) {
      lines.push(
        '> Identical repeats are not a defect. A multi-shot run writes one file per shot and each file ' +
          're-declares the run and cell spans it hangs under, so every file is analysable on its own; ' +
          'reading them together collapses those back to one span. Only a repeat with DIFFERENT content ' +
          'is reported as a problem.',
      )
      lines.push('')
    }
  }
  if (skipped && skipped.length > 0) {
    lines.push(
      `**${skipped.length} JSONL file(s) in this directory are not OTLP** and were not read. Their lines ` +
        'are not counted above and produce no findings: they were never claimed to be spans.',
    )
    lines.push('')
    lines.push('| File | What it holds |')
    lines.push('|---|---|')
    for (const file of skipped.slice(0, ISSUE_SAMPLE)) {
      lines.push(`| \`${tableCell(file.path)}\` | ${tableCell(file.reason)} |`)
    }
    if (skipped.length > ISSUE_SAMPLE) {
      lines.push(`| ... | ${skipped.length - ISSUE_SAMPLE} more omitted |`)
    }
    lines.push('')
  }
  if (issues && issues.length > 0) {
    lines.push(
      `**${issues.length} row(s) could not be analysed.** They are excluded from every count above ` +
        'rather than repaired, because a synthesized timestamp or id would put invented work into the totals.',
    )
    lines.push('')
    lines.push('| Reason | File | Line | Detail |')
    lines.push('|---|---|---:|---|')
    for (const issue of issues.slice(0, ISSUE_SAMPLE)) {
      lines.push(`| ${issue.kind} | \`${tableCell(issue.file)}\` | ${issue.line} | ${tableCell(issue.detail)} |`)
    }
    if (issues.length > ISSUE_SAMPLE) {
      lines.push(`| ... | ${issues.length - ISSUE_SAMPLE} more omitted | - | - |`)
    }
    lines.push('')
  }
  if (withheld && withheld.length > 0) {
    lines.push(
      `**${withheld.length} span(s) were analysed with one field withheld.** They ARE counted above and in ` +
        'every table that does not read the named field: a span with an unusable timestamp still has a real ' +
        'identity, name, tool and status, and dropping it would delete real work from every total to avoid ' +
        'one wrong number. The field itself is withheld, never repaired.',
    )
    lines.push('')
    lines.push('| Reason | Field | File | Line | Detail |')
    lines.push('|---|---|---|---:|---|')
    for (const entry of withheld.slice(0, ISSUE_SAMPLE)) {
      lines.push(
        `| ${entry.kind} | \`${tableCell(entry.field)}\` | \`${tableCell(entry.file)}\` | ${entry.line} | ` +
          `${tableCell(entry.detail)} |`,
      )
    }
    if (withheld.length > ISSUE_SAMPLE) {
      lines.push(`| ... | - | ${withheld.length - ISSUE_SAMPLE} more omitted | - | - |`)
    }
    lines.push('')
  }
}

/** Findings, capabilities and skipped analyses, without a section heading. */
function conformanceBody(
  validation: TraceValidation,
  opts: ConformanceRenderOptions,
): string {
  const heading = '#'.repeat(opts.headingLevel ?? 2)
  const lines: string[] = []
  const errors = validation.findings.filter((finding) => finding.severity === 'error').length
  const warnings = validation.findings.filter((finding) => finding.severity === 'warn').length
  const infos = validation.findings.filter((finding) => finding.severity === 'info').length
  const unavailable = validation.capabilities.filter((capability) => !capability.available)

  lines.push(
    `${errors} error, ${warnings} warn, ${infos} info finding(s); ` +
      `${validation.capabilities.length - unavailable.length}/${validation.capabilities.length} ` +
      'analysis capabilities available.',
  )
  lines.push('')
  renderInheritedLoss(lines, opts.unreadable)
  renderMintedFields(lines, opts.spans)
  renderIngest(lines, opts.files, opts.skipped, opts.issues, opts.withheld)
  if (opts.spans && opts.spans.length > 0) renderStructure(lines, summarizeSpanStructure(opts.spans))

  if (validation.findings.length > 0) {
    lines.push('| Severity | Code | Consequence | Blocks | Spans |')
    lines.push('|---|---|---|---|---|')
    for (const finding of validation.findings) {
      const badge = SEVERITY_BADGE[finding.severity] ?? finding.severity
      const blocks = finding.blocks?.length ? finding.blocks.map((name) => `\`${name}\``).join(', ') : '—'
      lines.push(
        `| ${badge} | \`${tableCell(finding.code)}\` | ${tableCell(finding.message)} | ${blocks} | ${spanIdSample(finding) || '—'} |`,
      )
    }
    lines.push('')
  } else {
    lines.push('No conformance findings: the spans carry every field this analysis reads.')
    lines.push('')
  }

  lines.push('| Capability | State | Analysis it drives | Why not |')
  lines.push('|---|---|---|---|')
  for (const capability of validation.capabilities) lines.push(capabilityRow(capability))
  lines.push('')

  const skipped = skippedAnalyses(validation)
  const unbuilt = unbuiltAnalyses(validation)
  if (skipped.length > 0 || unbuilt.length > 0) {
    lines.push(`${heading}# analyses skipped, and why`)
    lines.push('')
    if (skipped.length > 0) {
      lines.push(
        'These reported nothing because the trace never carried what they read — not because the run ' +
          'was uneventful. Every section they feed is marked at the table, not only here.',
      )
      lines.push('')
      for (const entry of skipped) {
        lines.push(`- **${entry.analysis}** — skipped: ${entry.reason} (\`${entry.capability}\`).`)
      }
      lines.push('')
    }
    if (unbuilt.length > 0) {
      lines.push(
        `These are supported by the trace and **not yet implemented here**: ` +
          `${unbuilt.map((name) => `\`${name}\``).join(', ')}. The spans carry what they need; the ` +
          'analysis does not exist, so nothing about them appears below.',
      )
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * The conformance section of an analysis report: findings, the capability
 * table, and — the part that makes a thin report honest — the named analyses
 * that produced nothing and why.
 */
export function renderConformance(
  validation: TraceValidation,
  opts: ConformanceRenderOptions,
): string {
  const heading = '#'.repeat(opts.headingLevel ?? 2)
  return `${heading} trace conformance — ${opts.subject}\n\n${conformanceBody(validation, opts)}`
}

/**
 * The `traces validate` report. Same body, plus a verdict line a reader (or a
 * CI job reading the exit code) can act on.
 *
 * The three verdicts are the three answers `@tangle-network/agent-trace-contract`
 * can give, in its own terms — `ok` says whether the input is a trace AT ALL, and
 * `capabilities` says what a trace can answer. Nothing here re-derives either.
 */
export function renderValidation(
  validation: TraceValidation,
  opts: ConformanceRenderOptions,
): string {
  const errors = validation.findings.filter((finding) => finding.severity === 'error')
  const available = validation.capabilities.filter((capability) => capability.available)
  const verdict = !validation.ok
    ? `NOT A TRACE — ${errors.length} error finding(s): not one entry in this export could be read as a ` +
      'span, so there is nothing to analyse and every capability below is unavailable. An empty export and ' +
      'one whose every line was unreadable both land here. This is the only state that exits non-zero.'
    : available.length === 0
      ? `ANALYSABLE, WITH NOTHING TO ANALYSE — spans WERE read, so this is a trace, but ` +
        `0/${validation.capabilities.length} capabilities are available: every analysis this package runs ` +
        'reads a field none of these spans carry. The rows below name what each one is missing. Exits 0, ' +
        'because the export is readable — a caller deciding whether to spend a run should read the ' +
        'capability table, not the exit code.'
      : 'CONFORMS — analysable. Every finding below is a degradation of a readable trace, not a bar to ' +
        'reading it; each one names the capability it costs.'
  return `# trace conformance — ${opts.subject}\n\n**${verdict}**\n\n${conformanceBody(validation, { ...opts, headingLevel: 2 })}`
}

/**
 * Exit code for `traces validate`, which is read by CI.
 *
 * Non-zero on exactly one condition: the input is not a trace. That is what
 * `TraceValidation.ok` means and the contract's severities are defined to match
 * it — `error` is "nothing readable", `warn` is "readable but degraded", `info`
 * is "nothing lost" — so a severity scan here would only be a second, driftable
 * copy of the same rule.
 *
 * A degraded trace exits 0 deliberately. Failing on degradation is failing on
 * thinness, and every real-world trace is thin somewhere: a gate that red-lights
 * `flat-hierarchy` or `no-usage` is one a producer learns to ignore. What a
 * missing field costs is stated per capability, in the table, where it can be
 * acted on.
 */
export function validationExitCode(validation: TraceValidation): number {
  return validation.ok ? 0 : 1
}
