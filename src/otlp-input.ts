/**
 * The INBOUND path: read OTLP-JSONL that some other system emitted and hand it
 * to the same analysis pipeline the adapters feed.
 *
 * The adapters (`src/adapters/`) exist because Claude Code, Codex, OpenCode and
 * friends write proprietary session logs we do not control, so somebody has to
 * translate. A system you DO control should not need one: emit
 * `@tangle-network/agent-trace-contract` spans and point `--otlp` at the file.
 *
 * Two rules govern everything here:
 *
 * 1. **Never throw on foreign input.** A tool that crashes on somebody else's
 *    trace cannot read "any AI system". A malformed line, a missing timestamp, a
 *    link pointing at nothing — each becomes a counted, named issue and the run
 *    continues on what is readable.
 * 2. **Validate what the PRODUCER wrote.** {@link readOtlpInput} runs
 *    `validateTraceSpans` over the raw rows, before this module normalizes
 *    anything, so the report tells the producer what to fix rather than
 *    describing our own repairs back to them.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  ATTR,
  type ContractSpan,
  declaredSpanKind,
  resolveSpanKind,
  SPAN_KIND_ATTR_KEYS,
  type TraceValidation,
  validateTraceSpans,
} from '@tangle-network/agent-trace-contract'
import { TOOL_NAME } from '@tangle-network/agent-eval/trace-attributes'
import { toolArgumentsFromAttributes, toolIoAttributes } from './adapters/tool-io.js'
import { appendAll } from './arrays.js'
import type { OtlpSpan, OtlpSpanKind, OtlpSpanLink, OtlpStatusCode } from './otlp.js'
import { parseIsoToEpochMs } from './time.js'

/** JSONL extensions a directory scan considers at all. */
const OTLP_FILE_EXTENSIONS = ['.jsonl', '.ndjson']

/**
 * Directory name a producer puts its OTLP exports in. When one exists, it is
 * the ONLY thing read: a producer that separated its span files from its event
 * files has already answered "which of these are spans", and second-guessing
 * that by also scanning siblings is how a run directory's raw stream logs got
 * counted as broken spans.
 */
const OTLP_DIRECTORY_NAME = 'otlp'

/** Lines sniffed before deciding a file is not OTLP. */
const SNIFF_LINES = 5

/** Why one row of an OTLP file did not become an analyzable span AT ALL. */
export type OtlpIngestIssueKind =
  | 'unparseable-line'
  | 'not-an-object'
  | 'missing-span-id'
  | 'unreadable-timestamp'
  | 'conflicting-span-id'

export interface OtlpIngestIssue {
  readonly kind: OtlpIngestIssueKind
  readonly file: string
  /** 1-indexed line within `file`. */
  readonly line: number
  readonly detail: string
}

/** Which unusable field cost a span one measurement, without costing it its existence. */
export type OtlpWithheldFieldKind = 'negative-duration'

/**
 * A row that DID become a span, with one unusable field withheld.
 *
 * This is a different event from an {@link OtlpIngestIssue} and the two must
 * never be merged. A span whose `end_time` precedes its `start_time` has an
 * unusable INTERVAL — it does not have an unusable identity, name, tool name or
 * status. Dropping the whole span for it silently deleted a real tool call from
 * every count in the report, which is a worse failure than the wrong duration
 * it was avoiding: a wrong number is visible and a missing row is not.
 *
 * So the span survives, its interval is withheld rather than repaired (no
 * synthesized end time enters any total), and the withholding is reported
 * here. The contract's own `negative-duration` finding independently marks
 * `latency-analysis` unavailable, so every table that prints a duration is
 * already gated.
 */
export interface OtlpFieldWithheld {
  readonly kind: OtlpWithheldFieldKind
  /** The span field that could not be used. */
  readonly field: string
  readonly file: string
  /** 1-indexed line within `file`. */
  readonly line: number
  readonly detail: string
}

/** Marks a span whose interval could not be measured, so no consumer reads its zero as a duration. */
export const DURATION_UNMEASURABLE_ATTR = 'traces.duration_unmeasurable'

/**
 * A span field this package ANALYSES as something other than what the producer
 * wrote.
 *
 * Every one of these is a place the reader has to substitute a value to analyse
 * the row at all — a trace id to group by, an end time to subtract, a status to
 * count, a kind to bucket, a link to follow. Substituting is correct; writing
 * the substitute into the EXPORT is not, because the export is re-validated and
 * the substitute is by construction more conforming than the source. Every
 * `missing-trace-id`, `invalid-timestamp`, `invalid-status`, `unknown-span-kind`
 * and `dangling-link` this package's own re-export ever laundered away was one
 * of these fields, so they are enumerated in ONE place and the export reads that
 * list rather than knowing them one at a time — a sixth substitution cannot be
 * added without the export learning about it.
 */
export type SubstitutedField = 'trace_id' | 'end_time' | 'status.code' | 'kind' | 'links'

/**
 * Where each substituted field's ORIGINAL value is kept, verbatim.
 *
 * The key names are the wire contract between {@link otlpRowToSpan} and
 * `toOpenInferenceSpan`; they are also what a human reads off an artifact to see
 * what the producer really wrote, so they spell the field they came from.
 */
export const RAW_FIELD_ATTRIBUTES: Readonly<Record<SubstitutedField, string>> = Object.freeze({
  trace_id: 'traces.raw_attribute.trace_id',
  end_time: 'traces.raw_attribute.end_time',
  'status.code': 'traces.raw_attribute.status.code',
  kind: 'traces.raw_attribute.openinference.span.kind',
  links: 'traces.raw_attribute.links',
})

/**
 * Which fields of this span were substituted, comma-joined.
 *
 * The list is what distinguishes the two cases a raw value alone cannot: a
 * producer who wrote a field this package could not use (the raw value is
 * recorded, and the export re-emits it), and a producer who wrote NO field at
 * all (there is no raw value, and the export must omit the field rather than
 * invent one). Without the list, "absent" and "unchanged" look identical on the
 * artifact, and an absent trace id came back out as a synthesized one.
 */
export const SUBSTITUTED_FIELDS_ATTR = 'traces.substituted_fields'

/**
 * Marks a span whose trace id this tool minted because the producer wrote none.
 *
 * Unlike every other entry in {@link SUBSTITUTED_FIELDS_ATTR}, which describes
 * only the hop that wrote it, this one STICKS: the minted id is a real,
 * non-empty trace id, so the next hop reads it as the producer's own and would
 * otherwise recompute the substitution away. It is never cleared once set — the
 * same rule as `traces.source.unreadable_rows`, and for the same reason: a chain
 * of re-exports must not launder a defect by its length.
 */
export const TRACE_ID_MINTED_ATTR = 'traces.trace_id_minted'

/**
 * The status code the producer wrote, when this package analysed a different
 * one. Kept for the same reason as `traces.raw_attribute.end_time`: the export
 * has to say what the SOURCE said, or a re-export validates cleaner than the
 * file it came from.
 */
export const RAW_STATUS_CODE_ATTR = RAW_FIELD_ATTRIBUTES['status.code']

/**
 * How many rows of the ORIGINAL source could not be represented as spans, and
 * which kinds — carried on every span of an export so the count survives any
 * number of re-exports.
 *
 * These exist because a dropped row CANNOT be re-emitted. The artifact this
 * package writes is also the store its analysts read, so a line that is not a
 * span would be garbage fed to the analysis, and a repaired one would be
 * invented work. What the artifact can do is refuse to pass itself off as the
 * source: it states, in its own resource attributes, exactly how much of the
 * source is missing from it, so `validate` on a re-export cannot read as a
 * clean bill of health for a file that never was one.
 */
export const SOURCE_UNREADABLE_ROWS_ATTR = 'traces.source.unreadable_rows'
export const SOURCE_UNREADABLE_KINDS_ATTR = 'traces.source.unreadable_row_kinds'

export interface OtlpInputFile {
  readonly path: string
  readonly rows: number
  readonly spans: number
  /** Rows that re-declared a span already read, byte-identically. */
  readonly repeats: number
  /** Distinct trace ids this file contributed, so a caller can attribute a
   *  trace back to the file it came from when a directory was ingested. */
  readonly traceIds: readonly string[]
}

/** A `*.jsonl` in the directory that does not hold OTLP spans, and how we know. */
export interface SkippedInputFile {
  readonly path: string
  /** What the first readable line was instead of a span. */
  readonly reason: string
}

/**
 * How much of the original source could not be represented as spans, summed
 * across every export hop that led to this file.
 *
 * `rows` is the count and `kinds` names the ingest issues behind it. On a file a
 * producer wrote, this is just what THIS ingest dropped. On a file
 * `traces` re-exported, it also carries what earlier hops dropped, read back off
 * the spans — so a re-export can never present itself as a complete copy of a
 * source it is missing rows from.
 */
export interface UnreadableSourceRows {
  readonly rows: number
  readonly kinds: readonly OtlpIngestIssueKind[]
  /** Rows dropped by EARLIER hops, already absent from the file just read. */
  readonly inherited: number
}

export interface OtlpInput {
  /** Every file read, in ingest order. */
  readonly files: readonly OtlpInputFile[]
  /** JSONL files in the directory that hold something other than OTLP spans. */
  readonly skipped: readonly SkippedInputFile[]
  /** Rows exactly as the producer wrote them — the input to `validateTraceSpans`. */
  readonly rows: readonly unknown[]
  /** Rows normalized into this package's span model, ready for the pipeline. */
  readonly spans: readonly OtlpSpan[]
  /** Conformance of the RAW rows: what this trace can and cannot answer. */
  readonly validation: TraceValidation
  /** Rows that could not become spans, each with its reason. */
  readonly issues: readonly OtlpIngestIssue[]
  /** Rows that DID become spans, with one unusable field withheld from them. */
  readonly withheld: readonly OtlpFieldWithheld[]
  /** Source rows absent from `spans`, this hop's and every earlier hop's. */
  readonly unreadable: UnreadableSourceRows
}

/** Collect `*.jsonl` / `*.ndjson` under a directory, recursively, sorted. */
async function jsonlFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) appendAll(files, await jsonlFilesUnder(path))
    else if (OTLP_FILE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) files.push(path)
  }
  return files
}

/** Every `otlp/` directory under `dir`, so a results tree of per-cell exports resolves. */
async function otlpDirectoriesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs: string[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    if (entry.name === OTLP_DIRECTORY_NAME) dirs.push(path)
    else appendAll(dirs, await otlpDirectoriesUnder(path))
  }
  return dirs
}

/**
 * Does this file hold OTLP spans?
 *
 * A run directory holds the span export next to raw event, stream and SDK logs
 * that are also `*.jsonl`. Reading them as spans turns 500 lines of perfectly
 * good telemetry into 500 conformance errors against a producer who never
 * claimed they were spans — so the first few readable lines decide, on the two
 * fields every OTLP span has and no event log does.
 */
function sniffOtlpFile(text: string): { otlp: true } | { otlp: false; reason: string } {
  let seen = 0
  let first: { row: unknown } | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    if (++seen > SNIFF_LINES) break
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (isObject(row) && nonEmptyString(row.span_id) !== null && nonEmptyString(row.name) !== null) {
      return { otlp: true }
    }
    first ??= { row }
  }
  if (seen === 0) return { otlp: false, reason: 'file is empty' }
  return { otlp: false, reason: first === null ? 'no line parses as JSON' : describeNonSpanRow(first.row) }
}

/** Name what a non-span row looks like, so the skip is checkable, not just asserted. */
function describeNonSpanRow(row: unknown): string {
  if (!isObject(row)) return `rows are ${row === null ? 'null' : Array.isArray(row) ? 'arrays' : typeof row}, not spans`
  const marker = nonEmptyString(row.type) ?? nonEmptyString(row.event) ?? nonEmptyString(row.kind)
  const keys = Object.keys(row).slice(0, 4).join(', ')
  return marker !== null
    ? `rows carry no span_id; they look like \`${marker}\` events (keys: ${keys})`
    : `rows carry no span_id (keys: ${keys})`
}

/** A file or directory resolved to the OTLP files in it, plus the JSONL that is not OTLP. */
export interface ResolvedOtlpInput {
  readonly files: readonly string[]
  readonly skipped: readonly SkippedInputFile[]
}

/**
 * Resolve a file or directory to the OTLP files it names.
 *
 * A named FILE is read as OTLP whatever it contains — the caller pointed at it,
 * and reporting its rows as unreadable is more useful than refusing it. A
 * DIRECTORY is a guess about which files were meant, so its non-OTLP JSONL is
 * skipped and named rather than ingested.
 */
export async function resolveOtlpInputFiles(path: string): Promise<ResolvedOtlpInput> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no OTLP file or directory at ${path}`)
    }
    throw error
  }
  if (!info.isDirectory()) return { files: [path], skipped: [] }

  const otlpDirs = basename(path) === OTLP_DIRECTORY_NAME ? [path] : await otlpDirectoriesUnder(path)
  const candidates = otlpDirs.length > 0
    ? (await Promise.all(otlpDirs.map(jsonlFilesUnder))).flat()
    : await jsonlFilesUnder(path)
  if (candidates.length === 0) {
    throw new Error(`no ${OTLP_FILE_EXTENSIONS.join(' / ')} files under ${path}`)
  }

  const files: string[] = []
  const skipped: SkippedInputFile[] = []
  for (const candidate of candidates) {
    const sniff = sniffOtlpFile(await readFile(candidate, 'utf8'))
    if (sniff.otlp) files.push(candidate)
    else skipped.push({ path: candidate, reason: sniff.reason })
  }
  if (files.length === 0) {
    throw new Error(
      `no OTLP span files under ${path}: ${skipped.length} JSONL file(s) hold something else ` +
        `(${skipped.slice(0, 3).map((entry) => `${basename(entry.path)} — ${entry.reason}`).join('; ')})`,
    )
  }
  return { files, skipped }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Key-order-independent JSON, so two spans are compared by content, not by the
 *  order their producer happened to serialize fields in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * OTLP JSON spells status codes `STATUS_CODE_*`; OpenInference exports and
 * hand-written files often spell them bare. Both are accepted, and anything
 * else becomes UNSET — `validateTraceSpans` has already reported the unknown
 * code as `invalid-status` against the raw row, so silently upgrading it here
 * would be inventing a verdict, and refusing the whole span would throw away
 * work that was recorded.
 */
function statusCode(value: unknown): OtlpStatusCode {
  if (value === 'OK' || value === 'STATUS_CODE_OK') return 'OK'
  if (value === 'ERROR' || value === 'STATUS_CODE_ERROR') return 'ERROR'
  return 'UNSET'
}

/**
 * The analysed status code, whether it is this package's substitute, and the
 * producer's own spelling when they wrote one.
 *
 * The contract recognises ONLY `STATUS_CODE_*`, so a bare `OK`, an invented
 * `WEIRD` and NO status at all are all `invalid-status` findings against the
 * source. This package analyses the first as OK and the other two as UNSET —
 * useful, and a licence to launder if the export then writes the analysed value:
 * the finding disappears from a copy of a trace that never conformed. So the raw
 * value is kept and re-emitted verbatim, exactly as an unusable `end_time` is,
 * and only the ANALYSIS uses the normalized code.
 *
 * `substituted` is a SEPARATE answer from `raw`, and conflating the two is what
 * let the finding through: a producer who wrote no readable code (no `status`
 * object, a `status` that is not an object, or one with no `code`) has no raw
 * value to keep, so `raw === undefined` meant "nothing was substituted" and the
 * export wrote the conforming `STATUS_CODE_UNSET` this package had inferred.
 * Three of the four ways a row can lack a status code took that path. The three
 * answers here are the same three `end_time` has had since its own erasure was
 * fixed, and `producerEntry` already knows how to spend them.
 */
function readStatusCode(declared: unknown): { code: OtlpStatusCode; substituted: boolean; raw?: unknown } {
  const code = statusCode(declared)
  if (declared === `STATUS_CODE_${code}`) return { code, substituted: false }
  return declared === undefined ? { code, substituted: true } : { code, substituted: true, raw: declared }
}

/** Execution/wait children DESCRIBE a tool call; counting them as another call
 *  would double every tool total, so they classify as containers. */
function isToolTelemetrySpan(attributes: Record<string, unknown>): boolean {
  const spanType = nonEmptyString(attributes['span.type'])?.toLowerCase()
  return spanType === 'tool.execution' || spanType === 'tool.blocked_on_user'
}

/** Tool spellings this stack's own producers use that the contract's reader
 *  candidates do not list. */
const LOCAL_TOOL_ATTRIBUTES = ['tool_name', 'mcp.tool.name', 'tool.input', 'tool.output'] as const

/**
 * Classify a span from its EVIDENCE — name and attributes — ignoring whatever
 * kind it declared. Callers decide whether a declaration wins; this answers the
 * separate question "what does this span look like".
 *
 * The contract's `resolveSpanKind` does the classifying, so a foreign trace
 * cannot land in one bucket here and another there. What sits on top of it are
 * only signals the contract deliberately does not read, and only where it
 * returned `UNKNOWN`:
 *
 * - `span.type`, a Tangle-internal marker. Its tool-telemetry values name
 *   children that DESCRIBE a tool call; counting them as calls doubles every
 *   tool total, which is why that check runs first.
 * - the local tool spellings above, and a name that mentions a tool.
 * - an interaction/agent name, which is the run container this model calls
 *   AGENT.
 *
 * Anything still unrecognised stays `UNKNOWN`. It is not `CHAIN`: CHAIN claims
 * the span CONTAINS other work, and inventing that relationship is how an
 * unclassifiable span ends up misreported as a container.
 */
export function inferSpanKind(name: string, attributes: Record<string, unknown>): OtlpSpanKind {
  if (isToolTelemetrySpan(attributes)) return 'CHAIN'
  const evidence = { ...attributes }
  for (const key of SPAN_KIND_ATTR_KEYS) delete evidence[key]
  const resolved = resolveSpanKind({ name, attributes: evidence })
  if (resolved !== 'UNKNOWN') return resolved

  const spanType = nonEmptyString(attributes['span.type'])?.toLowerCase()
  const lowered = name.toLowerCase()
  if (spanType === 'llm_request' || lowered.includes('llm')) return 'LLM'
  if (
    spanType === 'tool' ||
    lowered.includes('tool') ||
    LOCAL_TOOL_ATTRIBUTES.some((key) => attributes[key] != null)
  ) {
    return 'TOOL'
  }
  if (spanType === 'interaction' || lowered.includes('interaction') || lowered.includes('agent')) return 'AGENT'
  return 'UNKNOWN'
}

/** Normalize the many spellings of captured tool input/output onto the keys the
 *  tool analysts read. */
export function capturedToolIo(attributes: Record<string, unknown>): ReturnType<typeof toolIoAttributes> {
  const input =
    attributes['input.value'] ??
    attributes['tool.input'] ??
    attributes.tool_input ??
    attributes['tool.arguments'] ??
    attributes.tool_arguments ??
    attributes.arguments ??
    attributes.args ??
    attributes.full_command
  const capture = toolArgumentsFromAttributes({ ...attributes, 'input.value': input })
  return toolIoAttributes({
    input: capture.args,
    output: attributes['output.value'] ?? attributes['tool.output'] ?? attributes.tool_output,
    argsCaptured: capture.argsCaptured,
  })
}

/**
 * The kind to analyse a row as, and whether it came from the producer.
 *
 * A kind the CONTRACT recognises is kept exactly as written — including
 * EVALUATOR, RETRIEVER and UNKNOWN, which this model carries but an older,
 * narrower whitelist here did not: those spans were silently re-typed, so a
 * verdict span carrying `agent.outcome` came back out of a re-export as a
 * container and the re-exported file no longer said what the original did.
 *
 * A recognised declaration ALWAYS wins — that is the contract's own rule, and
 * the whole reason a producer bothers to declare. The `span.type` tool-telemetry
 * demotion below applies only where there is no declaration to override: the
 * legacy producer it exists for (this stack's `intelligence-spans` rows, whose
 * execution/wait children describe the tool call above them rather than being a
 * second call) declares no contract kind at all, so scoping the demotion to
 * undeclared spans keeps it doing its job while a conforming producer's `TOOL`
 * survives the round trip. Demoting a declared TOOL used to launder it into
 * CHAIN, which made `tool-usage` available on the source file and unavailable on
 * this package's own re-export of it.
 *
 * Whenever the declared word is not what the span is analysed as, that word is
 * kept verbatim under `traces.raw_attribute.*`, so nothing is lost and the
 * substitution is auditable.
 */
function resolveRowKind(
  row: Record<string, unknown>,
  attributes: Record<string, unknown>,
  name: string,
): { kind: OtlpSpanKind; declaredRaw: string | null; substituted: boolean } {
  const declared = declaredSpanKind({ kind: row.kind, attributes })
  if (declared.kind !== null) return { kind: declared.kind, declaredRaw: declared.raw, substituted: false }
  if (isToolTelemetrySpan(attributes)) return { kind: 'CHAIN', declaredRaw: declared.raw, substituted: true }
  return { kind: inferSpanKind(name, attributes), declaredRaw: declared.raw, substituted: true }
}

/**
 * Keep only the links a reader can follow. A link with no `span_id` names no
 * target and is dropped (`validateTraceSpans` reports it as `dangling-link`).
 * A link with a target but no `trace_id` is completed from the span's own
 * trace: OTLP requires both ids, and a same-export link is by construction in
 * the same trace — this is the field's real value, not a guess.
 */
function readLinks(value: unknown, traceId: string): OtlpSpanLink[] {
  if (!Array.isArray(value)) return []
  const links: OtlpSpanLink[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const spanId = nonEmptyString(entry.span_id)
    if (spanId === null) continue
    const attributes = isObject(entry.attributes) ? { ...entry.attributes } : undefined
    links.push({
      trace_id: nonEmptyString(entry.trace_id) ?? traceId,
      span_id: spanId,
      ...(attributes ? { attributes } : {}),
    })
  }
  return links
}

/**
 * `agent-eval`'s tool-name reader accepts `tool.name` and
 * `inference.tool.name`, not the semantic-convention `gen_ai.tool.name` the
 * contract writes. Every other contract key (model, tokens, cost) is already in
 * agent-eval's candidate lists, so this single alias is the whole bridge —
 * without it a conforming TOOL span analyses as an unnamed tool call.
 */
function bridgeContractAttributes(attributes: Record<string, unknown>): void {
  const toolName = nonEmptyString(attributes[ATTR.toolName])
  if (toolName !== null && nonEmptyString(attributes[TOOL_NAME]) === null) {
    attributes[TOOL_NAME] = toolName
  }
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  try {
    return parseIsoToEpochMs(value)
  } catch {
    return null
  }
}

/**
 * Exactly one of `span` or `issue`: a usable span, or the named reason there
 * isn't one. `withheld` accompanies a SPAN — the row was analysable, one field
 * on it was not.
 */
export interface OtlpRowConversion {
  span?: OtlpSpan
  issue?: Omit<OtlpIngestIssue, 'file' | 'line'>
  withheld?: Omit<OtlpFieldWithheld, 'file' | 'line'>
}

/**
 * One raw row to one analyzable span, or one named reason it is not analyzable.
 *
 * `fallbackTraceId` covers a row with no trace_id: `validateTraceSpans` reports
 * that as `missing-trace-id`, and grouping still needs SOME key, so the source
 * file names the anonymous trace instead of each span becoming its own run.
 */
export function otlpRowToSpan(row: unknown, fallbackTraceId: string): OtlpRowConversion {
  if (!isObject(row)) {
    // `typeof null` is "object"; reporting a null row as "row is object" sends
    // the producer looking for a field on a value that has none.
    const shape = row === null ? 'null' : Array.isArray(row) ? 'an array' : typeof row
    return { issue: { kind: 'not-an-object', detail: `row is ${shape}` } }
  }
  const spanId = nonEmptyString(row.span_id)
  if (spanId === null) return { issue: { kind: 'missing-span-id', detail: 'row carries no span_id' } }

  const startMs = parseTime(row.start_time)
  if (startMs === null) {
    return { issue: { kind: 'unreadable-timestamp', detail: `span ${spanId} has no readable start_time` } }
  }

  const attributes = isObject(row.attributes) ? { ...row.attributes } : {}
  // Resource attributes carry service/agent identity that the analysts key off;
  // this package's model has one attribute bag, so they are merged in without
  // overwriting a span-level value that disagrees.
  const resource = isObject(row.resource) ? row.resource : undefined
  const resourceAttributes = isObject(resource?.attributes) ? resource.attributes : undefined
  if (resourceAttributes) {
    for (const [key, value] of Object.entries(resourceAttributes)) {
      if (value != null && attributes[key] === undefined) attributes[key] = value
    }
  }

  const substituted: SubstitutedField[] = []
  /**
   * Record that `field` is analysed as something other than what the producer
   * wrote, keeping their value when there was one.
   *
   * The raw key is DELETED when the producer wrote nothing, never left as it was
   * found: on a re-export the attribute bag arrives already carrying an earlier
   * hop's raw values, and inheriting one would attribute a value to a producer
   * who wrote none.
   */
  const substitute = (field: SubstitutedField, declared: unknown): void => {
    substituted.push(field)
    const key = RAW_FIELD_ATTRIBUTES[field]
    if (declared === undefined) delete attributes[key]
    else attributes[key] = declared
  }

  // A row with no usable trace id still needs a grouping key, and the file's own
  // name is the most specific honest one — but the EXPORT carries the producer's
  // (absent) id, or `missing-trace-id` vanishes from the copy and `non-hex-id`
  // appears in its place, describing an id this package minted.
  const declaredTraceId = nonEmptyString(row.trace_id)
  const traceId = declaredTraceId ?? fallbackTraceId
  if (declaredTraceId === null) {
    substitute('trace_id', row.trace_id)
    attributes[TRACE_ID_MINTED_ATTR] = true
  }

  // An end before its start makes the INTERVAL unusable, not the span. The
  // interval is withheld — never repaired with a synthesized end — and the span
  // keeps its identity, name, tool and status so that a bad timestamp cannot
  // delete a real tool call from every count in the report. An end that is
  // ABSENT or unreadable is analysed as the start for the same reason, and is
  // the same substitution: writing that clamp into the export turned
  // `invalid-timestamp` into a clean bill of health AND flipped
  // `latency-analysis` to available on a copy of a trace that never supported it.
  const parsedEndMs = parseTime(row.end_time)
  const rawEndMs = parsedEndMs ?? startMs
  const durationUnmeasurable = rawEndMs < startMs
  const endMs = durationUnmeasurable ? startMs : rawEndMs
  if (durationUnmeasurable || parsedEndMs === null) substitute('end_time', row.end_time)
  if (durationUnmeasurable) attributes[DURATION_UNMEASURABLE_ATTR] = true
  const withheld = durationUnmeasurable
    ? {
      kind: 'negative-duration' as const,
      field: 'end_time',
      detail:
        `span ${spanId} ends ${startMs - rawEndMs}ms before it starts; the span is analysed and its ` +
        'duration is withheld (not repaired), so it appears in every count except the latency ones',
    }
    : undefined

  const name = nonEmptyString(row.name) ?? 'span'
  bridgeContractAttributes(attributes)
  // Foreign producers coin their own words (GUARDRAIL, EMBEDDING). One of those
  // is re-derived from the span itself rather than discarded, and the
  // producer's own word is kept verbatim so nothing is lost.
  const { kind, declaredRaw, substituted: kindSubstituted } = resolveRowKind(row, attributes, name)
  if (kindSubstituted) substitute('kind', declaredRaw ?? undefined)
  attributes[ATTR.spanKind] = kind
  if (kind === 'TOOL') Object.assign(attributes, capturedToolIo(attributes))

  // A `status` that is not an object carries no code to keep, and neither does
  // one with no `code` in it. Both are `invalid-status` against the source, and
  // both are analysed as UNSET here — so both are substitutions, recorded with
  // no raw value so the export omits `status.code` rather than declaring the
  // conforming code this package inferred.
  const status = isObject(row.status) ? row.status : undefined
  const statusMessage = nonEmptyString(status?.message)
  const { code: statusCodeValue, substituted: statusSubstituted, raw: rawStatusCode } = readStatusCode(status?.code)
  if (statusSubstituted) substitute('status.code', rawStatusCode)

  // A link this reader cannot follow is dropped from the ANALYSED span, and its
  // absence from the export erased the `dangling-link` the source earned. So the
  // producer's own `links` value rides along verbatim whenever the followable
  // set is not a faithful copy of it, and the export re-emits that instead.
  const links = readLinks(row.links, traceId)
  if (row.links !== undefined && canonicalJson(links) !== canonicalJson(row.links)) {
    substitute('links', row.links)
  }

  if (substituted.length > 0) attributes[SUBSTITUTED_FIELDS_ATTR] = substituted.join(',')
  else delete attributes[SUBSTITUTED_FIELDS_ATTR]

  return {
    span: {
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: nonEmptyString(row.parent_span_id),
      name,
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      status: { code: statusCodeValue, ...(statusMessage ? { message: statusMessage } : {}) },
      attributes,
      ...(links.length > 0 ? { links } : {}),
    },
    ...(withheld ? { withheld } : {}),
  }
}

/** One parsed row and the 1-indexed line of the file it came from. */
interface ReadRow {
  readonly value: unknown
  readonly line: number
}

/**
 * Split JSONL text into rows, reporting each unparseable line instead of
 * failing. Every row carries the LINE it was read from, not its index in the
 * surviving rows: blank lines and unparseable lines both shift those apart, so
 * an index reported as a line number sends the producer to the wrong place in
 * their own file.
 */
function readRows(text: string, file: string): { rows: ReadRow[]; issues: OtlpIngestIssue[] } {
  const rows: ReadRow[] = []
  const issues: OtlpIngestIssue[] = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue
    try {
      rows.push({ value: JSON.parse(line), line: index + 1 })
    } catch (error) {
      issues.push({
        kind: 'unparseable-line',
        file,
        line: index + 1,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { rows, issues }
}

/**
 * Read OTLP-JSONL from a file or a directory of them.
 *
 * A directory ingests the OTLP files under it, recursively — every `*.jsonl` /
 * `*.ndjson` that holds spans, or only the contents of an `otlp/` subdirectory
 * when the producer made one — so a results directory of per-shot exports
 * analyses as one body of work while its raw event and stream logs are named
 * and skipped rather than counted as broken spans.
 */
export async function readOtlpInput(path: string): Promise<OtlpInput> {
  const { files: paths, skipped } = await resolveOtlpInputFiles(path)
  const files: OtlpInputFile[] = []
  const rows: unknown[] = []
  const spans: OtlpSpan[] = []
  const issues: OtlpIngestIssue[] = []
  const withheld: OtlpFieldWithheld[] = []
  // (trace_id, span_id) is a span's identity, and a second row claiming it is
  // one of two very different things.
  //
  // An IDENTICAL re-declaration is correct behaviour: a multi-shot cell writes
  // one file per shot, and each file re-declares the run and cell spans it
  // hangs under so that every file is independently analysable. Concatenating
  // them must collapse back to one span, which is exactly what happens here —
  // counted, reported as a repeat, not as a defect.
  //
  // A CONFLICTING re-declaration — same identity, different content — is an
  // ambiguity nothing can resolve: parent lookups pick one arbitrarily and any
  // total that sums both counts the same work twice. The later row is dropped
  // and the conflict is reported.
  const seenIdentities = new Map<string, string>()

  for (const file of paths) {
    const parsed = readRows(await readFile(file, 'utf8'), file)
    appendAll(issues, parsed.issues)
    // A file with no trace_id anywhere still needs a grouping key; its own name
    // is the most specific honest one available.
    const fallbackTraceId = `otlp:${basename(file)}`
    let spansFromFile = 0
    let repeatsFromFile = 0
    const traceIds = new Set<string>()
    for (const { value: row, line } of parsed.rows) {
      rows.push(row)
      const converted = otlpRowToSpan(row, fallbackTraceId)
      if (converted.withheld) withheld.push({ ...converted.withheld, file, line })
      if (converted.span) {
        const identity = JSON.stringify([converted.span.trace_id, converted.span.span_id])
        const content = canonicalJson(converted.span)
        const seen = seenIdentities.get(identity)
        if (seen !== undefined) {
          if (seen === content) {
            repeatsFromFile += 1
            traceIds.add(converted.span.trace_id)
            continue
          }
          issues.push({
            kind: 'conflicting-span-id',
            file,
            line,
            detail:
              `span ${converted.span.span_id} in trace ${converted.span.trace_id} was already read with ` +
              'DIFFERENT content; the later row was dropped',
          })
          continue
        }
        seenIdentities.set(identity, content)
        spans.push(converted.span)
        traceIds.add(converted.span.trace_id)
        spansFromFile += 1
      } else if (converted.issue) {
        issues.push({ ...converted.issue, file, line })
      }
    }
    files.push({
      path: file,
      rows: parsed.rows.length,
      spans: spansFromFile,
      repeats: repeatsFromFile,
      traceIds: [...traceIds],
    })
  }

  const unreadable = stampUnreadableSourceRows(spans, issues)

  return {
    files,
    skipped,
    rows,
    spans,
    // Cast, not conversion: `validateTraceSpans` trusts nothing about its input
    // and reports whatever it finds, which is exactly what a foreign trace needs.
    validation: validateTraceSpans(rows as readonly ContractSpan[]),
    issues,
    withheld,
    unreadable,
  }
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Record on every span how much of the source is NOT in this set, and return
 * the same fact to the caller.
 *
 * A dropped row cannot be put back. It is not a span, so it cannot go in an
 * export that this package's own analysts read as spans, and repairing it into
 * one would put invented work into every total. This is the other half of the
 * only honest choice left: the export does not claim to be the source. It
 * carries the number of rows it is missing, so `traces validate` on a
 * re-export reports the loss instead of handing back the clean bill of health
 * the source never earned.
 *
 * The count ACCUMULATES. An export of an export inherits the earlier hops'
 * total (read off the spans, where the previous export left it) and adds its
 * own, so no chain of re-exports launders a defect by length.
 */
function stampUnreadableSourceRows(
  spans: readonly OtlpSpan[],
  issues: readonly OtlpIngestIssue[],
): UnreadableSourceRows {
  let inherited = 0
  const kinds = new Set<OtlpIngestIssueKind>()
  for (const span of spans) {
    inherited = Math.max(inherited, positiveInteger(span.attributes[SOURCE_UNREADABLE_ROWS_ATTR]))
    const declared = span.attributes[SOURCE_UNREADABLE_KINDS_ATTR]
    if (typeof declared === 'string') {
      for (const kind of declared.split(',')) if (kind.length > 0) kinds.add(kind as OtlpIngestIssueKind)
    }
  }
  for (const issue of issues) kinds.add(issue.kind)
  const total = inherited + issues.length
  const sortedKinds = [...kinds].sort()
  if (total > 0) {
    for (const span of spans) {
      span.attributes[SOURCE_UNREADABLE_ROWS_ATTR] = total
      span.attributes[SOURCE_UNREADABLE_KINDS_ATTR] = sortedKinds.join(',')
    }
  }
  return { rows: total, kinds: sortedKinds, inherited }
}
