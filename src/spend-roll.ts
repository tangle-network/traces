import type { Spend } from '@tangle-network/agent-runtime/kernel'

/**
 * A sum over spend records that keeps "unknown" out of the number.
 *
 * `usd` is the total of the records that priced themselves; `usdUnknown` is how
 * many declined to. A renderer that has 0 known records and >=1 unknown one must
 * print "unknown", never `$0.0000`: an unmetered turn and a free turn are
 * different facts, and agent-runtime's `Spend.usdKnown` is the only signal that
 * separates them (absent means known, per its contract).
 */
export interface SpendRoll {
  readonly records: number
  readonly iterations: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly usd: number
  readonly usdKnownRecords: number
  readonly usdUnknownRecords: number
}

export const ZERO_ROLL: SpendRoll = {
  records: 0,
  iterations: 0,
  tokensIn: 0,
  tokensOut: 0,
  usd: 0,
  usdKnownRecords: 0,
  usdUnknownRecords: 0,
}

export function addSpend(roll: SpendRoll, spend: Spend): SpendRoll {
  const known = spend.usdKnown !== false
  return {
    records: roll.records + 1,
    iterations: roll.iterations + (spend.iterations ?? 0),
    tokensIn: roll.tokensIn + (spend.tokens?.input ?? 0),
    tokensOut: roll.tokensOut + (spend.tokens?.output ?? 0),
    usd: roll.usd + (known ? (spend.usd ?? 0) : 0),
    usdKnownRecords: roll.usdKnownRecords + (known ? 1 : 0),
    usdUnknownRecords: roll.usdUnknownRecords + (known ? 0 : 1),
  }
}

export function mergeRolls(a: SpendRoll, b: SpendRoll): SpendRoll {
  return {
    records: a.records + b.records,
    iterations: a.iterations + b.iterations,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    usd: a.usd + b.usd,
    usdKnownRecords: a.usdKnownRecords + b.usdKnownRecords,
    usdUnknownRecords: a.usdUnknownRecords + b.usdUnknownRecords,
  }
}

