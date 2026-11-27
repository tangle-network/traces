/**
 * `traces behavior`: what each agent did per window, read a session at a time; exit 2 when no span is a tool call.
 * A Runtime run directory adds its own records (`src/run-record.ts`): who stopped it and why, its checks,
 * and each agent's quiet before the stop. Those records answer even when no span is a tool call. A node
 * still open in an ended run ends when the run did, not now; in a reopened run, an agent's quiet is read
 * from its acts before the reopen.
 */
import { BEHAVIOR_POLICY, behaviorReader, renderBehaviorText } from './behavior.js'
import type { CollectedSpans } from './cli-span-input.js'
import type { CliArgs } from './cli-selection-types.js'
import { workflowIssueText } from './session-workflow.js'
import { CliError } from './commands.js'
import type { OtlpSpan } from './otlp.js'
import { quietBeforeStop, readRunRecord, renderRunRecordLines, reopenSeconds, runEndSeconds, stoppedBetweenGenerations, type RunRecord } from './run-record.js'

/** The one Runtime run directory the selection names, when it names nothing else. */
export function selectedRunDir(args: CliArgs): string | null {
  const spans = args.selection?.spans ?? []
  if (spans.length !== 1 || (args.selection?.sessions.length ?? 0) > 0) return null
  return spans[0]!.kind === 'run-dir' ? spans[0]!.path : null
}

export async function cmdBehavior(args: CliArgs, forEachBatch: (onBatch: (spans: readonly OtlpSpan[]) => Promise<void>) => Promise<Pick<CollectedSpans, 'sourceGaps' | 'unread' | 'workflow'> & { spanCount: number }>): Promise<void> {
  const runDir = selectedRunDir(args)
  const record: RunRecord | null = runDir === null ? null : await readRunRecord(runDir)
  const now = record === null ? undefined : runEndSeconds(record)
  const actsBefore = record === null ? undefined : reopenSeconds(record)
  // A reopened run was stopped between its generations: that time is neither idle nor active.
  const between = record === null ? undefined : stoppedBetweenGenerations(record)
  const reader = behaviorReader({
    ...(args.window === undefined ? {} : { windowMs: args.window }), ...(now === undefined ? {} : { now }), ...(actsBefore === undefined ? {} : { actsBefore }),
    ...(between === undefined ? {} : { stopped: between.stopped }),
  })
  const selection = await forEachBatch(async (spans) => reader.add(spans))
  const gaps = [
    ...(selection.sourceGaps ?? []),
    ...(selection.unread?.length ? [`${selection.unread.length} selected session(s) were unreadable`] : []),
    ...(selection.workflow?.issues.map(workflowIssueText) ?? []),
    ...(between?.unknowns ?? []),
  ]
  let result: ReturnType<typeof reader.result> | undefined
  let unavailable: string | null = null
  if (selection.spanCount === 0) {
    if (record === null) throw new Error('no spans found for the given selection')
    unavailable = 'no spans found for the given selection'
  } else {
    try {
      result = reader.result(gaps)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'no-outcome') throw error
      const message = error instanceof Error ? error.message : String(error)
      if (record === null) throw new CliError(message, 'no-outcome')
      unavailable = message
    }
  }
  if (result === undefined) {
    // The run's own records still say why it stopped and how far it got; the categories need acts.
    const runRecord = { ...record!, quiet: [] }
    const doc = { policy: { ...BEHAVIOR_POLICY, window_s: (args.window ?? 300_000) / 1000 }, run_record: runRecord, categories: null, reason: unavailable,
      coverage: { input_spans: selection.spanCount, tool_calls: 0, unknowns: [...new Set(gaps)].sort() } }
    process.stdout.write(args.format === 'json'
      ? `${JSON.stringify(doc)}\n`
      : `${[...renderRunRecordLines(record!), `behavior: categories unavailable: ${unavailable}`, ...doc.coverage.unknowns.map((gap) => `  incomplete: ${gap}`)].join('\n')}\n`)
    return
  }
  if (record === null) {
    process.stdout.write(args.format === 'json' ? `${JSON.stringify(result)}\n` : `${renderBehaviorText(result)}\n`)
    return
  }
  const quiet = quietBeforeStop(record, result.nodes.map((node) => ({ id: node.id, label: node.label, state: node.state, lastActivity: (actsBefore === undefined ? node.last_act : node.last_act_before) ?? null })))
  process.stdout.write(args.format === 'json'
    ? `${JSON.stringify({ ...result, run_record: { ...record, quiet } })}\n`
    : `${[...renderRunRecordLines(record, quiet), renderBehaviorText(result)].join('\n')}\n`)
}
