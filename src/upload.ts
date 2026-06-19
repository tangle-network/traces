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
import type { HostedClient, TraceSpanEvent } from '@tangle-network/agent-eval/hosted'
import { REDACTION_VERSION } from '@tangle-network/agent-eval/traces'
import type { RedactionReport } from '@tangle-network/agent-eval/traces'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'
import { redactSpans } from './redact.js'
import { listAdapters, resolveAdapter } from './registry.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
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

export interface PlanOptions {
  harness?: string
  all?: boolean
  cwd?: string
  sinceMs?: number
}

function adaptersFor(opts: PlanOptions): HarnessTraceAdapter[] {
  if (opts.all) return [...listAdapters()]
  const a = resolveAdapter(opts.harness ?? 'claude-code')
  if (!a) throw new Error(`unknown harness "${opts.harness}"`)
  return [a]
}

/** Read-only: select sessions in the window, redact, and mark which are new. */
export async function planUpload(opts: PlanOptions): Promise<UploadPlan> {
  const state = await loadState()
  const items: UploadItem[] = []
  for (const adapter of adaptersFor(opts)) {
    let refs: SessionRef[]
    try {
      refs = await adapter.locate({ cwd: opts.cwd, sinceMs: opts.sinceMs })
    } catch {
      continue
    }
    for (const ref of refs) {
      let raw: OtlpSpan[]
      try {
        raw = await adapter.parse(ref)
      } catch {
        continue
      }
      if (raw.length === 0) continue
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
    'tangle.harness': item.ref.harness,
    'tangle.source': basename(item.ref.path),
    'tangle.host': hostname(),
    'tangle.uploaded_at': uploadedAt,
    'tangle.uploader': `tangle-traces@${TRACES_VERSION}`,
    'redaction.version': REDACTION_VERSION,
    'redaction.count': item.redaction.redactionCount,
  }
  if (item.ref.cwd) meta['tangle.cwd'] = item.ref.cwd
  const branch = await gitBranch(item.ref.cwd)
  if (branch) meta['tangle.git_branch'] = branch
  return meta
}

/** Parse an ISO-8601 or epoch-millis-string timestamp to epoch ms (0 if empty/bad). */
function epochMs(ts: string): number {
  if (!ts) return 0
  if (/^\d+$/.test(ts)) return Number(ts)
  const n = Date.parse(ts)
  return Number.isNaN(n) ? 0 : n
}

const msToNano = (iso: string): number => epochMs(iso) * 1_000_000

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

export interface ExecuteOptions {
  dryRun?: boolean
  /** Where to write the redacted OTLP-JSONL on a dry run. */
  otlpOut?: string
  log?: (msg: string) => void
}

/** Send the NEW items (or, on dryRun, write the redacted OTLP that would send). */
export async function executeUpload(plan: UploadPlan, opts: ExecuteOptions = {}): Promise<UploadResult> {
  const newItems = plan.items.filter((i) => i.isNew)
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

  const client: HostedClient | undefined = hostedClientFromEnv()
  if (!client) {
    throw new Error(
      'upload: Tangle Intelligence Platform is not configured. Set TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL), ' +
        'TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), and TANGLE_TENANT_ID. Use --dry-run to preview without uploading.',
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
