#!/usr/bin/env node
/**
 * `traces` — analyze your own coding-agent sessions.
 *
 *   traces list    [--harness claude-code] [--last 20] [--all]
 *   traces analyze [--harness claude-code] [--last 1] [--out report.md] [--llm]
 *   traces analyze <evidence.jsonl|spans.jsonl> [--format auto] [--out report.md]
 *   traces investigate [--harness claude-code] [--last 10] [--out report.md]
 *   traces improve [--all] [--since 24h] --dir .traces/improvement
 *   traces convert [--harness claude-code] [--last 1] --otlp spans.jsonl
 *   traces index   [--harness claude-code] [--last 20] --out session-index.json
 *   traces inspect session-index.json [--out inspection-report.md]
 *   traces export  <file.jsonl|file.json> --out spans.openinference.jsonl
 *   traces evidence [--harness claude-code] [--last 20] --out policy-evidence.jsonl
 *   traces stream  [input.jsonl] [--replay] [--all] [--format auto]
 *   traces watch   [--all] [--interval 5] [--window 30] [--min-loop 3]
 *
 * `analyze` runs the agent-eval analyst suite (deterministic + the shipped
 * loop/waste pipelines; +agentic RLM kinds with `--llm`). `watch` is the
 * online observer: it tails active sessions and prints notifications when a
 * stuck loop or semantic live finding appears. `stream` emits the same live
 * feed as JSONL for visualizers, dashboards, and external agents.
 */

import { readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { analyzeAdoption } from './adoption.js'
import { analyzeSpans } from './analyze.js'
import { buildPolicyEvidenceRecord, serializePolicyEvidence, writePolicyEvidenceFile } from './evidence.js'
import { commandAnalyzer, commandRedactor, haloAnalyzer, runExternalAnalyzers } from './external.js'
import { type TraceEvidenceFormatOption, exportTraceEvidenceFile, writeTraceEvidenceExportFile } from './file-export.js'
import { inspectSessionIndex, readSessionIndexFile, renderInspectionReport, writeInspectionReportFile } from './inspect.js'
import {
  loadTracesConfig,
  mergeTracesConfig,
  runTraceImprovementLoop,
  runTraceInvestigation,
  saveReport,
} from './improvement.js'
import {
  serializeTraceStreamEvent,
  streamSessions,
  traceStreamEventsFromSpans,
  type TraceLiveAnalyst,
  type TraceLiveFinding,
} from './live.js'
import type { OtlpSpan } from './otlp.js'
import { serializeSpans, writeOtlpFile } from './otlp.js'
import { watchSessions } from './observer.js'
import { runPipelines } from './pipelines.js'
import { knownHarnesses, resolveAdapter, selectAdapters } from './registry.js'
import { analyzeReactions } from './reactions.js'
import { parseSession } from './session-source.js'
import { buildSessionIndexFromRows, serializeSessionIndex, writeSessionIndexFile } from './session-index.js'
import { renderAdoption, renderPipelines, renderReactions, renderReport, summarizeDeterministicSignals } from './report.js'
import { parseSince } from './time.js'
import type { HarnessTraceAdapter, SessionRef } from './types.js'
import { executeUpload, planUpload } from './upload.js'

interface Args {
  command: string
  input?: string
  help: boolean
  harness: string
  harnessExplicit: boolean
  all: boolean
  last: number
  session?: string
  cwd?: string
  since?: string
  out?: string
  dir?: string
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
  config?: string
  format?: string
  mode?: string
  replay: boolean
  noSpans: boolean
  noFindings: boolean
  metadata?: string
  attrs: string[]
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json is missing version')
  return pkg.version
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] === '--help' || argv[0] === '-h' ? 'help' : argv[0] ?? 'help',
    help: argv[0] === '--help' || argv[0] === '-h',
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
    replay: false,
    noSpans: false,
    noFindings: false,
    attrs: [],
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
      case '--dir': a.dir = next(); break
      case '--otlp': a.otlp = next(); break
      case '--llm': a.llm = true; break
      case '--budget': a.budget = Number(next()); break
      case '--model': a.model = next(); break
      case '--config': a.config = next(); break
      case '--mode': a.mode = next(); break
      case '--metadata': a.metadata = next(); break
      case '--attr': { const v = next(); if (v) a.attrs.push(v); break }
      case '--interval': a.interval = Number(next()); break
      case '--window': a.window = Number(next()); break
      case '--min-loop': a.minLoop = Number(next()); break
      case '--dry-run': a.dryRun = true; break
      case '--no-content': a.noContent = true; break
      case '--replay':
      case '--once': a.replay = true; break
      case '--no-spans': a.noSpans = true; break
      case '--no-findings': a.noFindings = true; break
      case '--analyzer': { const v = next(); if (v) a.analyzers.push(v); break }
      case '--analyzer-prompt': a.analyzerPrompt = next(); break
      case '--redactor': a.redactorCmd = next(); break
      case '--format': a.format = next(); break
      case '--help':
      case '-h': a.help = true; break
      case '--yes':
      case '-y': a.yes = true; break
      default:
        if (arg?.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
        if (arg && !a.input) a.input = arg
        else if (arg) throw new Error(`unexpected positional argument: ${arg}`)
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
    const spans = await parseSession(adapter, ref)
    return { spans, harness: adapter.harness, sessionCount: 1, cwds: ref.cwd ? [ref.cwd] : [] }
  }
  const groups = await discover({ ...args, last: args.last || 1 })
  const spans: OtlpSpan[] = []
  let sessionCount = 0
  const harnesses: string[] = []
  const cwds: string[] = []
  for (const { adapter, refs } of groups) {
    if (refs.length > 0) harnesses.push(adapter.harness)
    for (const ref of refs) {
      spans.push(...(await parseSession(adapter, ref)))
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

async function collectSessionRows(args: Args): Promise<Array<{ ref: SessionRef; spans: OtlpSpan[] }>> {
  if (args.session) {
    const adapter = resolveAdapter(args.harness)
    if (!adapter) throw new Error(`unknown harness "${args.harness}"`)
    const st = await stat(args.session)
    const ref: SessionRef = {
      harness: adapter.harness,
      sessionId: args.session,
      path: args.session,
      cwd: args.cwd ?? null,
      mtimeMs: st.mtimeMs,
    }
    return [{ ref, spans: await parseSession(adapter, ref) }]
  }
  const groups = await discover({ ...args, last: args.last || 20 })
  const rows: Array<{ ref: SessionRef; spans: OtlpSpan[] }> = []
  for (const { adapter, refs } of groups) {
    for (const ref of refs) rows.push({ ref, spans: await parseSession(adapter, ref) })
  }
  return rows
}

async function cmdEvidence(args: Args): Promise<void> {
  const rows = (await collectSessionRows(args)).filter((row) => row.spans.length > 0)
  if (rows.length === 0) throw new Error('no spans found for the given selection')
  const otlpPath = args.otlp ? await writeOtlpFile(rows.flatMap((row) => row.spans), args.otlp) : undefined
  const generatedAt = new Date().toISOString()
  const records = await Promise.all(rows.map((row) =>
    buildPolicyEvidenceRecord(row.ref, row.spans, {
      generatedAt,
      minLoopOccurrences: args.minLoop,
      maxLoopExamples: 25,
      otlpPath,
    }),
  ))
  if (args.out) {
    const path = await writePolicyEvidenceFile(records, args.out)
    console.log(`policy evidence → ${path}  (${records.length} session rows${otlpPath ? `, OTLP: ${otlpPath}` : ''})`)
  } else {
    process.stdout.write(serializePolicyEvidence(records))
  }
}

async function cmdIndex(args: Args): Promise<void> {
  const rows = (await collectSessionRows(args)).filter((row) => row.spans.length > 0)
  if (rows.length === 0) throw new Error('no spans found for the given selection')
  const index = await buildSessionIndexFromRows(rows, {
    minLoopOccurrences: args.minLoop,
    selection: {
      command: 'index',
      harness: args.harnessExplicit ? args.harness : undefined,
      all: args.all || undefined,
      last: args.last || undefined,
      session: args.session,
      cwd: args.cwd,
      since: args.since,
    },
  })
  if (args.out) {
    const path = await writeSessionIndexFile(index, args.out)
    console.log(`session index → ${path}  (${index.totals.sessions} session rows)`)
  } else {
    process.stdout.write(serializeSessionIndex(index))
  }
}

async function cmdInspect(args: Args): Promise<void> {
  if (!args.input) throw new Error('inspect needs an index file; run `traces index --out session-index.json` first')
  const index = await readSessionIndexFile(args.input)
  const report = inspectSessionIndex(index)
  if (args.out) {
    const path = await writeInspectionReportFile(report, args.out)
    console.log(`inspection report → ${path}  (${report.totals.findings} finding(s), high ${report.totals.high})`)
  } else {
    process.stdout.write(renderInspectionReport(report))
  }
}

async function cmdExport(args: Args): Promise<void> {
  if (!args.input) throw new Error('export needs an input file; run `traces export --help` for examples')
  const format = traceEvidenceFormat(args.format)
  const attributes = await loadExportAttributes(args)
  const outPath = args.out ?? args.otlp
  if (outPath) {
    const result = await writeTraceEvidenceExportFile(args.input, outPath, { format, attributes })
    console.log(
      `exported ${result.spans.length} OpenInference span(s) from ${result.format} → ${result.path}` +
        ` (${result.redactionCount} redaction${result.redactionCount === 1 ? '' : 's'})`,
    )
    return
  }
  const result = await exportTraceEvidenceFile(args.input, { format, attributes })
  process.stdout.write(serializeSpans(result.spans))
}

function traceEvidenceFormat(raw: string | undefined): TraceEvidenceFormatOption {
  const format = raw ?? 'auto'
  if (
    format !== 'auto' &&
    format !== 'policy-evidence' &&
    format !== 'sandbox-events' &&
    format !== 'openinference' &&
    format !== 'intelligence-spans'
  ) {
    throw new Error('--format must be auto, policy-evidence, sandbox-events, openinference, or intelligence-spans')
  }
  return format
}

function parseAttributeValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw)
    if (Number.isFinite(number)) return number
  }
  return raw
}

async function loadExportAttributes(args: Args): Promise<Record<string, unknown>> {
  const attributes: Record<string, unknown> = {}
  if (args.metadata) {
    const parsed: unknown = JSON.parse(await readFile(args.metadata, 'utf8'))
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--metadata must point to a JSON object')
    }
    Object.assign(attributes, parsed as Record<string, unknown>)
  }
  for (const attr of args.attrs) {
    const eq = attr.indexOf('=')
    if (eq <= 0) throw new Error(`--attr must be key=value, got ${attr}`)
    attributes[attr.slice(0, eq)] = parseAttributeValue(attr.slice(eq + 1))
  }
  return attributes
}

async function cmdAnalyze(args: Args): Promise<void> {
  const { spans, harness, sessionCount, cwds } = args.input
    ? await collectImportedSpans(args)
    : await collectSpans(args)
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
  const deterministic = summarizeDeterministicSignals(pipelines, reactions)
  let report =
    `${renderReport(result, { harness, sessionCount, spanCount: spans.length, otlpPath, deterministic })}\n` +
    `${renderPipelines(pipelines)}\n${renderReactions(reactions)}\n${renderAdoption(adoption)}`
  if (args.analyzers.length > 0 && otlpPath) {
    const engines = externalAnalyzersFromArgs(args)
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

async function collectImportedSpans(args: Args): Promise<{ spans: OtlpSpan[]; harness: string; sessionCount: number; cwds: string[] }> {
  if (!args.input) throw new Error('analyze input missing')
  const attributes = await loadExportAttributes(args)
  const result = await exportTraceEvidenceFile(args.input, {
    format: traceEvidenceFormat(args.format),
    attributes,
  })
  const traceIds = new Set(result.spans.map((s) => s.trace_id).filter(Boolean))
  return {
    spans: result.spans,
    harness: result.format,
    sessionCount: traceIds.size || 1,
    cwds: [],
  }
}

function externalAnalyzersFromArgs(args: Args) {
  return args.analyzers.map((spec) =>
    spec === 'halo'
      ? haloAnalyzer({ defaultPrompt: args.analyzerPrompt, model: args.model })
      : commandAnalyzer({ name: spec, command: spec, args: (p, prompt) => (prompt ? [p, prompt] : [p]) }),
  )
}

async function cmdInvestigate(args: Args): Promise<void> {
  const { spans, harness, sessionCount, cwds } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const config = await loadTracesConfig(args.config)
  const ai = args.llm ? await buildAxService() : undefined
  const result = await runTraceInvestigation(mergeTracesConfig({
    spans,
    harness,
    sessionCount,
    cwds,
    minLoopOccurrences: args.minLoop,
    ai,
    model: args.model,
    budgetUsd: args.budget,
    otlpOutPath: args.otlp,
    externalAnalyzers: externalAnalyzersFromArgs(args),
    analyzerPrompt: args.analyzerPrompt,
    log: (msg) => process.stderr.write(`${msg}\n`),
  }, config))
  if (args.out) {
    await saveReport(args.out, result.report)
    console.log(`investigation report → ${args.out}  (${result.findings.length} findings, ${result.recommendations.length} recommendations, OTLP: ${result.otlpPath})`)
  } else {
    console.log(result.report)
  }
}

async function cmdImprove(args: Args): Promise<void> {
  const { spans, harness, sessionCount, cwds } = await collectSpans(args)
  if (spans.length === 0) throw new Error('no spans found for the given selection')
  const config = await loadTracesConfig(args.config)
  const ai = args.llm ? await buildAxService() : undefined
  const result = await runTraceImprovementLoop({
    ...mergeTracesConfig({
      spans,
      harness,
      sessionCount,
      cwds,
      minLoopOccurrences: args.minLoop,
      ai,
      model: args.model,
      budgetUsd: args.budget,
      otlpOutPath: args.otlp,
      externalAnalyzers: externalAnalyzersFromArgs(args),
      analyzerPrompt: args.analyzerPrompt,
      log: (msg) => process.stderr.write(`${msg}\n`),
    }, config),
    adapter: config?.improvementAdapter,
    outDir: args.dir ?? args.out,
  })
  const dir = result.artifacts?.directory
  if (!dir) throw new Error('improve did not produce an artifact directory')
  console.log(
    `improvement artifacts → ${dir}  ` +
      `(${result.findings.length} findings, ${result.recommendations.length} recommendations, ${result.proposals.length} proposal(s), OTLP: ${result.otlpPath})`,
  )
}

function summarizeFindingEvidence(finding: TraceLiveFinding): string {
  const first = finding.evidence[0]
  if (!first) return 'no evidence'
  return `${first.label}: ${first.value}`
}

function formatLiveFinding(finding: TraceLiveFinding): string {
  const ts = new Date(finding.observedAt).toISOString().slice(11, 19)
  const where = `[${finding.session.harness}] ${finding.session.sessionId.slice(0, 8)}`
  const cwd = finding.session.cwd ? ` · ${finding.session.cwd}` : ''
  return [
    `${ts} ${finding.severity.toUpperCase()} ${where} — ${finding.title}${cwd}`,
    `  evidence: ${summarizeFindingEvidence(finding)}`,
    `  action: ${finding.action}`,
    `  check: ${finding.check}`,
  ].join('\n')
}

type StreamMode = 'visualizer' | 'findings' | 'agent'

function streamMode(raw: string | undefined): StreamMode {
  if (raw === undefined) return 'visualizer'
  if (raw === 'visualizer' || raw === 'findings' || raw === 'agent') return raw
  throw new Error(`unknown stream mode "${raw}" (expected visualizer, findings, or agent)`)
}

function streamPreset(args: Args): { mode: StreamMode; includeSpans: boolean; includeFindings: boolean; includeBatches: boolean; includeReports: boolean } {
  const mode = streamMode(args.mode)
  return {
    mode,
    includeSpans: !args.noSpans && mode === 'visualizer',
    includeFindings: !args.noFindings,
    includeBatches: true,
    includeReports: mode === 'agent',
  }
}

async function streamExplicitSession(args: Args, extraAnalysts: readonly TraceLiveAnalyst[] | undefined): Promise<void> {
  if (!args.session) throw new Error('streamExplicitSession needs --session')
  const adapter = resolveAdapter(args.harness)
  if (!adapter) throw new Error(`unknown harness "${args.harness}"`)
  const preset = streamPreset(args)
  const st = await stat(args.session)
  const ref: SessionRef = {
    harness: adapter.harness,
    sessionId: basename(args.session),
    path: resolve(args.session),
    cwd: args.cwd ?? null,
    mtimeMs: st.mtimeMs,
  }
  const spans = await parseSession(adapter, ref)
  for (const event of traceStreamEventsFromSpans(spans, {
    ref,
    includeSpans: preset.includeSpans,
    includeFindings: preset.includeFindings,
    extraAnalysts,
  })) {
    process.stdout.write(serializeTraceStreamEvent(event))
  }
}

async function cmdStream(args: Args): Promise<void> {
  const config = await loadTracesConfig(args.config)
  const preset = streamPreset(args)
  if (args.input) {
    const { spans, harness } = await collectImportedSpans(args)
    const ref: SessionRef = {
      harness,
      sessionId: basename(args.input),
      path: resolve(args.input),
      cwd: args.cwd ?? null,
      mtimeMs: Date.now(),
    }
    for (const event of traceStreamEventsFromSpans(spans, {
      ref,
      includeSpans: preset.includeSpans,
      includeFindings: preset.includeFindings,
      extraAnalysts: config?.liveAnalysts,
    })) {
      process.stdout.write(serializeTraceStreamEvent(event))
    }
    return
  }
  if (args.session) {
    await streamExplicitSession(args, config?.liveAnalysts)
    return
  }

  const all = args.all || (!args.harnessExplicit && !args.cwd)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  if (!args.replay) {
    process.stderr.write(
      `traces stream — ${preset.mode} JSONL feed for ${all ? 'all harnesses' : args.harness}, ` +
        `last ${args.window}m, every ${args.interval}s. Ctrl-C to stop.\n`,
    )
  }
  await streamSessions({
    all,
    harnesses: all ? undefined : [args.harness],
    cwd: args.cwd,
    last: args.last > 0 ? args.last : args.replay ? 1 : undefined,
    windowMs: args.window * 60_000,
    intervalMs: args.interval * 1000,
    once: args.replay,
    includeSpans: preset.includeSpans,
    includeFindings: preset.includeFindings,
    includeBatches: preset.includeBatches,
    includeReports: preset.includeReports,
    extraAnalysts: config?.liveAnalysts,
    signal: controller.signal,
    onEvent: (event) => {
      process.stdout.write(serializeTraceStreamEvent(event))
    },
    onError: (err, ref) => {
      const where = ref ? ` [${ref.harness}] ${ref.sessionId}` : ''
      process.stderr.write(`stream error${where}: ${err instanceof Error ? err.message : String(err)}\n`)
    },
  })
}

async function cmdWatch(args: Args): Promise<void> {
  const all = args.all || (!args.harnessExplicit && !args.cwd)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.stderr.write(
    `traces watch — observing ${all ? 'all harnesses' : args.harness}, ` +
      `sessions active in the last ${args.window}m, every ${args.interval}s. ` +
      `Loop + semantic live findings; read-only; Ctrl-C to stop.\n`,
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
        `${ts} LOOP [${l.harness}] ${l.sessionId.slice(0, 8)} — ` +
          `\`${l.toolName}\` repeated ×${l.occurrences} with identical args ` +
          `(${(l.windowMs / 1000).toFixed(0)}s)${l.cwd ? ` · ${l.cwd}` : ''}\n`,
      )
    },
    onFinding: (finding) => {
      process.stdout.write(`${formatLiveFinding(finding)}\n`)
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

function usageExport(): void {
  console.log(`traces export — convert trace evidence files to OpenInference JSONL

Usage:
  traces export <input.jsonl|input.json> --out <spans.jsonl> [--format auto]
  traces export <input.json> --attr task.id=abc --attr arm=baseline --out spans.jsonl
  traces export <input.json> --metadata run-metadata.json --out spans.jsonl
  traces export <input.jsonl|input.json> > spans.jsonl

Input formats:
  policy-evidence  Compact JSONL rows from \`traces evidence --out policy-evidence.jsonl\`
  sandbox-events   Sandbox/OpenCode event arrays with start/raw/result/done/error events
  openinference    Existing OpenInference JSONL; rewrites through traces redaction
  intelligence-spans  JSONL rows exported from Tangle Intelligence trace spans
  auto             Detect the format from the file contents (default)

Examples:
  traces evidence --all --since 24h --out policy-evidence.jsonl
  traces export policy-evidence.jsonl --out spans.openinference.jsonl
  traces export sandbox-events.json --format sandbox-events --out spans.openinference.jsonl
  traces export intelligence-spans.jsonl --out spans.openinference.jsonl
  traces export sandbox-events.json --attr task.id=aec-001 --attr outcome.score=1 --out spans.openinference.jsonl
  halo spans.openinference.jsonl --prompt "Analyze this trace slice" --max-turns 1

Safety:
  export runs the same local regex redaction used by upload before writing spans.
  --metadata must be a JSON object; --attr key=value is repeatable and overrides matching metadata keys.`)
}

function usage(): void {
  console.log(`traces — analyze, observe & upload coding-agent sessions

Commands:
  list      List discovered sessions
  analyze   Run analyst suite + loop/waste pipelines over sessions or an input file
  investigate Run typed investigation flow, including BYO config + recommendations
  improve   Write a full improvement artifact directory for review/apply/rerun
  convert   Emit OTLP-JSONL only (HALO: use analyze --analyzer halo)
  index     Emit a reusable session index JSON for later investigation
  inspect   Read a session index and print ranked improvement findings
  export    Convert evidence/events files to OpenInference JSONL for HALO
  evidence  Emit compact session-evidence JSONL for downstream policy miners
  stream    Emit JSONL trace stream events for live visualizers or replay
  watch     Online observer: tail active sessions, notify on loops + semantic findings
  upload    Redact + upload sessions in a time window to the Tangle Intelligence Platform

Options:
  --harness <id>   Harness or alias (default: claude-code). Known: ${knownHarnesses().join(', ')}
  --all            Sweep every known harness
  --last <n>       Most-recent N sessions
  --session <path> Analyze/stream one explicit harness session file
  --cwd <dir>      Filter sessions by working directory
  --since <t>      upload: window — 30m / 2h / 7d or an ISO date (default 24h); analyze: ISO cutoff
  --out <path>     Write report to a file
  --dir <path>     improve: write artifacts to this directory
  --otlp <path>    OTLP artifact path (also evidence provenance / dry-run upload preview)
  --format <kind>  analyze/export file: auto | policy-evidence | sandbox-events | openinference | intelligence-spans
  --metadata <json> analyze/export file: attach JSON object fields as span attributes
  --attr <k=v>     analyze/export file: attach one span attribute (repeatable)
  --mode <kind>    stream: visualizer | findings | agent (default visualizer)
  --replay, --once stream: scan once and exit (default for positional input / --session)
  --no-spans       stream: omit per-span pulse events
  --no-findings    stream: omit semantic live-finding events
  --llm            Enable agentic RLM analysts (needs OPENAI_API_KEY / OPENAI_BASE_URL)
  --model <id>     --llm model id (e.g. a router model like glm-5.2); default is agent-eval's
  --config <path>  investigate/improve/stream: JS config with analysts, liveAnalysts, external analyzers, or proposal adapter
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
  --version, -v    Print the installed traces version
  --help, -h       Show help (use \`traces export --help\` for export examples)

Upload env: TANGLE_INGEST_URL (or TANGLE_ORCHESTRATOR_URL), TANGLE_INGEST_API_KEY (or TANGLE_API_KEY), TANGLE_TENANT_ID`)
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs[0] === '--version' || rawArgs[0] === '-v' || rawArgs[0] === 'version') {
    console.log(`traces ${packageVersion()}`)
    return
  }
  const args = parseArgs(rawArgs)
  if (args.help) {
    if (args.command === 'export' || (args.command === 'help' && args.input === 'export')) usageExport()
    else usage()
    return
  }
  switch (args.command) {
    case 'help':
      if (args.input === 'export') usageExport()
      else usage()
      break
    case 'list': await cmdList(args); break
    case 'analyze': await cmdAnalyze(args); break
    case 'investigate': await cmdInvestigate(args); break
    case 'improve': await cmdImprove(args); break
    case 'convert': await cmdConvert(args); break
    case 'index': await cmdIndex(args); break
    case 'inspect': await cmdInspect(args); break
    case 'export': await cmdExport(args); break
    case 'evidence': await cmdEvidence(args); break
    case 'stream': await cmdStream(args); break
    case 'watch': await cmdWatch(args); break
    case 'upload': await cmdUpload(args); break
    default: usage()
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
