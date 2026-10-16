/**
 * The moved table (spec §2.4): every 0.x spelling that 1.0 removed exits 2 and
 * prints what replaces it, before any parser or reader runs, and `traces help
 * moved` lists it. Each step that moves a spelling adds its rows here, and a
 * row never leaves within 1.x.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const PIN = 'npx --yes @tangle-network/traces@0.23.1'

interface MovedCase {
  readonly argv: readonly string[]
  /** The removed spelling the error names. */
  readonly spelling: string
  /** What the error tells the caller to run instead. */
  readonly instead: string
}

const pinned = (spelling: string, argv: readonly string[]): MovedCase => ({ argv, spelling, instead: `${PIN} ${argv.join(' ')}` })

/** Step 4: CodeTraceBench, replay, external engines and the redactor hook. */
const STEP_4: readonly MovedCase[] = [
  pinned('import-codetracebench', ['import-codetracebench', 'x']),
  pinned('import-codetracebench', ['import-codetracebench', 'rows.jsonl', '--trajectory-dir', 'normalized', '--out', 'out', '--revision', 'abc']),
  pinned('replay-verify', ['replay-verify', '--steps', 'steps.json', '--at', '37']),
  pinned('replay-verify-batch', ['replay-verify-batch', '--corpus', 'c.json']),
  pinned('verify-findings', ['verify-findings', '--findings', 'findings.json']),
  pinned('--analyzer', ['analyze', 'session.jsonl', '--analyzer', 'halo']),
  pinned('--analyzer-prompt', ['analyze', 'session.jsonl', '--analyzer-prompt', 'diagnose']),
  pinned('--verify-findings', ['analyze', 'session.jsonl', '--verify-findings']),
  pinned('--replay-corpus', ['analyze', 'session.jsonl', '--replay-corpus', 'h=labels.json::prepared']),
  pinned('--verify-out', ['analyze', 'session.jsonl', '--verify-out', 'receipts']),
  pinned('--trajectory-dir', ['convert', 'session.jsonl', '--trajectory-dir', 'normalized']),
  pinned('--revision', ['convert', 'session.jsonl', '--revision', 'abc']),
  {
    argv: ['upload', 'spans.otlp.jsonl', '--redactor', 'my-pii-scrubber'],
    spelling: '--redactor',
    instead: 'traces convert X --out f, your scrubber on f, then traces upload f',
  },
  pinned('--format chat-trajectory', ['convert', 'trajectory.json', '--format', 'chat-trajectory', '--out', 'spans.jsonl']),
]

/** Step 5: the second analyzer and the outputs no one reads. */
const STEP_5: readonly MovedCase[] = [
  { argv: ['index', '--harness', 'codex', '--last', '20', '--out', 'session-index.json'], spelling: 'index', instead: 'traces list --format json' },
  { argv: ['inspect', 'session-index.json', '--out', 'inspection-report.md'], spelling: 'inspect', instead: 'traces analyze <ref>' },
  { argv: ['evidence', '--since', '24h', '--out', 'policy-evidence.jsonl'], spelling: 'evidence', instead: 'traces facts --format json' },
  {
    argv: ['bundle-view', 'bundle-dir', '--view', 'evidence-only', '--out', 'writer-dir'],
    spelling: 'bundle-view',
    instead: 'traces facts <bundle-dir> --no-content',
  },
  {
    argv: ['analyze', '--source-bundle', 'bundle-dir', '--out', 'report.md'],
    spelling: '--source-bundle',
    instead: 'traces analyze bundle-dir --out report.md',
  },
  {
    argv: ['bundle', 'session.jsonl', '--view', 'evidence-only', '--out', 'bundle-dir'],
    spelling: '--view',
    instead: 'removed (bundle-view is traces facts <bundle-dir> --no-content)',
  },
  pinned('--format policy-evidence', ['convert', 'policy-evidence.jsonl', '--format', 'policy-evidence', '--out', 'spans.jsonl']),
  pinned('--format intelligence-spans', ['analyze', 'spans.jsonl', '--format', 'intelligence-spans']),
]

const MOVED = [...STEP_4, ...STEP_5]

let env: Record<string, string>
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traces-cli-contract-'))
  // An empty home: a removed spelling must be refused before any store is read.
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
})

describe('moved spellings', () => {
  it.each(MOVED.map((moved) => [`traces ${moved.argv.join(' ')}`, moved] as const))('%s exits 2 and prints its replacement', async (_argv, { argv, spelling, instead }) => {
    const run = await runCli(argv, { env })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    const lines = run.stderr.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${spelling} was removed in traces 1.0`)
    expect(lines[0]).toContain(instead)
  })

  it('prints the error as one JSON object on stderr under --format json', async () => {
    const run = await runCli(['facts', 'session.jsonl', '--analyzer', 'halo', '--format', 'json'], { env })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    const error = JSON.parse(run.stderr) as { error: string; code: string }
    expect(error.code).toBe('usage')
    expect(error.error).toContain(`${PIN} facts session.jsonl --analyzer halo --format json`)
  })

  it('refuses a removed command asked for help, rather than describing it', async () => {
    for (const [argv, instead] of [
      [['import-codetracebench', '--help'], PIN],
      [['help', 'replay-verify'], PIN],
      [['evidence', '--help'], 'Instead: traces facts --format json'],
      [['help', 'index'], 'Instead: traces list --format json'],
    ] as const) {
      const run = await runCli(argv, { env })
      expect(run.code).toBe(2)
      expect(run.stderr).toContain(instead)
    }
  })

  it('reads a question that names a removed flag as the question', async () => {
    // The question is free text: it is not the --redactor flag.
    const run = await runCli(['ask', 'missing.jsonl', '--question', '--redactor'], { env })
    expect(run.stderr).not.toContain('was removed in traces 1.0')
  })

  it('keeps a question that names a removed flag when it rewrites the argv', async () => {
    const run = await runCli(['ask', '--source-bundle', 'bundle-dir', '--question', '--source-bundle'], { env })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Instead: traces ask bundle-dir --question --source-bundle')
  })
})

describe('traces help moved', () => {
  it('lists every moved spelling with its replacement', async () => {
    const run = await runCli(['help', 'moved'], { env })
    expect(run.code).toBe(0)
    for (const { spelling } of MOVED) expect(run.stdout).toContain(spelling)
    expect(run.stdout).toContain(`removed. The last version with them: ${PIN} <command>`)
    expect(run.stdout).toContain('traces convert X --out f, your scrubber on f, then traces upload f')
  })

  it('is named by the global help, which advertises no moved spelling', async () => {
    const run = await runCli(['--help'], { env })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('traces help moved')
    for (const { spelling } of MOVED) {
      const word = spelling.split(' ').at(-1)!
      // A flag or a flag's value is advertised wherever it appears as a word. A
      // command is advertised by its entry in the command list or by a
      // `traces <command>` line; the same word in prose ("evidence") is not.
      const advertised = spelling.startsWith('--')
        ? new RegExp(`(^|[\\s(|,])${word}($|[\\s),.|])`, 'mu')
        : new RegExp(`(^ {2}|traces )${word}($|\\s)`, 'mu')
      expect(run.stdout).not.toMatch(advertised)
    }
  })
})
