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
import { analyzeAdoption } from './adoption.js'
import { analyzeSpans } from './analyze.js'
import { commandAnalyzer, commandRedactor, haloAnalyzer, runExternalAnalyzers } from './external.js'
import type { OtlpSpan } from './otlp.js'
import { writeOtlpFile } from './otlp.js'
import { watchSessions } from './observer.js'
import { runPipelines } from './pipelines.js'
import { knownHarnesses, resolveAdapter, selectAdapters } from './registry.js'
import { analyzeReactions } from './reactions.js'
import { renderAdoption, renderPipelines, renderReactions, renderReport } from './report.js'
import { parseSince } from './time.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import { executeUpload, planUpload } from './upload.js'

interface Args {
  command: string
  harness: string
  harnessExplicit: boolean
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
  dryRun: boolean
  yes: boolean
  noContent: boolean
  analyzers: string[]
  analyzerPrompt?: string
  redactorCmd?: string
  model?: string
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? 'help',
    harness: 'claude-code',
    harnessExplicit: false,
    all: false,
    last: 0,
    llm: false,
    interval: 5,
    window: 30,
    minLoop: 3,
    dryRun: false,
    yes: false,
    noContent: false,
    analyzers: [],
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--harness': a.harness = next() ?? a.harness; a.harnessExplicit = true; break
      case '--all': a.all = true; break
      case '--last': a.last = Number(next()); break
      case '--session': a.session = next(); break
      case '--cwd': a.cwd = next(); break
      case '--since': a.since = next(); break
      case '--out': a.out = next(); break
      case '--otlp': a.otlp = next(); break
      case '--llm': a.llm = true; break
      case '--budget': a.budget = Number(next()); break
      case '--model': a.model = next(); break
      case '--interval': a.interval = Number(next()); break
      case '--window': a.window = Number(next()); break
      case '--min-loop': a.minLoop = Number(next()); break
      case '--dry-run': a.dryRun = true; break
      case '--no-content': a.noContent = true; break
      case '--analyzer': { const v = next(); if (v) a.analyzers.push(v); break }
      case '--analyzer-prompt': a.analyzerPrompt = next(); break
      case '--redactor': a.redactorCmd = next(); break
      case '--yes':
      case '-y': a.yes = true; break
      default:
        if (arg?.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
    }
  }
  return a
}

/** Y/N confirm on a TTY (prompt to stderr so stdout stays clean). Non-TTY → false. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return ans === 'y' || ans === 'yes'
  } finally {
    rl.close()
  }
}

function adaptersFor(args: Args): HarnessTraceAdapter[] {
  return selectAdapters({ all: args.all, harnesses: [args.harness] })
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
    throw new Error(
      '--llm needs OPENAI_API_KEY — an OpenAI key, or a router/gateway key with OPENAI_BASE_URL set to an ' +
        'OpenAI-compatible endpoint (e.g. the Tangle router). Deterministic analysis needs no key.',
    )
  }
  // OPENAI_BASE_URL points the agentic analysts at any OpenAI-compatible gateway
  // (the Tangle router, a local proxy, …) instead of api.openai.com.
  const apiURL = process.env.OPENAI_BASE_URL || undefined
  const { AxAI } = await import('@ax-llm/ax')
  return new AxAI({ name: 'openai', apiKey, ...(apiURL ? { apiURL } : {}) }) as unknown as import('@ax-llm/ax').AxAIService
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

async function collectSpans(args: Args): Promise<{ spans: OtlpSpan[]; harness: string; sessionCount: number; cwds: string[] }> {
  if (args.session) {
    const adapter = resolveAdapter(args.harness)
    if (!adapter) throw new Error(`unknown harness "${args.harness}"`)
    const st = await stat(args.session)
    const ref: SessionRef = {
      harness: adapter.harness,
      sessionId: args.session,
      path: args.session,
      // --session is an explicit file; honor --cwd so adoption can find the
      // project's .evolve/skill-runs.jsonl (locate() infers cwd in the scan path).
      cwd: args.cwd ?? null,
      mtimeMs: st.mtimeMs,
    }
    return { spans: await adapter.parse(ref), harness: adapter.harness, sessionCount: 1, cwds: ref.cwd ? [ref.cwd] : [] }
  }
  const groups = await discover({ ...args, last: args.last || 1 })
  const spans: OtlpSpan[] = []
  let sessionCount = 0
  const harnesses: string[] = []
  const cwds: string[] = []
  for (const { adapter, refs } of groups) {
    if (refs.length > 0) harnesses.push(adapter.harness)
    for (const ref of refs) {
      spans.push(...(await adapter.parse(ref)))
      if (ref.cwd) cwds.push(ref.cwd)
      sessionCount += 1
    }
  }
  return { spans, harness: harnesses.join('+') || args.harness, sessionCount, cwds }
}

async function cmdConvert(args: Args): Promise<void> {
  const { spans } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const path = await writeOtlpFile(spans, args.otlp)
  console.log(`wrote ${spans.length} spans → ${path}`)
}

async function cmdAnalyze(args: Args): Promise<void> {
  const { spans, harness, sessionCount, cwds } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const ai = args.llm ? await buildAxService() : undefined
  const { otlpPath, result } = await analyzeSpans(spans, {
    ai,
    model: args.model,
    budgetUsd: args.budget,
    otlpOutPath: args.otlp,
    log: (msg) => process.stderr.write(`${msg}\n`),
  })
  const pipelines = await runPipelines(spans, { minLoopOccurrences: args.minLoop })
  const reactions = analyzeReactions(spans)
  const adoption = await analyzeAdoption(spans, { cwds })
  let report =
    `${renderReport(result, { harness, sessionCount, spanCount: spans.length, otlpPath })}\n` +
    `${renderPipelines(pipelines)}\n${renderReactions(reactions)}\n${renderAdoption(adoption)}`
  if (args.analyzers.length > 0 && otlpPath) {
    const engines = args.analyzers.map((spec) =>
      spec === 'halo'
        ? haloAnalyzer({ defaultPrompt: args.analyzerPrompt, model: args.model })
        : commandAnalyzer({ name: spec, command: spec, args: (p, prompt) => (prompt ? [p, prompt] : [p]) }),
    )
    const results = await runExternalAnalyzers(otlpPath, engines, { prompt: args.analyzerPrompt })
    for (const r of results) {
      report += `\n\n## ${r.analyzer} (external analyzer)\n\n${r.ok ? r.output || '(no output)' : `failed: ${r.error}`}`
    }
  }
  if (args.out) {
    await writeFile(args.out, report, 'utf8')
    console.log(`report → ${args.out}  (${result.findings.length} findings, ${pipelines.stuckLoops.findings.length} loops, OTLP: ${otlpPath})`)
  } else {
    console.log(report)
  }
}

async function cmdWatch(args: Args): Promise<void> {
  const all = args.all || (!args.harnessExplicit && !args.cwd)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.stderr.write(
    `traces watch — observing ${all ? 'all harnesses' : args.harness}, ` +
      `sessions active in the last ${args.window}m, every ${args.interval}s. Read-only; Ctrl-C to stop.\n`,
  )
  await watchSessions({
    all,
    harnesses: all ? undefined : [args.harness],
    cwd: args.cwd,
    windowMs: args.window * 60_000,
    intervalMs: args.interval * 1000,
    minLoopOccurrences: args.minLoop,
    signal: controller.signal,
    onLoop: (l) => {
      const ts = new Date().toISOString().slice(11, 19)
      process.stdout.write(
        `⚠️  ${ts} [${l.harness}] ${l.sessionId.slice(0, 8)} — ` +
          `\`${l.toolName}\` repeated ×${l.occurrences} with identical args ` +
          `(${(l.windowMs / 1000).toFixed(0)}s)${l.cwd ? ` · ${l.cwd}` : ''}\n`,
      )
    },
  })
}

async function cmdUpload(args: Args): Promise<void> {
  const sinceMs = args.since ? parseSince(args.since) : Date.now() - 24 * 60 * 60 * 1000
  // Default to ALL harnesses unless a specific --harness was given.
  const all = args.all || !args.harnessExplicit
  const plan = await planUpload({
    all,
    harnesses: args.harnessExplicit ? [args.harness] : undefined,
    cwd: args.cwd,
    sinceMs,
  })

  const redactorParts = args.redactorCmd?.split(/\s+/).filter(Boolean) ?? []
  const redactor = redactorParts[0] ? commandRedactor({ command: redactorParts[0], args: redactorParts.slice(1) }) : undefined

  const newItems = plan.items.filter((i) => i.isNew)
  const byRule: Record<string, number> = {}
  let totalRedactions = 0
  for (const i of newItems) {
    totalRedactions += i.redaction.redactionCount
    for (const [r, n] of Object.entries(i.redaction.byRule)) byRule[r] = (byRule[r] ?? 0) + n
  }

  const w = (s: string) => process.stderr.write(s)
  w(`\nWindow: since ${new Date(sinceMs).toISOString()}\n`)
  w(`Sessions found: ${plan.items.length}  ·  new: ${newItems.length}  ·  already uploaded: ${plan.items.length - newItems.length}\n`)
  w(`PII/secrets redacted: ${totalRedactions}${Object.keys(byRule).length ? ` (${Object.entries(byRule).map(([r, n]) => `${r}:${n}`).join(', ')})` : ''}\n`)
  for (const i of newItems.slice(0, 25)) {
    w(`  + [${i.ref.harness}] ${i.ref.sessionId.slice(0, 8)}  ${i.spans.length} spans  ${i.redaction.redactionCount} redacted  ${i.ref.cwd ?? ''}\n`)
  }
  if (newItems.length > 25) w(`  … and ${newItems.length - 25} more\n`)

  if (newItems.length === 0) {
    console.log('Nothing new to upload.')
    return
  }

  if (args.dryRun) {
    const res = await executeUpload(plan, { dryRun: true, otlpOut: args.otlp, stripContent: args.noContent, redactor })
    console.log(`dry run — ${newItems.length} session(s), ${totalRedactions} redaction(s). Redacted OTLP → ${res.otlpPath}`)
    console.log('No upload performed. Set TANGLE_INGEST_URL / TANGLE_INGEST_API_KEY / TANGLE_TENANT_ID and drop --dry-run to send.')
    return
  }

  if (!args.yes) {
    const ok = await confirm(`Upload ${newItems.length} redacted session(s) to the Tangle Intelligence Platform?`)
    if (!ok) {
      console.log('Aborted (use --yes to skip the prompt, or --dry-run to preview).')
      return
    }
  }

  const res = await executeUpload(plan, { log: (m) => w(`${m}\n`), stripContent: args.noContent, redactor })
  console.log(
    `Uploaded ${res.uploadedSessions} session(s), ${res.acceptedSpans} spans accepted, ` +
      `${res.redactionCount} redaction(s); ${res.skippedSessions} already-uploaded skipped.`,
  )
}

function usage(): void {
  console.log(`traces — analyze, observe & upload coding-agent sessions

Commands:
  list      List discovered sessions
  analyze   Run analyst suite + loop/waste pipelines, write a markdown report
  convert   Emit OTLP-JSONL only (HALO: use analyze --analyzer halo)
  watch     Online observer: tail active sessions, notify on stuck loops (read-only)
  upload    Redact + upload sessions in a time window to the Tangle Intelligence Platform

Options:
  --harness <id>   Harness or alias (default: claude-code). Known: ${knownHarnesses().join(', ')}
  --all            Sweep every known harness
  --last <n>       Most-recent N sessions
  --session <path> Analyze one explicit session file
  --cwd <dir>      Filter sessions by working directory
  --since <t>      upload: window — 30m / 2h / 7d or an ISO date (default 24h); analyze: ISO cutoff
  --out <path>     Write report to a file
  --otlp <path>    OTLP artifact path (also the dry-run upload preview path)
  --llm            Enable agentic RLM analysts (needs OPENAI_API_KEY / OPENAI_BASE_URL)
  --model <id>     --llm model id (e.g. a router model like glm-5.2); default is agent-eval's
  --budget <usd>   USD cap for agentic analysts
  --analyzer <cmd> analyze: also run an external engine over the OTLP (repeatable; "halo" or any command)
  --analyzer-prompt <p>  analyze: prompt passed to external analyzers (default: diagnose)
  --interval <s>   watch: poll interval seconds (default 5)
  --window <m>     watch: only sessions active in the last N minutes (default 30)
  --min-loop <n>   Min identical repeated calls to flag a loop (default 3)
  --dry-run        upload: redact + dedup + preview, write OTLP, but do NOT send
  --no-content     upload: strip prompt/response text — send metadata only
  --redactor <cmd> upload: external PII scrubber (JSON array stdin→stdout) after the regex pass
  --yes, -y        upload: skip the confirmation prompt

Upload env: TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL), TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), TANGLE_TENANT_ID`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'list': await cmdList(args); break
    case 'analyze': await cmdAnalyze(args); break
    case 'convert': await cmdConvert(args); break
    case 'watch': await cmdWatch(args); break
    case 'upload': await cmdUpload(args); break
    default: usage()
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
