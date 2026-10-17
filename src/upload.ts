/**
 * Upload local coding-session traces to the Tangle Intelligence Platform.
 *
 * Pipeline per session: locate (time window) → parse to OTLP spans → REDACT
 * (agent-eval's redaction core) → apply the selected privacy mode → augment
 * with metadata → CHECK the final events with the share-safety verdict → dedup
 * → POST via the hosted `ingestTraces` client. A session whose final events are
 * UNSAFE or UNKNOWN is refused: it is not sent, not written to a dry-run
 * preview, and not marked uploaded. The dedup is local-state + server
 * idempotency-key.
 *
 * `planUpload` is read-only (select + redact); `executeUpload` applies final
 * privacy options, checks, deduplicates, and sends or writes a dry-run preview.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { hostedClientFromEnv } from '@tangle-network/agent-eval/hosted'
import type { TraceSpanEvent } from '@tangle-network/agent-eval/hosted'
import { assessShareSafety, combineVerdicts, REDACTION_VERSION, redact, shareAllowed } from '@tangle-network/agent-eval/traces'
import type { RedactionReport, ShareSafetyVerdict } from '@tangle-network/agent-eval/traces'
import { ATTR, INGEST_SOURCE_CLI } from './attributes.js'
import { isMetadataAttribute, metadataOnly } from './metadata-only.js'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'
import { redactSpans } from './redact.js'
import { type ScanOptions, scanSessions } from './session-source.js'
import { parseIsoToEpochMs } from './time.js'
import type { SessionRef } from './types.js'
import {
  alreadyUploaded,
  loadState,
  outboundHash,
  saveState,
  sessionHash,
  type UploadIdentity,
  type UploadState,
  uploadKey,
} from './upload-state.js'

const require = createRequire(import.meta.url)
const TRACES_VERSION: string = (require('../package.json') as { version: string }).version

export interface UploadItem {
  ref: SessionRef
  /** Redacted spans (safe to send). */
  spans: OtlpSpan[]
  redaction: RedactionReport
  /** Source-span hash for inspection. Final outbound hashing happens in executeUpload. */
  hash: string
  /** Candidate marker retained for API compatibility; final freshness depends on execute options. */
  isNew: boolean
}

export interface UploadPlan {
  items: UploadItem[]
  state: UploadState
  sinceMs?: number
}

export type PlanOptions = ScanOptions

/** Read-only: select sessions in the window and redact them with the default profile. */
export async function planUpload(opts: PlanOptions = {}): Promise<UploadPlan> {
  return { ...await planUploadFrom(scanSessions(opts)), sinceMs: opts.sinceMs }
}

/**
 * Read-only: redact sessions already read, from any source (a session id, a
 * session file, an OTLP file), with the default profile.
 */
export async function planUploadFrom(
  sessions: AsyncIterable<{ ref: SessionRef; spans: OtlpSpan[] }> | Iterable<{ ref: SessionRef; spans: OtlpSpan[] }>,
): Promise<UploadPlan> {
  const state = await loadState()
  const items: UploadItem[] = []
  for await (const { ref, spans: raw } of sessions) {
    const { spans, report } = redactSpans(raw)
    const hash = sessionHash(spans)
    items.push({
      ref,
      spans,
      redaction: report,
      hash,
      isNew: true,
    })
  }
  return { items, state }
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
async function sessionMeta(item: UploadItem): Promise<Record<string, string | number | boolean>> {
  const meta: Record<string, string | number | boolean> = {
    [ATTR.HARNESS]: item.ref.harness,
    [ATTR.SESSION_FILE]: basename(item.ref.path),
    [ATTR.HOST]: hostname(),
    [ATTR.UPLOADER]: `tangle-traces@${TRACES_VERSION}`,
    [ATTR.REDACTION_VERSION]: REDACTION_VERSION,
    [ATTR.REDACTION_COUNT]: item.redaction.redactionCount,
  }
  if (item.ref.cwd) meta[ATTR.CWD] = item.ref.cwd
  const branch = await gitBranch(item.ref.cwd)
  if (branch) meta[ATTR.GIT_BRANCH] = branch
  // The spans were redacted before this metadata existed. A cwd can hold an
  // email (a synced drive's mount path) or a token, so it goes through the core too.
  return redact(meta).value
}

const msToNano = (epochMs: number): string => (BigInt(epochMs) * 1_000_000n).toString()

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
    const startMs = parseIsoToEpochMs(s.start_time)
    const endMs = Math.max(startMs, parseIsoToEpochMs(s.end_time))
    return {
      traceId: s.trace_id,
      spanId: s.span_id,
      ...(s.parent_span_id ? { parentSpanId: s.parent_span_id } : {}),
      name: s.name,
      startTimeUnixNano: msToNano(startMs),
      endTimeUnixNano: msToNano(endMs),
      attributes,
      ...(s.status.code === 'UNSET'
        ? {}
        : { status: { code: s.status.code, ...(s.status.message ? { message: s.status.message } : {}) } }),
    }
  })
}

/** A session the share-safety check kept on the machine. */
export interface RefusedSession {
  harness: string
  sessionId: string
  verdict: ShareSafetyVerdict
}

export interface UploadResult {
  uploadedSessions: number
  skippedSessions: number
  acceptedSpans: number
  redactionCount: number
  dryRun: boolean
  /** The redacted preview a dry run wrote, when `otlpOut` named one. */
  otlpPath?: string
  /** Sessions whose final events were UNSAFE or UNKNOWN. None of them was sent. */
  refused: RefusedSession[]
  /** The share verdict of every session checked, sent or refused, combined; absent when none was new. */
  verdict?: ShareSafetyVerdict
}

/** A trace sink. The hosted client satisfies this; pass your own to route
 *  redacted+deduped traces into a different system. */
export interface UploadBackend {
  ingestTraces(spans: TraceSpanEvent[], idempotencyKey?: string): Promise<{ accepted: number }>
}

export class PartialUploadError extends Error {
  readonly sessionKey: string
  readonly accepted: number
  readonly expected: number

  constructor(sessionKey: string, accepted: number, expected: number) {
    super(`upload: backend accepted ${accepted} of ${expected} spans for ${sessionKey}`)
    this.name = 'PartialUploadError'
    this.sessionKey = sessionKey
    this.accepted = accepted
    this.expected = expected
  }
}

export interface ExecuteOptions {
  dryRun?: boolean
  /** Where to write the redacted OTLP-JSONL on a dry run. Without it a dry run writes nothing. */
  otlpOut?: string
  /** Custom sink. Defaults to the hosted Tangle Intelligence client from env. */
  backend?: UploadBackend
  /** Metadata-only upload: drop captured prompt/response/tool values before the
   *  spans leave the machine (still keeps tool names, tokens, timing, and loop signal). */
  stripContent?: boolean
  log?: (msg: string) => void
}

interface OutboundItem {
  item: UploadItem
  events: TraceSpanEvent[]
  hash: string
}

async function prepareOutbound(
  plan: UploadPlan,
  opts: ExecuteOptions,
  uploadedAt: string,
): Promise<{ items: OutboundItem[]; skipped: number; refused: RefusedSession[]; verdict?: ShareSafetyVerdict }> {
  let candidates = plan.items
  if (opts.stripContent) {
    candidates = candidates.map((item) => ({ ...item, spans: metadataOnly(item.spans).spans }))
  }

  const identity: UploadIdentity = {
    stripContent: opts.stripContent === true,
    redactor: null,
    redactionVersion: REDACTION_VERSION,
  }
  const items: OutboundItem[] = []
  const refused: RefusedSession[] = []
  const verdicts: ShareSafetyVerdict[] = []
  for (const item of candidates) {
    const key = uploadKey(item.ref.harness, item.ref.sessionId)
    const previous = plan.state[key]
    const meta = await sessionMeta(item)
    // The metadata-only rule covers what this metadata adds too: no cwd, branch or file name.
    if (opts.stripContent) for (const [key, value] of Object.entries(meta)) if (!isMetadataAttribute(key, value)) delete meta[key]
    const eventsAt = (timestamp: string) =>
      toTraceSpanEvents(item.spans, { ...meta, [ATTR.UPLOADED_AT]: timestamp })

    let eventTimestamp = previous?.uploadedAt ?? uploadedAt
    let events = eventsAt(eventTimestamp)
    let hash = outboundHash(events, identity)
    if (alreadyUploaded(plan.state, item.ref.harness, item.ref.sessionId, hash)) continue

    if (eventTimestamp !== uploadedAt) {
      eventTimestamp = uploadedAt
      events = eventsAt(eventTimestamp)
      hash = outboundHash(events, identity)
    }
    // The check reads exactly what would be sent: redacted spans after privacy
    // mode, plus the session metadata added above.
    const verdict = assessShareSafety(events)
    verdicts.push(verdict)
    if (!shareAllowed(verdict)) {
      refused.push({ harness: item.ref.harness, sessionId: item.ref.sessionId, verdict })
      continue
    }
    items.push({ item, events, hash })
  }
  return {
    items,
    skipped: plan.items.length - items.length - refused.length,
    refused,
    ...(verdicts.length > 0 ? { verdict: combineVerdicts('default', verdicts) } : {}),
  }
}

/** Send the final, new outbound items, or on a dry run write their OTLP to `otlpOut` when it is given. */
export async function executeUpload(plan: UploadPlan, opts: ExecuteOptions = {}): Promise<UploadResult> {
  const uploadedAt = new Date().toISOString()
  const { items, skipped, refused, verdict } = await prepareOutbound(plan, opts, uploadedAt)
  const redactionCount = items.reduce((n, { item }) => n + item.redaction.redactionCount, 0)

  if (opts.dryRun) {
    const path = opts.otlpOut === undefined
      ? undefined
      : await writeOtlpFile(items.flatMap(({ item }) => item.spans), opts.otlpOut)
    return {
      uploadedSessions: 0,
      skippedSessions: skipped,
      acceptedSpans: 0,
      redactionCount,
      dryRun: true,
      ...(path === undefined ? {} : { otlpPath: path }),
      refused,
      ...(verdict ? { verdict } : {}),
    }
  }

  if (items.length === 0) {
    return {
      uploadedSessions: 0,
      skippedSessions: skipped,
      acceptedSpans: 0,
      redactionCount,
      dryRun: false,
      refused,
      ...(verdict ? { verdict } : {}),
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
  const completed: Array<{ key: string; item: UploadItem; hash: string; spanCount: number }> = []
  for (const outbound of items) {
    const { item, events, hash } = outbound
    const key = uploadKey(item.ref.harness, item.ref.sessionId)
    // idempotency-key = session + content hash → server-side retry-safe dedup.
    const idempotencyKey = `${key}:${hash}`
    const res = await client.ingestTraces(events, idempotencyKey)
    if (res.accepted !== events.length) throw new PartialUploadError(key, res.accepted, events.length)
    acceptedSpans += res.accepted
    completed.push({ key, item, hash, spanCount: events.length })
    opts.log?.(`uploaded ${item.ref.harness} ${item.ref.sessionId.slice(0, 8)} — ${res.accepted} spans`)
  }
  for (const { key, item, hash, spanCount } of completed) {
    state[key] = {
      hash,
      uploadedAt,
      harness: item.ref.harness,
      spanCount,
    }
  }
  await saveState(state)

  return {
    uploadedSessions: items.length,
    skippedSessions: skipped,
    acceptedSpans,
    redactionCount,
    dryRun: false,
    refused,
    ...(verdict ? { verdict } : {}),
  }
}
