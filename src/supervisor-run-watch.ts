/**
 * `traces watch <runDir>` — a live terminal view of a supervised run written by
 * agent-runtime's `createFileRunContext`.
 *
 * Plain stdout, no dependency, no cursor control: it works over SSH, in a CI
 * log, and through a pipe, and it prints a new block only when something
 * changed, so a long idle stretch does not scroll away the last real event.
 *
 * The whole view model comes from `readRunContextSnapshot`; this file only
 * formats. Two formatting rules carry the weight:
 *
 *  - **Driver inference and child work never merge.** A supervisor's own
 *    thinking and the work it spawned are separate lines on the same node,
 *    because a single total cannot answer "which half spent the budget" — the
 *    decisive question in three real runs, where a root burned its pool on its
 *    own turns while its one child cost almost nothing.
 *  - **Unknown is never rendered as zero.** `Spend.usdKnown === false` means
 *    the harness did not price that inference; it does not mean the inference
 *    was free. Those records are counted and named, never summed into `$0.00`.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CoordinationQuestion,
  RunContextNode,
  RunContextSnapshot,
  SpendRoll,
} from './supervisor-run-context.js'
import { isFileRunContextDir, mergeRolls, ZERO_ROLL } from './supervisor-run-context.js'
import {
  connectors,
  forEachTreeNode,
  int,
  ms,
  STATUS_MARK,
  tokens,
  usd,
  wrap,
  zeroPricedCost,
} from './run-view-format.js'

function budget(node: RunContextNode): string {
  const parts = [`${int(node.budget.maxIterations)}it`, `${int(node.budget.maxTokens)}tok`]
  if (node.budget.maxUsd !== undefined) parts.push(`$${node.budget.maxUsd.toFixed(2)}`)
  if (node.budget.deadlineMs !== undefined) parts.push(ms(node.budget.deadlineMs))
  return parts.join('/')
}

/**
 * How much of an authored ceiling a node has actually used. Reported per
 * channel because they exhaust independently: a run can die on iterations with
 * 98% of its token pool untouched.
 */
function budgetUse(node: RunContextNode, spent: SpendRoll): string {
  const parts: string[] = []
  if (node.budget.maxIterations > 0 && spent.iterations > 0) {
    parts.push(`${Math.round((spent.iterations / node.budget.maxIterations) * 100)}% it`)
  }
  const used = spent.tokensIn + spent.tokensOut
  if (node.budget.maxTokens > 0 && used > 0) {
    parts.push(`${Math.round((used / node.budget.maxTokens) * 100)}% tok`)
  }
  return parts.length === 0 ? '' : ` · ${parts.join(', ')} of budget`
}

// ── the tree ───────────────────────────────────────────────────────────────

function renderNode(node: RunContextNode, lastAtDepth: readonly boolean[], lines: string[]): void {
  const mark = STATUS_MARK[node.status] ?? '?'
  const { head: prefix, detail } = connectors(node.depth, lastAtDepth)
  const head = [
    `${prefix}${mark} ${node.label}`,
    `[${node.status}]`,
    node.role,
    node.runtime ?? 'no-runtime',
    `budget ${budget(node)}`,
  ]
  if (node.wallMs !== null) head.push(`wall ${ms(node.wallMs)}`)
  lines.push(head.join('  '))
  // The split. A supervisor gets both lines even when one is empty, so the
  // shape of the answer does not change as a run progresses.
  if (node.driver.records > 0 || node.role === 'supervisor') {
    lines.push(
      `${detail}driver    ${node.driver.records} turn(s) · ${tokens(node.driver)} · ${usd(node.driver)}` +
        budgetUse(node, node.driver),
    )
  }
  if (node.children.records > 0 || node.role === 'supervisor') {
    lines.push(
      `${detail}children  ${node.children.records} settled · ${tokens(node.children)} · ${usd(node.children)}`,
    )
  }
  if (node.settled.records > 0) {
    lines.push(
      `${detail}settled   ${node.settled.iterations}it · ${tokens(node.settled)} · ${usd(node.settled)}` +
        budgetUse(node, node.settled),
    )
  }
  if (node.cancelReason !== null) lines.push(`${detail}cancelled: ${node.cancelReason}`)
  if (node.outRef !== null) lines.push(`${detail}out ${node.outRef}`)
}

function renderQuestion(q: CoordinationQuestion, lines: string[]): void {
  const mark = q.blocking ? 'BLOCKING' : (q.urgency ?? 'question')
  lines.push(`  ⚠ ${mark} from ${q.from ?? 'unknown'}${q.status === null ? '' : ` [${q.status}]`}`)
  for (const line of wrap(q.question, 4)) lines.push(line)
  if (q.reason !== null) for (const line of wrap(`why: ${q.reason}`, 4)) lines.push(line)
}

/**
 * The whole view for one snapshot. Pure: the same snapshot always renders the
 * same text, which is what lets the tail print only on change.
 */
export function renderRunContextSnapshot(snapshot: RunContextSnapshot): string {
  const lines: string[] = []
  if (!snapshot.present) {
    lines.push(`run ${snapshot.runDir}`)
    lines.push('  no spawn-journal.jsonl yet — the run has not begun writing')
    return lines.join('\n')
  }

  const totals = runTotals(snapshot)
  lines.push(`run ${snapshot.runId ?? snapshot.runDir}`)
  lines.push(
    `  ${snapshot.nodes.length} node(s) · depth ${snapshot.maxDepth} · ` +
      `elapsed ${ms(elapsed(snapshot))}${snapshot.terminal ? '' : ' · live'}`,
  )
  lines.push(`  driver total    ${tokens(totals.driver)} · ${usd(totals.driver)}`)
  lines.push(`  worker total    ${tokens(totals.workers)} · ${usd(totals.workers)}`)
  lines.push('')

  if (snapshot.nodes.length === 0) lines.push('  (no node spawned yet)')
  forEachTreeNode(snapshot.nodes, (n) => n.parent, (n) => n.id, (node, lastAtDepth) =>
    renderNode(node, lastAtDepth, lines),
  )

  if (snapshot.questions.length > 0) {
    lines.push('')
    for (const q of snapshot.questions) renderQuestion(q, lines)
  }
  if (snapshot.steers.length > 0) {
    lines.push('')
    for (const steer of snapshot.steers) {
      lines.push(`  → steer ${steer.messageId ?? '(no id)'} to ${steer.toWorker ?? '(no target)'}`)
      for (const line of wrap(steer.instruction, 4)) lines.push(line)
    }
  }

  const problems: string[] = []
  if (snapshot.invalidJournalRows > 0) problems.push(`${snapshot.invalidJournalRows} unreadable journal row(s)`)
  if (snapshot.invalidCoordinationRows > 0) {
    problems.push(`${snapshot.invalidCoordinationRows} unreadable coordination row(s)`)
  }
  if (snapshot.treeError !== null) problems.push(snapshot.treeError)
  if (snapshot.partialTail) problems.push('an artifact ends mid-line — the writer is still appending')
  if (zeroPricedCost(totals.driver) || zeroPricedCost(totals.workers)) {
    problems.push(
      'spend recorded $0 with tokens spent: usdKnown was never set false, so this reads as FREE ' +
        'rather than unmetered. A harness-billed brain (a CLI on a subscription) looks exactly like this.',
    )
  }
  // A driver settles through result.json, not through its own journal, so an
  // unsettled node in a finished run is expected — and worth saying once,
  // because `[pending]` on a run that is over otherwise reads as a stall.
  const unsettled = snapshot.nodes.filter(
    (node) => node.status !== 'done' && node.status !== 'failed' && node.status !== 'cancelled',
  )
  if (snapshot.terminal && unsettled.length > 0) {
    problems.push(
      `${unsettled.length} node(s) have no journaled settlement (${unsettled
        .map((n) => n.label)
        .join(', ')}) — a driver reports its outcome through result.json, not the spawn journal`,
    )
  }
  if (problems.length > 0) {
    lines.push('')
    for (const problem of problems) lines.push(`  ! ${problem}`)
  }

  if (snapshot.result !== null) {
    lines.push('')
    lines.push(
      `RESULT ${snapshot.result.kind ?? 'unknown-kind'}` +
        `${snapshot.result.reason === null ? '' : ` · ${snapshot.result.reason}`}`,
    )
    if (snapshot.result.errorMessage !== null) {
      lines.push(`  driver error (${snapshot.result.errorName ?? 'Error'}):`)
      for (const line of wrap(snapshot.result.errorMessage, 4)) lines.push(line)
    }
  }
  return lines.join('\n')
}

/**
 * The two run-level halves, each counted exactly once.
 *
 * Driver total sums every node's OWN `metered` inference, at any depth. Worker
 * total sums the settled spend of LEAF nodes only, because a nested
 * supervisor's settlement re-homes its whole subtree up to its parent — adding
 * it would count every grandchild twice, and the sub-total would silently
 * exceed the pool the run actually spent.
 */
export function runTotals(snapshot: RunContextSnapshot): { driver: SpendRoll; workers: SpendRoll } {
  let driver = ZERO_ROLL
  let workers = ZERO_ROLL
  for (const node of snapshot.nodes) {
    driver = mergeRolls(driver, node.driver)
    if (node.role === 'worker') workers = mergeRolls(workers, node.settled)
  }
  return { driver, workers }
}

function elapsed(snapshot: RunContextSnapshot): number | null {
  if (snapshot.begunAt === null) return null
  const end = snapshot.terminal ? (snapshot.lastEventAt ?? Date.now()) : Date.now()
  return Math.max(0, end - snapshot.begunAt)
}

/**
 * Resolve what the user pointed at: the run directory itself, or a parent
 * holding exactly one. A parent holding several is ambiguous and says so with
 * the candidates, rather than picking one.
 */
export async function resolveRunContextDir(dir: string): Promise<string> {
  if (await isFileRunContextDir(dir)) return dir
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (entries === null) throw new Error(`cannot read ${dir}`)
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    if (await isFileRunContextDir(child)) candidates.push(child)
  }
  if (candidates.length === 1) return candidates[0] as string
  if (candidates.length === 0) {
    throw new Error(
      `no spawn-journal.jsonl in ${dir} or any immediate subdirectory — ` +
        'point at a directory written by agent-runtime createFileRunContext()',
    )
  }
  throw new Error(
    `${candidates.length} run directories under ${dir}; name one:\n  ${candidates.join('\n  ')}`,
  )
}
