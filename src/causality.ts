// What caused what, from span links (`agent.link.kind`, from the caused work to its cause: a round `steered_by` a steer, a session `spawned_by` the call that
// started it) and rounds (`agent.loop.iteration`, `agent.loop.id` defaulting to the trace, `agent.outcome` when scored); nothing from names or timing. Spans
// arrive a trace at a time, so each keeps a few fields, up to as many as the contract's validator reads; a link past that cap counts as unresolved.
import { ATTR, LINK_KIND_ATTR } from '@tangle-network/agent-trace-contract'
import { sessionIdFromAttributes } from './attributes.js'
import type { OtlpSpan } from './otlp.js'
const INDEXED_SPANS = 250_000, ROWS_KEPT = 200, SEP = '\u0000', RANK: Readonly<Record<string, number>> = { error: 0, fail: 0, pass: 1 }
type Change = 'improved' | 'held' | 'regressed'
interface Indexed { readonly sessionId: string; readonly name: string; readonly at: string; readonly loopId?: string; readonly iteration?: number; readonly outcome?: string }
export interface CausalEnd extends Partial<Indexed> { readonly traceId: string; readonly spanId: string }
/** A steer and the round it caused; `change` is that round's outcome against the previous round of its loop. */
export interface SteeringRow { readonly cause: CausalEnd; readonly effect: CausalEnd; readonly lagMs: number | null; readonly change: Change | null }
/** One loop: outcomes by iteration (p pass, f fail, e error, ? unscored) and how many rounds a steer caused. */
export interface LoopRounds { readonly loopId: string; readonly sessionId: string; readonly outcomes: string; readonly steered: number }
type Tally<K extends string> = Record<K, number>
/** `capped`: spans past the index cap, a link to which counts unresolved (an unknown, not a producer defect); `steers` caused `turns`, rows the first {@link ROWS_KEPT} by the caused round's start; `converged`: loops whose last scored round passed after one that did not. */
export interface CausalityMeasure {
  readonly capped: number
  readonly links: Readonly<Record<string, { readonly total: number; readonly resolved: number }>>
  readonly steering: { readonly links: number; readonly resolved: number; readonly steers: number; readonly turns: number; readonly medianLagMs: number | null; readonly changes: Tally<Change | 'unscored'>; readonly rows: readonly SteeringRow[] }
  readonly rounds: { readonly loops: number; readonly rounds: number; readonly outcomes: Tally<'pass' | 'fail' | 'error' | 'unscored'>; readonly transitions: Tally<Change>; readonly converged: number; readonly rows: readonly LoopRounds[] }
}
export function createCausalityAccumulator(): { add(spans: readonly OtlpSpan[]): void; report(): CausalityMeasure } {
  const index = new Map<string, Indexed>(), linked = new Map<string, { from: string; to: string; kind: string }>(), rounds = new Set<string>(), count = { capped: 0 }
  return {
    add(spans) {
      const traceSession = spans.map((span) => sessionIdFromAttributes(span.attributes)).find(Boolean)
      for (const span of spans) {
        const at = `${span.trace_id}${SEP}${span.span_id}`, { [ATTR.iteration]: iteration, [ATTR.loopId]: loopId, [ATTR.outcome]: outcome } = span.attributes
        const round = typeof iteration === 'number' && Number.isFinite(iteration)
        for (const link of span.links ?? []) { const to = `${link.trace_id}${SEP}${link.span_id}`, kind = String(link.attributes?.[LINK_KIND_ATTR] ?? 'unnamed'); linked.set(`${at}${SEP}${to}${SEP}${kind}`, { from: at, to, kind }) }
        if (!round && !span.links?.length && index.size >= INDEXED_SPANS && !index.has(at)) { count.capped += 1; continue }
        index.set(at, { sessionId: sessionIdFromAttributes(span.attributes) ?? traceSession ?? span.trace_id, name: span.name, at: span.start_time,
          ...(round ? { loopId: typeof loopId === 'string' && loopId ? loopId : span.trace_id, iteration } : {}), ...(typeof outcome === 'string' ? { outcome } : {}) })
        if (round) rounds.add(at)
      }
    },
    report() {
      const end = (at: string): CausalEnd => { const [traceId, spanId] = at.split(SEP) as [string, string]; return { traceId, spanId, ...index.get(at) } }
      const links = [...linked.values()], byKind: Record<string, { total: number; resolved: number }> = {}
      for (const link of links) { const entry = (byKind[link.kind] ??= { total: 0, resolved: 0 }); entry.total += 1; entry.resolved += index.has(link.to) ? 1 : 0 }
      const loops = new Map<string, { at: string; span: Indexed }[]>(), before = new Map<string, Indexed>()
      for (const at of rounds) { const span = index.get(at)!, list = loops.get(span.loopId!) ?? []; list.push({ at, span }); loops.set(span.loopId!, list) }
      for (const list of loops.values()) list.sort((a, b) => a.span.iteration! - b.span.iteration!).forEach((round, i) => i > 0 && before.set(round.at, list[i - 1]!.span))
      const change = (at: string): Change | null => {
        const [now, then] = [RANK[index.get(at)?.outcome ?? ''], RANK[before.get(at)?.outcome ?? '']]
        return now === undefined || then === undefined ? null : now > then ? 'improved' : now < then ? 'regressed' : 'held'
      }
      const steering = links.filter((link) => link.kind === 'steered_by'), resolved = steering.filter((link) => index.has(link.to))
      const turns = new Set(resolved.map((link) => link.from)), changes = { improved: 0, held: 0, regressed: 0, unscored: 0 }
      for (const turn of turns) changes[change(turn) ?? 'unscored'] += 1
      const rows = resolved.map((link): SteeringRow => {
        const cause = end(link.to), effect = end(link.from), lag = Date.parse(effect.at ?? '') - Date.parse(cause.at ?? '')
        return { cause, effect, lagMs: Number.isFinite(lag) ? lag : null, change: change(link.from) }
      }).sort((a, b) => (a.effect.at ?? '').localeCompare(b.effect.at ?? ''))
      const lags = rows.flatMap((row) => (row.lagMs === null ? [] : [row.lagMs])).sort((a, b) => a - b), mid = lags.length >> 1
      const outcomes = { pass: 0, fail: 0, error: 0, unscored: 0 }, transitions = { improved: 0, held: 0, regressed: 0 }
      let converged = 0
      const loopRows = [...loops].map(([loopId, list]): LoopRounds => {
        for (const { at, span } of list) {
          outcomes[span.outcome === 'pass' || span.outcome === 'fail' || span.outcome === 'error' ? span.outcome : 'unscored'] += 1
          const verdict = change(at)
          if (verdict) transitions[verdict] += 1
        }
        const scored = list.filter(({ span }) => RANK[span.outcome ?? ''] !== undefined)
        if (scored.length > 1 && scored.at(-1)!.span.outcome === 'pass' && scored.some(({ span }) => span.outcome !== 'pass')) converged += 1
        const letter = (outcome?: string): string => ({ pass: 'p', fail: 'f', error: 'e' })[outcome ?? ''] ?? '?'
        return { loopId, sessionId: list[0]!.span.sessionId, outcomes: list.map(({ span }) => letter(span.outcome)).join(''), steered: list.filter(({ at }) => turns.has(at)).length }
      }).sort((a, b) => b.outcomes.length - a.outcomes.length || a.loopId.localeCompare(b.loopId))
      return {
        capped: count.capped,
        links: byKind,
        steering: { links: steering.length, resolved: resolved.length, steers: new Set(resolved.map((link) => link.to)).size, turns: turns.size,
          medianLagMs: lags.length === 0 ? null : lags.length % 2 ? lags[mid]! : (lags[mid - 1]! + lags[mid]!) / 2, changes, rows: rows.slice(0, ROWS_KEPT) },
        rounds: { loops: loops.size, rounds: rounds.size, outcomes, transitions, converged, rows: loopRows.slice(0, ROWS_KEPT) },
      }
    },
  }
}
