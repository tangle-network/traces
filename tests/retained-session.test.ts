import { describe, expect, it, vi } from 'vitest'
import { resolveAdapter } from '../src/registry.js'
import { buildSessionFactsReport } from '../src/session-facts.js'
import { parseRetainedSession } from '../src/retained-session.js'

const sessionId = 'be251168-70eb-4880-b8dc-8c551529e03b'
const row = (value: unknown) => JSON.stringify(value) + '\n'
const claude = row({ type: 'assistant', sessionId, uuid: 'assistant-1', timestamp: '2026-01-01T00:00:00Z', message: {
  id: 'm1', model: 'model', role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'Read', input: { file_path: '/skills/example/SKILL.md' } }],
} }) + row({ type: 'user', sessionId, uuid: 'user-1', timestamp: '2026-01-01T00:00:01Z', message: {
  role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'Private document contents.' }],
} })

describe('retained session selection', () => {
  it('uses native identity without depending on filenames or host catalogs', async () => {
    const selected = await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId, files: [
      { path: 'unrelated-name.jsonl', content: claude },
      { path: `${sessionId}.jsonl`, content: claude.replaceAll(sessionId, 'some-other-session') },
    ] })
    expect(selected.status).toBe('selected')
    expect(selected.sourceFiles.map((file) => file.path)).toEqual(['unrelated-name.jsonl'])
    expect(selected.unselectedFiles).toHaveLength(1)
    const facts = buildSessionFactsReport(selected.spans, { includeContent: false })
    expect(facts.sessions[0]?.sessionId).toBe(sessionId)
    expect(facts.sessions[0]?.toolCalls.value).toBe(1)
    expect(JSON.stringify(facts)).not.toContain('Private document contents.')
  })

  it('deduplicates identical and append-only snapshots but refuses divergent histories', async () => {
    const prefix = claude.slice(0, claude.indexOf('\n') + 1)
    const selected = await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId, files: [
      { path: 'a.jsonl', content: claude }, { path: 'b.jsonl', content: claude }, { path: 'c.jsonl', content: prefix },
    ] })
    expect(selected.status).toBe('selected')
    expect(selected.duplicateFiles).toHaveLength(2)
    expect(buildSessionFactsReport(selected.spans).sessions[0]?.toolCalls.value).toBe(1)
    const conflict = await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId, files: [
      { path: 'a.jsonl', content: claude }, { path: 'b.jsonl', content: claude.replace('call1', 'different-call') },
    ] })
    expect(conflict.status).toBe('unavailable')
    expect(conflict.reason).toMatch(/divergent/)
  })

  it('selects Codex metadata and withholds unsupported fallback identities', async () => {
    const content = row({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: sessionId } })
      + row({ type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"pwd"}' } })
      + row({ type: 'response_item', timestamp: '2026-01-01T00:00:02Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\nOutput:\n/work' } })
    const selected = await parseRetainedSession({ harness: 'codex', nativeSessionId: sessionId, files: [{ path: 'capture.jsonl', content }] })
    expect(selected.status).toBe('selected')
    expect(buildSessionFactsReport(selected.spans).sessions[0]?.toolCalls.value).toBe(1)
    const fallback = await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId, files: [
      { path: `${sessionId}.jsonl`, content: claude.replaceAll(`,"sessionId":"${sessionId}"`, '') },
    ] })
    expect(fallback.status).toBe('unavailable')
    expect((await parseRetainedSession({ harness: 'unknown', nativeSessionId: sessionId, files: [] })).status).toBe('unavailable')
    expect((await parseRetainedSession({ harness: 'claude', nativeSessionId: null, files: [] })).status).toBe('unavailable')
  })

  it('retains corrupt-record evidence and refuses inputs beyond its text bounds', async () => {
    const selected = await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId, files: [
      { path: 'partial.jsonl', content: 'broken record\n' + claude },
    ] })
    expect(selected.status).toBe('selected')
    expect(buildSessionFactsReport(selected.spans).sessions[0]?.unreadRecords.value).toBe(1)
    expect((await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId,
      files: Array.from({ length: 1025 }, (_, i) => ({ path: String(i), content: '' })),
    })).reason).toMatch(/1024/)
  })

  it('refuses an adapter dependency outside the supplied capture before parsing', async () => {
    const adapter = resolveAdapter('claude')!
    const sources = vi.spyOn(adapter, 'sourcePaths').mockResolvedValue(['/outside-retained-capture.jsonl'])
    const parse = vi.spyOn(adapter, 'parse')
    try {
      const selected = await parseRetainedSession({ harness: 'claude', nativeSessionId: sessionId,
        files: [{ path: 'capture.jsonl', content: claude }],
      })
      expect(selected.status).toBe('unavailable')
      expect(parse).not.toHaveBeenCalled()
    } finally {
      sources.mockRestore()
      parse.mockRestore()
    }
  })

  it('keeps measurements stable across temporary directories and rejects path escapes', async () => {
    const input = { harness: 'claude', nativeSessionId: sessionId, files: [{ path: 'capture.jsonl', content: claude }] }
    const selected = await parseRetainedSession(input)
    expect(selected.status).toBe('selected')
    const first = buildSessionFactsReport(selected.spans)
    const second = buildSessionFactsReport((await parseRetainedSession(input)).spans)
    expect(first.sourceDigest).toBe(second.sourceDigest)
    await expect(parseRetainedSession({ ...input, files: [{ path: '../outside', content: claude }] })).rejects.toThrow(/relative/)
  })
})
