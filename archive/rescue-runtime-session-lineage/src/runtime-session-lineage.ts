import { createHash } from 'node:crypto'
import type {
  RuntimeControllerTurnReceipt,
  RuntimeTraceSessionBinding,
  SupervisorRunSessionLineage,
} from '@tangle-network/agent-eval/supervisor-run'
import { ACTOR_ATTR } from './adapters/conversation.js'
import { ATTR } from './attributes.js'
import type { OtlpSpan } from './otlp.js'

const SHA256 = /^sha256:[a-f0-9]{64}$/

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function requiredString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`session map row ${index}.${field} must be a non-empty string`)
  }
  return value
}

function parseControllerTurns(
  row: Record<string, unknown>,
  rowIndex: number,
  nativePromptCount: number,
): readonly RuntimeControllerTurnReceipt[] {
  const value = row.controllerTurns
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw new Error(`session map row ${rowIndex}.controllerTurns must be an array`)
  }
  if (value.length === 0) return Object.freeze([])
  const receipts: RuntimeControllerTurnReceipt[] = []
  const runIds = new Set<string>()
  let previousOrdinal = 0
  let previousEndedAt = Number.NEGATIVE_INFINITY
  for (const [turnIndex, item] of value.entries()) {
    const receipt = record(item)
    if (receipt === null) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns[${turnIndex}] must be an object`,
      )
    }
    const ordinal = receipt.ordinal
    if (
      !Number.isSafeInteger(ordinal) ||
      (ordinal as number) < 1 ||
      (ordinal as number) > nativePromptCount
    ) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns[${turnIndex}].ordinal must be within the saved session turn count`,
      )
    }
    if ((ordinal as number) <= previousOrdinal) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns ordinals must be unique and strictly increasing`,
      )
    }
    const runId = requiredString(
      receipt.runId,
      `controllerTurns[${turnIndex}].runId`,
      rowIndex,
    )
    if (runIds.has(runId)) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns repeats runId ${JSON.stringify(runId)}`,
      )
    }
    const bridgeRequestDigest = requiredString(
      receipt.bridgeRequestDigest,
      `controllerTurns[${turnIndex}].bridgeRequestDigest`,
      rowIndex,
    )
    const promptSha256 = requiredString(
      receipt.promptSha256,
      `controllerTurns[${turnIndex}].promptSha256`,
      rowIndex,
    )
    if (!SHA256.test(bridgeRequestDigest) || !SHA256.test(promptSha256)) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns[${turnIndex}] digests must be canonical SHA-256 values`,
      )
    }
    const startedAt = receipt.startedAt
    const endedAt = receipt.endedAt
    if (
      !Number.isSafeInteger(startedAt) ||
      (startedAt as number) < 0 ||
      !Number.isSafeInteger(endedAt) ||
      (endedAt as number) < (startedAt as number)
    ) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns[${turnIndex}] must have an ordered Unix-millisecond interval`,
      )
    }
    if ((startedAt as number) < previousEndedAt) {
      throw new Error(
        `session map row ${rowIndex}.controllerTurns contains overlapping intervals`,
      )
    }
    receipts.push(
      Object.freeze({
        ordinal: ordinal as number,
        runId,
        bridgeRequestDigest,
        promptSha256: promptSha256 as `sha256:${string}`,
        startedAt: startedAt as number,
        endedAt: endedAt as number,
      }),
    )
    runIds.add(runId)
    previousOrdinal = ordinal as number
    previousEndedAt = endedAt as number
  }
  return Object.freeze(receipts)
}

function parseNativePromptCount(row: Record<string, unknown>, rowIndex: number): number {
  const value = row.nativePromptCount ?? row.turns
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(
      `session map row ${rowIndex}.nativePromptCount must be a positive safe integer`,
    )
  }
  return value as number
}

/**
 * Normalize a saved, read-only cli-bridge `GET /v1/sessions` response into the
 * provider-neutral binding consumed by agent-eval's Runtime reader.
 */
export function parseCliBridgeSessionMap(
  raw: string,
): readonly RuntimeTraceSessionBinding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `session map must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const response = record(parsed)
  const rows = Array.isArray(parsed) ? parsed : response?.data
  if (!Array.isArray(rows)) {
    throw new Error('session map must be a cli-bridge response object with a data array')
  }

  const bindings: RuntimeTraceSessionBinding[] = []
  const externalOwners = new Map<string, number>()
  for (const [index, value] of rows.entries()) {
    const row = record(value)
    if (row === null) throw new Error(`session map row ${index} must be an object`)
    const externalId = requiredString(row.externalId, 'externalId', index)
    const backend = requiredString(row.backend, 'backend', index)
    const internalId = requiredString(row.internalId, 'internalId', index)
    const cwdValue = row.cwd
    const nativePromptCount = parseNativePromptCount(row, index)
    const controllerTurns = parseControllerTurns(row, index, nativePromptCount)
    if (typeof cwdValue !== 'string' || cwdValue.length === 0) {
      throw new Error(`session map row ${index}.cwd must be a non-empty string`)
    }

    const externalKey = `${backend}\u0000${externalId}`
    const duplicateExternal = externalOwners.get(externalKey)
    if (duplicateExternal !== undefined) {
      throw new Error(
        `session map rows ${duplicateExternal} and ${index} repeat one external id for the same backend`,
      )
    }
    externalOwners.set(externalKey, index)
    bindings.push(
      Object.freeze({
        provider: 'cli-bridge',
        backend,
        externalId,
        nativeSessionId: internalId,
        cwd: cwdValue,
        nativePromptCount,
        controllerTurns,
      }),
    )
  }
  return Object.freeze(bindings)
}

/**
 * Stamp Runtime's exact tree relationship onto normalized native spans.
 * Only prompt ordinals carrying a verified controller-turn receipt are
 * re-attributed; an unbounded or stale native session never becomes agent input.
 */
export function stampRuntimeSessionLineage(
  spans: readonly OtlpSpan[],
  lineage: SupervisorRunSessionLineage,
): OtlpSpan[] {
  const providerSession = lineage.providerSession
  if (providerSession === undefined) {
    throw new Error(
      `Runtime node ${JSON.stringify(lineage.nodeId)} has no measured provider session`,
    )
  }
  const roots = spans.filter((item) => item.parent_span_id === null)
  if (roots.length !== 1) {
    throw new Error(
      `trace session ${JSON.stringify(providerSession.nativeSessionId)} has ${roots.length} root spans; expected exactly one`,
    )
  }
  const nativeRoot = roots[0] as OtlpSpan
  const prompts = spans.filter((item) => item.name === 'user.prompt')
  const controllerInputs = new Set<OtlpSpan>()
  const promptOwners = new Map<OtlpSpan, string>()
  const turnWindows: Array<{
    readonly startedAt: number
    readonly endedAt: number
    readonly nextPromptAt: number | null
  }> = []
  for (const receipt of providerSession.controllerTurns) {
    const matches = prompts.filter((prompt) => {
      const promptMs = Date.parse(prompt.start_time)
      if (
        !Number.isFinite(promptMs) ||
        promptMs < receipt.startedAt ||
        promptMs > receipt.endedAt
      ) {
        return false
      }
      const exactDigest = prompt.attributes['traces.prompt_sha256']
      if (typeof exactDigest === 'string' && SHA256.test(exactDigest)) {
        return exactDigest === receipt.promptSha256
      }
      const content = prompt.attributes.content
      if (typeof content !== 'string') return false
      return (
        `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}` ===
        receipt.promptSha256
      )
    })
    if (matches.length !== 1) {
      throw new Error(
        `Runtime node ${JSON.stringify(lineage.nodeId)} controller turn ${receipt.ordinal} maps to ${matches.length} exact native provider prompts; expected one`,
      )
    }
    const prompt = matches[0] as OtlpSpan
    const owner = promptOwners.get(prompt)
    if (owner !== undefined) {
      throw new Error(
        `Runtime controller runs ${JSON.stringify(owner)} and ${JSON.stringify(receipt.runId)} map to one native provider prompt`,
      )
    }
    promptOwners.set(prompt, receipt.runId)
    controllerInputs.add(prompt)
    const promptStartedAt = Date.parse(prompt.start_time)
    const nextPromptAt =
      prompts
        .map((candidate) => Date.parse(candidate.start_time))
        .filter(
          (candidateStartedAt) =>
            Number.isFinite(candidateStartedAt) && candidateStartedAt > promptStartedAt,
        )
        .sort((left, right) => left - right)[0] ?? null
    turnWindows.push({
      startedAt: promptStartedAt,
      endedAt: receipt.endedAt,
      nextPromptAt,
    })
  }

  const exactSpans = spans.filter((item) => {
    if (item === nativeRoot) return false
    const startedAt = Date.parse(item.start_time)
    const endedAt = Date.parse(item.end_time)
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
      throw new Error(
        `trace session ${JSON.stringify(providerSession.nativeSessionId)} span ${JSON.stringify(item.span_id)} has an invalid time interval`,
      )
    }
    return turnWindows.some(
      (window) =>
        startedAt >= window.startedAt &&
        endedAt <= window.endedAt &&
        (window.nextPromptAt === null ||
          (startedAt < window.nextPromptAt && endedAt <= window.nextPromptAt)),
    )
  })
  const selectedIds = new Set([nativeRoot.span_id, ...exactSpans.map((item) => item.span_id)])
  const knownOrdinals = new Set(
    providerSession.controllerTurns.map((receipt) => receipt.ordinal),
  )
  const missingOrdinals = Array.from(
    { length: providerSession.nativePromptCount },
    (_, index) => index + 1,
  ).filter((ordinal) => !knownOrdinals.has(ordinal))
  const selected = [nativeRoot, ...exactSpans]
  return selected.map((item) => {
    const isRuntimeInput = controllerInputs.has(item)
    const attributes: Record<string, unknown> = {
      ...item.attributes,
      [ATTR.SESSION_ID]: lineage.nodeId,
    }
    if ('session.id' in attributes) attributes['session.id'] = lineage.nodeId
    if ('traces.session.id' in attributes) attributes['traces.session.id'] = lineage.nodeId
    if (isRuntimeInput) {
      attributes[ACTOR_ATTR] = 'agent'
    }
    if (item.parent_span_id === null) {
      attributes['traces.session.role'] = lineage.parentNodeId === null ? 'operator' : 'child'
      attributes['traces.session.depth'] = lineage.depth
      attributes['traces.child_session_ids'] = JSON.stringify(lineage.childNodeIds)
      attributes['traces.runtime.node_id'] = lineage.nodeId
      attributes['traces.provider.provider'] = providerSession.provider
      attributes['traces.provider.backend'] = providerSession.backend
      attributes['traces.provider.external_id'] = providerSession.externalId
      attributes['traces.provider.native_session_id'] = providerSession.nativeSessionId
      attributes['traces.provider.trace_id'] = item.trace_id
      attributes['traces.runtime.exact_prompt_count'] = providerSession.controllerTurns.length
      attributes['traces.provider.native_prompt_count'] = providerSession.nativePromptCount
      attributes['traces.runtime.missing_prompt_ordinals'] = JSON.stringify(missingOrdinals)
      if (lineage.parentNodeId === null) {
        delete attributes['traces.parent_session_id']
        delete attributes['traces.runtime.parent_node_id']
      } else {
        attributes['traces.parent_session_id'] = lineage.parentNodeId
        attributes['traces.runtime.parent_node_id'] = lineage.parentNodeId
      }
    }
    const parentSpanId =
      item.parent_span_id !== null && !selectedIds.has(item.parent_span_id)
        ? nativeRoot.span_id
        : item.parent_span_id
    const interval =
      item === nativeRoot && providerSession.controllerTurns.length > 0
        ? {
            start_time: new Date(
              Math.min(...turnWindows.map((window) => window.startedAt)),
            ).toISOString(),
            end_time: new Date(
              Math.max(
                ...turnWindows.map((window) =>
                  window.nextPromptAt === null
                    ? window.endedAt
                    : Math.min(window.endedAt, window.nextPromptAt),
                ),
              ),
            ).toISOString(),
          }
        : {}
    return {
      ...item,
      ...interval,
      trace_id: lineage.nodeId,
      parent_span_id: parentSpanId,
      attributes,
    }
  })
}
