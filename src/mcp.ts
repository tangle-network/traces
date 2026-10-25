/**
 * `traces mcp`: the trace analyst tools as a read-only MCP server over stdio.
 *
 * The tools are agent-eval's (`buildTraceAnalysisToolDescriptors`): the same
 * bounded reads the model-backed analysts use, and the server is agent-runtime's
 * stdio core. This module only binds them to the spans a user selected:
 *
 * - Every tool is published with `readOnlyHint` and `idempotentHint` taken from
 *   its descriptor, and `openWorldHint: false`: it reads one in-memory store of
 *   the selected spans, and nothing is written to disk.
 * - Spans are redacted (`redactSpans`, `default` profile: name, attributes,
 *   status message and causal links' attributes — every span field
 *   `openAgenticTraceStore` reads) before the store is built, and every
 *   result is redacted again at the boundary. The server then reassesses the
 *   redacted spans (`assessSpans`) and refuses to start (throws) when the
 *   verdict is UNSAFE or UNKNOWN, so a detector gap in `redactSpans` shows up
 *   as a refusal instead of a leak served to a client — the same gate
 *   `upload` applies to what it sends.
 * - Every result is wrapped with the untrusted-text notice, and a result above
 *   {@link MCP_RESULT_BYTE_CAP} is refused rather than cut, so a client never
 *   reads half a record as a whole one.
 * - `readSpanSource` is not served. It reads original source bytes in windows
 *   the caller chooses, and a secret split across two windows matches no
 *   redaction rule in either, so no boundary redaction can make it safe.
 */

import {
  buildTraceAnalysisToolDescriptors,
  combineVerdicts,
  redact,
  shareAllowed,
  type ShareSafetyVerdict,
  UNTRUSTED_TRACE_TEXT,
} from '@tangle-network/agent-eval/traces'
import { createStdioToolServer, type McpToolDescriptor } from '@tangle-network/agent-runtime/mcp'
import { exportBytes, openAgenticTraceStore } from './analysis-store.js'
import type { OtlpSpan } from './otlp.js'
import { assessSpans, redactSpans } from './redact.js'
import { tracesVersion } from './version.js'

/** Serialized bytes one tool result may carry. The store's own per-call ceiling is lower. */
const MCP_RESULT_BYTE_CAP = 512 * 1024

export interface TraceMcpServerOptions {
  /** The selected spans; or pass `served`, redacted a batch at a time. */
  readonly spans?: readonly OtlpSpan[]
  readonly served?: ServedSpans
}

/** The redacted export the server reads, and the share-safety verdict of exactly those spans. */
export interface ServedSpans {
  readonly bytes: Buffer
  readonly verdict: ShareSafetyVerdict
}

/**
 * Redact and assess a batch of sessions at a time, keeping only the redacted
 * export's bytes: a week of sessions is never held as spans. Verdicts combine
 * the way one assessment of every span does (counts add, the first paths are kept).
 */
export function createServedSpans(): { add(spans: readonly OtlpSpan[]): void; finish(): ServedSpans } {
  const chunks: Buffer[] = []
  const verdicts: ShareSafetyVerdict[] = []
  return {
    add(spans) {
      if (spans.length === 0) return
      const { spans: redacted } = redactSpans(spans)
      verdicts.push(assessSpans(redacted))
      chunks.push(exportBytes(redacted))
    },
    finish() {
      return { bytes: Buffer.concat(chunks), verdict: combineVerdicts('default', verdicts) }
    },
  }
}

/** Build the MCP tools over the selected spans, redacted. */
function traceMcpTools(options: TraceMcpServerOptions): McpToolDescriptor[] {
  const served = options.served ?? (() => {
    const builder = createServedSpans()
    builder.add(options.spans ?? [])
    return builder.finish()
  })()
  // Gate on what would actually be served, the same way upload gates on what
  // would actually be sent: a detector gap in redactSpans shows up here as
  // UNSAFE (refuse) instead of a leak served to a client.
  const { verdict } = served
  if (!shareAllowed(verdict)) {
    const findings = verdict.findings.map((f) => `${f.category}/${f.detector} (${f.count})`).join(', ')
    throw new Error(
      `mcp: refusing to serve — redacted spans are still ${verdict.status}` +
        (findings ? `: ${findings}` : '') +
        (verdict.unreadable.length > 0 ? `; unreadable: ${verdict.unreadable.join('; ')}` : ''),
    )
  }
  const store = openAgenticTraceStore(served.bytes)
  const descriptors = buildTraceAnalysisToolDescriptors({ store }).filter((d) => d.name !== 'readSpanSource')
  return descriptors.map((descriptor): McpToolDescriptor => ({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.parameters,
    annotations: {
      readOnlyHint: descriptor.readOnly,
      idempotentHint: descriptor.idempotent,
      destructiveHint: false,
      openWorldHint: false,
    },
    handler: async (args) => {
      const { value } = redact(await descriptor.handler(args))
      const result = { untrusted: UNTRUSTED_TRACE_TEXT, result: value }
      const bytes = Buffer.byteLength(JSON.stringify(result))
      if (bytes > MCP_RESULT_BYTE_CAP) {
        throw new RangeError(
          `${descriptor.name}: result is ${bytes} bytes, above the ${MCP_RESULT_BYTE_CAP}-byte cap; narrow the request`,
        )
      }
      return result
    },
  }))
}

/** Serve the tools on stdin/stdout until the client closes the stream. */
export async function serveTraceMcp(options: TraceMcpServerOptions): Promise<void> {
  const tools = traceMcpTools(options)
  const server = createStdioToolServer({ serverName: 'traces', serverVersion: tracesVersion(), tools })
  await server.serve()
}
