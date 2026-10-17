#!/usr/bin/env node
/**
 * The fork-parity scorecard (spec U11): every hand-written session parser that
 * traces retires, run beside the traces command that replaces it over the same
 * sessions, compared field by field.
 *
 *   tsx bench/parity/score.ts --home DIR --dotfiles DIR --tangle-tools DIR --out DIR
 *     [--since ISO --until ISO] [--traces CLI] [--forks id,id] [--files N] [--spool FILE…] [--forks-file F]
 *
 * `--home` is the store home both sides read: each old parser runs with HOME set
 * to it, and traces reads it the same way, so the two read the same bytes. A
 * window fork runs once over `--since`/`--until`; a file fork runs on each of
 * up to `--files` session files per harness under `--home`; a spool fork reads
 * the `--spool` collector files. Nothing is written outside `--out`: traces'
 * state, every raw output and `scorecard.json` go there.
 *
 * Agreement is printed per fork with its first 5 disagreements by id: session
 * ids, times, file names and numbers, never session text.
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

type Unit = 'window' | 'file' | 'spool'
type Fields = Record<string, unknown>
type Rows = Map<string, Fields>

export interface Fork {
  readonly id: string
  /** The retired parser: owner repo and path. */
  readonly parser: string
  readonly retiredBy: string
  /** The consumer step whose PR deletes the parser, citing this row. */
  readonly deletedIn: string
  readonly unit: Unit
  readonly harnesses?: readonly string[]
  /** argv with {DOTFILES} {TANGLE_TOOLS} {HOME} {SINCE} {UNTIL} {FILE} {HARNESS} {OUT}; `traces` names the CLI. */
  readonly old: readonly string[]
  readonly new: readonly string[]
  /** How each side's stdout becomes keyed rows (`READERS`). */
  readonly read: { readonly old: string; readonly new: string }
  /** What the key is, and each compared field: the old field and the traces field it maps to. */
  readonly key: string
  readonly fields: Readonly<Record<string, string>>
  readonly tolerance: number
}

interface ForksFile {
  readonly window: { readonly since: string; readonly until: string }
  readonly forks: readonly Fork[]
}

export interface ForkScore {
  id: string
  parser: string
  deletedIn: string
  tolerance: number
  status: 'scored' | 'skipped'
  reason?: string
  /** Keys on either side, and the share found on both. */
  keys: { old: number; new: number; both: number; agreement: number | null }
  /** Per field, the share of keys on both sides whose values are equal. */
  fields: Record<string, number | null>
  /** The lowest of the key and field agreements; the row passes at or above its tolerance. */
  agreement: number | null
  pass: boolean
  disagreements: string[]
}

// ---------------------------------------------------------------------------
// Readers: one side's stdout to rows keyed the same way on both sides
// ---------------------------------------------------------------------------

const second = (at: unknown): string => {
  const ms = Date.parse(String(at))
  return Number.isFinite(ms) ? new Date(Math.floor(ms / 1000) * 1000).toISOString() : String(at)
}
const jsonl = (text: string): unknown[] => text.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line) as unknown)
const json = (text: string): unknown => JSON.parse(text.slice(text.indexOf('{')))
const path = (value: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), value)
/** A set of pull-request numbers as one comparable string; an entry with no number is left out, not read as 0. */
const numbers = (values: unknown): string =>
  [...new Set((Array.isArray(values) ? values : []).filter((value) => value !== null && value !== undefined && value !== '').map(Number).filter(Number.isFinite))].sort((a, b) => a - b).join(',')

interface ReadContext { readonly key: string; readonly since: number; readonly until: number }
type Reader = (stdout: string, context: ReadContext) => Rows

const inWindow = (at: unknown, context: ReadContext): boolean => {
  const ms = Date.parse(String(at))
  return ms >= context.since && ms < context.until
}

/** Typed turns, keyed by session and second, from a per-session row with `turns[]`. */
function sessionTurns(stdout: string, context: ReadContext, authors: ReadonlySet<string>, authorOf: (turn: Fields) => string): Rows {
  const rows: Rows = new Map()
  for (const session of jsonl(stdout) as Array<{ session: string; turns?: Fields[] }>) {
    for (const turn of session.turns ?? []) {
      const author = authorOf(turn)
      if (!authors.has(author) || !inWindow(turn.ts, context)) continue
      rows.set(`${session.session}@${second(turn.ts)}`, { author })
    }
  }
  return rows
}

const TYPED = new Set(['human', 'relay'])

export const READERS: Readonly<Record<string, Reader>> = {
  /** Already keyed: one JSON row per line, `key` plus the fields. */
  rows: (stdout) => new Map((jsonl(stdout) as Fields[]).map(({ key, ...fields }) => [String(key), fields])),
  'multi-extract-turns': (stdout, context) => sessionTurns(stdout, context, TYPED, (turn) => String(turn.author)),
  'trace-mine-turns': (stdout, context) => sessionTurns(stdout, context, TYPED, () => 'human'),
  'facts-jsonl-turns': (stdout, context) => {
    const rows: Rows = new Map()
    for (const row of jsonl(stdout) as Fields[]) {
      if (TYPED.has(String(row.author)) && inWindow(row.at, context)) rows.set(`${row.session}@${second(row.at)}`, { author: row.author })
    }
    return rows
  },
  'self-audit': (stdout, { key }) => {
    const rework = path(json(stdout), 'rework')
    return new Map([[key, { repeatedCommands: path(rework, 'repeatedCommands'), extraRuns: path(rework, 'extraRuns'), rollbacks: path(rework, 'rollbacks') }]])
  },
  'facts-waste': (stdout, { key }) => {
    const waste = path(json(stdout), 'sessions.0.measurements.waste')
    return new Map([[key, {
      repeatedCommands: path(waste, 'repeatedCommands.value.commands'),
      extraRuns: path(waste, 'repeatedCommands.value.extraRuns'),
      rollbacks: path(waste, 'rollbacks.value'),
    }]])
  },
  halo: (stdout, { key }) => {
    const profile = jsonl(stdout)[0]
    return new Map([[key, { toolCalls: path(profile, 'toolCalls'), humanTurns: path(profile, 'realUserTurns'), toolErrors: path(profile, 'toolErrors') }]])
  },
  'facts-halo': (stdout, { key }) => {
    const session = path(json(stdout), 'sessions.0') as Fields
    const tools = (path(session, 'measurements.tools') ?? []) as Array<{ outcomes: { error: number } }>
    return new Map([[key, {
      toolCalls: path(session, 'toolCalls.value'),
      humanTurns: (path(session, 'humanTurns.value') as unknown[] | null)?.length ?? null,
      toolErrors: tools.reduce((total, row) => total + row.outcomes.error, 0),
    }]])
  },
  'skill-ledger-prs': (stdout, { key }) => {
    const prs = json(stdout) as { created: unknown[]; merged: unknown[] }
    return new Map([[key, { created: numbers(prs.created), merged: numbers(prs.merged) }]])
  },
  'facts-prs': (stdout, { key }) => {
    const prs = path(json(stdout), 'sessions.0.pullRequests.value') as { created: Fields[]; merged: Fields[] } | null
    return new Map([[key, { created: numbers(prs?.created.map((pr) => pr.number)), merged: numbers(prs?.merged.map((pr) => pr.number)) }]])
  },
  'facts-tokens': (stdout, { key }) => new Map([[key, { tokens: path(json(stdout), 'sessions.0.tokenTotal.value') }]]),
  /** One JSON object of fields for the unit. */
  json: (stdout, { key }) => new Map([[key, json(stdout) as Fields]]),
}

/** Read from the OTLP JSONL file traces wrote to `{OUT_FILE}`, not from stdout. */
const FILE_READERS = new Set(['otlp-file'])

// ---------------------------------------------------------------------------
// Running both sides
// ---------------------------------------------------------------------------

interface Ran { code: number; stdout: string; stderr: string }

function run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
  })
}

/**
 * Counts of an OTLP JSONL file traces wrote, streamed: spans, distinct (trace,
 * span) pairs, traces, and the TOOL spans of the named session alone (the
 * file's first trace), since `convert` of a session also writes its spawned children.
 */
async function countSpans(file: string): Promise<Fields> {
  let spans = 0
  let toolSpans = 0
  let named: string | undefined
  const traces = new Set<string>()
  const distinct = new Set<string>()
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (!line.trim()) continue
    const span = JSON.parse(line) as { trace_id?: string; span_id?: string; kind?: string }
    named ??= span.trace_id
    spans += 1
    if (span.kind === 'TOOL' && span.trace_id === named) toolSpans += 1
    traces.add(String(span.trace_id))
    distinct.add(`${span.trace_id}:${span.span_id}`)
  }
  return { spans, distinctSpans: distinct.size, toolSpans, traces: traces.size }
}

export interface ScoreOptions {
  readonly home: string
  readonly dotfiles: string
  readonly tangleTools: string
  readonly out: string
  readonly traces: string
  readonly since: string
  readonly until: string
  readonly files: number
  readonly spool: readonly string[]
}

/**
 * Session files under the home, per harness: a Claude Code `<uuid>.jsonl` or a
 * Codex `rollout-*.jsonl`, 1 KB to 40 MB, modified in the window; `limit` of
 * them spread evenly over the path order, so one project cannot fill the sample.
 */
async function sessionFiles(options: ScoreOptions, harness: string, limit: number): Promise<string[]> {
  const root = harness === 'codex' ? join(options.home, '.codex', 'sessions') : join(options.home, '.claude', 'projects')
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && depth > 0 && entry.name !== 'subagents') await walk(full, depth - 1)
      else if (SESSION_FILE[harness === 'codex' ? 'codex' : 'claude'].test(entry.name)) found.push(full)
    }
  }
  await walk(root, harness === 'codex' ? 3 : 1)
  const eligible: string[] = []
  for (const file of found) {
    const info = await stat(file)
    if (info.size < 1024 || info.size > 40 * 1024 * 1024) continue
    if (info.mtimeMs < Date.parse(options.since) || info.mtimeMs >= Date.parse(options.until)) continue
    eligible.push(file)
  }
  if (eligible.length <= limit) return eligible
  return Array.from({ length: limit }, (_, index) => eligible[Math.floor((index * eligible.length) / limit)]!)
}

const SESSION_FILE = {
  claude: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/u,
  codex: /^rollout-.+\.jsonl$/u,
}

function fill(argv: readonly string[], values: Record<string, string>, traces: string): string[] {
  const filled = argv.map((arg) => arg.replace(/\{([A-Z_]+)\}/gu, (whole, name: string) => values[name] ?? whole))
  return filled[0] === 'traces' ? [process.execPath, traces, ...filled.slice(1)] : filled
}

async function side(fork: Fork, which: 'old' | 'new', values: Record<string, string>, options: ScoreOptions, context: ReadContext): Promise<Rows | string> {
  const env = which === 'new'
    ? { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: options.home, XDG_STATE_HOME: join(options.out, 'state'), XDG_CACHE_HOME: join(options.out, 'cache'), NO_COLOR: '1' }
    : { ...process.env, HOME: options.home, PYTHONDONTWRITEBYTECODE: '1' }
  const ran = await run(fill(fork[which], values, options.traces), env)
  const label = `${fork.id}.${which}.${values.KEY_SLUG ?? 'window'}`
  await writeFile(join(options.out, 'raw', `${label}.stdout`), ran.stdout)
  await writeFile(join(options.out, 'raw', `${label}.stderr`), ran.stderr)
  if (ran.code !== 0) return `${which} exited ${ran.code}`
  try {
    if (FILE_READERS.has(fork.read[which])) return new Map([[context.key, await countSpans(values.OUT_FILE!)]])
    const reader = READERS[fork.read[which]]
    if (!reader) return `no reader ${fork.read[which]}`
    return reader(ran.stdout, context)
  } catch (error) {
    return `${which} output unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

const equal = (left: unknown, right: unknown): boolean => left !== undefined && left !== null && JSON.stringify(left) === JSON.stringify(right)

/** Compare two sides' rows: the keys found on both, and per field the share of shared keys that agree. */
export function compareRows(fork: Pick<Fork, 'id' | 'parser' | 'deletedIn' | 'tolerance' | 'fields'>, oldRows: Rows, newRows: Rows, failures: readonly string[] = []): ForkScore {
  const shared = [...oldRows.keys()].filter((key) => newRows.has(key))
  const union = new Set([...oldRows.keys(), ...newRows.keys()]).size + failures.length
  const disagreements = [
    ...failures,
    ...[...oldRows.keys()].filter((key) => !newRows.has(key)).map((key) => `${key}: only the old parser`),
    ...[...newRows.keys()].filter((key) => !oldRows.has(key)).map((key) => `${key}: only traces`),
  ]
  const fields: Record<string, number | null> = {}
  for (const name of Object.keys(fork.fields)) {
    const agree = shared.filter((key) => equal(oldRows.get(key)![name], newRows.get(key)![name])).length
    fields[name] = shared.length === 0 ? null : agree / shared.length
    for (const key of shared) {
      const [left, right] = [oldRows.get(key)![name], newRows.get(key)![name]]
      if (!equal(left, right)) disagreements.push(`${key}: ${name} ${JSON.stringify(left)} vs ${JSON.stringify(right)}`)
    }
  }
  const keyAgreement = union === 0 ? null : shared.length / union
  const scores = [keyAgreement, ...Object.values(fields)].filter((value): value is number => value !== null)
  const agreement = scores.length === 0 ? null : Math.min(...scores)
  return {
    id: fork.id,
    parser: fork.parser,
    deletedIn: fork.deletedIn,
    tolerance: fork.tolerance,
    status: 'scored',
    keys: { old: oldRows.size, new: newRows.size, both: shared.length, agreement: keyAgreement },
    fields,
    agreement,
    pass: agreement !== null && agreement >= fork.tolerance,
    disagreements: disagreements.slice(0, 5),
  }
}

async function scoreFork(fork: Fork, options: ScoreOptions): Promise<ForkScore> {
  const context = { key: 'window', since: Date.parse(options.since), until: Date.parse(options.until) }
  const base = { DOTFILES: options.dotfiles, TANGLE_TOOLS: options.tangleTools, HOME: options.home, SINCE: options.since, UNTIL: options.until, OUT: options.out }
  const skipped = (reason: string): ForkScore => ({
    id: fork.id, parser: fork.parser, deletedIn: fork.deletedIn, tolerance: fork.tolerance, status: 'skipped', reason,
    keys: { old: 0, new: 0, both: 0, agreement: null }, fields: {}, agreement: null, pass: false, disagreements: [],
  })
  const units: Array<{ key: string; values: Record<string, string> }> = []
  if (fork.unit === 'window') units.push({ key: 'window', values: base })
  if (fork.unit === 'file') {
    for (const harness of fork.harnesses ?? []) {
      for (const file of await sessionFiles(options, harness, options.files)) {
        const key = relative(options.home, file)
        const slug = key.replace(/[^\w.-]+/gu, '_').slice(-80)
        units.push({ key, values: { ...base, FILE: file, HARNESS: harness, KEY_SLUG: slug, OUT_FILE: join(options.out, 'raw', `${fork.id}.${slug}.otlp.jsonl`) } })
      }
    }
  }
  if (fork.unit === 'spool') {
    if (options.spool.length === 0) return skipped('no --spool collector files given')
    for (const file of options.spool) {
      const slug = file.replace(/[^\w.-]+/gu, '_').slice(-80)
      units.push({ key: file.split('/').at(-1)!, values: { ...base, FILE: file, KEY_SLUG: slug, OUT_FILE: join(options.out, 'raw', `${fork.id}.${slug}.otlp.jsonl`) } })
    }
  }
  if (units.length === 0) return skipped('no session file under --home in the window')
  const oldRows: Rows = new Map()
  const newRows: Rows = new Map()
  const failures: string[] = []
  for (const unit of units) {
    const unitContext = { ...context, key: unit.key }
    const [left, right] = await Promise.all([side(fork, 'old', unit.values, options, unitContext), side(fork, 'new', unit.values, options, unitContext)])
    if (unit.values.OUT_FILE) await rm(unit.values.OUT_FILE, { force: true })
    if (typeof left === 'string' || typeof right === 'string') {
      failures.push(`${unit.key}: ${[left, right].filter((value) => typeof value === 'string').join('; ')}`)
      continue
    }
    for (const [key, value] of left) oldRows.set(key, value)
    for (const [key, value] of right) newRows.set(key, value)
  }
  return compareRows(fork, oldRows, newRows, failures)
}

const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

export function renderScorecard(scores: readonly ForkScore[], window: { since: string; until: string }): string {
  const lines = [
    `Fork parity, ${window.since} to ${window.until}`,
    '',
    '| Fork | Keys old / traces / both | Key agreement | Field agreement | Agreement | Tolerance | Pass | Deleted in |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const score of scores) {
    if (score.status === 'skipped') {
      lines.push(`| ${score.id} | skipped: ${score.reason} | | | | ${pct(score.tolerance)} | no | ${score.deletedIn} |`)
      continue
    }
    const fields = Object.entries(score.fields).map(([name, value]) => `${name} ${pct(value)}`).join(', ') || 'none'
    lines.push(`| ${score.id} | ${score.keys.old} / ${score.keys.new} / ${score.keys.both} | ${pct(score.keys.agreement)} | ${fields} | ${pct(score.agreement)} | ${pct(score.tolerance)} | ${score.pass ? 'yes' : 'no'} | ${score.deletedIn} |`)
  }
  lines.push('')
  for (const score of scores.filter((item) => item.disagreements.length > 0)) {
    lines.push(`${score.id}, first disagreements:`, ...score.disagreements.map((line) => `  - ${line}`))
  }
  return `${lines.join('\n')}\n`
}

function flags(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string | undefined
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      current = arg.slice(2)
      out.set(current, out.get(current) ?? [])
    } else if (current) out.get(current)!.push(arg)
  }
  return out
}

async function main(argv: readonly string[]): Promise<number> {
  const given = flags(argv)
  const one = (name: string): string | undefined => given.get(name)?.[0]
  if (argv.includes('--help') || !one('out') || !one('home')) {
    console.error('usage: score.ts --home DIR --dotfiles DIR --tangle-tools DIR --out DIR [--since ISO --until ISO] [--traces CLI] [--forks id,id] [--files N] [--spool FILE…] [--forks-file F]')
    return argv.includes('--help') ? 0 : 2
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const forksFile = JSON.parse(await readFile(one('forks-file') ?? join(here, 'forks.json'), 'utf8')) as ForksFile
  const options: ScoreOptions = {
    home: resolve(one('home')!),
    dotfiles: resolve(one('dotfiles') ?? '.'),
    tangleTools: resolve(one('tangle-tools') ?? '.'),
    out: resolve(one('out')!),
    traces: resolve(one('traces') ?? join(here, '..', '..', 'dist', 'cli.js')),
    since: one('since') ?? forksFile.window.since,
    until: one('until') ?? forksFile.window.until,
    files: Number(one('files') ?? 8),
    spool: (given.get('spool') ?? []).map((file) => resolve(file)),
  }
  await mkdir(join(options.out, 'raw'), { recursive: true })
  const only = one('forks')?.split(',')
  const scores: ForkScore[] = []
  for (const fork of forksFile.forks.filter((item) => !only || only.includes(item.id))) {
    const score = await scoreFork(fork, options)
    console.error(`${fork.id}: ${score.status === 'skipped' ? `skipped (${score.reason})` : `agreement ${pct(score.agreement)}, ${score.pass ? 'pass' : 'below tolerance'}`}`)
    scores.push(score)
  }
  await writeFile(join(options.out, 'scorecard.json'), `${JSON.stringify({ window: { since: options.since, until: options.until }, scores }, null, 2)}\n`)
  const card = renderScorecard(scores, options)
  await writeFile(join(options.out, 'scorecard.md'), card)
  process.stdout.write(card)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
