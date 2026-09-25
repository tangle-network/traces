/**
 * `traces mcp`: the trace analyst tools as a read-only MCP server over stdio.
 *
 * The tools are agent-eval's (`buildTraceAnalysisToolDescriptors`): the same
 * bounded reads the model-backed analysts use, and the server is agent-runtime's
 * stdio core. This module only binds them to the spans a user selected:
 *
 * - Every tool is published with `readOnlyHint` and `idempotentHint` taken from
 *   its descriptor, and `openWorldHint: false`: it reads one local trace file.
 * - Spans are redacted with agent-eval's redaction core (`default` profile)
 *   before the store is built, so a search cannot match a secret, and every
 *   result is redacted again at the boundary.
 * - Every result is wrapped with the untrusted-text notice, and a result above
 *   {@link MCP_RESULT_BYTE_CAP} is refused rather than cut, so a client never
 *   reads half a record as a whole one.
 * - `readSpanSource` is not served. It reads original source bytes in windows
 *   the caller chooses, and a secret split across two windows matches no
 *   redaction rule in either, so no boundary redaction can make it safe.
 */

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildTraceAnalysisToolDescriptors, redact, UNTRUSTED_TRACE_TEXT } from '@tangle-network/agent-eval/traces'
import { createStdioToolServer, type McpToolDescriptor } from '@tangle-network/agent-runtime/mcp'
import { openAgenticTraceStore, writeAnalysisTraceFile } from './analysis-store.js'
import type { OtlpSpan } from './otlp.js'
import { redactSpans } from './redact.js'

/** Serialized bytes one tool result may carry. The store's own per-call ceiling is lower. */
export const MCP_RESULT_BYTE_CAP = 512 * 1024

export interface TraceMcpServerOptions {
  readonly spans: readonly OtlpSpan[]
}

function tracesVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
  return pkg.version ?? '0.0.0'
}

/** Build the MCP tools over the selected spans, and the redacted span file they read. */
export async function traceMcpTools(
  options: TraceMcpServerOptions,
): Promise<{ tools: McpToolDescriptor[]; otlpPath: string }> {
  const { spans } = redactSpans(options.spans)
  const file = await writeAnalysisTraceFile(spans)
  const store = await openAgenticTraceStore(file)
  const descriptors = buildTraceAnalysisToolDescriptors({ store }).filter((d) => d.name !== 'readSpanSource')
  const tools = descriptors.map((descriptor): McpToolDescriptor => ({
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
  return { tools, otlpPath: file.otlpPath }
}

/** Serve the tools on stdin/stdout until the client closes the stream. */
export async function serveTraceMcp(options: TraceMcpServerOptions): Promise<void> {
  const { tools, otlpPath } = await traceMcpTools(options)
  const server = createStdioToolServer({ serverName: 'traces', serverVersion: tracesVersion(), tools })
  try {
    await server.serve()
  } finally {
    // The span file is this server's own temporary copy (mkdtemp under the OS temp dir).
    await rm(dirname(otlpPath), { recursive: true, force: true })
  }
}
