import {
  callLlm,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  LlmCallError,
  type LlmCallRequest,
} from '@tangle-network/agent-eval'
import type { createDspyRlmTraceEngine } from '@tangle-network/agent-eval/analyst'

/**
 * The engine's own model-call seam. Derived from the factory rather than
 * imported, because agent-eval does not export the contract type by name and a
 * hand-written copy would silently drift from the version installed here.
 */
type ExternalOptimizerModelCall = NonNullable<Parameters<typeof createDspyRlmTraceEngine>[0]['call']>

/**
 * How much of a provider error body is retained as execution evidence. Enough
 * to name the cause, bounded because the body is attacker-influenced and the
 * proxy holds the whole execution record in memory.
 */
export const PROVIDER_ERROR_BODY_LIMIT = 2_000

/**
 * The CLI's owned execution path for one admitted analyst model call.
 *
 * agent-eval 0.144.0 stopped accepting provider credentials: the caller owns
 * execution and returns a typed result plus a cost receipt for every admitted
 * call. This path is one OpenAI-compatible HTTP call through agent-eval's own
 * `callLlm`.
 *
 * The callback always resolves. Rejecting loses the execution record and fails
 * the whole optimizer attempt.
 */
export function createAnalystModelCall(opts: {
  apiKey: string
  baseUrl: string
}): ExternalOptimizerModelCall {
  const { apiKey, baseUrl } = opts
  return async ({ request, callId, signal }) => {
    try {
      const req = structuredClone(request) as LlmCallRequest
      // callId is the ledger's stable identity for this one paid call, so it
      // is the provider idempotency key: callLlm retries transient failures,
      // and without it a lost-but-billed response is charged twice.
      const response = await callLlm(req, {
        apiKey,
        baseUrl,
        signal,
        idempotencyKey: callId,
      })
      return {
        succeeded: true,
        response,
        receipt: costReceiptFromLlm(response),
        execution: {
          callId,
          baseUrl,
          requestedModel: req.model,
          servedModel: response.servedModel ?? null,
          finishReason: response.finishReason ?? null,
          durationMs: response.durationMs,
        },
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      // The callback must resolve, so an abort cannot reach the proxy as a
      // thrown AbortError and can never take its 504 branch. Naming the class
      // in the failure text is what lets the bridge tell a cancelled call apart
      // from a transient one it should retry.
      //
      // Only the caller's signal proves a cancellation. `callLlm` aborts an
      // internal controller to enforce its own per-attempt timeout, so a plain
      // provider timeout also surfaces as an `AbortError` while this signal
      // stays clear. Reading the error name here would mark that timeout
      // uncancellable and stop the bridge retrying a call it should retry.
      const aborted = signal.aborted
      const message = aborted ? `AbortError: ${err.message}` : err.message
      // LlmCallError carries the provider's own reason (bad key, context
      // length, unknown model). Without it the operator sees only the HTTP
      // status. It stays in the execution evidence and out of the log line,
      // because a gateway can echo request headers into an error body.
      const detail =
        err instanceof LlmCallError
          ? { status: err.status, body: err.body.slice(0, PROVIDER_ERROR_BODY_LIMIT) }
          : {}
      return {
        succeeded: false,
        error: message,
        // costReceiptFromLlmError recovers the provider receipt when the
        // response completed but violated the contract; otherwise usage and
        // cost stay explicitly unknown.
        receipt: costReceiptFromLlmError(err) ?? {
          model: request.model,
          inputTokens: 0,
          outputTokens: 0,
          costUnknown: true,
          usageUnknown: true,
        },
        execution: {
          callId,
          baseUrl,
          requestedModel: request.model,
          aborted,
          error: message,
          ...detail,
        },
      }
    }
  }
}
