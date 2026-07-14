import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeAdoption } from '../src/adoption.js'
import { ATTR } from '../src/attributes.js'
import { serializeSpans, span, toOpenInferenceSpan } from '../src/otlp.js'
import {
  cwdMatchesSelection,
  equivalentGitCwds,
  normalizeRemote,
  resolveRepoAttrs,
  resolveSessionRepoAttrs,
  stampRepoAttrs,
} from '../src/repo.js'
import { locateSessions, parseSession } from '../src/session-source.js'
import type { HarnessTraceAdapter, OtlpSpan, SessionRef } from '../src/index.js'

const run = promisify(execFile)
const created: string[] = []

afterAll(async () => {
  for (const d of created) await rm(d, { recursive: true, force: true })
})

async function initGitRepo(dir: string, remote: string): Promise<void> {
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', dir, 'remote', 'add', 'origin', remote])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.t'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await run('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init'])
}

async function gitRepo(remote: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'traces-repo-'))
  created.push(dir)
  await initGitRepo(dir, remote)
  return dir
}

async function gitRepoUnder(base: string, name: string, remote: string): Promise<string> {
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  await initGitRepo(dir, remote)
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

describe('parseSession identity', () => {
  it('stamps one source-derived identity when the adapter omitted it', async () => {
    const spans = await parseSession(adapter(), ref('sessIdentity', null))
    const adoption = await analyzeAdoption(spans)

    expect(spans.every((item) => item.attributes[ATTR.SESSION_ID] === 'sessIdentity')).toBe(true)
    expect(adoption.identifiedSessionCount).toBe(1)
    expect(adoption.unassignedTraceCount).toBe(0)
    expect(adoption.executionGroupCount).toBe(1)
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

  it('nested cwd → nearest parent git repo labels, while preserving the original cwd', async () => {
    const repo = await gitRepo('git@github.com:tangle-network/traces.git')
    const nested = join(repo, 'src', 'adapters')
    await mkdir(nested, { recursive: true })

    const a = await resolveRepoAttrs(nested)
    expect(a[ATTR.SUBJECT_KEY]).toBe('github.com/tangle-network/traces')
    expect(a[ATTR.GIT_REPOSITORY]).toBe('github.com/tangle-network/traces')
    expect(a[ATTR.CWD]).toBe(nested)
  })
})

describe('cwd selection', () => {
  it('expands a selected git worktree to sibling worktree roots', async () => {
    const repo = await gitRepo('git@github.com:tangle-network/traces.git')
    const sibling = `${repo}-sibling`
    created.push(sibling)
    await run('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', sibling, 'HEAD'])

    const aliases = await equivalentGitCwds(sibling)
    expect(aliases).toContain(repo)
    expect(aliases).toContain(sibling)
  })

  it('locates sessions recorded under an equivalent sibling worktree', async () => {
    const repo = await gitRepo('git@github.com:tangle-network/traces.git')
    const sibling = `${repo}-sibling`
    created.push(sibling)
    await run('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', sibling, 'HEAD'])
    const session = ref('main-worktree-session', repo)
    const locatingAdapter: HarnessTraceAdapter = {
      harness: 'synthetic',
      async locate() {
        return [session, ref('wrong-prefix', `${repo}-old`)]
      },
      async parse() {
        return []
      },
    }

    const refs = await locateSessions(locatingAdapter, { cwd: sibling })
    expect(refs.map((r) => r.sessionId)).toEqual(['main-worktree-session'])
  })

  it('uses path boundaries when filtering cwd matches', () => {
    expect(cwdMatchesSelection('/tmp/repo/src', ['/tmp/repo'])).toBe(true)
    expect(cwdMatchesSelection('/tmp/repo-old', ['/tmp/repo'])).toBe(false)
  })
})

describe('resolveSessionRepoAttrs', () => {
  it('repairs lossy slash-decoded cwd paths from dashed transcript directories', async () => {
    const base = await mkdtemp(join(tmpdir(), 'traces-lossy-cwd-'))
    created.push(base)
    const repo = await gitRepoUnder(base, 'agent-runtime', 'git@github.com:tangle-network/agent-runtime.git')
    const lossyCwd = join(base, 'agent', 'runtime')

    const result = await resolveSessionRepoAttrs(lossyCwd, [])
    expect(result.source).toBe('repaired-cwd')
    expect(result.cwd).toBe(repo)
    expect(result.attrs[ATTR.SUBJECT_KEY]).toBe('github.com/tangle-network/agent-runtime')
    expect(result.attrs[ATTR.CWD]).toBe(repo)
    expect(result.attrs[ATTR.REPO_RESOLUTION_SOURCE]).toBe('repaired-cwd')
  })

  it('infers a null session cwd from absolute paths captured in tool inputs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'traces-span-cwd-'))
    created.push(base)
    const repo = await gitRepoUnder(base, 'opencode-repo', 'https://github.com/tangle-network/opencode-repo.git')
    const src = join(repo, 'src')
    await mkdir(src, { recursive: true })
    const file = join(src, 'index.ts')

    const spans = [
      span({
        traceId: 'sessSpanPath',
        spanId: 'tool-1',
        name: 'tool.bash',
        kind: 'TOOL',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'opencode',
        tool: 'bash',
        content: JSON.stringify({ cmd: `sed -n '1,20p' ${file}`, workdir: repo }),
      }),
    ]

    const result = await resolveSessionRepoAttrs(null, spans)
    expect(result.source).toBe('span-workdir')
    expect(result.cwd).toBe(repo)
    expect(result.attrs[ATTR.SUBJECT_KEY]).toBe('github.com/tangle-network/opencode-repo')
    expect(result.attrs[ATTR.CWD]).toBe(repo)
    expect(result.attrs[ATTR.REPO_RESOLUTION_SOURCE]).toBe('span-workdir')
  })

  it('prefers explicit tool workdir over a different recorded session cwd', async () => {
    const base = await mkdtemp(join(tmpdir(), 'traces-exec-cwd-'))
    created.push(base)
    const sessionRepo = await gitRepoUnder(base, 'session-repo', 'https://github.com/tangle-network/session-repo.git')
    const execRepo = await gitRepoUnder(base, 'exec-repo', 'https://github.com/tangle-network/exec-repo.git')

    const spans = [
      span({
        traceId: 'sessExecPath',
        spanId: 'tool-1',
        name: 'tool.exec_command',
        kind: 'TOOL',
        startTime: '2026-01-01T00:00:00.000Z',
        service: 'codex',
        tool: 'exec_command',
        content: JSON.stringify({ cmd: 'pnpm test', workdir: execRepo }),
      }),
    ]

    const result = await resolveSessionRepoAttrs(sessionRepo, spans)
    expect(result.source).toBe('span-workdir')
    expect(result.cwd).toBe(execRepo)
    expect(result.attrs[ATTR.SUBJECT_KEY]).toBe('github.com/tangle-network/exec-repo')
    expect(result.attrs[ATTR.REPO_RESOLUTION_SOURCE]).toBe('span-workdir')
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

  it('parseSession mutates the session ref to the repaired cwd before downstream consumers see it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'traces-ref-cwd-'))
    created.push(base)
    const repo = await gitRepoUnder(base, 'agent-runtime', 'git@github.com:tangle-network/agent-runtime.git')
    const r = ref('sessRepair', join(base, 'agent', 'runtime'))

    const spans = await parseSession(adapter(), r)
    const res = JSON.parse(serializeSpans(spans).trim().split('\n')[0]!).resource.attributes as Record<string, unknown>
    expect(r.cwd).toBe(repo)
    expect(res[ATTR.SUBJECT_KEY]).toBe('github.com/tangle-network/agent-runtime')
    expect(res[ATTR.CWD]).toBe(repo)
    expect(res[ATTR.REPO_RESOLUTION_SOURCE]).toBe('repaired-cwd')
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
        [ATTR.REPO_RESOLUTION_SOURCE]: 'span-path',
      },
    )[0]!
    const res = (toOpenInferenceSpan(s).resource as { attributes: Record<string, unknown> }).attributes
    expect(res['tangle.subject.key']).toBe('github.com/o/r')
    expect(res['git.repository']).toBe('github.com/o/r')
    expect(res['git.branch']).toBe('feat/x')
    expect(res['git.commit']).toBe('abc1234')
    expect(res['tangle.cwd']).toBe('/work/r')
    expect(res['traces.repo_resolution_source']).toBe('span-path')
    expect(res['service.name']).toBe('codex')
  })

  it('overlays explicit tool workdir labels on the individual tool span', async () => {
    const base = await mkdtemp(join(tmpdir(), 'traces-span-overlay-'))
    created.push(base)
    const sessionRepo = await gitRepoUnder(base, 'session-repo', 'https://github.com/tangle-network/session-repo.git')
    const execRepo = await gitRepoUnder(base, 'exec-repo', 'https://github.com/tangle-network/exec-repo.git')
    const ad: HarnessTraceAdapter = {
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
            service: 'codex',
            agent: 'codex',
          }),
          span({
            traceId: r.sessionId,
            spanId: 'tool-session',
            parentSpanId: `root:${r.sessionId}`,
            name: 'tool.exec_command',
            kind: 'TOOL',
            startTime: '2026-01-01T00:00:01.000Z',
            service: 'codex',
            agent: 'codex',
            tool: 'exec_command',
            content: JSON.stringify({ cmd: 'pnpm test', workdir: sessionRepo }),
          }),
          span({
            traceId: r.sessionId,
            spanId: 'tool-exec',
            parentSpanId: `root:${r.sessionId}`,
            name: 'tool.exec_command',
            kind: 'TOOL',
            startTime: '2026-01-01T00:00:02.000Z',
            service: 'codex',
            agent: 'codex',
            tool: 'exec_command',
            content: JSON.stringify({ cmd: 'pnpm test', workdir: execRepo }),
          }),
        ]
      },
    }

    const spans = await parseSession(ad, ref('sessSpanOverlay', sessionRepo))
    const rootRes = (toOpenInferenceSpan(spans[0]!).resource as { attributes: Record<string, unknown> }).attributes
    const sessionToolRes = (toOpenInferenceSpan(spans[1]!).resource as { attributes: Record<string, unknown> }).attributes
    const execToolRes = (toOpenInferenceSpan(spans[2]!).resource as { attributes: Record<string, unknown> }).attributes

    expect(rootRes[ATTR.GIT_REPOSITORY]).toBe('github.com/tangle-network/session-repo')
    expect(sessionToolRes[ATTR.CWD]).toBe(sessionRepo)
    expect(execToolRes[ATTR.GIT_REPOSITORY]).toBe('github.com/tangle-network/exec-repo')
    expect(execToolRes[ATTR.CWD]).toBe(execRepo)
    expect(execToolRes[ATTR.REPO_RESOLUTION_SOURCE]).toBe('span-workdir')
    expect(execToolRes['service.name']).toBe('codex')
    expect(execToolRes['agent.name']).toBe('codex')
  })
})
