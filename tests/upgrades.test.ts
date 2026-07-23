import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTOR_ATTR } from '../src/adapters/conversation.js'
import { classifyReaction, claudeActor, codexActor } from '../src/adapters/actor.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { CodexAdapter } from '../src/adapters/codex.js'
import { analyzeAdoption, countSkillRunsJsonl } from '../src/adoption.js'
import type { OtlpSpan } from '../src/otlp.js'
import { span } from '../src/otlp.js'
import { analyzeReactions } from '../src/reactions.js'
import { renderAdoption } from '../src/report.js'
import type { SessionRef } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'tt-upgrades-'))
function refFor(path: string, harness: string, cwd: string | null = null): SessionRef {
  return { harness, sessionId: 'fixture', path, cwd, mtimeMs: 0 }
}
const userPrompts = (s: OtlpSpan[]) => s.filter((x) => x.name === 'user.prompt')

// ── Feature 1: actor tag ─────────────────────────────────────────────────────

describe('actor derivation', () => {
  it('claudeActor: sidechain → subagent-spawn, external → human, injected userType → injected', () => {
    expect(claudeActor({ text: 'do x', isSidechain: true })).toBe('subagent-spawn')
    expect(claudeActor({ text: 'do x', userType: 'external' })).toBe('human')
    expect(claudeActor({ text: 'do x', userType: 'memory' })).toBe('injected')
    expect(claudeActor({ text: 'do x' })).toBe('human')
  })

  it('claudeActor: synthetic harness prompt → injected; first-turn agent brief → subagent-spawn', () => {
    expect(claudeActor({ text: 'You are an autonomous coding agent. Build it.' })).toBe('injected')
    expect(claudeActor({ text: 'You are a senior reviewer. Audit the diff.', isFirstUserTurn: true })).toBe(
      'subagent-spawn',
    )
    // The same imperative on a LATER turn is treated as a human follow-up.
    expect(claudeActor({ text: 'your task: keep going', isFirstUserTurn: false })).toBe('human')
  })

  it('codexActor: text-only — synthetic → injected, first-turn brief → injected, else human', () => {
    expect(codexActor({ text: 'hello there' })).toBe('human')
    expect(codexActor({ text: 'Return ONLY valid JSON.' })).toBe('injected')
    expect(codexActor({ text: 'You are an agent. Do the task.', isFirstUserTurn: true })).toBe('injected')
  })

  it('flags harness-injected wrappers as injected even on an external user turn', () => {
    // <task-notification> / continuation summaries arrive AS userType:external —
    // the structural human test passes, so the text marker must override it.
    expect(claudeActor({ text: '<task-notification> done </task-notification>', userType: 'external' })).toBe(
      'injected',
    )
    expect(
      claudeActor({ text: 'This session is being continued from a previous conversation…', userType: 'external' }),
    ).toBe('injected')
    expect(codexActor({ text: '<task-notification> done </task-notification>' })).toBe('injected')
    expect(codexActor({ text: '<codex_internal_context source="goal">continue</codex_internal_context>' })).toBe(
      'injected',
    )
    expect(codexActor({ text: '<subagent_notification>done</subagent_notification>' })).toBe('injected')
    expect(codexActor({ text: '# AGENTS.md instructions\n<INSTRUCTIONS>' })).toBe('injected')
    expect(codexActor({ text: '# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>' })).toBe('injected')
    // Slash-command skill bodies expand into a user turn without a <command-name> wrapper.
    expect(claudeActor({ text: 'Base directory for this skill: /x\nYou are…', userType: 'external' })).toBe(
      'injected',
    )
  })

  it('claude adapter stamps actor on the user.prompt span (sidechain → subagent-spawn)', async () => {
    const path = join(dir, 'claude-actor.jsonl')
    writeFileSync(
      path,
      [
        { type: 'user', uuid: 'u1', isSidechain: true, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'spawn brief: build the parser' }] } },
        { type: 'user', uuid: 'u2', userType: 'external', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'now fix the bug' }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    const spans = await new ClaudeAdapter().parse(refFor(path, 'claude-code'))
    const ups = userPrompts(spans)
    expect(ups).toHaveLength(2)
    expect(ups[0]!.attributes[ACTOR_ATTR]).toBe('subagent-spawn')
    expect(ups[1]!.attributes[ACTOR_ATTR]).toBe('human')
  })

  it('codex adapter defaults a plain user turn to human and flags a synthetic one as injected', async () => {
    const path = join(dir, 'rollout-actor.jsonl')
    writeFileSync(
      path,
      [
        { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 's1', cwd: '/x' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:02Z', payload: { type: 'message', role: 'user', content: 'Return ONLY a JSON object.' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:03Z', payload: { type: 'message', role: 'assistant', content: 'ok' } },
        { type: 'response_item', timestamp: '2026-06-20T00:00:04Z', payload: { type: 'message', role: 'user', content: 'thanks, that works' } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))
    const ups = userPrompts(spans)
    expect(ups).toHaveLength(2)
    expect(ups[0]!.attributes[ACTOR_ATTR]).toBe('injected')
    expect(ups[1]!.attributes[ACTOR_ATTR]).toBe('human')
  })

  it('applies a delayed Codex model without a metadata pre-scan', async () => {
    const path = join(dir, 'rollout-delayed-model.jsonl')
    const rows = [
      { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 'late-model', cwd: '/x' } },
      { type: 'event_msg', timestamp: '2026-06-20T00:00:01Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
      ...Array.from({ length: 40 }, (_, index) => ({ type: 'event_msg', timestamp: `2026-06-20T00:00:${String(index + 2).padStart(2, '0')}Z`, payload: { type: 'progress' } })),
      { type: 'turn_context', timestamp: '2026-06-20T00:01:00Z', payload: { model: 'gpt-late' } },
    ]
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'))

    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))

    expect(spans[0]!.attributes['llm.model_name']).toBe('gpt-late')
    expect(spans.find((item) => item.name === 'llm.turn')?.attributes['llm.model_name']).toBe('gpt-late')
  })
})

// ── Feature 2: user-reaction analyst ─────────────────────────────────────────

describe('reaction classifier', () => {
  it('labels correction / frustration / praise / jargon / structure complaints', () => {
    expect(classifyReaction('no, that is wrong')).toContain('correction')
    expect(classifyReaction('ugh, again? this is wasting time')).toContain('frustration')
    expect(classifyReaction('perfect, ship it')).toContain('praise')
    expect(classifyReaction('plain english please, that is jargon')).toContain('jargon')
    expect(classifyReaction('too long, get to the point')).toContain('structure')
    expect(classifyReaction('looks fine to me overall')).toEqual([])
  })
})

function humanPrompt(i: number, traceId: string, text: string): OtlpSpan {
  return span({
    traceId,
    spanId: `u${i}`,
    parentSpanId: 'root',
    name: 'user.prompt',
    kind: 'CHAIN',
    startTime: new Date(1000 + i * 1000).toISOString(),
    step: i,
    content: text,
    extra: { [ACTOR_ATTR]: 'human' },
  })
}
function assistant(i: number, traceId: string, text: string): OtlpSpan {
  return span({
    traceId,
    spanId: `a${i}`,
    parentSpanId: 'root',
    name: 'llm.turn',
    kind: 'LLM',
    startTime: new Date(1000 + i * 1000).toISOString(),
    step: i,
    content: text,
  })
}

describe('analyzeReactions', () => {
  it('classifies only human turns that follow an assistant turn, and computes the ratio', () => {
    const spans: OtlpSpan[] = [
      assistant(0, 's1', 'Here is a verbose technical wall of text.'),
      humanPrompt(1, 's1', 'no, that is wrong'), // correction (follows assistant)
      assistant(2, 's1', 'Sorry, corrected.'),
      humanPrompt(3, 's1', 'perfect, exactly right'), // praise (follows assistant)
    ]
    const r = analyzeReactions(spans)
    expect(r.humanReactionTurns).toBe(2)
    expect(r.signals.correction).toBe(1)
    expect(r.signals.praise).toBe(1)
    expect(r.correctiveToPositiveRatio).toBe(1)
    expect(r.triggerPairs.length).toBe(2)
    // The most-corrective pair ranks first.
    expect(r.triggerPairs[0]!.reactions).toContain('correction')
  })

  it('ignores a non-human (injected/subagent) turn and a leading human turn with no prior assistant', () => {
    const injected = span({
      traceId: 's2',
      spanId: 'u9',
      parentSpanId: 'root',
      name: 'user.prompt',
      kind: 'CHAIN',
      startTime: new Date(5000).toISOString(),
      step: 9,
      content: 'no this is wrong',
      extra: { [ACTOR_ATTR]: 'injected' },
    })
    const spans: OtlpSpan[] = [
      humanPrompt(0, 's2', 'no this is wrong'), // first turn, no prior assistant → not a reaction
      assistant(1, 's2', 'working on it'),
      injected, // injected → never counted even though it follows an assistant
    ]
    const r = analyzeReactions(spans)
    expect(r.humanReactionTurns).toBe(0)
    expect(r.signals.correction).toBe(0)
    expect(r.triggerPairs).toHaveLength(0)
  })
})

// ── Feature 3: adoption metrics ──────────────────────────────────────────────

function skillTool(i: number, traceId: string, skill: string): OtlpSpan {
  return span({
    traceId,
    spanId: `t${i}`,
    parentSpanId: 'root',
    name: 'tool.Skill',
    kind: 'TOOL',
    startTime: new Date(1000 + i * 1000).toISOString(),
    step: i,
    tool: 'Skill',
    extra: { 'input.value': JSON.stringify({ skill }) },
  })
}
function taskTool(i: number, traceId: string, type: string): OtlpSpan {
  return span({
    traceId,
    spanId: `g${i}`,
    parentSpanId: 'root',
    name: 'tool.Task',
    kind: 'TOOL',
    startTime: new Date(1000 + i * 1000).toISOString(),
    step: i,
    tool: 'Task',
    extra: { 'input.value': JSON.stringify({ subagent_type: type }) },
  })
}

describe('countSkillRunsJsonl', () => {
  it('counts both array (`skills`) and string (`skill`) schemas, skipping blanks', () => {
    const raw = [
      JSON.stringify({ skills: ['research', 'critical-audit'], status: 'completed' }),
      JSON.stringify({ skill: 'evolve', round: 1 }),
      '',
      'not json',
      JSON.stringify({ skill: 'evolve' }),
    ].join('\n')
    const counts = countSkillRunsJsonl(raw)
    expect(counts.research).toBe(1)
    expect(counts['critical-audit']).toBe(1)
    expect(counts.evolve).toBe(2)
  })
})

describe('analyzeAdoption', () => {
  it('separates session-linked loop runs from unlinked repository history', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tt-adopt-cwd-'))
    mkdirSync(join(cwd, '.evolve'), { recursive: true })
    writeFileSync(
      join(cwd, '.evolve', 'skill-runs.jsonl'),
      [
        JSON.stringify({ skill: 'evolve', sessionId: 's1' }),
        JSON.stringify({ skill: 'evolve' }),
        JSON.stringify({ skills: ['evolve', 'converge'] }),
      ].join('\n'),
    )
    const spans: OtlpSpan[] = [
      span({
        traceId: 's1',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'claude-code',
        extra: { 'tangle.sessionId': 's1' },
      }),
      skillTool(1, 's1', 'evolve'),
      skillTool(2, 's1', 'polish'),
      taskTool(3, 's1', 'Explore'),
      span({
        traceId: 's1',
        spanId: 'fallback-ignored',
        name: 'tool.spawn_agent',
        kind: 'TOOL',
        startTime: new Date(5000).toISOString(),
        step: 4,
        tool: 'spawn_agent',
        extra: { 'input.value': JSON.stringify({ agent_type: 'duplicate' }) },
      }),
      span({ traceId: 's2', spanId: 'root2', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      span({
        traceId: 's2',
        spanId: 'spawn-1',
        name: 'tool.spawn_agent',
        kind: 'TOOL',
        startTime: new Date(2000).toISOString(),
        step: 1,
        tool: 'spawn_agent',
        extra: { 'input.value': JSON.stringify({ agent_type: 'explorer' }) },
      }),
      span({
        traceId: 's2',
        spanId: 'spawn-2',
        name: 'tool.multi_agent_v1__spawn_agent',
        kind: 'TOOL',
        startTime: new Date(3000).toISOString(),
        step: 2,
        tool: 'multi_agent_v1__spawn_agent',
        extra: { 'input.value': JSON.stringify({ subagent_type: 'reviewer' }) },
      }),
      // s2 invokes no skill → penetration is 1/2, but its spawn tools count.
    ]
    const r = await analyzeAdoption(spans, { cwds: [cwd] })
    expect(r.executionGroupCount).toBe(2)
    expect(r.identifiedSessionCount).toBe(1)
    expect(r.unassignedTraceCount).toBe(1)
    expect(r.sessionsWithSkill).toBe(1)
    expect(r.skillPenetration).toBe(0.5)
    expect(r.skillTelemetryStatus).toBe('measured')
    expect(r.skillTelemetrySessions).toBe(2)
    expect(r.skillInvocations.evolve).toBe(1)
    expect(r.skillInvocations.polish).toBe(1)
    expect(r.totalSkillInvocations).toBe(2)
    expect(r.subagentSpawns.Explore).toBe(1)
    expect(r.subagentSpawns.explorer).toBe(1)
    expect(r.subagentSpawns.reviewer).toBe(1)
    expect(r.subagentSpawns.duplicate).toBeUndefined()
    expect(r.totalSubagentSpawns).toBe(3)
    expect(r.sessionsWithSubagent).toBe(2)
    expect(r.loopDispatchedRuns.evolve).toBe(1)
    expect(r.totalLoopDispatchedRuns).toBe(1)
    expect(r.unlinkedLoopDispatchedRuns.evolve).toBe(2)
    expect(r.unlinkedLoopDispatchedRuns.converge).toBe(1)
    expect(r.totalUnlinkedLoopDispatchedRuns).toBe(3)
    expect(r.skillRunFilesRead).toBe(1)
  })

  it('reports Codex skill invocation as unsupported while preserving catalog, file, and subagent evidence', async () => {
    const path = join(dir, 'rollout-codex-skill-evidence.jsonl')
    const rows = [
      { type: 'session_meta', timestamp: '2026-06-20T00:00:00Z', payload: { id: 'codex-skill-evidence', cwd: '/x' } },
      {
        type: 'response_item',
        timestamp: '2026-06-20T00:00:01Z',
        payload: {
          type: 'message',
          role: 'developer',
          content: '<skills_instructions>\n### Available skills\n- simplify: capability-preserving cleanup',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-20T00:00:02Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'skill-file',
          name: 'exec',
          input: 'const r = await tools.exec_command({cmd:"sed -n 1,80p /skills/simplify/SKILL.md"}); text(r.output)',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-20T00:00:03Z',
        payload: { type: 'custom_tool_call_output', call_id: 'skill-file', output: 'Script completed' },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-20T00:00:03.100Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'skill-catalog',
          name: 'exec',
          input: 'const r = await tools.exec_command({cmd:"rg --files /skills/simplify/SKILL.md"}); text(r.output)',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-20T00:00:03.200Z',
        payload: { type: 'custom_tool_call_output', call_id: 'skill-catalog', output: 'Script completed' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-20T00:00:04Z',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          agent_thread_id: 'child-1',
          agent_path: 'reviewer',
        },
      },
    ]
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'))

    const spans = await new CodexAdapter().parse(refFor(path, 'codex'))
    const report = await analyzeAdoption(spans)
    const rendered = renderAdoption(report)

    expect(report.skillPenetration).toBeNull()
    expect(report.skillTelemetryStatus).toBe('unsupported')
    expect(report.skillTelemetrySessions).toBe(0)
    expect(report.sessionsWithMaterializedSkills).toBe(1)
    expect(report.sessionsWithSkillFileReference).toBe(1)
    expect(report.skillDocumentReads.simplify).toBe(1)
    expect(report.totalSubagentSpawns).toBe(1)
    expect(report.subagentSpawns.reviewer).toBe(1)
    expect(rendered).toContain('Explicit skill invocation rate:** uncaptured/unsupported')
    expect(rendered).toContain('Materialized skill catalogs/instructions:** 1/1')
    expect(rendered).toContain('Sessions with successful skill-document reads:** 1/1')
    expect(rendered).toContain('Successful skill-document reads:** 1; inspection is not outcome evidence.')
    expect(rendered).toContain('Subagent spawns observed:** 1')
    expect(rendered).toContain('Prompt, tools, MCP, hooks, and full agent profile:** not assessed')
    expect(rendered).not.toContain('Skill penetration')
    expect(rendered).not.toContain('0%')
  })

  it('excludes Codex from a mixed corpus explicit-invocation denominator', async () => {
    const report = await analyzeAdoption([
      span({
        traceId: 'claude-session',
        spanId: 'claude-root',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'claude-code',
      }),
      span({
        traceId: 'codex-session',
        spanId: 'codex-root',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'codex',
      }),
    ])
    const rendered = renderAdoption(report)

    expect(report.skillTelemetryStatus).toBe('partial')
    expect(report.skillTelemetrySessions).toBe(1)
    expect(report.skillPenetration).toBe(0)
    expect(rendered).toContain('0/1 measurable group(s); 1 unmeasurable group(s) excluded')
  })

  it('collapses many traces under their shared session identity', async () => {
    const spans = [
      span({
        traceId: 'trace-1',
        spanId: 'root-1',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'claude-code',
        extra: { 'tangle.sessionId': 'shared-session' },
      }),
      span({
        traceId: 'trace-2',
        spanId: 'root-2',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(1).toISOString(),
        service: 'claude-code',
        extra: { 'session.id': 'shared-session' },
      }),
      span({
        traceId: 'trace-without-session',
        spanId: 'root-3',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(2).toISOString(),
        service: 'claude-code',
      }),
    ]

    const report = await analyzeAdoption(spans)

    expect(report).toMatchObject({
      executionGroupCount: 2,
      identifiedSessionCount: 1,
      unassignedTraceCount: 1,
      sessionIdentityConflicts: [],
      skillTelemetrySessions: 2,
    })
    expect(renderAdoption(report)).toContain(
      '1 identified session(s) + 1 trace(s) without a single stable session identity',
    )
  })

  it('preserves traces with conflicting session identities as unassigned evidence', async () => {
    const report = await analyzeAdoption([
      span({
        traceId: 'trace-conflict',
        spanId: 'root',
        name: 'session',
        kind: 'AGENT',
        startTime: new Date(0).toISOString(),
        service: 'claude-code',
        extra: { 'tangle.sessionId': 'session-a' },
      }),
      span({
        traceId: 'trace-conflict',
        spanId: 'child',
        name: 'message',
        kind: 'CHAIN',
        startTime: new Date(1).toISOString(),
        service: 'claude-code',
        extra: { 'session.id': 'session-b' },
      }),
    ])

    expect(report).toMatchObject({
      executionGroupCount: 1,
      identifiedSessionCount: 0,
      unassignedTraceCount: 1,
      sessionIdentityConflicts: [
        { traceId: 'trace-conflict', sessionIds: ['session-a', 'session-b'] },
      ],
    })
    expect(renderAdoption(report)).toContain(
      'Conflicting session identity:** 1 trace(s): `trace-conflict` (`session-a`, `session-b`)',
    )
  })

  it('handles a corpus with no skill-runs files (loop counts stay zero, not crash)', async () => {
    const spans: OtlpSpan[] = [
      span({ traceId: 's1', spanId: 'root', name: 'session', kind: 'AGENT', startTime: new Date(0).toISOString(), service: 'claude-code' }),
      skillTool(1, 's1', 'report'),
    ]
    const r = await analyzeAdoption(spans, { cwds: ['/nonexistent/path/xyz'] })
    expect(r.totalSkillInvocations).toBe(1)
    expect(r.totalLoopDispatchedRuns).toBe(0)
    expect(r.skillRunFilesRead).toBe(0)
  })
})
