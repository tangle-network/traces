import type { Spend } from '@tangle-network/agent-runtime/kernel'

type CountChannel = 'iterations' | 'tokensIn' | 'tokensOut'
type MissingCounts = Partial<Record<CountChannel, number>>

/** Numeric subtotals contain only recorded amounts. Missing receipts are counted by channel. */
export interface SpendRoll {
  readonly records: number
  readonly iterations: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly usd: number
  readonly usdKnownRecords: number
  readonly usdUnknownRecords: number
  readonly missing?: Readonly<MissingCounts>
}

export const ZERO_ROLL: SpendRoll = {
  records: 0, iterations: 0, tokensIn: 0, tokensOut: 0, usd: 0, usdKnownRecords: 0, usdUnknownRecords: 0,
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function exactCount(roll: SpendRoll, channel: CountChannel): number | null {
  return roll.records > 0 && !roll.missing?.[channel] ? roll[channel] : null
}

export function addSpend(roll: SpendRoll, spend: Spend | undefined | null): SpendRoll {
  const input = spend?.tokens?.input, output = spend?.tokens?.output, iterations = spend?.iterations
  const price = spend?.usd
  const partialTokens = spend?.tokensKnown === false || spend?.tokens?.tokensKnown === false
  const priced = nonnegative(price) && spend?.usdKnown !== false
  const missing: MissingCounts = {}
  if (!nonnegative(input) || partialTokens) missing.tokensIn = 1
  if (!nonnegative(output) || partialTokens) missing.tokensOut = 1
  if (!nonnegative(iterations) || spend?.iterationsKnown === false) missing.iterations = 1
  return mergeRolls(roll, {
    records: 1, iterations: nonnegative(iterations) ? iterations : 0,
    tokensIn: nonnegative(input) ? input : 0, tokensOut: nonnegative(output) ? output : 0,
    usd: priced ? price : 0, usdKnownRecords: priced ? 1 : 0, usdUnknownRecords: priced ? 0 : 1,
    ...(Object.keys(missing).length ? { missing } : {}),
  })
}

export function mergeRolls(a: SpendRoll, b: SpendRoll): SpendRoll {
  let missing = a.missing
  if (b.missing) {
    const counts = { ...missing }
    for (const channel of ['iterations', 'tokensIn', 'tokensOut'] as const) {
      const delta = b.missing[channel] ?? 0
      if (delta) counts[channel] = (counts[channel] ?? 0) + delta
    }
    missing = counts
  }
  return {
    records: a.records + b.records,
    iterations: a.iterations + b.iterations,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    usd: a.usd + b.usd,
    usdKnownRecords: a.usdKnownRecords + b.usdKnownRecords,
    usdUnknownRecords: a.usdUnknownRecords + b.usdUnknownRecords,
    ...(missing ? { missing } : {}),
  }
}
