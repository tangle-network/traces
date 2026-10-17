import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTOR_ATTR } from '../src/adapters/conversation.js'
import {
  claudeActor,
  claudePromptStartsTask,
  codexActor,
} from '../src/adapters/actor.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import { CodexAdapter } from '../src/adapters/codex.js'
import type { OtlpSpan } from '../src/otlp.js'
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
    expect(claudeActor({ text: 'do x', isMeta: true })).toBe('injected')
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

  it('separates automated task boundaries from injected actor identity', () => {
    const headlessTask = '## Current Skill\nExtract the transaction. Return ONLY JSON.'
    expect(claudeActor({
      text: headlessTask,
      userType: 'external',
      isFirstUserTurn: true,
    })).toBe('injected')
    expect(claudePromptStartsTask({
      text: headlessTask,
      userType: 'external',
    })).toBe(true)
    expect(claudePromptStartsTask({
      text: '<task-notification>worker complete</task-notification>',
      userType: 'external',
    })).toBe(false)
    expect(claudePromptStartsTask({
      text: '<local-command-stdout>model changed</local-command-stdout>',
      userType: 'external',
    })).toBe(false)
    expect(claudePromptStartsTask({
      text: '<command-name>/model</command-name>',
      userType: 'external',
    })).toBe(false)
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
