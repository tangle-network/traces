#!/usr/bin/env node
/**
 * `traces` — analyze your own coding-agent sessions.
 *
 *   traces list    [--harness claude-code] [--last 20] [--all]
 *   traces analyze [--harness claude-code] [--last 1] [--out report.md] [--llm]
 *   traces convert [--harness claude-code] [--last 1] --otlp spans.jsonl
 *   traces watch   [--all] [--interval 5] [--window 30] [--min-loop 3]
 *
 * `analyze` runs the agent-eval analyst suite (deterministic + the shipped
 * loop/waste pipelines; +agentic RLM kinds with `--llm`). `watch` is the
 * online observer: it tails active sessions and prints a notification when a
 * stuck loop / high duplicate-rate appears. `watch` is read-only — it never
 * touches the agent or its harness.
 */

import { stat, writeFile } from 'node:fs/promises'
import { analyzeSpans, writeOtlp } from './analyze.js'
import type { OtlpSpan } from './otlp.js'
import { runPipelines } from './pipelines.js'
import { knownHarnesses, listAdapters, resolveAdapter } from './registry.js'
import { renderPipelines, renderReport } from './report.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'

interface Args {
  command: string
  harness: string
  all: boolean
  last: number
  session?: string
  cwd?: string
  since?: string
  out?: string
  otlp?: string
  llm: boolean
  budget?: number
  interval: number
  window: number
  minLoop: number
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? 'help',
    harness: 'claude-code',
    all: false,
    last: 0,
    llm: false,
    interval: 5,
    window: 30,
    minLoop: 3,
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--harness': a.harness = next() ?? a.harness; break
      case '--all': a.all = true; break
      case '--last': a.last = Number(next()); break
      case '--session': a.session = next(); break
      case '--cwd': a.cwd = next(); break
      case '--since': a.since = next(); break
      case '--out': a.out = next(); break
      case '--otlp': a.otlp = next(); break
      case '--llm': a.llm = true; break
      case '--budget': a.budget = Number(next()); break
      case '--interval': a.interval = Number(next()); break
      case '--window': a.window = Number(next()); break
      case '--min-loop': a.minLoop = Number(next()); break
      default:
        if (arg?.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
    }
  }
  return a
}

function adaptersFor(args: Args): HarnessTraceAdapter[] {
  if (args.all) return [...listAdapters()]
  const adapter = resolveAdapter(args.harness)
  if (!adapter) {
    throw new Error(`unknown harness "${args.harness}". Known: ${knownHarnesses().join(', ')}`)
  }
  return [adapter]
}

async function discover(args: Args): Promise<{ adapter: HarnessTraceAdapter; refs: SessionRef[] }[]> {
  const sinceMs = args.since ? Date.parse(args.since) : undefined
  const out: { adapter: HarnessTraceAdapter; refs: SessionRef[] }[] = []
  for (const adapter of adaptersFor(args)) {
    let refs = await adapter.locate({ cwd: args.cwd, sinceMs })
    if (args.last > 0) refs = refs.slice(0, args.last)
    out.push({ adapter, refs })
  }
  return out
}

async function buildAxService(): Promise<import('@ax-llm/ax').AxAIService> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('--llm needs OPENAI_API_KEY for the agentic analyst kinds (deterministic analysis needs no key)')
  }
  const { AxAI } = await import('@ax-llm/ax')
  return new AxAI({ name: 'openai', apiKey }) as unknown as import('@ax-llm/ax').AxAIService
}

async function cmdList(args: Args): Promise<void> {
  const groups = await discover({ ...args, last: args.last || 20 })
  for (const { adapter, refs } of groups) {
    console.log(`\n${adapter.harness} — ${refs.length} session(s)`)
    for (const r of refs) {
      console.log(`  ${new Date(r.mtimeMs).toISOString()}  ${r.sessionId}  ${r.cwd ?? ''}`)
    }
  }
}

async function collectSpans(args: Args): Promise<{ spans: OtlpSpan[]; harness: string; sessionCount: number }> {
  if (args.session) {
    const adapter = resolveAdapter(args.harness)
    if (!adapter) throw new Error(`unknown harness "${args.harness}"`)
    const st = await stat(args.session)
    const ref: SessionRef = {
      harness: adapter.harness,
      sessionId: args.session,
      path: args.session,
      cwd: null,
      mtimeMs: st.mtimeMs,
    }
    return { spans: await adapter.parse(ref), harness: adapter.harness, sessionCount: 1 }
  }
  const groups = await discover({ ...args, last: args.last || 1 })
  const spans: OtlpSpan[] = []
  let sessionCount = 0
  const harnesses: string[] = []
  for (const { adapter, refs } of groups) {
    if (refs.length > 0) harnesses.push(adapter.harness)
    for (const ref of refs) {
      spans.push(...(await adapter.parse(ref)))
      sessionCount += 1
    }
  }
  return { spans, harness: harnesses.join('+') || args.harness, sessionCount }
}

async function cmdConvert(args: Args): Promise<void> {
  const { spans } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const path = await writeOtlp(spans, args.otlp)
  console.log(`wrote ${spans.length} spans → ${path}`)
}

async function cmdAnalyze(args: Args): Promise<void> {
  const { spans, harness, sessionCount } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const ai = args.llm ? await buildAxService() : undefined
  const { otlpPath, result } = await analyzeSpans(spans, {
    ai,
    budgetUsd: args.budget,
    otlpOutPath: args.otlp,
    log: (msg) => process.stderr.write(`${msg}\n`),
  })
  const pipelines = await runPipelines(spans, { minLoopOccurrences: args.minLoop })
  const report = `${renderReport(result, { harness, sessionCount, spanCount: spans.length, otlpPath })}\n${renderPipelines(pipelines)}`
  if (args.out) {
    await writeFile(args.out, report, 'utf8')
    console.log(`report → ${args.out}  (${result.findings.length} findings, ${pipelines.stuckLoops.findings.length} loops, OTLP: ${otlpPath})`)
  } else {
    console.log(report)
  }
}

/** A loop signal worth alerting on — keyed so we only notify on growth. */
function loopKey(sessionId: string, toolName: string, argHash: string): string {
  return `${sessionId}|${toolName}|${argHash}`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function cmdWatch(args: Args): Promise<void> {
  if (!args.all && !args.cwd) args.all = true // default: observe everything active
  const seen = new Map<string, number>() // loopKey → max occurrences alerted
  const intervalMs = Math.max(1, args.interval) * 1000
  process.stderr.write(
    `traces watch — observing ${args.all ? 'all harnesses' : args.harness}, ` +
      `sessions active in the last ${args.window}m, every ${args.interval}s. Read-only; Ctrl-C to stop.\n`,
  )

  for (;;) {
    const sinceMs = Date.now() - args.window * 60_000
    for (const adapter of adaptersFor(args)) {
      let refs: SessionRef[]
      try {
        refs = await adapter.locate({ cwd: args.cwd, sinceMs })
      } catch {
        continue
      }
      for (const ref of refs) {
        let report: Awaited<ReturnType<typeof runPipelines>>
        try {
          const spans = await adapter.parse(ref)
          if (spans.length === 0) continue
          report = await runPipelines(spans, { minLoopOccurrences: args.minLoop })
        } catch {
          continue
        }
        for (const f of report.stuckLoops.findings) {
          const key = loopKey(ref.sessionId, f.toolName, f.argHash)
          const prior = seen.get(key) ?? 0
          if (f.occurrences > prior) {
            seen.set(key, f.occurrences)
            const ts = new Date().toISOString().slice(11, 19)
            process.stdout.write(
              `⚠️  ${ts} [${adapter.harness}] ${ref.sessionId.slice(0, 8)} — ` +
                `\`${f.toolName}\` repeated ×${f.occurrences} with identical args ` +
                `(${(f.windowMs / 1000).toFixed(0)}s)${ref.cwd ? ` · ${ref.cwd}` : ''}\n`,
            )
          }
        }
      }
    }
    await sleep(intervalMs)
  }
}

function usage(): void {
  console.log(`traces — analyze & observe coding-agent sessions

Commands:
  list      List discovered sessions
  analyze   Run analyst suite + loop/waste pipelines, write a markdown report
  convert   Emit OTLP-JSONL only (also feeds HALO)
  watch     Online observer: tail active sessions, notify on stuck loops (read-only)

Options:
  --harness <id>   Harness or alias (default: claude-code). Known: ${knownHarnesses().join(', ')}
  --all            Sweep every known harness
  --last <n>       Most-recent N sessions
  --session <path> Analyze one explicit session file
  --cwd <dir>      Filter sessions by working directory
  --since <iso>    Only sessions modified since this time
  --out <path>     Write report to a file
  --otlp <path>    OTLP artifact path
  --llm            Enable agentic RLM analysts (needs OPENAI_API_KEY)
  --budget <usd>   USD cap for agentic analysts
  --interval <s>   watch: poll interval seconds (default 5)
  --window <m>     watch: only sessions active in the last N minutes (default 30)
  --min-loop <n>   Min identical repeated calls to flag a loop (default 3)`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'list': await cmdList(args); break
    case 'analyze': await cmdAnalyze(args); break
    case 'convert': await cmdConvert(args); break
    case 'watch': await cmdWatch(args); break
    default: usage()
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
