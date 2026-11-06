/**
 * `traces behavior`: what each agent did in each five-minute window of a run, from the contract spans any
 * producer emits. One node per `session.id` (the M9 producer's shape); a producer with one trace for the whole
 * run is split at its agent boundaries (`buildSpanRunTree`). A port of dl-ui's analytics.py, policy
 * `dl-ui-behavior-windows@1`, calibrated on 508 labeled windows (2026-11-02): its PARITY.md proves the rules and
 * the output shape, so a rule changes only with a new policy version. Any producer's model, edit and tool spans read
 * as `llm.turn`, `file_change` and the rules' tool names do; a call left `running` falls back to `pipelines.ts`'s
 * kinds. Gaming flags and uncalibrated classes are record-only, never above info. Times are epoch seconds.
 */
import { resolveSpanKind } from '@tangle-network/agent-trace-contract'
import { isInheritedSpan, SUBAGENT_SPAWN_ATTR, SUBAGENT_SPAWN_TASK_ATTR } from './adapters/provenance.js'
import { sessionIdFromAttributes } from './attributes.js'
import { dominantModel } from './execution.js'
import type { OtlpSpan } from './otlp.js'
import { SUBSTITUTED_FIELDS_ATTR } from './otlp-input.js'
import { classifyLiveActions, type TraceLiveActionKind } from './pipelines.js'
import { resolveAdapter } from './registry.js'
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
/** A tool as the rules name it, whatever the harness's case, separators or MCP server: `Bash` is `bash`, `WebFetch` and `web_fetch` are `webfetch`. */
const toolKey = (tool: string): string => tool.split('__').pop()!.replace(/[-_]/gu, '').toLowerCase()
const toolOf = ({ name, attributes: a }: Pick<OtlpSpan, 'name' | 'attributes'>): string => str(a['gen_ai.tool.name']) ?? str(a['tool.name']) ?? name.replace(/^tool\./u, '')
const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'multiedit'])
const REVIEW_TOOLS = new Set(['observe_agent', 'read_journal'].map(toolKey))
const EXPLORE_TOOLS = new Set(['knowledge_read', 'knowledge_search', 'knowledge_resolve', 'websearch', 'webfetch', 'read', 'glob', 'grep'].map(toolKey))
const COMMUNICATE_TOOLS = new Set(['steer_agent', 'spawn_worker', 'report_blocked', 'knowledge_record', 'send_message', 'reply'].map(toolKey))
/** A shell call that runs `fleet send [flags] <target>`: a message to another lane. */
const FLEET_SEND_RE = /\bfleet send(?:\s+--?(?:id|reason)[= ]\S+|\s+--?[\w-]+)*\s+([\w.@:/-]+)/u
const SHELL_TOOLS = new Set(['bash', 'execcommand', 'exec', 'shell'])
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
  const [k, j] = [toolKey(toolOf(span)), parseInput(a['input.value'])]
  if (k === 'filechange') return classifyFileChange(j, flags)
  const edited = FILE_EDIT_TOOLS.has(k) ? str(j.file_path) ?? str(j.filePath) ?? str(j.path) : null
  if (edited) return classifyFileChange({ changes: [{ path: edited }] }, flags)
  if (REVIEW_TOOLS.has(k)) return { category: 'reviewing', flags, detail: String(j.workerId ?? '') }
  if (EXPLORE_TOOLS.has(k)) return { category: 'exploring', flags, detail: cut(j.query || j.id || j.path || '', 120) }
  if (COMMUNICATE_TOOLS.has(k)) return { category: 'communicating', flags, detail: cut(j.workerId || (isObject(j.profile) ? j.profile.name : null) || j.reason || '', 120) }
  if (k === 'bash' || typeof j.command === 'string') return classifyCommand(String(j.command ?? ''), flags, live)
  return { category: FALLBACK[live] ?? 'running', flags, detail: toolOf(span).replaceAll(COORDINATION_PREFIX, '') }
}

const isToolSpan = (s: OtlpSpan): boolean => s.attributes['openinference.span.kind'] === 'TOOL' || s.name.startsWith('tool.')
const failed = (s: OtlpSpan): boolean => String(s.status?.code).endsWith('ERROR') || s.attributes['tangle.tool.status'] === 'failed'
/** A span whose end the reader substituted is still running: its end is now. */
const endOf = (s: OtlpSpan, now: number): number => (String(s.attributes[SUBSTITUTED_FIELDS_ATTR] ?? '').split(',').includes('end_time') ? now : ts(s.end_time))
const byStart = (x: OtlpSpan, y: OtlpSpan): number => ts(x.start_time) - ts(y.start_time)

type RawNode = Pick<BehaviorNode, 'id' | 'label' | 'parent' | 'depth' | 'state' | 'profile' | 'model' | 'harness' | 'start' | 'end' | 'span_id'> & {
  readonly spans: OtlpSpan[]
  /** The root of the tree this node was read in; the harness session that root opens and the one that spawned it; the Codex child thread a lifecycle span stands for. */
  readonly top: string; readonly session: string | null; readonly parentSession: string | null; readonly thread: string | null
}
/** The model and harness that acted: the root's `agent.*` identity, else the model its own calls name (facts' `tokens.byModel`) and the harness whose reader wrote it. */
const identity = (a: Record<string, unknown>, own: readonly OtlpSpan[]): Pick<RawNode, 'model' | 'harness'> => ({
  model: str(a['agent.model']) ?? str(a['gen_ai.request.model']) ?? dominantModel(own),
  harness: str(a['agent.harness']) ?? str(a['tangle.harness']) ?? resolveAdapter(String(a['service.name'] ?? ''))?.harness ?? null,
})

/** One node per `session.id`, its `session` span (else its earliest root) the node's own; without session ids, one per agent boundary. */
function groupNodes(spans: readonly OtlpSpan[], now: number): RawNode[] {
  const bySession = new Map<string, OtlpSpan[]>()
  for (const s of spans) {
    const sid = s.attributes['session.id']
    if (sid != null) (bySession.get(String(sid)) ?? bySession.set(String(sid), []).get(String(sid))!).push(s)
  }
  if (bySession.size === 0) {
    const byId = new Map(spans.map((s) => [s.span_id, s]))
    const tops = new Map<string, string>()
    return buildSpanRunTree(spans, 'behavior').nodes.map((n) => {
      const root = byId.get(n.spanId)!
      const own = n.spanIds.map((id) => byId.get(id)!)
      const top = n.parentNodeId === null ? n.spanId : tops.get(n.parentNodeId) ?? n.spanId
      tops.set(n.spanId, top)
      return { id: n.spanId, label: n.label, parent: n.parentNodeId, depth: n.depth, state: n.status, profile: str(root.attributes['agent.profile.name']), ...identity(root.attributes, own),
        start: n.startMs / 1000, end: endOf(root, now), span_id: n.spanId, spans: own, top, session: top === n.spanId ? sessionIdFromAttributes(root.attributes) ?? null : null,
        parentSession: str(root.attributes['traces.parent_session_id']), thread: str(root.attributes['traces.codex.subagent_thread_id']) }
    })
  }
  return [...bySession].map(([id, own]) => {
    const root = own.find((s) => s.name === 'session') ?? [...own].sort(byStart).find((s) => s.parent_span_id === null) ?? [...own].sort(byStart)[0]!
    const a = root.attributes
    return { id, label: str(a['tangle.node.label']) ?? str(a['gen_ai.agent.name']) ?? id, parent: str(a['tangle.harness_session.parent']), depth: num(a['tangle.node.depth']) ?? 0,
      state: str(a['tangle.node.state']), profile: str(a['agent.profile.name']), ...identity(a, own), start: ts(root.start_time), end: endOf(root, now), span_id: root.span_id, spans: own,
      top: id, session: null, parentSession: null, thread: null }
  })
}

type Mail = { readonly kind: string; readonly to: string | null }
type Event = BehaviorSpanClass & { readonly t: number; readonly e: number; readonly cat: BehaviorCategory; readonly name: string; readonly tool: string; readonly span: string; readonly ok: boolean; readonly llm: boolean; readonly tokens_in: number | null; readonly tokens_out: number | null; readonly mail: Mail | null }

/** Whom a call messaged or started: a coordination call, a harness's own spawn or message (Codex `spawn_agent`, `send_message`, `followup_task`; a Claude Code subagent), or a `fleet send`. */
function mailOf(span: OtlpSpan, cls: BehaviorSpanClass, parent: string | null): Mail | null {
  const a = span.attributes
  const kind = toolOf(span).split('__').pop()!
  const key = toolKey(kind)
  if (key === 'spawnworker') return { kind, to: WORKER_ID_RE.exec(String(a['output.value'] ?? ''))?.[1] ?? null }
  if (key === 'reportblocked') return { kind, to: parent }
  if (key === 'steeragent' || key === 'observeagent') return { kind, to: cls.detail }
  if (key === 'spawnagent' || key === 'sendmessage' || key === 'followuptask') { const j = parseInput(a['input.value']); return { kind, to: str(j.target) ?? str(j.task_name) ?? str(j.to) } }
  if (a[SUBAGENT_SPAWN_ATTR] === true) return { kind: 'spawn', to: str(a[SUBAGENT_SPAWN_TASK_ATTR]) }
  const sent = SHELL_TOOLS.has(key) ? FLEET_SEND_RE.exec(String(a['input.value'] ?? '')) : null
  return sent ? { kind: 'fleet_send', to: sent[1]! } : null
}

/** The node's own events: a span a fork or compaction carried in (`traces.session.inherited`) is the parent's work, as in facts. */
function nodeEvents(n: RawNode): Event[] {
  const kinds = new Map(classifyLiveActions(n.spans).map((act) => [act.spanId, act.kind]))
  return n.spans.filter((s) => s.name !== 'session' && !isInheritedSpan(s.attributes)).map((s): Event => {
    const cls = classifySpan(s, kinds.get(s.span_id) ?? 'other')
    return { ...cls, cat: cls.category, t: ts(s.start_time), e: ts(s.end_time || s.start_time), name: s.name, tool: toolKey(toolOf(s)), span: s.span_id, ok: !failed(s), llm: resolveSpanKind(s) === 'LLM',
      tokens_in: num(s.attributes['gen_ai.usage.input_tokens']), tokens_out: num(s.attributes['gen_ai.usage.output_tokens']), mail: mailOf(s, cls, n.parent) }
  }).sort((x, y) => x.t - y.t)
}

interface Segment { readonly a: number; readonly b: number; readonly cat: BehaviorCategory; readonly span: string }

/** An event explains the time until the next event (capped); a longer gap is idle, and a stall. */
function segments(ev: readonly Event[], n: Pick<RawNode, 'id' | 'end'>, stalls: BehaviorStall[]): Segment[] {
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
    if (e.tool !== 'bash') continue
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
    if (e.tool === 'filechange' || FILE_EDIT_TOOLS.has(e.tool)) {
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
      for (let k = i - 1; k >= 0 && ev[k]!.t >= e.t - CLAIM_LOOKBACK_S && !recent; k--) recent = ev[k]!.cat === 'verifying' || ev[k]!.cat === 'reviewing' || ev[k]!.tool === 'knowledgeread'
      if (!recent) flag('claim_without_reading', e)
    }
    for (const f of e.flags) if (f !== 'claim' && f !== 'test_edit') flag(f, e)
  })
  return out
}

/** The calibrated precedence rule: a code edit makes the window implementing, else a verify command makes it verifying, else the category with the most seconds; a failing streak makes its window looping. */
function windowCategories(ev: readonly Mark[], segs: readonly Segment[], streaks: readonly BehaviorStreak[], t0: number, W: number, nwin: number): { cats: Array<BehaviorCategory | null>; spans: Array<Set<string>> } {
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
/** Harness and model per worker a node's spawn_worker calls started. */
function spawnsOf(spans: readonly OtlpSpan[]): Array<[string, Spawn]> {
  return spans.flatMap((s): Array<[string, Spawn]> => {
    const m = s.name.endsWith('spawn_worker') ? WORKER_ID_RE.exec(String(s.attributes['output.value'] ?? '')) : null
    const p = m ? parseInput(s.attributes['input.value']).profile : null
    return m ? [[m[1]!, { harness: isObject(p) ? str(p.harness) : null, model: isObject(p) && isObject(p.model) ? str(p.model.default) : null }]] : []
  })
}

function mailEdges(ev: readonly Event[], n: Pick<RawNode, 'id'>): BehaviorMailEdge[] {
  return ev.flatMap((e) => (e.mail ? [{ kind: e.mail.kind, from: n.id, to: e.mail.to, at: e.t, span: e.span, ok: e.ok, detail: cut(e.detail, 120), read_latency_min: null }] : []))
}

/** Read latency: a steer at t to W is read at W's next model turn starting at or after t. */
function readLatency(edges: BehaviorMailEdge[], turnStarts: ReadonlyMap<string, readonly number[]>): void {
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

function drift(read: readonly ReadNode[], cats: ReadonlyMap<string, ReadonlyArray<BehaviorCategory | null>>, t0: number, W: number, nwin: number): BehaviorDrift[] {
  const rows: BehaviorDrift[] = Array.from({ length: nwin }, (_, w) => ({ w, from: t0 + w * W, to: t0 + (w + 1) * W, calls: 0, failed: 0, active: 0 }))
  for (const m of read.flatMap((r) => r.marks)) {
    const w = Math.floor((m.t - t0) / W)
    if (m.ok === undefined || w < 0 || w >= nwin) continue
    rows[w]!.calls += 1; rows[w]!.failed += m.ok ? 0 : 1
  }
  for (const c of cats.values()) c.forEach((cat, w) => { if (cat != null && cat !== 'idle') rows[w]!.active += 1 })
  return rows
}

/** What the run-wide pass needs of an event once its node is read: when, its category, and a tool call's outcome (`ok`). */
interface Mark { readonly t: number; readonly cat: BehaviorCategory; readonly span: string; readonly ok?: boolean }
/** A node once its spans are read: its row as read alone, and what the run's windows, links and read latency need. */
interface ReadNode { readonly node: BehaviorNode; readonly n: Omit<RawNode, 'spans'>; readonly marks: Mark[]; readonly segs: Segment[]; readonly streaks: BehaviorStreak[]; readonly turns: number[] }
interface Accumulator { flags: BehaviorFlag[]; streaks: BehaviorStreak[]; stalls: BehaviorStall[]; edges: BehaviorMailEdge[]; spawned: Map<string, Spawn> }

function readNode({ spans, ...n }: RawNode, acc: Accumulator): ReadNode {
  const ev = nodeEvents({ ...n, spans })
  const segs = segments(ev, n, acc.stalls)
  const streaks = failingStreaks(ev, n.id)
  acc.streaks.push(...streaks); acc.flags.push(...gamingFlags(ev, n.id)); acc.edges.push(...mailEdges(ev, n))
  for (const [worker, spawn] of spawnsOf(spans)) acc.spawned.set(worker, spawn)
  const byCat: Record<string, number> = {}
  for (const s of segs) byCat[s.cat] = (byCat[s.cat] || 0) + (s.b - s.a)
  const calls = ev.filter((e) => e.name.startsWith('tool.'))
  const failedCalls = calls.filter((e) => !e.ok)
  const hours = Math.max((n.end - n.start) / 3600, 1 / 60)
  const known = ev.filter((e) => e.tokens_in != null)
  const lastActive = [...segs].reverse().find((s) => s.cat !== 'idle')
  const node: BehaviorNode = {
    id: n.id, label: n.label, parent: n.parent, depth: n.depth, state: n.state, profile: n.profile, model: n.model, harness: n.harness,
    start: n.start, end: n.end, hours: round(hours, 2), by_cat: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, round(v / 60, 1)])),
    tool_calls: calls.length, failed: failedCalls.length, fail_rate: calls.length ? round(failedCalls.length / calls.length, 3) : null,
    calls_per_hour: round(calls.length / hours, 1), idle_min: round((byCat.idle || 0) / 60, 1), streaks: streaks.length, llm_turns: ev.filter((e) => e.llm).length,
    tokens_in: known.length ? known.reduce((a, e) => a + e.tokens_in!, 0) : null, tokens_out: known.length ? ev.reduce((a, e) => a + (e.tokens_out || 0), 0) : null,
    tokens_known_turns: known.length, last_cat: lastActive ? lastActive.cat : null, span_id: n.span_id,
    claims: ev.filter((e) => e.flags.includes('claim')).length, test_edits: ev.filter((e) => e.flags.includes('test_edit')).length, z: {},
  }
  return { node, n, segs, streaks, marks: ev.map(({ t, cat, span, name, ok }) => (name.startsWith('tool.') ? { t, cat, span, ok } : { t, cat, span })), turns: ev.filter((e) => e.llm).map((e) => e.t) }
}

/** The run's nodes, a session read on its own hung under the session that spawned it (`traces.parent_session_id`); then the windows on the run's clock. */
function runResult(read: readonly ReadNode[], acc: Accumulator, W: number, spanCount: number): BehaviorResult {
  const bySession = new Map(read.flatMap((r) => (r.n.session ? [[r.n.session, r.node.id] as const] : [])))
  const byId = new Map(read.map((r) => [r.node.id, r]))
  const links = new Map<string, string>()
  for (const { n } of read) {
    const parent = n.session === null || n.parentSession === null ? undefined : bySession.get(n.parentSession)
    if (parent !== undefined) links.set(n.id, parent)
  }
  const depthOf = (r: ReadNode, hops = 0): number => {
    const up = hops < read.length ? byId.get(links.get(r.n.top) ?? '') : undefined
    return r.n.depth + (up ? depthOf(up, hops + 1) + 1 : 0)
  }
  const outNodes = read.map(({ node, n }) => {
    const spawn = acc.spawned.get(node.id)
    const model = node.model ?? spawn?.model ?? null
    return { ...node, parent: links.get(node.id) ?? node.parent, depth: depthOf(byId.get(node.id)!), model, harness: node.harness ?? spawn?.harness ?? (String(model ?? '').startsWith('gpt') ? 'codex' : null) }
  })
  const [t0, t1] = [Math.min(...outNodes.map((n) => n.start)), Math.max(...outNodes.map((n) => n.end))]
  const nwin = Math.floor((t1 - t0) / W) + 1
  const windows: BehaviorWindow[] = []
  const cats = new Map<string, Array<BehaviorCategory | null>>()
  for (const r of read) {
    const { cats: nodeCats, spans } = windowCategories(r.marks, r.segs, r.streaks, t0, W, nwin)
    cats.set(r.node.id, nodeCats)
    nodeCats.forEach((category, w) => {
      if (category != null) windows.push({ node: r.node.id, w, from: t0 + w * W, to: t0 + (w + 1) * W, category, span_ids: [...spans[w]!], calibrated: isCalibrated(category) })
    })
  }
  readLatency(acc.edges, new Map(read.map((r) => [r.node.id, r.turns])))
  return {
    policy: { ...BEHAVIOR_POLICY, window_s: W }, run: { t0, t1, n_windows: nwin, spans: spanCount }, nodes: outNodes, windows,
    flags: acc.flags, streaks: acc.streaks, stalls: acc.stalls, anomalies: anomalies(outNodes), drift: drift(read, cats, t0, W, nwin),
    mail: { edges: acc.edges, summary: mailSummary(acc.edges) }, calibration: BEHAVIOR_CALIBRATION,
  }
}

/** Behavior over spans handed in a session at a time: each `add` reads its nodes and keeps only what the run-wide pass needs, so a week of sessions is never held at once. */
export function behaviorReader({ windowMs = 300_000, now = Date.now() / 1000 }: BehaviorOptions = {}): { add(spans: readonly OtlpSpan[]): void; result(): BehaviorResult } {
  const acc: Accumulator = { flags: [], streaks: [], stalls: [], edges: [], spawned: new Map() }
  const read: ReadNode[] = []
  let spanCount = 0
  let tools = false
  return {
    add(all) {
      const spans = all.filter((s) => ts(s.start_time) > 0) // OTLP's zero time is unknown; one such span opened millions of windows back to 1970
      spanCount += spans.length
      tools ||= spans.some(isToolSpan)
      // A Codex lifecycle span stands for another session's thread (a child it spawned, or the parent it answered),
      // whose records are in that session's file: that session is the node, never a callless stand-in.
      for (const n of groupNodes(spans, now)) if (n.thread === null) read.push(readNode(n, acc))
    },
    result() {
      if (!tools || read.length === 0) throw Object.assign(new Error('no tool spans; categories unavailable'), { code: 'no-outcome' })
      return runResult(read, acc, windowMs / 1000, spanCount)
    },
  }
}

/** The behavior of every node in `spans`. Throws (`code: no-outcome`) when no span is a tool call: categories need acts. */
export function behaviorFromSpans(all: readonly OtlpSpan[], options: BehaviorOptions = {}): BehaviorResult {
  const reader = behaviorReader(options)
  reader.add(all)
  return reader.result()
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
