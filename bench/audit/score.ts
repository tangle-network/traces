/**
 * Exact-match scorer. No model judges any answer.
 *
 * Each schema leaf is scored on its own: counts, numbers, names and paths by
 * equality, sets by set equality, times within 1 s, and quotes by verbatim
 * text plus a citation that resolves to the gold record. A leaf the gold has no
 * value for is correct only when the answer says "not in trace". A question is
 * correct when every leaf is, wrong when none is, and partial otherwise.
 */

import { type CitationIndex, normalizeText, type RecordRef } from './citations.js'
import type { GoldAnswers } from './fixtures.js'
import { type AnswerSchema, type Field, type Question, QUESTIONS, questionById } from './questions.js'

export const TIME_TOLERANCE_MS = 1_000

export type Verdict = 'correct' | 'partial' | 'wrong'
export type CostBasis = 'observed' | 'estimated'

/** One attempt by an arm at one question wording. */
export interface AnswerRow {
  question: string
  /** 0 is the canonical wording; higher numbers are held-out paraphrases. */
  variant?: number
  repeat?: number
  /** The answer object, or null when the arm produced none. */
  answer: unknown
  wall_ms?: number | null
  model_calls?: number | null
  tool_calls?: number | null
  cost_usd?: number | null
  cost_basis?: CostBasis | null
  error?: string | null
}

export interface AnswersFile {
  arm: string
  notes?: string
  answers: AnswerRow[]
}

export interface CitationCheck {
  cite: string
  /** The cite names a known record or span. */
  resolved: boolean
  /** A named record holds the quoted text. */
  verified: boolean
  /** The cite names the gold record. */
  onGold: boolean
}

export interface LeafResult {
  path: string
  correct: boolean
  /** The answer said "not in trace" (null) where the gold has a value. */
  falseNotInTrace: boolean
  citations: CitationCheck[]
}

export interface ScoredAnswer {
  question: string
  variant: number
  repeat: number
  verdict: Verdict
  leaves: LeafResult[]
}

const isNotInTrace = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && /^not in trace$/i.test(value.trim()))

function leaf(path: string, correct: boolean, answer: unknown, citations: CitationCheck[] = []): LeafResult {
  return { path, correct, falseNotInTrace: !correct && isNotInTrace(answer), citations }
}

function parseLineCite(cite: string): RecordRef {
  const match = /^(.+):(\d+)$/.exec(cite)
  if (!match) throw new Error(`gold cite is not <file>:<line>: ${cite}`)
  return { file: match[1]!, line: Number(match[2]) }
}

interface Quote {
  text: string
  cite: string
}

const asQuote = (value: unknown): Quote | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const { text, cite } = value as Record<string, unknown>
  return typeof text === 'string' && typeof cite === 'string' ? { text, cite } : undefined
}

function checkQuote(answer: Quote, gold: Quote, index: CitationIndex): { correct: boolean; citation: CitationCheck } {
  const target = parseLineCite(gold.cite)
  const refs = index.resolve(answer.cite)
  const verified = refs?.some((ref) => index.contains(ref, answer.text)) ?? false
  const onGold = refs?.some((ref) => ref.file === target.file && ref.line === target.line) ?? false
  const textMatches = normalizeText(answer.text) === normalizeText(gold.text)
  return {
    correct: textMatches && onGold,
    citation: { cite: answer.cite, resolved: refs !== undefined, verified, onGold },
  }
}

function sameSet(answer: unknown, gold: readonly unknown[], of: 'integer' | 'string'): boolean {
  if (!Array.isArray(answer)) return false
  const valid = of === 'integer'
    ? answer.every((item) => Number.isSafeInteger(item))
    : answer.every((item) => typeof item === 'string')
  if (!valid) return false
  const normalize = (item: unknown): unknown => (typeof item === 'string' ? item.trim() : item)
  const left = new Set(answer.map(normalize))
  const right = new Set(gold.map(normalize))
  return left.size === right.size && [...right].every((item) => left.has(item))
}

function scoreField(path: string, field: Field, answer: unknown, gold: unknown, index: CitationIndex): LeafResult[] {
  // A gold leaf the trace has no value for is answered by "not in trace" and by nothing
  // else, whatever its kind. Without this, an optional field could not be scored at all.
  if (gold === null || gold === undefined) return [leaf(path, isNotInTrace(answer), answer)]
  switch (field.kind) {
    case 'count':
      return [leaf(path, Number.isSafeInteger(answer) && answer === gold, answer)]
    case 'string':
      return [leaf(path, typeof answer === 'string' && answer.trim() === gold, answer)]
    case 'boolean':
      return [leaf(path, answer === gold, answer)]
    case 'time': {
      const parsed = typeof answer === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(answer) ? Date.parse(answer) : Number.NaN
      const correct = Number.isFinite(parsed) && Math.abs(parsed - Date.parse(String(gold))) <= TIME_TOLERANCE_MS
      return [leaf(path, correct, answer)]
    }
    case 'set':
      return [leaf(path, sameSet(answer, gold as unknown[], field.of), answer)]
    case 'quote': {
      const quote = asQuote(answer)
      if (!quote) return [leaf(path, false, answer)]
      const { correct, citation } = checkQuote(quote, gold as Quote, index)
      return [leaf(path, correct, answer, [citation])]
    }
    case 'quotes': {
      const golds = gold as Quote[]
      const quotes = Array.isArray(answer) ? answer.map(asQuote) : []
      if (!Array.isArray(answer) || quotes.some((item) => item === undefined)) return [leaf(path, false, answer)]
      const citations: CitationCheck[] = []
      const matched = new Set<number>()
      let unmatched = 0
      for (const quote of quotes as Quote[]) {
        const checks = golds.map((target) => checkQuote(quote, target, index))
        const hit = checks.findIndex((check, position) => check.correct && !matched.has(position))
        const first = checks[0]?.citation ?? { cite: quote.cite, resolved: false, verified: false, onGold: false }
        citations.push({ ...first, onGold: checks.some((check) => check.citation.onGold) })
        if (hit >= 0) matched.add(hit)
        else unmatched += 1
      }
      return [leaf(path, unmatched === 0 && matched.size === golds.length, answer, citations)]
    }
    case 'records': {
      const golds = gold as Array<Record<string, unknown>>
      const rows = Array.isArray(answer)
        ? answer.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        : []
      const keyOf = (row: Record<string, unknown>): unknown => (typeof row[field.key] === 'string' ? (row[field.key] as string).trim() : row[field.key])
      const answerKeys = rows.map(keyOf)
      const keysCorrect = Array.isArray(answer) && rows.length === answer.length && sameSet(answerKeys, golds.map(keyOf), field.keyOf)
      const results = [leaf(`${path}[*].${field.key}`, keysCorrect, answer)]
      for (const target of golds) {
        const key = keyOf(target)
        const row = rows.find((candidate) => keyOf(candidate) === key)
        for (const [name, subfield] of Object.entries(field.fields)) {
          results.push(...scoreField(`${path}[${String(key)}].${name}`, subfield, row?.[name] ?? null, target[name], index))
        }
      }
      return results
    }
  }
}

function scoreSchema(schema: AnswerSchema, answer: unknown, gold: Record<string, unknown>, index: CitationIndex): LeafResult[] {
  const object = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer as Record<string, unknown> : {}
  return Object.entries(schema).flatMap(([name, field]) => scoreField(name, field, object[name] ?? null, gold[name], index))
}

export function scoreAnswer(question: Question, row: AnswerRow, gold: GoldAnswers, index: CitationIndex): ScoredAnswer {
  const expected = gold[question.id]
  if (!expected) throw new Error(`gold has no answer for ${question.id}`)
  const leaves = scoreSchema(question.schema, row.answer, expected, index)
  const correct = leaves.filter((item) => item.correct).length
  return {
    question: question.id,
    variant: row.variant ?? 0,
    repeat: row.repeat ?? 1,
    verdict: correct === leaves.length ? 'correct' : correct === 0 ? 'wrong' : 'partial',
    leaves,
  }
}

/** Reject a malformed answers file before scoring, with every problem listed. */
export function parseAnswersFile(value: unknown): AnswersFile {
  const problems: string[] = []
  const file = value as Partial<AnswersFile> | null
  if (!file || typeof file !== 'object') throw new Error('answers file must be a JSON object')
  if (typeof file.arm !== 'string' || file.arm.length === 0) problems.push('arm must be a non-empty string')
  if (!Array.isArray(file.answers)) problems.push('answers must be an array')
  for (const [position, row] of (Array.isArray(file.answers) ? file.answers : []).entries()) {
    const question = typeof row?.question === 'string' ? questionById(row.question) : undefined
    if (!question) problems.push(`answers[${position}].question is not a known question id`)
    const variant = row?.variant ?? 0
    if (question && (!Number.isInteger(variant) || variant < 0 || variant > question.paraphrases.length)) {
      problems.push(`answers[${position}].variant must be 0 to ${question.paraphrases.length}`)
    }
    if (row && !('answer' in row)) problems.push(`answers[${position}].answer is missing (use null for no answer)`)
    if (row?.cost_basis != null && row.cost_basis !== 'observed' && row.cost_basis !== 'estimated') {
      problems.push(`answers[${position}].cost_basis must be observed, estimated, or null`)
    }
  }
  if (problems.length > 0) throw new Error(`invalid answers file:\n- ${problems.join('\n- ')}`)
  return file as AnswersFile
}

export interface Distribution {
  /** Attempts that reported the measure. */
  reported: number
  /** Attempts that did not; never counted as zero. */
  missing: number
  median: number | null
  max: number | null
  total: number | null
}

function distribution(values: ReadonlyArray<number | null | undefined>): Distribution {
  const reported = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  const middle = Math.floor(reported.length / 2)
  return {
    reported: reported.length,
    missing: values.length - reported.length,
    median: reported.length === 0 ? null : reported.length % 2 === 1 ? reported[middle]! : (reported[middle - 1]! + reported[middle]!) / 2,
    max: reported.at(-1) ?? null,
    total: reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0),
  }
}

export interface Tally {
  attempts: number
  correct: number
  partial: number
  wrong: number
  /** Leaves answered "not in trace" where the gold has a value. */
  falseNotInTrace: number
  citations: { total: number; resolved: number; verified: number; onGold: number }
  wallMs: Distribution
  modelCalls: Distribution
  toolCalls: Distribution
  cost: Distribution & { basis: CostBasis | 'mixed' | 'unknown' }
}

export interface QuestionScore extends Tally {
  question: string
  variant: number
  heldOut: boolean
}

export interface ArmScore {
  arm: string
  notes?: string
  questions: QuestionScore[]
  canonical: Tally
  heldOut: Tally
  /** Question wordings with no attempt in the answers file. */
  notAttempted: Array<{ question: string; variant: number }>
  attempts: ScoredAnswer[]
}

function tally(rows: ReadonlyArray<{ row: AnswerRow; scored: ScoredAnswer }>): Tally {
  const citations = rows.flatMap(({ scored }) => scored.leaves.flatMap((item) => item.citations))
  // An attempt that reported no cost says nothing about the basis of the ones that did;
  // `missing` already carries the omission.
  const bases = new Set(rows.filter(({ row }) => row.cost_usd != null).map(({ row }) => row.cost_basis ?? null))
  const cost = distribution(rows.map(({ row }) => row.cost_usd))
  const knownBases = [...bases].filter((basis): basis is CostBasis => basis !== null)
  return {
    attempts: rows.length,
    correct: rows.filter(({ scored }) => scored.verdict === 'correct').length,
    partial: rows.filter(({ scored }) => scored.verdict === 'partial').length,
    wrong: rows.filter(({ scored }) => scored.verdict === 'wrong').length,
    falseNotInTrace: rows.reduce((sum, { scored }) => sum + scored.leaves.filter((item) => item.falseNotInTrace).length, 0),
    citations: {
      total: citations.length,
      resolved: citations.filter((item) => item.resolved).length,
      verified: citations.filter((item) => item.verified).length,
      onGold: citations.filter((item) => item.onGold).length,
    },
    wallMs: distribution(rows.map(({ row }) => row.wall_ms)),
    modelCalls: distribution(rows.map(({ row }) => row.model_calls)),
    toolCalls: distribution(rows.map(({ row }) => row.tool_calls)),
    cost: {
      ...cost,
      basis: knownBases.length === 0 ? 'unknown' : knownBases.length === 1 && !bases.has(null) ? knownBases[0]! : 'mixed',
    },
  }
}

/**
 * Score one answers file. The file is validated here rather than by the caller, so a
 * malformed one reports every problem instead of crashing on the first bad row.
 */
export function scoreArm(input: unknown, gold: GoldAnswers, index: CitationIndex): ArmScore {
  const file = parseAnswersFile(input)
  const scored = file.answers.map((row) => ({ row, scored: scoreAnswer(questionById(row.question)!, row, gold, index) }))
  const questions: QuestionScore[] = []
  const notAttempted: ArmScore['notAttempted'] = []
  for (const question of QUESTIONS) {
    for (let variant = 0; variant <= question.paraphrases.length; variant += 1) {
      const rows = scored.filter(({ scored: item }) => item.question === question.id && item.variant === variant)
      if (rows.length === 0) notAttempted.push({ question: question.id, variant })
      else questions.push({ question: question.id, variant, heldOut: variant > 0, ...tally(rows) })
    }
  }
  return {
    arm: file.arm,
    ...(file.notes ? { notes: file.notes } : {}),
    questions,
    canonical: tally(scored.filter(({ scored: item }) => item.variant === 0)),
    heldOut: tally(scored.filter(({ scored: item }) => item.variant > 0)),
    notAttempted,
    attempts: scored.map(({ scored: item }) => item),
  }
}

const fmt = (value: number | null, digits = 0): string => (value === null ? 'n/a' : value.toFixed(digits))

function costCell(cost: Tally['cost']): string {
  if (cost.total === null) return 'unknown'
  const missing = cost.missing > 0 ? `, ${cost.missing} unknown` : ''
  return `$${cost.total.toFixed(4)} ${cost.basis}${missing}`
}

/**
 * One table row. `wordings` is the denominator a reader compares arms on: for the two
 * aggregate rows it is every wording the benchmark asks, so an arm that skipped the hard
 * questions is not rewarded with a smaller denominator.
 */
function row(label: string, item: Tally, wordings = item.attempts): string {
  const cites = item.citations.total === 0
    ? 'none'
    : `${item.citations.verified}/${item.citations.total} verify, ${item.citations.onGold} on gold`
  const skipped = wordings - item.attempts
  const verdicts = `${item.correct}/${item.partial}/${item.wrong} of ${wordings}${skipped > 0 ? ` (${skipped} not attempted)` : ''}`
  return `| ${label} | ${verdicts} | ${item.falseNotInTrace} | ${cites} | ${fmt(item.wallMs.median)} / ${fmt(item.wallMs.max)} | ${fmt(item.modelCalls.total)} | ${fmt(item.toolCalls.total)} | ${costCell(item.cost)} |`
}

export function renderArmScore(score: ArmScore): string {
  const header = [
    '| Question | Correct/partial/wrong of wordings | False "not in trace" | Citations | Wall ms median / max | Model calls | Tool calls | Cost |',
    '|---|---|---|---|---|---|---|---|',
  ]
  const canonicalWordings = QUESTIONS.length
  const heldOutWordings = QUESTIONS.reduce((sum, question) => sum + question.paraphrases.length, 0)
  return [
    `# Audit benchmark score: ${score.arm}`,
    '',
    ...(score.notes ? [score.notes, ''] : []),
    ...header,
    row('all canonical', score.canonical, canonicalWordings),
    row('all held-out', score.heldOut, heldOutWordings),
    ...score.questions.map((item) => row(`${item.question}${item.heldOut ? ` (paraphrase ${item.variant})` : ''}`, item)),
    '',
    score.notAttempted.length === 0
      ? 'Every question wording was attempted.'
      : `Not attempted (${score.notAttempted.length}): ${score.notAttempted.map((item) => `${item.question}#${item.variant}`).join(', ')}.`,
    '',
  ].join('\n')
}
