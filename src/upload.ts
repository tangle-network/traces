/**
 * Upload local coding-session traces to the Tangle Intelligence Platform.
 *
 * Pipeline per session: locate (time window) → parse to OTLP spans → REDACT
 * (PII/secrets) → augment with metadata → dedup (skip unchanged, already-sent
 * sessions) → POST via the hosted `ingestTraces` client. The redaction happens
 * before anything leaves the machine; the dedup is local-state + server
 * idempotency-key.
 *
 * `planUpload` is read-only (select + redact + dedup); `executeUpload` does the
 * actual send (or, with `dryRun`, writes the redacted OTLP it *would* send).
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { hostedClientFromEnv } from '@tangle-network/agent-eval/hosted'
import type { TraceSpanEvent } from '@tangle-network/agent-eval/hosted'
import { REDACTION_VERSION } from '@tangle-network/agent-eval/traces'
import type { RedactionReport } from '@tangle-network/agent-eval/traces'
import { ATTR, INGEST_SOURCE_CLI } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'
import type { Redactor } from './external.js'
import { applyRedactor, redactSpans } from './redact.js'
import { type ScanOptions, scanSessions } from './session-source.js'
import { parseIsoToEpochMs } from './time.js'
import type { SessionRef } from './types.js'
import { alreadyUploaded, loadState, saveState, sessionHash, type UploadState, uploadKey } from './upload-state.js'

const require = createRequire(import.meta.url)
const TRACES_VERSION: string = (require('../package.json') as { version: string }).version

export interface UploadItem {
  ref: SessionRef
  /** Redacted spans (safe to send). */
  spans: OtlpSpan[]
  redaction: RedactionReport
  hash: string
  isNew: boolean
}

export interface UploadPlan {
  items: UploadItem[]
  state: UploadState
  sinceMs?: number
}

export type PlanOptions = ScanOptions

/** Read-only: select sessions in the window, redact, and mark which are new. */
export async function planUpload(opts: PlanOptions = {}): Promise<UploadPlan> {
  const state = await loadState()
  const items: UploadItem[] = []
  for await (const { ref, spans: raw } of scanSessions(opts)) {
    const { spans, report } = redactSpans(raw)
    const hash = sessionHash(spans)
    items.push({
      ref,
      spans,
      redaction: report,
      hash,
      isNew: !alreadyUploaded(state, ref.harness, ref.sessionId, hash),
    })
  }
  return { items, state, sinceMs: opts.sinceMs }
}

/** Best-effort git branch for a session's cwd (no shell-out; reads .git/HEAD). */
async function gitBranch(cwd: string | null): Promise<string | undefined> {
  if (!cwd) return undefined
  try {
    const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf8')
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/m)
    return m?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** Resource metadata attached to a session's root span — the "augmentation". */
async function sessionMeta(item: UploadItem, uploadedAt: string): Promise<Record<string, string | number | boolean>> {
  const meta: Record<string, string | number | boolean> = {
    [ATTR.HARNESS]: item.ref.harness,
    [ATTR.SESSION_FILE]: basename(item.ref.path),
    [ATTR.HOST]: hostname(),
    [ATTR.UPLOADED_AT]: uploadedAt,
    [ATTR.UPLOADER]: `tangle-traces@${TRACES_VERSION}`,
    [ATTR.REDACTION_VERSION]: REDACTION_VERSION,
    [ATTR.REDACTION_COUNT]: item.redaction.redactionCount,
  }
  if (item.ref.cwd) meta[ATTR.CWD] = item.ref.cwd
  const branch = await gitBranch(item.ref.cwd)
  if (branch) meta[ATTR.GIT_BRANCH] = branch
  return meta
}

// TraceSpanEvent.*UnixNano is typed `number`, and our source resolution is
// milliseconds. ms × 1e6 exceeds MAX_SAFE_INTEGER, so the low ~256ns are not
// representable — but that's below our input resolution, and since both ends
// are integer-ms × 1e6 the rounding preserves ordering (start ≤ end always).
const msToNano = (iso: string): number => parseIsoToEpochMs(iso) * 1_000_000

/** Map redacted OtlpSpan[] → the hosted TraceSpanEvent[] wire shape, attaching
 *  session metadata to the root span(s). */
export function toTraceSpanEvents(
  spans: readonly OtlpSpan[],
  rootMeta: Record<string, string | number | boolean>,
): TraceSpanEvent[] {
  return spans.map((s) => {
    const attributes: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(s.attributes)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attributes[k] = v
      else if (v != null) attributes[k] = JSON.stringify(v)
    }
    // Session identity (= the trace id) + provenance on every span, so the
    // platform can dedup a CLI re-upload of a session that also streamed live.
    attributes[ATTR.SESSION_ID] = s.trace_id
    attributes[ATTR.INGEST_SOURCE] = INGEST_SOURCE_CLI
    if (s.parent_span_id === null) Object.assign(attributes, rootMeta)
    const startNano = msToNano(s.start_time)
    return {
      traceId: s.trace_id,
      spanId: s.span_id,
      ...(s.parent_span_id ? { parentSpanId: s.parent_span_id } : {}),
      name: s.name,
      startTimeUnixNano: startNano,
      endTimeUnixNano: Math.max(startNano, msToNano(s.end_time)),
      attributes,
      ...(s.status.code === 'UNSET'
        ? {}
        : { status: { code: s.status.code, ...(s.status.message ? { message: s.status.message } : {}) } }),
    } as TraceSpanEvent
  })
}

export interface UploadResult {
  uploadedSessions: number
  skippedSessions: number
  acceptedSpans: number
  redactionCount: number
  dryRun: boolean
  otlpPath?: string
}

/** A trace sink. The hosted client satisfies this; pass your own to route
 *  redacted+deduped traces into a different system. */
export interface UploadBackend {
  ingestTraces(spans: TraceSpanEvent[], idempotencyKey?: string): Promise<{ accepted: number }>
}

export interface ExecuteOptions {
  dryRun?: boolean
  /** Where to write the redacted OTLP-JSONL on a dry run. */
  otlpOut?: string
  /** Custom sink. Defaults to the hosted Tangle Intelligence client from env. */
  backend?: UploadBackend
  /** Metadata-only upload: drop captured prompt/response `content` from every
   *  span before it leaves the machine (still keeps tool calls, tokens, timing,
   *  loop signal). The strongest privacy posture when prose can't leave. */
  stripContent?: boolean
  /** External PII scrubber applied to `content` AFTER the regex pass — catches
   *  free-form PII (names, addresses) the rules miss. Ignored if stripContent. */
  redactor?: Redactor
  log?: (msg: string) => void
}

/** Drop captured conversation `content` from spans (metadata-only upload). */
function stripSpanContent(spans: readonly OtlpSpan[]): OtlpSpan[] {
  return spans.map((s) => {
    if (s.attributes['content'] == null) return s
    const { content: _drop, ...attributes } = s.attributes
    return { ...s, attributes }
  })
}

/** Send the NEW items (or, on dryRun, write the redacted OTLP that would send). */
export async function executeUpload(plan: UploadPlan, opts: ExecuteOptions = {}): Promise<UploadResult> {
  let newItems = plan.items.filter((i) => i.isNew)
  if (opts.redactor && !opts.stripContent) {
    const r = opts.redactor
    newItems = await Promise.all(newItems.map(async (i) => ({ ...i, spans: (await applyRedactor(i.spans, r)).spans })))
  }
  if (opts.stripContent) newItems = newItems.map((i) => ({ ...i, spans: stripSpanContent(i.spans) }))
  const skipped = plan.items.length - newItems.length
  const redactionCount = newItems.reduce((n, i) => n + i.redaction.redactionCount, 0)
  const uploadedAt = new Date().toISOString()

  if (opts.dryRun) {
    const allSpans = newItems.flatMap((i) => i.spans)
    const path = await writeOtlpFile(allSpans, opts.otlpOut)
    return {
      uploadedSessions: 0,
      skippedSessions: skipped,
      acceptedSpans: 0,
      redactionCount,
      dryRun: true,
      otlpPath: path,
    }
  }

  const client: UploadBackend | undefined = opts.backend ?? hostedClientFromEnv()
  if (!client) {
    throw new Error(
      'upload: no backend. Pass opts.backend, or configure the hosted Tangle Intelligence client via ' +
        'TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL), TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), and ' +
        'TANGLE_TENANT_ID. Use --dry-run to preview without uploading.',
    )
  }

  const state = plan.state
  let acceptedSpans = 0
  for (const item of newItems) {
    const meta = await sessionMeta(item, uploadedAt)
    const events = toTraceSpanEvents(item.spans, meta)
    // idempotency-key = session + content hash → server-side retry-safe dedup.
    const idempotencyKey = `${uploadKey(item.ref.harness, item.ref.sessionId)}:${item.hash}`
    const res = await client.ingestTraces(events, idempotencyKey)
    acceptedSpans += res.accepted
    state[uploadKey(item.ref.harness, item.ref.sessionId)] = {
      hash: item.hash,
      uploadedAt,
      harness: item.ref.harness,
      spanCount: item.spans.length,
    }
    opts.log?.(`uploaded ${item.ref.harness} ${item.ref.sessionId.slice(0, 8)} — ${res.accepted} spans`)
  }
  await saveState(state)

  return {
    uploadedSessions: newItems.length,
    skippedSessions: skipped,
    acceptedSpans,
    redactionCount,
    dryRun: false,
  }
}
