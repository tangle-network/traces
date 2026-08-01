/**
 * `traces watch <target>` — the live terminal view, over whichever sources the
 * target actually has.
 *
 * Two sources, one verb:
 *
 *  - **General** — `run-span-tree.ts`, over OTLP spans. `trace_id` /
 *    `span_id` / `parent_span_id` reconstruct the tree for ANY emitter, so a
 *    system nobody has written yet is watchable the day it emits its first
 *    span. It cannot report an authored budget, because no span vocabulary
 *    carries one.
 *  - **Specific** — `supervisor-run-context.ts`, over agent-runtime's durable
 *    spawn journal. It carries the exact budget, spend, and settlement the
 *    telemetry does not.
 *
 * When a run has both, the output shows both and LABELS which number came from
 * which: the journal section first, because its numbers are the authoritative
 * ones, then the span section for the shape and the per-turn detail. They are
 * never merged into one column, because a merged column cannot be audited —
 * and the numbers legitimately differ (a driver's spans price each turn; the
 * journal's `settled` re-homes a whole subtree onto its parent).
 *
 * Plain stdout, no dependency, no cursor control: it works over SSH, in a CI
 * log, and through a pipe. A block prints only when the rendered view changed,
 * so a long idle stretch never scrolls the last real event away.
 */

import { stat } from 'node:fs/promises'
import { RULE } from './run-view-format.js'
import type { SpanRunSnapshot } from './run-span-tree.js'
import { findSpanSourceFiles, readSpanRunSnapshot, renderSpanRunSnapshot } from './run-span-tree.js'
import type { RunContextSnapshot } from './supervisor-run-context.js'
import { isFileRunContextDir, readRunContextSnapshot } from './supervisor-run-context.js'
import { renderRunContextSnapshot, resolveRunContextDir } from './supervisor-run-watch.js'

/** What a resolved target will be read from. At least one is always present. */
export interface RunWatchTarget {
  /** The directory holding `spawn-journal.jsonl`, when there is one. */
  readonly runDir: string | null
  /** OTLP span files to fold, in read order. */
  readonly spanFiles: readonly string[]
  /** What the caller named, verbatim — the thing to print in an error. */
  readonly requested: string
}

/**
 * Resolve what the user pointed at.
 *
 * A file the caller named is read as spans, whatever it is called. A directory
 * is the run directory when it holds a spawn journal, or the parent of exactly
 * one — the same rule `resolveRunContextDir` already applies — and either way
 * its span files come along. A directory with neither is an error naming both
 * things it looked for, because "nothing here" and "wrong kind of thing here"
 * are different mistakes.
 */
export async function resolveRunWatchTarget(target: string): Promise<RunWatchTarget> {
  const info = await stat(target).catch(() => null)
  if (info === null) throw new Error(`cannot read ${target}`)
  // A file the caller NAMED is read as spans whatever it is called; only
  // discovery inside a directory filters by name. Naming a file is already the
  // statement of intent, and a wrong guess surfaces as a readable "unreadable"
  // line rather than as a refusal to look.
  if (info.isFile()) return { runDir: null, spanFiles: [target], requested: target }

  const spanFiles = await findSpanSourceFiles(target)
  if (await isFileRunContextDir(target)) return { runDir: target, spanFiles, requested: target }

  const nested = await resolveRunContextDir(target).catch(() => null)
  if (nested !== null) {
    const nestedSpans = await findSpanSourceFiles(nested)
    return {
      runDir: nested,
      spanFiles: [...new Set([...spanFiles, ...nestedSpans])].sort(),
      requested: target,
    }
  }
  if (spanFiles.length > 0) return { runDir: null, spanFiles, requested: target }
  throw new Error(
    `nothing to watch in ${target} — found neither spawn-journal.jsonl (agent-runtime ` +
      'createFileRunContext, at this level or one below) nor an OTLP span file ' +
      '(*.otlp.jsonl / *.spans.jsonl / *.traces.jsonl / *.openinference.jsonl)',
  )
}

export interface RunWatchSnapshot {
  readonly target: RunWatchTarget
  /** Present only when the target has a spawn journal. */
  readonly journal: RunContextSnapshot | null
  readonly spans: readonly SpanRunSnapshot[]
  /** True once every present source says the run is over. */
  readonly terminal: boolean
}

export async function readRunWatchSnapshot(target: RunWatchTarget): Promise<RunWatchSnapshot> {
  const journal = target.runDir === null ? null : await readRunContextSnapshot(target.runDir)
  const spans = await Promise.all(target.spanFiles.map((file) => readSpanRunSnapshot(file)))
  return {
    target,
    journal,
    spans,
    // A span file alone never declares itself finished — an emitter can always
    // append one more span — so only the journal's `result.json` ends a watch.
    terminal: journal !== null && journal.terminal,
  }
}

/**
 * One header naming every source and what each is authoritative for, so a
 * reader never has to guess where a number came from.
 */
function sourceHeader(snapshot: RunWatchSnapshot): string[] {
  const lines: string[] = ['sources']
  if (snapshot.journal !== null) {
    lines.push(
      `  journal  ${snapshot.target.runDir}/spawn-journal.jsonl` +
        '  → authored budget, settled spend, settlement status (authoritative)',
    )
  }
  for (const span of snapshot.spans) {
    lines.push(
      `  spans    ${span.source}` +
        `  → tree shape and per-turn detail${span.readError === null ? '' : ' (unreadable)'}`,
    )
  }
  if (snapshot.journal === null) {
    lines.push('  (no spawn journal here: budget and settlement are UNAVAILABLE, not zero)')
  }
  if (snapshot.spans.length === 0) {
    lines.push('  (no OTLP span file here: per-turn shape is UNAVAILABLE, not empty)')
  }
  return lines
}

export function renderRunWatchSnapshot(snapshot: RunWatchSnapshot): string {
  const blocks: string[] = [sourceHeader(snapshot).join('\n')]
  if (snapshot.journal !== null) blocks.push(renderRunContextSnapshot(snapshot.journal))
  for (const span of snapshot.spans) blocks.push(renderSpanRunSnapshot(span))
  return blocks.join('\n\n')
}

export interface WatchRunTargetOptions {
  /** Print one snapshot and return — what a script or an agent wants. */
  readonly once?: boolean
  /** Poll period in ms (default 2000). */
  readonly intervalMs?: number
  /** Where to write (default stdout). */
  readonly write?: (text: string) => void
  readonly signal?: AbortSignal
  /** Keep tailing after the run reaches a terminal state (default: stop). */
  readonly follow?: boolean
}

/**
 * Tail a target until every source says the run is over. Prints a block only
 * when the rendered view changed, so the last thing on screen is always the
 * last thing that happened.
 */
export async function watchRunTarget(
  target: RunWatchTarget,
  opts: WatchRunTargetOptions = {},
): Promise<RunWatchSnapshot> {
  const write = opts.write ?? ((text: string) => process.stdout.write(text))
  const intervalMs = opts.intervalMs ?? 2000
  let previous = ''
  for (;;) {
    const snapshot = await readRunWatchSnapshot(target)
    const rendered = renderRunWatchSnapshot(snapshot)
    if (opts.once) {
      write(`${rendered}\n`)
      return snapshot
    }
    if (rendered !== previous) {
      write(`\n${RULE}\n${new Date().toISOString()}\n${rendered}\n`)
      previous = rendered
    }
    if (snapshot.terminal && opts.follow !== true) return snapshot
    if (aborted(opts.signal)) return snapshot
    await sleep(intervalMs, opts.signal)
    // Ctrl-C during the sleep: re-read once so the last thing printed is the
    // state the run was actually in when the watch stopped.
    if (aborted(opts.signal)) return await readRunWatchSnapshot(target)
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function sleep(msDelay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, msDelay)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
