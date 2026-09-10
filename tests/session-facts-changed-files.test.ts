/**
 * Which paths the facts sheet names as changed, and from which source.
 *
 * The measured failure this replaces: the sheet recovered every path from the
 * `apply_patch` headers kept in `input.value`, so a patch a code-mode script
 * generated arrived with the script's own `${path}` in the header while the
 * `file.change` spans the harness writes — which already carry the path the
 * edit reached — were never read. On one private holdout session that cost the
 * sheet three of fifteen paths and added one that named no file.
 *
 * Every record below is invented for this test and parsed through the real
 * Codex adapter, so the rule is exercised end to end rather than against spans
 * a test built by hand.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import { computeSessionFacts, type SessionFacts } from '../src/session-facts.js'

const dir = mkdtempSync(join(tmpdir(), 'traces-changed-files-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function at(second: number): string {
  return new Date(Date.UTC(2026, 8, 9, 12, 0, second)).toISOString()
}

/** One `apply_patch` call and its output, as Codex records a function call. */
function patchCall(callId: string, second: number, patch: string): Record<string, unknown>[] {
  return [
    {
      type: 'response_item',
      timestamp: at(second),
      payload: { type: 'function_call', call_id: callId, name: 'apply_patch', arguments: JSON.stringify({ input: patch }) },
    },
    {
      type: 'response_item',
      timestamp: at(second + 1),
      payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ exit_code: 0 }) },
    },
  ]
}

/** One shell call whose script writes a patch, as a code-mode session records it. */
function scriptCall(callId: string, second: number, script: string): Record<string, unknown>[] {
  return [
    {
      type: 'response_item',
      timestamp: at(second),
      payload: { type: 'function_call', call_id: callId, name: 'exec_command', arguments: JSON.stringify({ cmd: script }) },
    },
    {
      type: 'response_item',
      timestamp: at(second + 1),
      payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ exit_code: 0 }) },
    },
  ]
}

/** The harness's own record of what a patch changed. */
function fileChangeItem(
  itemId: string,
  second: number,
  changes: Record<string, Record<string, unknown>>,
  status = 'completed',
): Record<string, unknown> {
  return {
    type: 'event_msg',
    timestamp: at(second),
    payload: { type: 'item_completed', item: { id: itemId, type: 'FileChange', status, changes } },
  }
}

async function facts(name: string, records: readonly Record<string, unknown>[]): Promise<SessionFacts> {
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const spans = await new CodexAdapter().parse({ harness: 'codex', sessionId: name, path, cwd: '/repo', mtimeMs: 0 })
  const [session, ...rest] = computeSessionFacts(spans)
  expect(rest).toEqual([])
  return session!
}

const META = { type: 'session_meta', timestamp: at(0), payload: { id: 'changed-files', cwd: '/repo' } }

function paths(session: SessionFacts): string[] {
  return (session.changedFiles.value ?? []).map((file) => file.path)
}

describe('changed files', () => {
  it('takes the harness path for a patch a code-mode script generated', async () => {
    // The script interpolates the path, so the header the patch text carries is
    // the template literal, not a file. The harness resolved it before applying.
    const session = await facts('code-mode', [
      META,
      ...scriptCall('call-script', 2, [
        'node -e "',
        'const target = process.env.TARGET;',
        'writePatch(`*** Begin Patch',
        '*** Update File: ${target}',
        '*** End Patch`);',
        '"',
      ].join('\n')),
      fileChangeItem('item-script', 4, { '/repo/src/target.ts': { type: 'update' } }),
    ])

    expect(paths(session)).toEqual(['/repo/src/target.ts'])
    expect(session.changedFiles.value?.[0]?.operations).toEqual(['update'])
    expect(session.changedFiles.partial).toContain('unexpanded variable')
  })

  it('drops a path written through a shell variable and keeps the resolved one', async () => {
    const session = await facts('shell-variable', [
      META,
      ...scriptCall('call-sh', 2, [
        'OUT=generated',
        'apply_patch <<PATCH',
        '*** Begin Patch',
        '*** Add File: $OUT/new.ts',
        '*** End Patch',
        'PATCH',
      ].join('\n')),
      fileChangeItem('item-sh', 4, { '/repo/generated/new.ts': { type: 'add' } }),
    ])

    expect(paths(session)).toEqual(['/repo/generated/new.ts'])
    expect(paths(session).some((path) => path.includes('$'))).toBe(false)
  })

  it('counts an edit both sources saw once, with both spans as its evidence', async () => {
    // The header names the path relative to the directory the harness resolved
    // it against, so the two sources describe one edit under two spellings.
    const session = await facts('both-sources', [
      META,
      ...patchCall('call-patch', 2, ['*** Begin Patch', '*** Update File: src/upload.ts', '*** End Patch'].join('\n')),
      fileChangeItem('item-patch', 4, { '/repo/src/upload.ts': { type: 'update' } }),
    ])

    expect(paths(session)).toEqual(['/repo/src/upload.ts'])
    expect(session.changedFiles.value?.[0]?.spanIds.length).toBe(2)
    expect(session.changedFiles.partial).toBeUndefined()
  })

  it('still recovers header paths in a session that records no file change', async () => {
    const session = await facts('headers-only', [
      META,
      ...patchCall('call-legacy', 2, [
        '*** Begin Patch',
        '*** Update File: /repo/src/legacy.ts',
        '*** Add File: /repo/src/added.ts',
        '*** End Patch',
      ].join('\n')),
    ])

    expect(paths(session)).toEqual(['/repo/src/added.ts', '/repo/src/legacy.ts'])
  })

  it('names the rename destination and leaves a declined change out', async () => {
    const session = await facts('rename-and-declined', [
      META,
      fileChangeItem('item-move', 2, { '/repo/src/old.ts': { type: 'update', move_path: '/repo/src/new.ts' } }),
      fileChangeItem('item-declined', 4, { '/repo/src/rejected.ts': { type: 'add' } }, 'declined'),
    ])

    expect(paths(session)).toEqual(['/repo/src/new.ts', '/repo/src/old.ts'])
  })
})
