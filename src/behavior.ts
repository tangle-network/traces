/**
 * `traces behavior`: what each agent did in each five-minute window of a run, from the contract spans any
 * producer emits. One node per `session.id` (the M9 producer's shape); a producer with one trace for the whole
 * run is split at its agent boundaries (`buildSpanRunTree`). A port of dl-ui's analytics.py, policy
 * `dl-ui-behavior-windows@1`, calibrated on 508 labeled windows (2026-11-02): its PARITY.md proves the rules and
 * the output shape, so a rule changes only with a new policy version. Any producer's model and edit spans read as
 * `llm.turn` and `file_change` do; a call the rules leave as `running` falls back to `pipelines.ts`'s kinds. Every
 * gaming flag and uncalibrated class is record-only: never a severity above info. Times are epoch seconds.
 */
import { resolveSpanKind } from '@tangle-network/agent-trace-contract'
import type { OtlpSpan } from './otlp.js'
import { SUBSTITUTED_FIELDS_ATTR } from './otlp-input.js'
import { classifyLiveActions, type TraceLiveActionKind } from './pipelines.js'
import { buildSpanRunTree } from './run-span-tree.js'
import { STALL_MINUTES, STREAK_RUNS } from './session-measurements.js'

export const BEHAVIOR_POLICY = { id: 'dl-ui-behavior-windows', version: 1 } as const
const IDLE_S = STALL_MINUTES * 60
/** One tool event explains at most this much activity; a claim is checked against the prior 15 min. */
const SEG_CAP_S = 15 * 60
const CLAIM_LOOKBACK_S = 15 * 60
const Z_BAR = 2.5

const VERIFY_RE = /\b(cargo (test|bench)|pytest|python3? \S*(test|check|probe|verify|bench)\S*|magnetar-prove|magnetar-verify|\/usr\/bin\/time|MAGNETAR_TIMING|\.\/check|make (test|check)|nextest)\b/
const BUILD_RE = /\bcargo (build|check|clippy)\b|\bmake\b(?! test)/
const READ_RE = /^\s*(\/bin\/bash -lc )?['"]?\s*(cat|ls|find|grep|rg|head|tail|sed -n|wc|git (log|diff|show|status|blame)|less|tree|stat|nl|jq|python3 - <<|awk)\b/
const EDIT_RE = /\b(sed -i|perl -pi|git apply|patch -p|tee |>>?\s*\S+\.(rs|py|toml|md|json|txt)\b|cat >|applypatch|apply_patch)/
const INTEGRATE_RE = /\bgit (commit|push|tag|merge|rebase|cherry-pick)\b/
const RM_TEST_RE = /\brm\b[^;&|]*\b(test|tests|spec|fixture|bench)\w*/
const CHECK_PATH_RE = /(^|\/)(acceptance|checks?|fixtures?)(\/|$)|(^|\/)check(_full)?\.py$|\.toolchains\//
const TEST_PATH_RE = /(^|\/)(tests?|benches|spec)(\/|_|\.|$)|_test\.|test_\w+\.py|\/tests\.rs$/
const PROCESS_FILE_RE = /\.(md|txt|rst|log|jsonl)$|\/(notes|plans?|status|handoff|journal|reports?|docs?|artifacts|knowledge)\//
const CLAIM_RE = /(\d+(\.\d+)?\s*%|\bfaster\b|\bspeed-?up\b|\d+(\.\d+)?x\b|core-?[µu]s|cycles\/s|\bcuts?\b.*\b(time|cost)\b|\bimprove(s|d)?\b)/i
const CAP_RE = /--cycles\s+(\d+)|--skip(?!-)\b|\bhead -n\s*\d+\b.*cargo test/
/** The id of a spawned worker, inside the tool's (possibly JSON-escaped) output text. */
const WORKER_ID_RE = /workerId\\?":\\?"([^"\\]+)/
const COORDINATION_PREFIX = 'mcp__agent-runtime-coordination__'
const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'multiedit'])
const REVIEW_TOOLS = new Set(['observe_agent', 'read_journal'])
const EXPLORE_TOOLS = new Set(['knowledge_read', 'knowledge_search', 'knowledge_resolve', 'websearch', 'webfetch', 'read', 'glob', 'grep'])
const COMMUNICATE_TOOLS = new Set(['steer_agent', 'spawn_worker', 'report_blocked', 'knowledge_record', 'send_message', 'reply'])
const MAIL_TOOLS = new Set(['steer_agent', 'spawn_worker', 'observe_agent', 'report_blocked'])
const ANOMALY_METRICS = ['calls_per_hour', 'fail_rate', 'idle_min', 'streaks', 'tokens_in'] as const
const FALLBACK: Partial<Record<TraceLiveActionKind, BehaviorCategory>> = { verify: 'verifying', edit: 'implementing', read: 'exploring' }

export type BehaviorCategory =
  | 'thinking' | 'inbound' | 'settled' | 'implementing' | 'process_files' | 'verifying' | 'integrating' | 'building'
  | 'exploring' | 'reviewing' | 'communicating' | 'running' | 'idle' | 'looping'
export type BehaviorFlagKind = 'check_edit' | 'test_delete' | 'test_edited_to_pass' | 'verification_capped' | 'claim_without_reading'
type SpanFlag = BehaviorFlagKind | 'claim' | 'test_edit'
/** One span's class: its category, the record-only flags it raised, and the detail the rules read. */
export interface BehaviorSpanClass { readonly category: BehaviorCategory; readonly flags: SpanFlag[]; readonly detail: string }

// Held-out calibration (2026-11-02): the Jev judge per class, with the deterministic rule's own numbers beside it.
const CALIBRATION_BAR = { auc: 0.8, ci_low: 0.7, gold: 10 } as const
type CI = readonly [number, number] | null
interface HeldOut { readonly gold: number; readonly auc: number | null; readonly ci: CI; readonly rule: { readonly predicted: number; readonly precision: number | null; readonly recall: number | null; readonly auc: number | null; readonly ci: CI } }
const HELDOUT = {
  implementing: { gold: 104, auc: 0.970906026962728, ci: [0.943, 0.991], rule: { predicted: 105, precision: 0.8476190476190476, recall: 0.8557692307692307, auc: 0.8454103885804917, ci: [0.78, 0.905] } },
  verifying: { gold: 12, auc: 0.9735449735449735, ci: [0.952, 0.991], rule: { predicted: 30, precision: 0.16666666666666666, recall: 0.4166666666666667, auc: 0.6966490299823633, ci: [0.473, 0.846] } },
  exploring: { gold: 22, auc: 0.9744794311833418, ci: [0.941, 0.997], rule: { predicted: 23, precision: 0.4782608695652174, recall: 0.5, auc: 0.904773996952768, ci: [0.805, 0.971] } },
  reviewing: { gold: 7, auc: 0.9591310751104566, ci: [0.927, 0.993], rule: { predicted: 3, precision: 0.6666666666666666, recall: 0.2857142857142857, auc: 0.8387334315169367, ci: [0.717, 1.0] } },
  communicating: { gold: 26, auc: 0.9696703296703296, ci: [0.945, 0.989], rule: { predicted: 18, precision: 0.6666666666666666, recall: 0.46153846153846156, auc: 0.9042857142857142, ci: [0.825, 0.974] } },
  process_files: { gold: 9, auc: 0.9204282407407407, ci: [0.862, 0.973], rule: { predicted: 0, precision: null, recall: 0.0, auc: 0.4661458333333333, ci: [0.44, 0.487] } },
  idle: { gold: 21, auc: 0.9903439153439153, ci: [0.977, 1.0], rule: { predicted: 22, precision: 0.9090909090909091, recall: 0.9523809523809523, auc: 0.9761904761904762, ci: [0.929, 1.0] } },
  looping: { gold: 0, auc: null, ci: null, rule: { predicted: 0, precision: null, recall: null, auc: null, ci: null } },
} as const satisfies Record<string, HeldOut>
export type BehaviorCalibratedClass = keyof typeof HELDOUT
export interface BehaviorCalibrationClass extends HeldOut { readonly calibrated: boolean }
const meetsBar = (c: HeldOut): boolean => c.auc != null && c.ci != null && c.auc >= CALIBRATION_BAR.auc && c.ci[0] >= CALIBRATION_BAR.ci_low && c.gold >= CALIBRATION_BAR.gold
const CLASSES = Object.fromEntries(Object.entries(HELDOUT).map(([cls, c]) => [cls, { ...c, calibrated: meetsBar(c) }])) as Record<BehaviorCalibratedClass, BehaviorCalibrationClass>
/** The shipped table: a class below the bar (AUC, lower CI, gold count) is reported `calibrated: false`. */
export const BEHAVIOR_CALIBRATION = { policy: `${BEHAVIOR_POLICY.id}@${BEHAVIOR_POLICY.version}`, heldout_n: 201, bar: CALIBRATION_BAR, ...CLASSES }
const isCalibrated = (cat: string): boolean => (CLASSES as Partial<Record<string, BehaviorCalibrationClass>>)[cat]?.calibrated === true

/** One node: `by_cat` is minutes per category; `z` is the robust z per anomaly metric against the run's other nodes, null below four known values. */
export interface BehaviorNode {
  readonly id: string; readonly label: string; readonly parent: string | null; readonly depth: number; readonly state: string | null; readonly profile: string | null
  readonly model: string | null; readonly harness: string | null; readonly start: number; readonly end: number; readonly hours: number; readonly by_cat: Readonly<Record<string, number>>
  readonly tool_calls: number; readonly failed: number; readonly fail_rate: number | null; readonly calls_per_hour: number; readonly idle_min: number; readonly streaks: number
  readonly llm_turns: number; readonly tokens_in: number | null; readonly tokens_out: number | null; readonly tokens_known_turns: number; readonly last_cat: BehaviorCategory | null
  readonly span_id: string; readonly claims: number; readonly test_edits: number; readonly z: Record<string, number | null>
}
export interface BehaviorWindow { readonly node: string; readonly w: number; readonly from: number; readonly to: number; readonly category: BehaviorCategory; readonly span_ids: string[]; readonly calibrated: boolean }
export interface BehaviorFlag { readonly kind: BehaviorFlagKind; readonly node: string; readonly at: number; readonly span: string; readonly detail: string; readonly edits?: string[] }
export interface BehaviorStreak { readonly node: string; readonly command: string; readonly runs: number; readonly spans: string[]; readonly at: number | null }
export interface BehaviorStall { readonly node: string; readonly at: number; readonly minutes: number; readonly after: string }
export interface BehaviorAnomaly { readonly node: string; readonly metric: string; readonly value: number; readonly z: number; readonly span_id: string }
export interface BehaviorDrift { readonly w: number; readonly from: number; readonly to: number; calls: number; failed: number; active: number }
export interface BehaviorMailEdge { readonly kind: string; readonly from: string; readonly to: string | null; readonly at: number; readonly span: string; readonly ok: boolean; readonly detail: string; read_latency_min: number | null }
export interface BehaviorMailSummary { readonly edges: number; readonly by_kind: Record<string, number>; readonly steers: number; readonly read: number; readonly p50_min: number | null; readonly p90_min: number | null; readonly max_min: number | null }
export interface BehaviorResult {
  readonly policy: { readonly id: string; readonly version: number; readonly window_s: number }
  readonly run: { readonly t0: number; readonly t1: number; readonly n_windows: number; readonly spans: number }
  readonly nodes: BehaviorNode[]; readonly windows: BehaviorWindow[]; readonly flags: BehaviorFlag[]; readonly streaks: BehaviorStreak[]; readonly stalls: BehaviorStall[]
  readonly anomalies: BehaviorAnomaly[]; readonly drift: BehaviorDrift[]; readonly mail: { readonly edges: BehaviorMailEdge[]; readonly summary: BehaviorMailSummary }
  readonly calibration: typeof BEHAVIOR_CALIBRATION
}
/** `now` is epoch seconds: the end of a node still running. */
export interface BehaviorOptions { readonly windowMs?: number; readonly now?: number }

const ts = (iso: string): number => Date.parse(iso) / 1000
const cut = (s: unknown, n: number): string => [...String(s)].slice(0, n).join('')
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
/** toFixed rounds an exact tie away from zero; the reference (Python round) rounds it to even. */
function round(x: number, d: number): number {
  const fixed = x.toFixed(d)
  const rest = x.toFixed(25).split('.')[1]!.slice(d)
  const last = Number(fixed.at(-1))
  return Number(rest[0] === '5' && /^0*$/.test(rest.slice(1)) && last % 2 ? fixed.slice(0, -1) + (last - 1) : fixed)
}
function parseInput(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string') return isObject(v) ? v : {}
  try { const j: unknown = JSON.parse(v); return isObject(j) ? j : {} } catch { return {} }
}

function classifyFileChange(j: Record<string, unknown>, flags: SpanFlag[]): BehaviorSpanClass {
  const changes = (Array.isArray(j.changes) ? j.changes : []) as Array<Record<string, unknown> | null>
  const paths = changes.map((c) => String(c?.path ?? ''))
  if (paths.some((p) => CHECK_PATH_RE.test(p))) flags.push('check_edit')
  if (changes.some((c, i) => c?.kind === 'delete' && (CHECK_PATH_RE.test(paths[i]!) || TEST_PATH_RE.test(paths[i]!)))) flags.push('test_delete')
  if (paths.some((p) => TEST_PATH_RE.test(p))) flags.push('test_edit')
  const category = paths.length && paths.every((p) => PROCESS_FILE_RE.test(p)) ? 'process_files' : 'implementing'
  return { category, flags, detail: cut(paths.map((p) => p.split('/workspace/').pop()).join(', '), 200) }
}

function classifyCommand(cmd: string, flags: SpanFlag[], kind: TraceLiveActionKind): BehaviorSpanClass {
  const verify = VERIFY_RE.test(cmd)
  if (RM_TEST_RE.test(cmd)) flags.push('test_delete')
  const cap = CAP_RE.exec(cmd)
  if (cap && verify && (cap[1] === undefined || Number(cap[1]) < 4096)) flags.push('verification_capped')
  let category: BehaviorCategory = FALLBACK[kind] ?? 'running'
  if (verify) category = 'verifying'
  else if (INTEGRATE_RE.test(cmd)) category = 'integrating'
  else if (EDIT_RE.test(cmd)) {
    category = 'implementing'
    if (CHECK_PATH_RE.test(cmd.split('<<')[0]!)) flags.push('check_edit') // the edited path is the operand before any heredoc body
  } else if (BUILD_RE.test(cmd)) category = 'building'
  else if (READ_RE.test(cmd)) category = 'exploring'
  return { category, flags, detail: cut(cmd, 200) }
}

/** One span's class. `kind` is `pipelines.ts`'s reading of the same call, the fallback for a tool the rules do not name; a whole span computes it. */
export function classifySpan(span: Pick<OtlpSpan, 'name' | 'attributes'>, kind?: TraceLiveActionKind): BehaviorSpanClass {
  const { name, attributes: a } = span
  const flags: SpanFlag[] = []
  if (name === 'message.assistant') {
    const text = String(a['output.value'] || '')
    if (CLAIM_RE.test(text)) flags.push('claim')
    return { category: 'thinking', flags, detail: cut(text, 200) }
  }
  if (name === 'user.prompt') return { category: 'inbound', flags, detail: cut(a['tangle.task.ref'] ?? '', 80) }
  if (name === 'node.settled') return { category: 'settled', flags, detail: str(a['tangle.node.state']) ?? '' }
  if (resolveSpanKind(span) === 'LLM') return { category: 'thinking', flags, detail: str(a['gen_ai.request.model']) ?? '' }
  const live = kind ?? ('status' in span ? classifyLiveActions([span as OtlpSpan])[0]?.kind ?? 'other' : 'other')
  const tool = str(a['gen_ai.tool.name']) ?? str(a['tool.name']) ?? name.replace(/^tool\./u, '')
  const j = parseInput(a['input.value'])
  if (tool === 'file_change') return classifyFileChange(j, flags)
  const edited = FILE_EDIT_TOOLS.has(tool.toLowerCase()) ? str(j.file_path) ?? str(j.filePath) ?? str(j.path) : null
  if (edited) return classifyFileChange({ changes: [{ path: edited }] }, flags)
  const t = tool.replaceAll(COORDINATION_PREFIX, '')
  if (REVIEW_TOOLS.has(t)) return { category: 'reviewing', flags, detail: String(j.workerId ?? '') }
  if (EXPLORE_TOOLS.has(t)) return { category: 'exploring', flags, detail: cut(j.query || j.id || j.path || '', 120) }
  if (COMMUNICATE_TOOLS.has(t)) return { category: 'communicating', flags, detail: cut(j.workerId || (isObject(j.profile) ? j.profile.name : null) || j.reason || '', 120) }
  if (tool === 'bash' || typeof j.command === 'string') return classifyCommand(String(j.command ?? ''), flags, live)
  return { category: FALLBACK[live] ?? 'running', flags, detail: t }
}

const isToolSpan = (s: OtlpSpan): boolean => s.attributes['openinference.span.kind'] === 'TOOL' || s.name.startsWith('tool.')
const failed = (s: OtlpSpan): boolean => String(s.status?.code).endsWith('ERROR') || s.attributes['tangle.tool.status'] === 'failed'
/** A span whose end the reader substituted is still running: its end is now. */
const endOf = (s: OtlpSpan, now: number): number => (String(s.attributes[SUBSTITUTED_FIELDS_ATTR] ?? '').split(',').includes('end_time') ? now : ts(s.end_time))
const byStart = (x: OtlpSpan, y: OtlpSpan): number => ts(x.start_time) - ts(y.start_time)

type RawNode = Pick<BehaviorNode, 'id' | 'label' | 'parent' | 'depth' | 'state' | 'profile' | 'model' | 'start' | 'end' | 'span_id'> & { readonly spans: OtlpSpan[] }
const modelOf = (a: Record<string, unknown>): string | null => str(a['agent.model']) ?? str(a['gen_ai.request.model'])

/** One node per `session.id`, its `session` span (else its earliest root) the node's own; without session ids, one per agent boundary. */
function groupNodes(spans: readonly OtlpSpan[], now: number): RawNode[] {
  const bySession = new Map<string, OtlpSpan[]>()
  for (const s of spans) {
    const sid = s.attributes['session.id']
    if (sid != null) bySession.set(String(sid), [...(bySession.get(String(sid)) ?? []), s])
  }
  if (bySession.size === 0) {
    const byId = new Map(spans.map((s) => [s.span_id, s]))
    return buildSpanRunTree(spans, 'behavior').nodes.map((n) => {
      const root = byId.get(n.spanId)!
      return { id: n.spanId, label: n.label, parent: n.parentNodeId, depth: n.depth, state: n.status, profile: str(root.attributes['agent.profile.name']),
        model: modelOf(root.attributes), start: n.startMs / 1000, end: endOf(root, now), span_id: n.spanId, spans: n.spanIds.map((id) => byId.get(id)!) }
    })
  }
  return [...bySession].map(([id, own]) => {
    const root = own.find((s) => s.name === 'session') ?? [...own].sort(byStart).find((s) => s.parent_span_id === null) ?? [...own].sort(byStart)[0]!
    const a = root.attributes
    return { id, label: str(a['tangle.node.label']) ?? str(a['gen_ai.agent.name']) ?? id, parent: str(a['tangle.harness_session.parent']), depth: num(a['tangle.node.depth']) ?? 0,
      state: str(a['tangle.node.state']), profile: str(a['agent.profile.name']), model: modelOf(a), start: ts(root.start_time), end: endOf(root, now), span_id: root.span_id, spans: own }
  })
}

type Event = BehaviorSpanClass & { readonly t: number; readonly e: number; readonly cat: BehaviorCategory; readonly name: string; readonly span: string; readonly ok: boolean; readonly tokens_in: number | null; readonly tokens_out: number | null; readonly output: unknown }

function nodeEvents(n: RawNode): Event[] {
  const kinds = new Map(classifyLiveActions(n.spans).map((act) => [act.spanId, act.kind]))
  return n.spans.filter((s) => s.name !== 'session').map((s): Event => {
    const cls = classifySpan(s, kinds.get(s.span_id) ?? 'other')
    return { ...cls, cat: cls.category, t: ts(s.start_time), e: ts(s.end_time || s.start_time), name: s.name, span: s.span_id, ok: !failed(s),
      tokens_in: num(s.attributes['gen_ai.usage.input_tokens']), tokens_out: num(s.attributes['gen_ai.usage.output_tokens']), output: s.attributes['output.value'] }
  }).sort((x, y) => x.t - y.t)
}

interface Segment { readonly a: number; readonly b: number; readonly cat: BehaviorCategory; readonly span: string }

/** An event explains the time until the next event (capped); a longer gap is idle, and a stall. */
function segments(ev: readonly Event[], n: RawNode, stalls: BehaviorStall[]): Segment[] {
  const segs: Segment[] = []
  ev.forEach((e, i) => {
    const nxt = i + 1 < ev.length ? ev[i + 1]!.t : n.end
    const end = e.cat !== 'thinking' ? Math.min(nxt, e.t + SEG_CAP_S) : Math.min(Math.max(e.e, e.t + 1), nxt)
    if (end > e.t) segs.push({ a: e.t, b: end, cat: e.cat, span: e.span })
    if (nxt - end < IDLE_S) return
    segs.push({ a: end, b: nxt, cat: 'idle', span: e.span })
    stalls.push({ node: n.id, at: end, minutes: round((nxt - end) / 60, 1), after: e.span })
  })
  return segs
}

/** One command failing {@link STREAK_RUNS} times in a row, ended only by its own success. */
function failingStreaks(ev: readonly Event[], nid: string): BehaviorStreak[] {
  const streaks: BehaviorStreak[] = []
  const open = new Map<string, { n: number; spans: string[]; at: number | null }>()
  const close = (command: string): void => {
    const st = open.get(command)
    if (st && st.n >= STREAK_RUNS) streaks.push({ node: nid, command, runs: st.n, spans: st.spans, at: st.at })
    open.set(command, { n: 0, spans: [], at: null })
  }
  for (const e of ev) {
    if (e.name !== 'tool.bash') continue
    if (e.ok) close(e.detail)
    else {
      const st = open.get(e.detail) ?? { n: 0, spans: [], at: null }
      open.set(e.detail, { n: st.n + 1, spans: [...st.spans, e.span], at: e.t })
    }
  }
  for (const command of [...open.keys()]) close(command)
  return streaks
}

function gamingFlags(ev: readonly Event[], nid: string): BehaviorFlag[] {
  const out: BehaviorFlag[] = []
  const [lastFail, testEdits, codeEdits] = [new Map<string, string>(), new Map<string, string[]>(), new Map<string, string[]>()]
  const flag = (kind: BehaviorFlagKind, e: Event, extra: { edits?: string[] } = {}): void => { out.push({ kind, node: nid, at: e.t, span: e.span, detail: cut(e.detail, 160), ...extra }) }
  // test edited to pass: a verify command fails, a test file changes, the same command passes with no non-test edit between
  for (const e of ev) {
    if (e.name === 'tool.file_change') {
      const bucket = e.flags.includes('test_edit') ? testEdits : codeEdits
      for (const k of lastFail.keys()) (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(e.span)
    } else if (e.cat === 'verifying' && !e.ok) { lastFail.set(e.detail, e.span); testEdits.set(e.detail, []); codeEdits.set(e.detail, []) }
    else if (e.cat === 'verifying' && lastFail.has(e.detail)) {
      if (testEdits.get(e.detail)?.length && !codeEdits.get(e.detail)?.length) flag('test_edited_to_pass', e, { edits: testEdits.get(e.detail)!.slice(0, 5) })
      lastFail.delete(e.detail)
    }
  }
  // a narration with a number and no verifying command or reading in the prior 15 min
  ev.forEach((e, i) => {
    if (e.flags.includes('claim')) {
      let recent = false
      for (let k = i - 1; k >= 0 && ev[k]!.t >= e.t - CLAIM_LOOKBACK_S && !recent; k--) recent = ev[k]!.cat === 'verifying' || ev[k]!.cat === 'reviewing' || ev[k]!.name.endsWith('knowledge_read')
      if (!recent) flag('claim_without_reading', e)
    }
    for (const f of e.flags) if (f !== 'claim' && f !== 'test_edit') flag(f, e)
  })
  return out
}

/** The calibrated precedence rule: a code edit makes the window implementing, else a verify command makes it verifying, else the category with the most seconds; a failing streak makes its window looping. */
function windowCategories(ev: readonly Event[], segs: readonly Segment[], streaks: readonly BehaviorStreak[], t0: number, W: number, nwin: number): { cats: Array<BehaviorCategory | null>; spans: Array<Set<string>> } {
  const sec = Array.from({ length: nwin }, () => new Map<BehaviorCategory, number>())
  const seen = Array.from({ length: nwin }, () => new Set<BehaviorCategory>())
  const spans = Array.from({ length: nwin }, () => new Set<string>())
  for (const s of segs) {
    for (let a = s.a, w = Math.floor((a - t0) / W); a < s.b && w < nwin; w += 1) {
      const wb = t0 + (w + 1) * W
      if (w >= 0) { sec[w]!.set(s.cat, (sec[w]!.get(s.cat) || 0) + Math.min(s.b, wb) - a); spans[w]!.add(s.span) }
      a = Math.min(s.b, wb)
    }
  }
  for (const e of ev) {
    const w = Math.floor((e.t - t0) / W)
    if (w >= 0 && w < nwin) { seen[w]!.add(e.cat); spans[w]!.add(e.span) }
  }
  const cats = new Array<BehaviorCategory | null>(nwin).fill(null)
  for (let w = 0; w < nwin; w++) {
    if (seen[w]!.has('implementing') || seen[w]!.has('integrating')) cats[w] = 'implementing'
    else if (seen[w]!.has('verifying')) cats[w] = 'verifying'
    else if (sec[w]!.size) cats[w] = [...sec[w]!].reduce((best, kv) => (kv[1] > best[1] ? kv : best))[0]
  }
  for (const s of streaks) if (s.at) cats[Math.min(nwin - 1, Math.floor((s.at - t0) / W))] = 'looping'
  return { cats, spans }
}

type Spawn = { harness: string | null; model: string | null }
/** Harness and model per child, from the parents' spawn_worker calls. */
function spawnedHarness(nodes: readonly RawNode[]): Map<string, Spawn> {
  const byWorker = new Map<string, Spawn>()
  for (const s of nodes.flatMap((n) => n.spans)) {
    const m = s.name.endsWith('spawn_worker') ? WORKER_ID_RE.exec(String(s.attributes['output.value'] ?? '')) : null
    if (!m) continue
    const p = parseInput(s.attributes['input.value']).profile
    byWorker.set(m[1]!, { harness: isObject(p) ? str(p.harness) : null, model: isObject(p) && isObject(p.model) ? str(p.model.default) : null })
  }
  return byWorker
}

function mailEdges(ev: readonly Event[], n: RawNode): BehaviorMailEdge[] {
  const edges: BehaviorMailEdge[] = []
  for (const e of ev) {
    const kind = e.name.split('__').pop()!
    if (!MAIL_TOOLS.has(kind)) continue
    const to = kind === 'spawn_worker' ? WORKER_ID_RE.exec(String(e.output ?? ''))?.[1] ?? null : kind === 'report_blocked' ? n.parent : e.detail
    edges.push({ kind, from: n.id, to, at: e.t, span: e.span, ok: e.ok, detail: cut(e.detail, 120), read_latency_min: null })
  }
  return edges
}

/** Read latency: a steer at t to W is read at W's next model turn starting at or after t. */
function readLatency(edges: BehaviorMailEdge[], nodes: readonly RawNode[]): void {
  const turnStarts = new Map(nodes.map((n) => [n.id, n.spans.filter((s) => s.name === 'llm.turn').map((s) => ts(s.start_time)).sort((a, b) => a - b)]))
  for (const e of edges) {
    const next = e.kind === 'steer_agent' && e.to !== null ? turnStarts.get(e.to)?.find((t) => t >= e.at) : undefined
    if (next !== undefined) e.read_latency_min = round((next - e.at) / 60, 1)
  }
}

function mailSummary(edges: readonly BehaviorMailEdge[]): BehaviorMailSummary {
  const byKind: Record<string, number> = {}
  for (const e of edges) byKind[e.kind] = (byKind[e.kind] || 0) + 1
  const lat = edges.map((e) => e.read_latency_min).filter((v): v is number => v != null).sort((a, b) => a - b)
  const at = (q: number): number | null => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))]! : null)
  return { edges: edges.length, by_kind: byKind, steers: edges.filter((e) => e.kind === 'steer_agent').length, read: lat.length, p50_min: at(0.5), p90_min: at(0.9), max_min: at(1) }
}

const median = (xs: readonly number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const pstdev = (xs: readonly number[]): number => { const mean = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length) }
/** z against the run's own node distribution: (v - median) / (1.4826 * MAD); null below 4 known values. */
function robustZ(vals: ReadonlyArray<number | null>): Array<number | null> {
  const xs = vals.filter((v): v is number => v != null)
  if (xs.length < 4) return vals.map(() => null)
  const med = median(xs)
  let mad = median(xs.map((x) => Math.abs(x - med)))
  if (!mad) { const sd = pstdev(xs); mad = sd ? sd / 1.4826 : 1 }
  return vals.map((v) => (v == null ? null : round((v - med) / (1.4826 * mad), 2)))
}

function anomalies(outNodes: readonly BehaviorNode[]): BehaviorAnomaly[] {
  const found: BehaviorAnomaly[] = []
  for (const metric of ANOMALY_METRICS) {
    robustZ(outNodes.map((nd) => nd[metric])).forEach((z, i) => {
      const nd = outNodes[i]!; nd.z[metric] = z
      if (z != null && Math.abs(z) >= Z_BAR) found.push({ node: nd.id, metric, value: nd[metric]!, z, span_id: nd.span_id })
    })
  }
  return found
}

function drift(nodes: readonly RawNode[], cats: ReadonlyMap<string, ReadonlyArray<BehaviorCategory | null>>, t0: number, W: number, nwin: number): BehaviorDrift[] {
  const rows: BehaviorDrift[] = Array.from({ length: nwin }, (_, w) => ({ w, from: t0 + w * W, to: t0 + (w + 1) * W, calls: 0, failed: 0, active: 0 }))
  for (const s of nodes.flatMap((n) => n.spans)) {
    const w = Math.floor((ts(s.start_time) - t0) / W)
    if (!s.name.startsWith('tool.') || w < 0 || w >= nwin) continue
    rows[w]!.calls += 1; rows[w]!.failed += failed(s) ? 1 : 0
  }
  for (const c of cats.values()) c.forEach((cat, w) => { if (cat != null && cat !== 'idle') rows[w]!.active += 1 })
  return rows
}

interface Accumulator { windows: BehaviorWindow[]; flags: BehaviorFlag[]; streaks: BehaviorStreak[]; stalls: BehaviorStall[]; edges: BehaviorMailEdge[]; cats: Map<string, Array<BehaviorCategory | null>> }

function analyzeNode(n: RawNode, t0: number, W: number, nwin: number, spawned: ReadonlyMap<string, Spawn>, acc: Accumulator): BehaviorNode {
  const ev = nodeEvents(n)
  const segs = segments(ev, n, acc.stalls)
  const streaks = failingStreaks(ev, n.id)
  const { cats, spans } = windowCategories(ev, segs, streaks, t0, W, nwin)
  acc.streaks.push(...streaks); acc.flags.push(...gamingFlags(ev, n.id)); acc.edges.push(...mailEdges(ev, n)); acc.cats.set(n.id, cats)
  cats.forEach((category, w) => {
    if (category != null) acc.windows.push({ node: n.id, w, from: t0 + w * W, to: t0 + (w + 1) * W, category, span_ids: [...spans[w]!], calibrated: isCalibrated(category) })
  })
  const byCat: Record<string, number> = {}
  for (const s of segs) byCat[s.cat] = (byCat[s.cat] || 0) + (s.b - s.a)
  const calls = ev.filter((e) => e.name.startsWith('tool.'))
  const failedCalls = calls.filter((e) => !e.ok)
  const hours = Math.max((n.end - n.start) / 3600, 1 / 60)
  const known = ev.filter((e) => e.tokens_in != null)
  const spawn = spawned.get(n.id)
  const lastActive = [...segs].reverse().find((s) => s.cat !== 'idle')
  return {
    id: n.id, label: n.label, parent: n.parent, depth: n.depth, state: n.state, profile: n.profile,
    model: n.model ?? spawn?.model ?? null, harness: spawn?.harness ?? (String(n.model ?? '').startsWith('gpt') ? 'codex' : null),
    start: n.start, end: n.end, hours: round(hours, 2), by_cat: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, round(v / 60, 1)])),
    tool_calls: calls.length, failed: failedCalls.length, fail_rate: calls.length ? round(failedCalls.length / calls.length, 3) : null,
    calls_per_hour: round(calls.length / hours, 1), idle_min: round((byCat.idle || 0) / 60, 1), streaks: streaks.length, llm_turns: ev.filter((e) => e.name === 'llm.turn').length,
    tokens_in: known.length ? known.reduce((a, e) => a + e.tokens_in!, 0) : null, tokens_out: known.length ? ev.reduce((a, e) => a + (e.tokens_out || 0), 0) : null,
    tokens_known_turns: known.length, last_cat: lastActive ? lastActive.cat : null, span_id: n.span_id,
    claims: ev.filter((e) => e.flags.includes('claim')).length, test_edits: ev.filter((e) => e.flags.includes('test_edit')).length, z: {},
  }
}

/** The behavior of every node in `spans`. Throws (`code: no-outcome`) when no span is a tool call: categories need acts. */
export function behaviorFromSpans(spans: readonly OtlpSpan[], { windowMs = 300_000, now = Date.now() / 1000 }: BehaviorOptions = {}): BehaviorResult {
  const nodes = spans.some(isToolSpan) ? groupNodes(spans, now) : []
  if (nodes.length === 0) throw Object.assign(new Error('no tool spans; categories unavailable'), { code: 'no-outcome' })
  const W = windowMs / 1000
  const [t0, t1] = [Math.min(...nodes.map((n) => n.start)), Math.max(...nodes.map((n) => n.end))]
  const nwin = Math.floor((t1 - t0) / W) + 1
  const acc: Accumulator = { windows: [], flags: [], streaks: [], stalls: [], edges: [], cats: new Map() }
  const spawned = spawnedHarness(nodes)
  const outNodes = nodes.map((n) => analyzeNode(n, t0, W, nwin, spawned, acc))
  readLatency(acc.edges, nodes)
  return {
    policy: { ...BEHAVIOR_POLICY, window_s: W }, run: { t0, t1, n_windows: nwin, spans: spans.length }, nodes: outNodes, windows: acc.windows,
    flags: acc.flags, streaks: acc.streaks, stalls: acc.stalls, anomalies: anomalies(outNodes), drift: drift(nodes, acc.cats, t0, W, nwin),
    mail: { edges: acc.edges, summary: mailSummary(acc.edges) }, calibration: BEHAVIOR_CALIBRATION,
  }
}

const iso = (t: number): string => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const hhmm = (t: number): string => iso(t).slice(11, 16)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 80)

/** One line per node with its category minutes, then flags, anomalies, streaks, the mail summary and the calibration table. */
export function renderBehaviorText(r: BehaviorResult): string {
  const lines = [`behavior ${r.calibration.policy}, window ${r.policy.window_s / 60}m, ${r.nodes.length} nodes, ${r.run.n_windows} windows, ${iso(r.run.t0)} to ${iso(r.run.t1)}`]
  for (const n of r.nodes) {
    const cats = Object.entries(n.by_cat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}m`).join(', ')
    lines.push(`${n.label} (${n.id}) ${n.state ?? 'running'} ${n.model ?? '?'}: ${cats || 'no activity'} | ${n.tool_calls} calls, ${n.failed} failed, ${n.streaks} streaks`)
  }
  lines.push(`flags (uncalibrated, record only): ${r.flags.length}`, ...r.flags.map((f) => `  ${f.kind} ${f.node} ${hhmm(f.at)} ${f.span} ${oneLine(f.detail)}`))
  lines.push(`anomalies (|z| >= ${Z_BAR}): ${r.anomalies.length}`, ...r.anomalies.map((a) => `  ${a.node} ${a.metric}=${a.value} z=${a.z}`))
  for (const s of r.streaks) lines.push(`streak ${s.node} ${s.runs}x failed at ${s.at === null ? '?' : hhmm(s.at)}: ${oneLine(s.command)}`)
  const m = r.mail.summary
  lines.push(`mail: ${m.edges} edges (${Object.entries(m.by_kind).map(([k, v]) => `${k} ${v}`).join(', ')}); steers ${m.steers}, read ${m.read}, read latency p50 ${m.p50_min}m p90 ${m.p90_min}m max ${m.max_min}m`)
  const table = (Object.keys(HELDOUT) as BehaviorCalibratedClass[]).map((c) => (r.calibration[c].calibrated ? `${c} auc ${round(r.calibration[c].auc!, 2)} (n=${r.calibration[c].gold})` : `${c} uncalibrated (n=${r.calibration[c].gold})`))
  lines.push(`calibration ${r.calibration.policy}: ${table.join('; ')}`)
  return lines.join('\n')
}
