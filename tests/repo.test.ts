import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { ATTR } from '../src/attributes.js'
import { serializeSpans, span, toOpenInferenceSpan } from '../src/otlp.js'
import { normalizeRemote, resolveRepoAttrs, stampRepoAttrs } from '../src/repo.js'
import { parseSession } from '../src/session-source.js'
import type { HarnessTraceAdapter, OtlpSpan, SessionRef } from '../src/index.js'

const run = promisify(execFile)
const created: string[] = []

afterAll(async () => {
  for (const d of created) await rm(d, { recursive: true, force: true })
})

async function gitRepo(remote: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-repo-'))
  created.push(dir)
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.t'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await run('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init'])
  return dir
}

/** Minimal adapter: one root span per ref, parents nothing — repo attrs are
 *  stamped by parseSession, NOT by the adapter. */
function adapter(): HarnessTraceAdapter {
  return {
    harness: 'synthetic',
    async locate() {
      return []
    },
    async parse(r: SessionRef): Promise<OtlpSpan[]> {
      return [
        span({
          traceId: r.sessionId,
          spanId: `root:${r.sessionId}`,
          name: 'session',
          kind: 'AGENT',
          startTime: '2026-01-01T00:00:00.000Z',
          service: 'claude-code',
          agent: 'claude-code',
        }),
      ]
    },
  }
}

const ref = (id: string, cwd: string | null): SessionRef => ({
  harness: 'synthetic',
  sessionId: id,
  path: `/tmp/${id}`,
  cwd,
  mtimeMs: 0,
})

describe('normalizeRemote', () => {
  it('normalizes https + scp git urls to host/owner/repo', () => {
    expect(normalizeRemote('https://github.com/tangle-network/agent-dev-container.git')).toBe(
      'github.com/tangle-network/agent-dev-container',
    )
    expect(normalizeRemote('git@github.com:tangle-network/agent-dev-container.git')).toBe(
      'github.com/tangle-network/agent-dev-container',
    )
    expect(normalizeRemote('https://user:tok@gitlab.com:443/a/b')).toBe('gitlab.com/a/b')
  })
})

describe('resolveRepoAttrs', () => {
  it('null/undefined cwd → {} (keeps today behavior)', async () => {
    expect(await resolveRepoAttrs(null)).toEqual({})
    expect(await resolveRepoAttrs(undefined)).toEqual({})
  })

  it('git cwd → remote-derived subject key + git.* labels', async () => {
    const dir = await gitRepo('git@github.com:tangle-network/agent-dev-container.git')
    const a = await resolveRepoAttrs(dir)
    expect(a[ATTR.SUBJECT_KEY]).toBe('github.com/tangle-network/agent-dev-container')
    expect(a[ATTR.GIT_REPOSITORY]).toBe('github.com/tangle-network/agent-dev-container')
    expect(a[ATTR.GIT_BRANCH_NAME]).toBe('main')
    expect(typeof a[ATTR.GIT_COMMIT]).toBe('string')
    expect(a[ATTR.GIT_COMMIT]!.length).toBeGreaterThan(0)
    expect(a[ATTR.CWD]).toBe(dir)
  })

  it('DELETED cwd (gone worktree) → path-basename subject key, NO git.* fabrication', async () => {
    const gone = '/tmp/this-dir-does-not-exist-12345/my-old-worktree'
    const a = await resolveRepoAttrs(gone)
    expect(a[ATTR.SUBJECT_KEY]).toBe('my-old-worktree')
    expect(a[ATTR.CWD]).toBe(gone)
    expect(ATTR.GIT_REPOSITORY in a).toBe(false)
    expect(ATTR.GIT_BRANCH_NAME in a).toBe(false)
    expect(ATTR.GIT_COMMIT in a).toBe(false)
  })
})

describe('per-session repo grouping in OTLP resource attrs', () => {
  it('two sessions with different cwds get DIFFERENT tangle.subject.key in resource attributes', async () => {
    const repoA = await gitRepo('git@github.com:tangle-network/agent-dev-container.git')
    const repoB = await gitRepo('https://github.com/tangle-network/traces.git')
    const ad = adapter()

    const spansA = await parseSession(ad, ref('sessA', repoA))
    const spansB = await parseSession(ad, ref('sessB', repoB))

    // Resource attributes (what the spine groups on) must differ per repo.
    const resourceKeyOf = (spans: OtlpSpan[]): unknown => {
      const line = serializeSpans(spans).trim().split('\n')[0]!
      return (JSON.parse(line).resource.attributes as Record<string, unknown>)[ATTR.SUBJECT_KEY]
    }
    const keyA = resourceKeyOf(spansA)
    const keyB = resourceKeyOf(spansB)
    expect(keyA).toBe('github.com/tangle-network/agent-dev-container')
    expect(keyB).toBe('github.com/tangle-network/traces')
    expect(keyA).not.toBe(keyB)

    // service.name + agent.name still present (additive, not replaced).
    const resA = JSON.parse(serializeSpans(spansA).trim().split('\n')[0]!).resource.attributes
    expect(resA['service.name']).toBe('claude-code')
    expect(resA['agent.name']).toBe('claude-code')
    expect(resA['git.repository']).toBe('github.com/tangle-network/agent-dev-container')
  })

  it('deleted-cwd session falls back to the path basename in resource attrs, no git.* keys', async () => {
    const spans = await parseSession(adapter(), ref('sessGone', '/tmp/nope-9999/legacy-worktree'))
    const res = JSON.parse(serializeSpans(spans).trim().split('\n')[0]!).resource.attributes as Record<string, unknown>
    expect(res[ATTR.SUBJECT_KEY]).toBe('legacy-worktree')
    expect('git.repository' in res).toBe(false)
    expect('git.commit' in res).toBe(false)
  })

  it('toOpenInferenceSpan copies subject/git/cwd keys into resource attributes', () => {
    const s = stampRepoAttrs(
      [span({ traceId: 't', spanId: 's', name: 'x', kind: 'AGENT', startTime: 'now', service: 'codex', agent: 'codex' })],
      {
        [ATTR.SUBJECT_KEY]: 'github.com/o/r',
        [ATTR.GIT_REPOSITORY]: 'github.com/o/r',
        [ATTR.GIT_BRANCH_NAME]: 'feat/x',
        [ATTR.GIT_COMMIT]: 'abc1234',
        [ATTR.CWD]: '/work/r',
      },
    )[0]!
    const res = (toOpenInferenceSpan(s).resource as { attributes: Record<string, unknown> }).attributes
    expect(res['tangle.subject.key']).toBe('github.com/o/r')
    expect(res['git.repository']).toBe('github.com/o/r')
    expect(res['git.branch']).toBe('feat/x')
    expect(res['git.commit']).toBe('abc1234')
    expect(res['tangle.cwd']).toBe('/work/r')
    expect(res['service.name']).toBe('codex')
  })
})
