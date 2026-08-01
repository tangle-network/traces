/**
 * Formatting primitives shared by every `traces watch <target>` view.
 *
 * Two rules live here rather than in each renderer, because they are the whole
 * reason this view exists and a second copy would eventually disagree with the
 * first:
 *
 *  - **Unknown is never rendered as zero.** A roll with no priced record prints
 *    "cost unknown", not `$0.0000`. An unmetered turn and a free turn are
 *    different facts.
 *  - **A recorded $0 that burned tokens is printed AND flagged.** The recorded
 *    value stands; the ambiguity is named next to it.
 *
 * Plain ASCII-plus-box-drawing, no cursor control and no colour: the output has
 * to survive SSH, a CI log, and a pipe into a file.
 */

import type { SpendRoll } from './supervisor-run-context.js'

export const RULE = '─'.repeat(76)

export function int(n: number): string {
  return n.toLocaleString('en-US')
}

export function ms(value: number | null): string {
  if (value === null) return '—'
  if (value < 1000) return `${value}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  return `${minutes}m${String(Math.round((value % 60_000) / 1000)).padStart(2, '0')}s`
}

/**
 * A dollar figure that keeps unknown out of the number. With no priced record
 * at all the answer is "cost unknown" — printing `$0.0000` there is the exact
 * fabrication this view exists to prevent.
 */
export function usd(roll: SpendRoll): string {
  if (roll.usdKnownRecords === 0) {
    return roll.usdUnknownRecords === 0
      ? 'no spend recorded'
      : `cost unknown (${roll.usdUnknownRecords} unpriced)`
  }
  const priced = zeroPricedCost(roll)
    ? `$${roll.usd.toFixed(4)} (zero across ${roll.usdKnownRecords} priced)`
    : `$${roll.usd.toFixed(4)}`
  return roll.usdUnknownRecords === 0 ? priced : `${priced} + ${roll.usdUnknownRecords} unpriced`
}

/**
 * A roll that claims a price of exactly $0 while recording real tokens.
 *
 * agent-runtime's contract is that `Spend.usdKnown` absent means the dollar
 * figure IS known, so the honest number is $0 and this view prints it. But a
 * harness-billed brain (a CLI on a subscription) also records $0 without ever
 * setting `usdKnown:false`, and "free" and "unmetered" are the two facts this
 * view exists to keep apart. So the value stands and the ambiguity is named —
 * never the reverse.
 */
export function zeroPricedCost(roll: SpendRoll): boolean {
  return roll.usdKnownRecords > 0 && roll.usd === 0 && roll.tokensIn + roll.tokensOut > 0
}

export function tokens(roll: SpendRoll): string {
  return `in ${int(roll.tokensIn)} · out ${int(roll.tokensOut)}`
}

export const STATUS_MARK: Record<string, string> = {
  pending: '·',
  acquiring: '◐',
  running: '▶',
  waiting: '⏸',
  done: '✓',
  failed: '✗',
  cancelled: '⊘',
}

/**
 * Tree connectors for a depth-first node list. `lastAtDepth` records, per
 * ancestor level, whether that ancestor was its parent's last child, which is
 * what decides between a continuing `│` and a blank column — the difference
 * between a readable tree and an ambiguous indent at depth 3+.
 */
export function connectors(
  depth: number,
  lastAtDepth: readonly boolean[],
): { head: string; detail: string } {
  if (depth === 0) return { head: '● ', detail: '    ' }
  let stem = ''
  for (let level = 1; level < depth; level++) stem += lastAtDepth[level] ? '   ' : '│  '
  const isLast = lastAtDepth[depth] ?? true
  return { head: `${stem}${isLast ? '└─ ' : '├─ '}`, detail: `${stem}${isLast ? '   ' : '│  '}    ` }
}

/**
 * Walk a depth-first node list, handing each node the `lastAtDepth` state its
 * connectors need. A node is its parent's last child when no later node shares
 * that parent, which the caller's list order already encodes.
 */
export function forEachTreeNode<T extends { readonly depth: number }>(
  nodes: readonly T[],
  parentKey: (node: T) => string | null,
  selfKey: (node: T) => string,
  visit: (node: T, lastAtDepth: readonly boolean[]) => void,
): void {
  const lastChildOf = new Map<string | null, string>()
  for (const node of nodes) lastChildOf.set(parentKey(node), selfKey(node))
  const lastAtDepth: boolean[] = []
  for (const node of nodes) {
    lastAtDepth[node.depth] = lastChildOf.get(parentKey(node)) === selfKey(node)
    lastAtDepth.length = node.depth + 1
    visit(node, lastAtDepth)
  }
}

/** Wrap to a terminal width so a long question is readable, never truncated. */
export function wrap(text: string, indent: number): string[] {
  const width = Math.max(40, (process.stdout.columns ?? 100) - indent - 2)
  const pad = ' '.repeat(indent)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length > 0 && line.length + 1 + word.length > width) {
        out.push(pad + line)
        line = word
      } else line = line.length === 0 ? word : `${line} ${word}`
    }
    out.push(pad + line)
  }
  return out
}
