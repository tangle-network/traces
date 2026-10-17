/**
 * The one owner of a session's token counts and their price.
 *
 * Every harness reader writes a model call's usage in agent-eval's vocabulary,
 * whose prompt categories are mutually exclusive: fresh input
 * (`llm.token_count.prompt`), cache reads and cache writes. `tokens.input` is
 * their sum, the whole prompt, on every harness: Claude's
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, and
 * Codex's own `input_tokens`, which already holds its cached tokens. That is
 * what agent-runtime's `priceTokens` takes as `inputTokens`.
 *
 * A harness that keeps a cumulative counter (Codex's `total_token_usage`) has
 * it copied onto the session's root span by its reader, and that counter is
 * the session's tokens: summing the per-call deltas would miss what the
 * harness counted outside the recorded calls. Otherwise the tokens are the sum
 * of the session's model calls (Claude Code, OpenCode, a Sandbox live stream).
 *
 * `facts` computes these per session; `analyze` and `bundle` render facts'
 * numbers, so the two read paths and every command print one number.
 */
import type { TokenWork } from '@tangle-network/agent-runtime'
import {
  type ExecutionReport,
  summarizeExecution,
} from '@tangle-network/agent-eval/contract'
import { otlpRowsToRunRecords, type OtlpToRunRecordsOptions } from '@tangle-network/agent-eval/traces'
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
} from './attributes.js'
import type { OtlpSpan } from './otlp.js'
import { toOpenInferenceSpan } from './otlp.js'

export interface TraceExecutionOptions {
  readonly experimentId?: string
  readonly candidateId?: string
}

function runOptions(opts: TraceExecutionOptions): OtlpToRunRecordsOptions {
  return {
    experimentId: opts.experimentId ?? 'traces-observed',
    candidateId: opts.candidateId ?? 'observed',
    fallbackModel: 'unknown@otlp',
  }
}

function* openInferenceRows(
  spans: readonly OtlpSpan[],
): Iterable<Record<string, unknown>> {
  for (const item of spans) yield toOpenInferenceSpan(item)
}

/** Map normalized spans into agent-eval's shared execution accounting. */
export function summarizeSpanExecution(
  spans: readonly OtlpSpan[],
  opts: TraceExecutionOptions = {},
): ExecutionReport {
  if (spans.length === 0) throw new Error('summarizeSpanExecution: no spans to summarize')
  return summarizeExecution({
    runs: otlpRowsToRunRecords(openInferenceRows(spans), runOptions(opts)),
  })
}

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

/**
 * agent-runtime's `priceTokens`, the one price table (generated from the
 * Router's catalog). Its package root loads agent-core, agent-knowledge and
 * sandbox, 0.3 s or more, so it is imported only when a session has tokens to
 * price (`priceReport`); `list`, `--match`, jsonl rows and a session with no
 * usage never load it.
 */
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

/** A model call's usage, or null when the span reports none. */
function callUsage(span: OtlpSpan): CallUsage | null {
  if (span.attributes[OPENINFERENCE_SPAN_KIND] !== 'LLM') return null
  const fresh = count(firstNumberAttr(span.attributes, LLM_INPUT_TOKEN_ATTR_KEYS))
  const output = count(firstNumberAttr(span.attributes, LLM_OUTPUT_TOKEN_ATTR_KEYS))
  const cacheRead = count(firstNumberAttr(span.attributes, LLM_CACHED_TOKEN_ATTR_KEYS)) ?? 0
  const cacheWrite = count(firstNumberAttr(span.attributes, LLM_CACHE_WRITE_TOKEN_ATTR_KEYS)) ?? 0
  // A call that used no tokens (Claude Code's `<synthetic>` notices) is not a model call to count or price.
  if ((fresh ?? 0) + (output ?? 0) + cacheRead + cacheWrite === 0) return null
  const model = modelOf(span)
  return {
    model: model ?? UNRECORDED_MODEL,
    modelRecorded: model !== null,
    input: (fresh ?? 0) + cacheRead + cacheWrite,
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

function sum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}

/**
 * The tokens of one session from its own spans: a subagent folded into its
 * trace is not this session's agent, as every other fact of the sheet says.
 */
export function sessionTokens(own: readonly OtlpSpan[]): SessionTokens {
  const calls = own.map(callUsage).filter((call): call is CallUsage => call !== null)
  const root = own.find((span) => span.parent_span_id === null
    && count(span.attributes[SESSION_TOTAL_INPUT_ATTR]) !== null && count(span.attributes[SESSION_TOTAL_OUTPUT_ATTR]) !== null)
  if (root) {
    const input = count(root.attributes[SESSION_TOTAL_INPUT_ATTR])!
    const output = count(root.attributes[SESSION_TOTAL_OUTPUT_ATTR])!
    const cacheRead = count(root.attributes[SESSION_TOTAL_CACHED_INPUT_ATTR]) ?? 0
    const cacheWrite = count(root.attributes[SESSION_TOTAL_CACHE_WRITE_ATTR]) ?? 0
    const perCall = byModel(calls)
    const recorded = [...new Set(calls.filter((call) => call.modelRecorded).map((call) => call.model))]
    const callInput = calls.reduce((total, call) => total + call.input, 0)
    const callOutput = calls.reduce((total, call) => total + call.output, 0)
    // The counter does not split by model. One model takes all of it; several
    // are priced per call when the calls add up to the counter exactly.
    const models: ModelTokens[] = recorded.length === 1
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
      unavailable: "no model call of this session's own records reports token usage, and no root span carries the harness's cumulative counter",
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

