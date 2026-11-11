/**
 * The one owner of a session's token counts and their price.
 *
 * `tokens.input` is the whole prompt: `tangle.llm.context_tokens` when set,
 * else `llm.token_count.prompt` plus the cache categories. A bare
 * `gen_ai.usage.input_tokens` is that whole when the cache fits inside it, and
 * the fresh tail when the cache is larger. A root cumulative counter, when the
 * reader copied one, is the session total; otherwise the total is the sum of
 * model calls. `facts` owns the number.
 */
import type { TokenWork } from '@tangle-network/agent-runtime'
import {
  firstNumberAttr,
  LLM_CACHE_WRITE_TOKEN_ATTR_KEYS,
  LLM_CACHED_TOKEN_ATTR_KEYS,
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_MODEL_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  LLM_REASONING_TOKEN_ATTR_KEYS,
  OPENINFERENCE_SPAN_KIND,
} from '@tangle-network/agent-eval/trace-attributes'
import {
  SESSION_TOTAL_CACHE_WRITE_ATTR,
  SESSION_TOTAL_CACHED_INPUT_ATTR,
  SESSION_TOTAL_INPUT_ATTR,
  SESSION_TOTAL_OUTPUT_ATTR,
  SESSION_TOTAL_REASONING_ATTR,
  isUsageAggregate,
  sourceChannelUnavailable,
} from './attributes.js'
import type { OtlpSpan } from './otlp.js'

/** A session's tokens under one model, in the categories `priceTokens` takes. */
export interface ModelTokens {
  readonly model: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** A session's tokens. Every count is null, with the reason, when nothing in the session records usage. */
export interface SessionTokens {
  /** The whole prompt: fresh input plus cache reads plus cache writes. */
  readonly input: number | null
  readonly output: number | null
  /** The part of `input` read from the provider's cache. */
  readonly cacheRead: number | null
  /** The part of `input` written to the provider's cache. */
  readonly cacheWrite: number | null
  /** The part of `output` spent reasoning; null when the harness does not report it. */
  readonly reasoning: number | null
  /** Model calls of this session that reported usage. */
  readonly modelCalls: number
  /** The same tokens by model, as they are priced. Empty when no model is recorded. */
  readonly byModel: readonly ModelTokens[]
  readonly spanIds: readonly string[]
  readonly unavailable: string | null
}

/** What `priceTokens` charges; the label says whose rates. */
export interface SessionCost {
  readonly usd: number | null
  readonly label: typeof COST_LABEL
  readonly unavailable: string | null
}

export const COST_LABEL = 'list price (Router rates)'

/** agent-runtime's `priceTokens`: USD for the work, or undefined when the Router prices no such model. */
export type TokenPricer = (work: TokenWork) => number | undefined

let routerPricer: Promise<TokenPricer> | undefined

/** The Router price table, loaded only once a session has tokens to price. */
export function routerPrices(): Promise<TokenPricer> {
  routerPricer ??= import('@tangle-network/agent-runtime').then((runtime) => runtime.priceTokens)
  return routerPricer
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function modelOf(span: OtlpSpan): string | null {
  for (const key of LLM_MODEL_ATTR_KEYS) {
    const value = span.attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

interface CallUsage extends ModelTokens {
  readonly reasoning: number | null
  readonly spanId: string
  readonly modelRecorded: boolean
}

const UNRECORDED_MODEL = '(model not recorded)'

/** Whole prompt of one model call, or null when the span reports no usage. */
export function modelCallContextTokens(span: OtlpSpan): number | null {
  return callUsage(span)?.input ?? null
}

function wholePrompt(span: OtlpSpan, cacheRead: number, cacheWrite: number): number {
  const context = count(span.attributes['tangle.llm.context_tokens'])
  if (context !== null) return context
  const classified = cacheRead + cacheWrite
  const exclusiveFresh = count(span.attributes['llm.token_count.prompt'])
  if (exclusiveFresh !== null) return exclusiveFresh + classified
  const reported = count(firstNumberAttr(span.attributes, LLM_INPUT_TOKEN_ATTR_KEYS))
  if (reported === null) return classified
  return classified > reported ? reported + classified : reported
}

/** A model call's usage, or null when the span reports none. */
function callUsage(span: OtlpSpan): CallUsage | null {
  if (span.attributes[OPENINFERENCE_SPAN_KIND] !== 'LLM') return null
  // Its calls carry the usage; counting the turn too would double every total.
  if (isUsageAggregate(span.attributes)) return null
  const output = count(firstNumberAttr(span.attributes, LLM_OUTPUT_TOKEN_ATTR_KEYS))
  const cacheRead = count(firstNumberAttr(span.attributes, LLM_CACHED_TOKEN_ATTR_KEYS)) ?? 0
  const cacheWrite = count(firstNumberAttr(span.attributes, LLM_CACHE_WRITE_TOKEN_ATTR_KEYS)) ?? 0
  const input = wholePrompt(span, cacheRead, cacheWrite)
  // A call that used no tokens (Claude Code's `<synthetic>` notices) is not a model call to count or price.
  if (input + (output ?? 0) === 0) return null
  const model = modelOf(span)
  return {
    model: model ?? UNRECORDED_MODEL,
    modelRecorded: model !== null,
    input,
    output: output ?? 0,
    cacheRead,
    cacheWrite,
    reasoning: count(firstNumberAttr(span.attributes, LLM_REASONING_TOKEN_ATTR_KEYS)),
    spanId: span.span_id,
  }
}

function byModel(calls: readonly CallUsage[]): ModelTokens[] {
  const models = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>()
  for (const call of calls) {
    const entry = models.get(call.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    entry.input += call.input
    entry.output += call.output
    entry.cacheRead += call.cacheRead
    entry.cacheWrite += call.cacheWrite
    models.set(call.model, entry)
  }
  return [...models]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([model, entry]) => ({ model, ...entry }))
}

/** The model most of these spans' token-reporting calls went to, as `tokens.byModel` prices them; null when no call names one. */
export function dominantModel(spans: readonly OtlpSpan[]): string | null {
  const models = byModel(spans.map(callUsage).filter((call): call is CallUsage => call?.modelRecorded === true))
  return models.reduce<ModelTokens | null>((best, entry) => (best && best.input + best.output >= entry.input + entry.output ? best : entry), null)?.model ?? null
}

/** The model a folded-in child's own calls ran on, by the span its records hang under: a bound Claude Code subagent's spawn call. */
export function childModelBySpawn(spans: readonly OtlpSpan[]): (spawnSpanId: string) => string | null {
  const childUnder = new Map<string, string>()
  const own = new Map<string, OtlpSpan[]>()
  for (const span of spans) {
    const child = span.attributes['traces.span.subagent_session_id']
    if (typeof child !== 'string') continue
    const list = own.get(child)
    if (list) list.push(span)
    else own.set(child, [span])
    if (span.parent_span_id !== null && !childUnder.has(span.parent_span_id)) childUnder.set(span.parent_span_id, child)
  }
  return (spawnSpanId) => dominantModel(own.get(childUnder.get(spawnSpanId) ?? '') ?? [])
}

function sum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}

/** The tokens of one session from the spans the caller hands it. */
export function sessionTokens(own: readonly OtlpSpan[], honorRoot = true): SessionTokens {
  const calls = own.map(callUsage).filter((call): call is CallUsage => call !== null)
  const counted = (span: OtlpSpan) => count(span.attributes[SESSION_TOTAL_INPUT_ATTR]) !== null && count(span.attributes[SESSION_TOTAL_OUTPUT_ATTR]) !== null
  const root = own.find((span) => span.parent_span_id === null && counted(span))
  // A nested span with its own counter is another agent's total (a Runtime child node), so the root's counter is not this sheet's.
  const nested = root !== undefined && own.some((span) => span !== root && counted(span))
  // A pool of several children passes false: one child's counter must not replace the others.
  if (honorRoot && root && !nested) {
    const input = count(root.attributes[SESSION_TOTAL_INPUT_ATTR])!
    const output = count(root.attributes[SESSION_TOTAL_OUTPUT_ATTR])!
    const cacheRead = count(root.attributes[SESSION_TOTAL_CACHED_INPUT_ATTR]) ?? (sourceChannelUnavailable(own, 'cache-read') ? null : 0)
    const cacheWrite = count(root.attributes[SESSION_TOTAL_CACHE_WRITE_ATTR]) ?? (sourceChannelUnavailable(own, 'cache-write') ? null : 0)
    const perCall = byModel(calls)
    const recorded = [...new Set(calls.filter((call) => call.modelRecorded).map((call) => call.model))]
    const callInput = calls.reduce((total, call) => total + call.input, 0)
    const callOutput = calls.reduce((total, call) => total + call.output, 0)
    // The counter does not split by model. One model takes all of it; several
    // are priced per call when the calls add up to the counter exactly.
    const models: ModelTokens[] = cacheRead === null || cacheWrite === null ? [] : recorded.length === 1
      ? [{ model: recorded[0]!, input, output, cacheRead, cacheWrite }]
      : recorded.length > 1 && callInput === input && callOutput === output ? perCall : []
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: count(root.attributes[SESSION_TOTAL_REASONING_ATTR]),
      modelCalls: calls.length,
      byModel: models,
      spanIds: [root.span_id],
      unavailable: null,
    }
  }
  if (calls.length === 0) {
    return {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      modelCalls: 0,
      byModel: [],
      spanIds: [],
      unavailable: nested ? 'several agents in this trace each carry their own usage counter, and no record states their sum'
        : "no model call of this session's own records reports token usage, and no root span carries the harness's cumulative counter",
    }
  }
  return {
    input: calls.reduce((total, call) => total + call.input, 0),
    output: calls.reduce((total, call) => total + call.output, 0),
    cacheRead: calls.reduce((total, call) => total + call.cacheRead, 0),
    cacheWrite: calls.reduce((total, call) => total + call.cacheWrite, 0),
    reasoning: sum(calls.map((call) => call.reasoning)),
    modelCalls: calls.length,
    byModel: byModel(calls),
    spanIds: calls.map((call) => call.spanId),
    unavailable: null,
  }
}

function mergeModelTokens(left: readonly ModelTokens[], right: readonly ModelTokens[]): ModelTokens[] {
  const models = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>()
  for (const entry of [...left, ...right]) {
    const row = models.get(entry.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    row.input += entry.input
    row.output += entry.output
    row.cacheRead += entry.cacheRead
    row.cacheWrite += entry.cacheWrite
    models.set(entry.model, row)
  }
  return [...models]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([model, entry]) => ({ model, ...entry }))
}

function hasUsage(tokens: SessionTokens): boolean {
  return tokens.modelCalls > 0 || tokens.byModel.length > 0 || (tokens.input ?? 0) + (tokens.output ?? 0) > 0
}

/** Sum two readings. A side with no usage is ignored. An empty `byModel` on a side that has usage blanks the split. */
export function addSessionTokens(left: SessionTokens, right: SessionTokens): SessionTokens {
  if (left.input === null) return right
  if (right.input === null || !hasUsage(right)) return left
  if (!hasUsage(left)) return right
  const cacheRead = left.cacheRead === null || right.cacheRead === null ? null : left.cacheRead + right.cacheRead
  const cacheWrite = left.cacheWrite === null || right.cacheWrite === null ? null : left.cacheWrite + right.cacheWrite
  const priced = left.byModel.length > 0 && right.byModel.length > 0 && cacheRead !== null && cacheWrite !== null
  return {
    input: left.input + right.input,
    output: (left.output ?? 0) + (right.output ?? 0),
    cacheRead,
    cacheWrite,
    reasoning: left.reasoning === null && right.reasoning === null ? null : (left.reasoning ?? 0) + (right.reasoning ?? 0),
    modelCalls: left.modelCalls + right.modelCalls,
    byModel: priced ? mergeModelTokens(left.byModel, right.byModel) : [],
    spanIds: [...left.spanIds, ...right.spanIds],
    unavailable: null,
  }
}

function subagentTokens(spans: readonly OtlpSpan[]): SessionTokens {
  const groups = new Map<string, OtlpSpan[]>()
  const loose: OtlpSpan[] = []
  for (const span of spans) {
    const id = span.attributes['traces.span.subagent_session_id']
    if (typeof id === 'string' && id.length > 0) (groups.get(id) ?? groups.set(id, []).get(id)!).push(span)
    else loose.push(span)
  }
  let total = sessionTokens([])
  for (const group of groups.values()) total = addSessionTokens(total, sessionTokens(group))
  return loose.length === 0 ? total : addSessionTokens(total, sessionTokens(loose, false))
}

/** True when the parent's cumulative counter already equals its own calls plus `extra`. */
function rootAlreadyIncludes(ownSpans: readonly OtlpSpan[], extra: SessionTokens): boolean {
  const root = ownSpans.find((span) => span.parent_span_id === null
    && count(span.attributes[SESSION_TOTAL_INPUT_ATTR]) !== null && count(span.attributes[SESSION_TOTAL_OUTPUT_ATTR]) !== null)
  if (!root || extra.input === null) return false
  let input = extra.input
  let output = extra.output ?? 0
  for (const span of ownSpans) {
    const call = callUsage(span)
    if (call) { input += call.input; output += call.output }
  }
  return count(root.attributes[SESSION_TOTAL_INPUT_ATTR]) === input && count(root.attributes[SESSION_TOTAL_OUTPUT_ATTR]) === output
}

/** Parent tokens plus each folded child, once. A counter that already matches both is kept.
 * `apart` is the exclusive child sheet: the parent reports only its own calls.
 */
export function foldSubagentTokens(ownSpans: readonly OtlpSpan[], subagentSpans: readonly OtlpSpan[], apart = false): SessionTokens {
  if (subagentSpans.length === 0) return sessionTokens(ownSpans)
  const extra = subagentTokens(subagentSpans)
  const covered = rootAlreadyIncludes(ownSpans, extra)
  if (apart) return sessionTokens(ownSpans, !covered)
  return covered ? sessionTokens(ownSpans) : addSessionTokens(sessionTokens(ownSpans), extra)
}

/** True when `sessionCost` needs the price table for these tokens: they are known, non-zero and name a model. */
export function needsPrice(tokens: SessionTokens): boolean {
  return tokens.input !== null && tokens.input + (tokens.output ?? 0) > 0 && tokens.byModel.length > 0
}

/** USD to the micro-dollar, so a sum of float products prints the same on every run. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}

/** What the Router would charge for the session's tokens, or null with the reason. */
export function sessionCost(tokens: SessionTokens, price: TokenPricer | undefined): SessionCost {
  const unknown = (reason: string): SessionCost => ({ usd: null, label: COST_LABEL, unavailable: reason })
  if (tokens.input === null) return unknown(`no token counts: ${tokens.unavailable}`)
  if (tokens.input + (tokens.output ?? 0) === 0) return { usd: 0, label: COST_LABEL, unavailable: null }
  if (tokens.byModel.length === 0) {
    return unknown('no model call of the session records its model, or several models share a cumulative counter the calls do not add up to')
  }
  if (price === undefined) return unknown('not priced yet: `await priceReport(report)` loads the price table and fills it')
  const unpriced = tokens.byModel.filter((entry) => entry.model === UNRECORDED_MODEL
    || price({ model: entry.model, inputTokens: entry.input, outputTokens: entry.output, cacheReadTokens: entry.cacheRead, cacheWriteTokens: entry.cacheWrite }) === undefined)
  if (unpriced.length > 0) {
    return unknown(`the Router lists no price for ${unpriced.map((entry) => entry.model).join(', ')}`)
  }
  const usd = tokens.byModel.reduce((total, entry) => total + price({
    model: entry.model,
    inputTokens: entry.input,
    outputTokens: entry.output,
    cacheReadTokens: entry.cacheRead,
    cacheWriteTokens: entry.cacheWrite,
  })!, 0)
  return { usd: roundUsd(usd), label: COST_LABEL, unavailable: null }
}

