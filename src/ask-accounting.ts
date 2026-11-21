import type { AnalystUsageReceipt, TraceAnalysisEngine } from '@tangle-network/agent-eval/analyst'

/**
 * Smallest reservation one model call makes before it runs: its full output and
 * reasoning allowance at the output rate, before any input tokens. Undefined
 * when the engine does not describe its pricing and token caps.
 */
export function engineCallReservationFloorUsd(engine: TraceAnalysisEngine): number | undefined {
  const config = engine.executionConfig
  const pricing = config.pricing as { outputUsdPerMillion?: unknown } | undefined
  const outputRate = pricing?.outputUsdPerMillion
  const maxOutput = config.max_output_tokens
  const maxReasoning = config.max_reasoning_tokens ?? 0
  if (typeof outputRate !== 'number' || typeof maxOutput !== 'number' || typeof maxReasoning !== 'number') {
    return undefined
  }
  return ((maxOutput + maxReasoning) * outputRate) / 1_000_000
}

export function formatUsd(value: number): string {
  return `$${value < 0.01 && value > 0 ? value.toPrecision(2) : value.toFixed(2)}`
}

export function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

// Older analyst engines provide only provider usage. Failed attempts do not imply completions.
export function receiptActivity(receipt: AnalystUsageReceipt | null) {
  return receipt?.activity
}
