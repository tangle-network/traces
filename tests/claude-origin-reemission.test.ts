import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude.js'
import type { SessionRef } from '../src/types.js'

/**
 * Integration suite over a REAL transcript, not synthesized events: these
 * rows were extracted (text redacted, structure verbatim) from a Claude Code
 * subagent file that `traces analyze --harness claude-code --last 1` could not
 * analyze — continuing the subagent under later prompts re-emits its earlier
 * events with the `origin` labels the first copies predate, and one such
 * re-emission used to abort the whole session (#44).
 *
 * The re-emission shapes covered here, exactly as Claude Code writes them:
 *   - a `user` kickoff event re-emitted with a top-level `origin` and a new
 *     `promptId` (content byte-identical);
 *   - an `attachment` (queued task notification) re-emitted WITHOUT its
 *     `rendered`/`renderedInHumanTurn` blocks and WITH an `origin` inside the
 *     `attachment` object itself.
 */

const fixtureDir = join(import.meta.dirname, 'fixtures', 'claude-origin-reemission')
const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function refFor(path: string): SessionRef {
  return { harness: 'claude-code', sessionId: 'origin-reemission', path, cwd: null, mtimeMs: 0 }
}

describe('claude origin re-emission (real transcript fixture)', () => {
  it('collapses each re-emitted event to one span and enriches its origin attribution', async () => {
    const spans = await new ClaudeAdapter().parse(
      refFor(join(fixtureDir, 'origin-reemission.jsonl')))

    expect(spans.length - new Set(spans.map((s) => s.span_id)).size).toBe(0)

    const kickoff = spans.filter(
      (s) => s.attributes['traces.claude.source_span_id']
        === 'agent-reemit:52af97ef-067d-4ddd-94d6-c9c28d7d05d3:user')
    expect(kickoff).toHaveLength(1)
    expect(kickoff[0]!.attributes['traces.claude.origin_recorded']).toBe(true)
    expect(kickoff[0]!.attributes['traces.claude.origin_kind']).toBe('unclassified')
    expect(kickoff[0]!.attributes['tangle.actor']).toBe('injected')
    expect(kickoff[0]!.attributes['traces.claude.actor_evidence']).toBeUndefined()

    const queued = spans.filter(
      (s) => s.attributes['traces.claude.source_span_id']
        === 'agent-reemit:0f7b62de-c479-404d-b099-d5633bfe1258:queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.attributes['traces.claude.queued']).toBe(true)
    expect(queued[0]!.attributes['traces.claude.origin_recorded']).toBe(true)
    expect(queued[0]!.attributes['traces.claude.origin_kind']).toBe('unclassified')
  })

  it('still fails loud when a re-emission contradicts the origin already recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-origin-conflict-'))
    tempDirs.push(dir)
    cpSync(fixtureDir, dir, { recursive: true })
    const subagentPath = join(dir, 'origin-reemission', 'subagents', 'agent-reemit.jsonl')
    const rows = readFileSync(subagentPath, 'utf8').split('\n').filter(Boolean)
    // The third copy of the kickoff carries origin "unclassified"; contradict
    // it to prove a genuine conflict still refuses rather than re-attributing.
    const doctored: string[] = []
    let seen = 0
    for (const row of rows) {
      if (row.includes('52af97ef-067d-4ddd-94d6-c9c28d7d05d3')) {
        seen += 1
        if (seen === 3) {
          doctored.push(row.replace('"kind":"unclassified"', '"kind":"human"'))
          continue
        }
      }
      doctored.push(row)
    }
    writeFileSync(subagentPath, `${doctored.join('\n')}\n`)

    await expect(
      new ClaudeAdapter().parse(refFor(join(dir, 'origin-reemission.jsonl'))),
    ).rejects.toThrow('conflicting payloads')
  })

  it('analyzes the session end-to-end through the real CLI', () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-origin-home-'))
    tempDirs.push(home)
    const projectDir = join(home, '.claude', 'projects', '-tmp-fixture')
    mkdirSync(projectDir, { recursive: true })
    cpSync(join(fixtureDir, 'origin-reemission.jsonl'), join(projectDir, 'origin-reemission.jsonl'))
    cpSync(
      join(fixtureDir, 'origin-reemission'),
      join(projectDir, 'origin-reemission'),
      { recursive: true })

    const report = join(home, 'report.md')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FORCE_COLOR: '0' }
    delete env.NODE_OPTIONS
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'src', 'cli.ts'),
        'analyze', '--harness', 'claude-code', '--last', '1', '--out', report],
      { cwd: process.cwd(), encoding: 'utf8', env, timeout: 240_000 },
    )
    expect(run.status, run.stderr || run.error?.message).toBe(0)
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('# Trace analysis — claude-code')
    expect(text).toMatch(/\*\*\d+ findings?|spans? →/)
  })
})
