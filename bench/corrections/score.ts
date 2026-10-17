#!/usr/bin/env node
/**
 * How well the turn signals of `traces facts` find the turns where a person
 * corrected the agent, beside the lexical classifier traces 0.23.1 used.
 *
 *   traces facts <refs> --format jsonl | pnpm -s bench:corrections <labels.jsonl> [--format json]
 *   pnpm -s bench:corrections <labels.jsonl> <facts.jsonl> [--format json]
 *
 * `labels.jsonl` holds one labelled turn per line, `{"session", "at", "label"}`,
 * where `label` is true when a judge called the turn a correction. A label
 * joins the facts row with the same session id and the same instant. Each arm
 * is scored on the joined turns only, so every arm is scored on the same turns:
 *
 *   interrupt, rejected-tool, after-claim   one `signals` value each
 *   union                                   any of the three
 *   lexical                                 the 0.23.1 `correction` reaction
 *   lexical-any                             any 0.23.1 corrective reaction
 *
 * The last line applies the rule of analyze section 7: the section is titled
 * "Correction signals" only when the union's recall beats each lexical arm's
 * at no lower precision; otherwise it is "Interrupts and rejections".
 */

import { readFile } from 'node:fs/promises'
import { classifyReaction, CORRECTIVE_REACTIONS } from './lexical-baseline.js'

const USAGE = 'Usage: bench:corrections <labels.jsonl> [facts.jsonl] [--format text|json]  (facts rows from stdin when no file is given)'

const SIGNALS = ['interrupt', 'rejected-tool', 'after-claim'] as const
const LEXICAL_ARMS = ['lexical', 'lexical-any'] as const
type Arm = (typeof SIGNALS)[number] | 'union' | (typeof LEXICAL_ARMS)[number]
const ARMS: readonly Arm[] = [...SIGNALS, 'union', ...LEXICAL_ARMS]

/** One row of `traces facts --format jsonl`, the fields this bench reads. */
interface FactsRow {
  readonly session: string
  readonly at: string
  readonly text: string
  readonly signals: readonly string[]
}

interface Label {
  readonly session: string
  readonly at: string
  readonly label: boolean
}

interface ArmScore {
  readonly arm: Arm
  readonly fires: number
  readonly truePositives: number
  readonly falsePositives: number
  readonly falseNegatives: number
  readonly recall: number | null
  /** Wilson 95% interval. */
  readonly recallInterval: readonly [number, number] | null
  readonly precision: number | null
  readonly precisionInterval: readonly [number, number] | null
  readonly f1: number | null
}

class UsageError extends Error {}

/** The same instant written two ways (`…00.000Z`, `…00Z`) is one key. */
function key(session: string, at: string): string {
  const time = Date.parse(at)
  return `${session}\u0000${Number.isFinite(time) ? new Date(time).toISOString() : at}`
}

function parseLines<T>(text: string, source: string, check: (row: Record<string, unknown>) => T): T[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        throw new UsageError(`${source} line ${index + 1} is not JSON`)
      }
      if (typeof row !== 'object' || row === null) throw new UsageError(`${source} line ${index + 1} is not an object`)
      return check(row as Record<string, unknown>)
    })
}

function factsRow(row: Record<string, unknown>): FactsRow {
  if (typeof row.session !== 'string' || typeof row.at !== 'string' || typeof row.text !== 'string' || !Array.isArray(row.signals)) {
    throw new UsageError('facts rows need session, at, text and signals: pass `traces facts <refs> --format jsonl`')
  }
  return { session: row.session, at: row.at, text: row.text, signals: row.signals.map(String) }
}

function label(row: Record<string, unknown>): Label {
  if (typeof row.session !== 'string' || typeof row.at !== 'string' || typeof row.label !== 'boolean') {
    throw new UsageError('labels need {"session": string, "at": ISO time, "label": boolean}')
  }
  return { session: row.session, at: row.at, label: row.label }
}

function wilson(hits: number, n: number): readonly [number, number] | null {
  if (n === 0) return null
  const z = 1.96
  const p = hits / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function fires(arm: Arm, row: FactsRow): boolean {
  if (arm === 'union') return row.signals.some((signal) => (SIGNALS as readonly string[]).includes(signal))
  if (arm === 'lexical') return classifyReaction(row.text).includes('correction')
  if (arm === 'lexical-any') return classifyReaction(row.text).some((reaction) => CORRECTIVE_REACTIONS.includes(reaction))
  return row.signals.includes(arm)
}

function scoreArm(arm: Arm, turns: ReadonlyArray<{ readonly label: boolean; readonly row: FactsRow }>): ArmScore {
  const positives = turns.filter((turn) => turn.label).length
  const fired = turns.filter((turn) => fires(arm, turn.row))
  const truePositives = fired.filter((turn) => turn.label).length
  const recall = positives === 0 ? null : truePositives / positives
  const precision = fired.length === 0 ? null : truePositives / fired.length
  return {
    arm,
    fires: fired.length,
    truePositives,
    falsePositives: fired.length - truePositives,
    falseNegatives: positives - truePositives,
    recall: recall === null ? null : round(recall),
    recallInterval: wilson(truePositives, positives),
    precision: precision === null ? null : round(precision),
    precisionInterval: wilson(truePositives, fired.length),
    f1: recall === null || precision === null || truePositives === 0 ? null : round((2 * precision * recall) / (precision + recall)),
  }
}

/**
 * The §2.2 rule: the union beats every lexical arm's recall, at no lower
 * precision. It compares the counts, never the rounded rates, and a precision
 * that cannot be computed (an arm that never fired) is no win.
 */
function decide(scores: readonly ArmScore[]): { title: string; reason: string } {
  const union = scores.find((score) => score.arm === 'union')!
  const shown = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3))
  const losses: string[] = []
  for (const lexical of scores.filter((score) => (LEXICAL_ARMS as readonly string[]).includes(score.arm))) {
    // Every arm is scored on the same turns, so recall orders as the true positives do.
    if (union.recall === null || union.truePositives <= lexical.truePositives) {
      losses.push(`union recall ${shown(union.recall)} is not above ${lexical.arm} ${shown(lexical.recall)}`)
    }
    if (union.fires === 0 || lexical.fires === 0) {
      losses.push(`precision cannot be compared: union fired ${union.fires} times, ${lexical.arm} ${lexical.fires}`)
    } else if (union.truePositives * lexical.fires < lexical.truePositives * union.fires) {
      losses.push(`union precision ${shown(union.precision)} is below ${lexical.arm} ${shown(lexical.precision)}`)
    }
  }
  return losses.length === 0
    ? { title: 'Correction signals', reason: 'the union beats every lexical arm on recall at no lower precision' }
    : { title: 'Interrupts and rejections', reason: losses.join('; ') }
}

interface CorrectionsReport {
  readonly kind: 'traces.bench.corrections'
  readonly schemaVersion: 1
  readonly labels: number
  /** Labelled turns that joined a facts row: every arm is scored on these. */
  readonly joined: number
  readonly corrections: number
  /** Labels with no facts row at the same session and instant. */
  readonly unjoined: number
  /** Labels whose session and instant name two different facts rows. Not scored. */
  readonly ambiguous: number
  readonly arms: readonly ArmScore[]
  readonly section7: { readonly title: string; readonly reason: string }
}

function scoreCorrections(labels: readonly Label[], facts: readonly FactsRow[]): CorrectionsReport {
  // A session read twice (two hosts, a copied store) repeats identical rows; two different rows at one instant are ambiguous.
  const rows = new Map<string, FactsRow | null>()
  for (const row of facts) {
    const at = key(row.session, row.at)
    const seen = rows.get(at)
    if (seen === undefined) rows.set(at, row)
    else if (seen !== null && JSON.stringify(seen) !== JSON.stringify(row)) rows.set(at, null)
  }
  const turns: Array<{ label: boolean; row: FactsRow }> = []
  let unjoined = 0
  let ambiguous = 0
  for (const entry of labels) {
    const row = rows.get(key(entry.session, entry.at))
    if (row === undefined) unjoined += 1
    else if (row === null) ambiguous += 1
    else turns.push({ label: entry.label, row })
  }
  const arms = ARMS.map((arm) => scoreArm(arm, turns))
  return {
    kind: 'traces.bench.corrections',
    schemaVersion: 1,
    labels: labels.length,
    joined: turns.length,
    corrections: turns.filter((turn) => turn.label).length,
    unjoined,
    ambiguous,
    arms,
    section7: decide(arms),
  }
}

function show(value: number | null, interval: readonly [number, number] | null): string {
  if (value === null) return 'n/a'.padEnd(20)
  return `${value.toFixed(3)} [${interval![0].toFixed(2)}, ${interval![1].toFixed(2)}]`.padEnd(20)
}

function renderCorrections(report: CorrectionsReport): string {
  return [
    `${report.joined} labelled turns scored (${report.corrections} corrections) · labels with no facts row ${report.unjoined} · ambiguous ${report.ambiguous}`,
    `${'arm'.padEnd(14)} ${'fires'.padStart(5)}  ${'recall [95% CI]'.padEnd(20)} ${'precision [95% CI]'.padEnd(20)} F1`,
    ...report.arms.map((arm) =>
      `${arm.arm.padEnd(14)} ${String(arm.fires).padStart(5)}  ${show(arm.recall, arm.recallInterval)} ${show(arm.precision, arm.precisionInterval)} ${arm.f1 === null ? 'n/a' : arm.f1.toFixed(3)}`,
    ),
    `analyze section 7: "${report.section7.title}" (${report.section7.reason})`,
  ].join('\n')
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(argv: readonly string[]): Promise<void> {
  let format = 'text'
  const files: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--format') {
      format = argv[index + 1] ?? ''
      index += 1
    } else if (arg.startsWith('--format=')) {
      format = arg.slice('--format='.length)
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown flag ${arg}`)
    } else {
      files.push(arg)
    }
  }
  if (format !== 'text' && format !== 'json') throw new UsageError('--format is text or json')
  if (files.length < 1 || files.length > 2) throw new UsageError('pass a labels file, then a facts file or facts rows on stdin')
  const [labelsPath, factsPath] = files as [string, string | undefined]
  const labels = parseLines(await readFile(labelsPath, 'utf8'), labelsPath, label)
  const facts = parseLines(factsPath ? await readFile(factsPath, 'utf8') : await readStdin(), factsPath ?? 'stdin', factsRow)
  const report = scoreCorrections(labels, facts)
  process.stdout.write(`${format === 'json' ? JSON.stringify(report, null, 2) : renderCorrections(report)}\n`)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(error instanceof UsageError ? `${message}\n${USAGE}\n` : `${message}\n`)
  process.exitCode = 2
})
