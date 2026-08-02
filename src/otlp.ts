/**
 * OTLP-flat-line emitter — the canonical normalized trace shape.
 *
 * Every harness adapter projects its native session log onto `OtlpSpan[]`.
 * `serializeSpans` emits one COMPLETE OpenInference span per JSONL line
 * (top-level `kind`, `resource`, `scope`, string `parent_span_id`, plus the
 * `openinference.span.kind` attribute). One standard artifact feeds three
 * consumers unchanged: `@tangle-network/agent-eval`'s `OtlpFileTraceStore`
 * (which reads the attribute vocabulary), HALO, and any OpenInference tool.
 *
 * Attribute vocabulary the downstream analysts key off:
 *   - `openinference.span.kind`  → span kind ({@link OtlpSpanKind})
 *   - `service.name`             → harness id (claude-code, codex, …)
 *   - `agent.name`               → agent / subagent name
 *   - `llm.model_name`           → model
 *   - shared `llm.token_count.*` keys → input, output, reasoning, and cache usage
 *   - `tool.name`                → tool histogram (monoculture / no-verify)
 *   - `step`                     → run order (falls back to start_time)
 */

import {
  applyLlmSpanOtlpAttributes,
  LLM_COST_USD,
  LLM_INPUT_TOKENS,
  LLM_MODEL_NAME,
  LLM_OUTPUT_TOKENS,
  OPENINFERENCE_SPAN_KIND,
  TOOL_NAME,
} from '@tangle-network/agent-eval/trace-attributes'
import type { SpanKind } from '@tangle-network/agent-trace-contract'
import { traceContractBuildIdOrNull } from './contract-build.js'
import { RAW_FIELD_ATTRIBUTES, SUBSTITUTED_FIELDS_ATTR, type SubstitutedField } from './otlp-input.js'
import { validateOtlpSpans } from './span-validation.js'

/**
 * The span-kind vocabulary, which is exactly
 * `@tangle-network/agent-trace-contract`'s — AGENT, CHAIN, LLM, TOOL,
 * EVALUATOR, RETRIEVER, UNKNOWN.
 *
 * It is an alias, not a copy, because the two vocabularies MUST NOT drift: a
 * narrower local union silently re-typed every kind it did not list, so a
 * producer's EVALUATOR verdict span came back out as CHAIN and the re-exported
 * file no longer said what the original did.
 */
export type OtlpSpanKind = SpanKind

export type OtlpStatusCode = 'OK' | 'ERROR' | 'UNSET'

/**
 * A causal edge that is NOT containment. `parent_span_id` says "this span
 * happened INSIDE that one"; a link says "that one CAUSED this one" — round N's
 * verdict steering round N+1, a retry pointing at the attempt it replaces.
 * Encoding those as a parent would claim a nesting that never existed, so OTLP
 * gives them their own edge and this model keeps it.
 *
 * Matches `SpanLink` in `@tangle-network/agent-trace-contract`.
 */
export interface OtlpSpanLink {
  trace_id: string
  span_id: string
  /** e.g. `{ 'agent.link.kind': 'steered_by' }`. */
  attributes?: Record<string, unknown>
}

export interface OtlpSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  start_time: string
  end_time: string
  status: { code: OtlpStatusCode; message?: string }
  attributes: Record<string, unknown>
  /** Causal edges to other spans. Absent when the producer recorded none. */
  links?: OtlpSpanLink[]
}

export interface SpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string | null
  name: string
  kind: OtlpSpanKind
  startTime: string
  /** Defaults to startTime when the source has no explicit end. */
  endTime?: string
  status?: OtlpStatusCode
  statusMessage?: string
  service?: string | null
  agent?: string | null
  model?: string | null
  tool?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  /** Reasoning subset of output tokens. */
  reasoningTokens?: number | null
  cachedInputTokens?: number | null
  cacheWriteInputTokens?: number | null
  costUsd?: number | null
  /** Run-order pivot; the behavioral analyst orders trajectories by this. */
  step?: number
  /** Verbatim content the agentic analysts read via regex search. */
  content?: string | null
  /** Causal edges (steered-by / graded-by / retry-of), not containment. */
  links?: readonly OtlpSpanLink[]
  /** Extra attributes merged last (escape hatch for harness-specific signal). */
  extra?: Record<string, unknown>
}

/**
 * Build one OTLP span line from a harness event. Only sets attribute keys
 * that carry real signal — an absent token count is omitted, not zeroed,
 * so the behavioral analyst's "no LLM data" case stays honest.
 */
export function span(input: SpanInput): OtlpSpan {
  const attributes: Record<string, unknown> = {
    [OPENINFERENCE_SPAN_KIND]: input.kind,
  }
  if (input.service != null) attributes['service.name'] = input.service
  if (input.agent != null) attributes['agent.name'] = input.agent
  if (input.tool != null) attributes[TOOL_NAME] = input.tool
  applyLlmSpanOtlpAttributes(attributes, {
    model: input.model ?? undefined,
    inputTokens: input.inputTokens ?? undefined,
    outputTokens: input.outputTokens ?? undefined,
    reasoningTokens: input.reasoningTokens ?? undefined,
    cachedTokens: input.cachedInputTokens ?? undefined,
    cacheWriteTokens: input.cacheWriteInputTokens ?? undefined,
    costUsd: input.costUsd ?? undefined,
  })
  if (input.step != null) attributes.step = input.step
  if (input.content != null && input.content.length > 0) attributes['content'] = input.content
  if (input.extra) Object.assign(attributes, input.extra)

  const status: OtlpSpan['status'] = { code: input.status ?? 'OK' }
  if (input.statusMessage && input.statusMessage.length > 0) status.message = input.statusMessage

  return {
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId ?? null,
    name: input.name,
    start_time: input.startTime,
    end_time: input.endTime ?? input.startTime,
    status,
    attributes,
    ...(input.links && input.links.length > 0 ? { links: input.links.map((link) => ({ ...link })) } : {}),
  }
}

/** Project an in-memory span to a COMPLETE OpenInference span: the standard shape
 *  OTel/OpenInference consumers (and HALO) expect — top-level `kind`, `resource`,
 *  `scope`, and a string `parent_span_id` ("" at the root) — while keeping the
 *  attribute vocabulary (incl. `openinference.span.kind`) our own analysts read.
 *  One artifact feeds our pipeline, HALO, and any OpenInference tool. */
/**
 * What the PRODUCER wrote for a field this package analysed as something else.
 *
 * `src/otlp-input.ts` substitutes a value wherever a row cannot be analysed as
 * written — a trace id to group by, an end time to subtract, a status to count, a
 * kind to bucket, a link to follow — and records the field in
 * {@link SUBSTITUTED_FIELDS_ATTR} with the original beside it. This is the only
 * reader of that pairing, and it is deliberately ONE reader over the whole list
 * rather than one function per field: three separate audits found three
 * separately-forgotten fields, because writing the substitute into the export
 * makes the copy validate CLEANER than the source it came from — the finding the
 * producer earned disappears, and a consumer of the copy never learns of it.
 *
 * Three answers, and the caller must handle all three:
 *   - not substituted → emit the analysed value.
 *   - substituted, producer wrote something → emit THAT, verbatim.
 *   - substituted, producer wrote nothing → emit NO field at all.
 */
type ProducerField = { substituted: false } | { substituted: true; wrote: false } | { substituted: true; wrote: true; value: unknown }

function producerField(attributes: Record<string, unknown>, field: SubstitutedField): ProducerField {
  const declared = attributes[SUBSTITUTED_FIELDS_ATTR]
  if (typeof declared !== 'string' || !declared.split(',').includes(field)) return { substituted: false }
  const key = RAW_FIELD_ATTRIBUTES[field]
  return key in attributes ? { substituted: true, wrote: true, value: attributes[key] } : { substituted: true, wrote: false }
}

/** The three things an export can write for a substituted field, and nothing else. */
export type ExportRule = 'faithful' | 'declared-or-analysed' | 'analysed'

/**
 * What the export writes for a field this package substituted. One rule per
 * field, in one table, because the difference between them is not a style choice
 * — each `analysed` entry is a consumer that HARD-REQUIRES the field, named.
 *
 * The table is EXPORTED because it is a guarantee, not documentation:
 * `tests/otlp-export-rule.test.ts` reads it and derives, per field, the checks
 * the declared word promises — the exact value written in each of the two
 * producer states, that a `faithful` field erases no finding its source earned,
 * and that the artifact stays readable by the consumer whose hard requirement is
 * the only reason `analysed` exists. A field could be declared `faithful` here
 * while nothing implemented it (`status.code` was, and the finding vanished from
 * every re-export); a table that reads as a guarantee and is not one is worse
 * than no table.
 *
 * - `faithful` — the producer's value, or NO field at all when they wrote none.
 *   This is the default and the only rule that reproduces the source's finding
 *   exactly.
 * - `declared-or-analysed` — the producer's word when they wrote one, else this
 *   package's. A kind is what every consumer buckets by, and a span with none is
 *   re-derived differently by each of them (the tool-execution demotion that
 *   stops a tool call being counted twice is one such re-derivation), so the
 *   export always declares one. Writing the producer's word when there is one is
 *   what keeps `unknown-span-kind` alive across the trip.
 * - `analysed` — this package's value regardless. `trace_id` is the one field
 *   here, and it is not a choice: `analyze --otlp-out` hands the artifact
 *   straight to `agent-eval`'s `OtlpFileTraceStore`, whose `projectOtlpFlatLine`
 *   drops any row with a falsy `trace_id` and then throws `TraceFileMalformed`
 *   on the drop. A faithful (absent) trace id makes the artifact unreadable by
 *   the tool that reads it, so `missing-trace-id` CANNOT survive the trip. The
 *   substitution is disclosed instead — the span carries the pairing, and
 *   `renderConformance` states it above the findings so a reader of the artifact
 *   is told the id was minted here rather than left to assume the source had one.
 */
export const EXPORT_RULE: Readonly<Record<SubstitutedField, ExportRule>> = Object.freeze({
  trace_id: 'analysed',
  end_time: 'faithful',
  'status.code': 'faithful',
  kind: 'declared-or-analysed',
  links: 'faithful',
})

/**
 * `{ key: value }` to spread into the exported span, or `{}` to omit the field.
 *
 * A `faithful` field the producer did not write is OMITTED, not defaulted: the
 * whole point of the pairing is that `end_time` absent and `end_time` equal to
 * `start_time` are different traces to a validator, and only the first is true
 * of the source. `analysed === undefined` omits for the same reason — an empty
 * `links` on every span tells a reader "checked, none" where the truth is "never
 * captured".
 */
function producerEntry(
  attributes: Record<string, unknown>,
  field: SubstitutedField,
  key: string,
  analysed: unknown,
): Record<string, unknown> {
  const producer = producerField(attributes, field)
  if (producer.substituted) {
    if (producer.wrote && EXPORT_RULE[field] !== 'analysed') return { [key]: producer.value }
    if (EXPORT_RULE[field] === 'faithful') return {}
  }
  return analysed === undefined ? {} : { [key]: analysed }
}

export function toOpenInferenceSpan(s: OtlpSpan): Record<string, unknown> {
  const a = s.attributes
  const attributes = { ...a }
  attributes['inference.observation_kind'] ??= a[OPENINFERENCE_SPAN_KIND]
  if (a['agent.name'] != null) attributes['inference.agent_name'] ??= a['agent.name']
  if (a[LLM_MODEL_NAME] != null) attributes['inference.llm.model_name'] ??= a[LLM_MODEL_NAME]
  if (a[LLM_INPUT_TOKENS] != null) attributes['inference.llm.input_tokens'] ??= a[LLM_INPUT_TOKENS]
  if (a[LLM_OUTPUT_TOKENS] != null) attributes['inference.llm.output_tokens'] ??= a[LLM_OUTPUT_TOKENS]
  if (a[LLM_COST_USD] != null) attributes['inference.llm.cost.total'] ??= a[LLM_COST_USD]
  const resourceAttrs: Record<string, unknown> = {}
  if (a['service.name'] != null) resourceAttrs['service.name'] = a['service.name']
  if (a['agent.name'] != null) resourceAttrs['agent.name'] = a['agent.name']
  // Per-session repo/git grouping labels (see src/repo.ts). `tangle.subject.key`
  // is THE spine grouping key; the rest are stored-but-not-parsed provenance.
  for (const k of ['tangle.subject.key', 'git.repository', 'git.branch', 'git.commit', 'tangle.cwd', 'traces.repo_resolution_source']) {
    if (a[k] != null) resourceAttrs[k] = a[k]
  }
  // How much of the ORIGINAL source is missing from this file. Carried at the
  // resource level so it survives every further round trip: `readOtlpInput`
  // merges resource attributes back onto the span, and adds this hop's own
  // drops to whatever it finds there. Without it, exporting a trace whose rows
  // could not all be read produces a file that validates clean — the laundering
  // this pairing exists to stop. See `SOURCE_UNREADABLE_ROWS_ATTR`.
  for (const k of ['traces.source.unreadable_rows', 'traces.source.unreadable_row_kinds']) {
    if (a[k] != null) resourceAttrs[k] = a[k]
  }
  // WHICH BUILD of `@tangle-network/agent-trace-contract` this hop exported
  // with. Every kind, substitution, and finding in this artifact is that
  // build's reading, so the artifact names it the way cli-bridge and VB name
  // theirs. Omitted — never faked — when the installed tree cannot be read:
  // an absent stamp says "this producer did not know its build", a placeholder
  // would claim a build that never existed. Span attributes stay faithful, so a
  // re-export keeps the ORIGINAL producer's stamp there while this hop signs
  // the resource.
  const contractBuild = traceContractBuildIdOrNull()
  if (contractBuild !== null) resourceAttrs['traces.trace_contract.build'] = contractBuild
  // The analysed kind, which is what a span the producer left unclassified is
  // exported as: the artifact is also the store this package's analysts and
  // agent-eval read, and an unclassified span there is re-derived differently by
  // every consumer. UNKNOWN, not CHAIN, when even this package could not
  // classify it — the contract makes UNKNOWN the emittable word for "could not
  // classify", and guessing CHAIN would put a container in the export that the
  // producer never claimed.
  const analysedKind = typeof a[OPENINFERENCE_SPAN_KIND] === 'string' ? a[OPENINFERENCE_SPAN_KIND] : 'UNKNOWN'
  return {
    // Substituted fields carry the PRODUCER's value, or no field at all when the
    // producer wrote none — see `producerField`. Emitting the analysed value
    // here is what made a re-export validate cleaner than its own source.
    ...producerEntry(a, 'trace_id', 'trace_id', s.trace_id),
    span_id: s.span_id,
    parent_span_id: s.parent_span_id ?? '',
    name: s.name,
    ...producerEntry(a, 'kind', 'kind', analysedKind),
    start_time: s.start_time,
    ...producerEntry(a, 'end_time', 'end_time', s.end_time),
    status: {
      ...producerEntry(a, 'status.code', 'code', `STATUS_CODE_${s.status.code}`),
      message: s.status.message ?? '',
    },
    resource: { attributes: resourceAttrs },
    scope: { name: 'tangle-traces', version: '' },
    attributes,
    ...producerEntry(
      a,
      'links',
      'links',
      s.links && s.links.length > 0 ? s.links.map((link) => ({ ...link })) : undefined,
    ),
  }
}

/** Serialize spans to OpenInference JSONL (one complete span per line). This is a
 *  standard OpenInference representation: it feeds our analysts, HALO, and other
 *  OpenInference tools directly — no per-tool conversion. */
export function serializeSpans(spans: readonly OtlpSpan[]): string {
  if (spans.length === 0) return ''
  const validated = validateOtlpSpans(spans, 'serialized spans')
  return `${validated.map((s) => JSON.stringify(toOpenInferenceSpan(s))).join('\n')}\n`
}

/** Write spans to an OTLP-JSONL file (a temp file when no path is given). */
export async function writeOtlpFile(spans: readonly OtlpSpan[], outPath?: string): Promise<string> {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = outPath ?? join(await mkdtemp(join(tmpdir(), 'traces-')), 'spans.otlp.jsonl')
  await writeFile(path, serializeSpans(spans), 'utf8')
  return path
}
