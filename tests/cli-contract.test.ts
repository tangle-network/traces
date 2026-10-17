/**
 * The CLI contract (spec §2.1-§2.5), through the built CLI.
 *
 * The moved table: every 0.x spelling that 1.0 removed exits 2 and prints what
 * replaces it, before any parser or reader runs, and `traces help moved` lists
 * it. Each step that moves a spelling adds its rows here, and a row never
 * leaves within 1.x.
 *
 * The command table: `traces --help` fits 40 lines, each command's help fits
 * 25 and lists exactly the flags it takes, a flag a command does not take
 * exits 2 naming where it applies, a hidden 0.x spelling still runs and is
 * absent from help, and a usage error under `--format json` is one JSON
 * object on stderr with stdout empty.
 */
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deriveHexId, llmSpan, toolSpan } from '@tangle-network/agent-trace-contract'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeFixtureHome } from './fixtures/home.js'
import { CLI, runCli } from './run-cli.js'

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

/** Step 6: refs replace the flags that named a trace; the command table owns every flag. */
const STEP_6: readonly MovedCase[] = [
  { argv: ['analyze', '--harness', 'claude-code', '--session', 'abc12345'], spelling: '--session', instead: 'traces analyze abc12345 --harness claude-code' },
  { argv: ['facts', '--otlp', 'spans.otlp.jsonl', '--format', 'json'], spelling: '--otlp', instead: 'traces facts spans.otlp.jsonl --format json' },
  { argv: ['analyze', '--supervisor-run-dir', 'runs/r1', '--out', 'r.md'], spelling: '--supervisor-run-dir', instead: 'traces analyze runs/r1 --out r.md' },
  { argv: ['watch', '--supervisor-run-dir', 'runs/r1', '--once'], spelling: '--supervisor-run-dir', instead: 'traces watch runs/r1 --once' },
  { argv: ['facts', '--all', '--since', '1d'], spelling: '--all', instead: 'traces facts --since 1d' },
  { argv: ['analyze', 'abc12345', '--workflow'], spelling: '--workflow', instead: 'traces analyze abc12345' },
  {
    argv: ['convert', 'abc12345', '--max-workflow-sessions', '200', '--out', 'f.jsonl'],
    spelling: '--max-workflow-sessions',
    instead: 'traces convert abc12345 --out f.jsonl',
  },
  { argv: ['analyze', 'spans.jsonl', '--format', 'auto'], spelling: '--format auto', instead: 'traces analyze spans.jsonl' },
  { argv: ['analyze', 'events.json', '--format', 'sandbox-events'], spelling: '--format sandbox-events', instead: 'traces analyze events.json' },
  { argv: ['stream', 'spans.jsonl', '--format', 'openinference'], spelling: '--format openinference', instead: 'traces stream spans.jsonl' },
  { argv: ['check', 'spans.jsonl', '--format', 'otlp', '--contract', 'c.json'], spelling: '--format otlp', instead: 'traces check spans.jsonl --contract c.json' },
  {
    argv: ['check', 'run.jsonl', '--format', 'claude-code', '--contract', 'c.json'],
    spelling: '--format claude-code',
    instead: 'traces check run.jsonl --contract c.json --harness claude-code',
  },
  { argv: ['check', 'rollout.jsonl', '--format', 'codex', '--contract', 'c.json'], spelling: '--format codex', instead: 'traces check rollout.jsonl --contract c.json --harness codex' },
  { argv: ['investigate', 'x'], spelling: 'investigate', instead: 'traces analyze x' },
  { argv: ['investigate', 'spans.jsonl', '--out', 'r.md'], spelling: 'investigate', instead: 'traces analyze spans.jsonl --out r.md' },
  { argv: ['export', 'events.json', '--out', 'spans.jsonl'], spelling: 'export', instead: 'traces convert events.json --out spans.jsonl' },
  { argv: ['convert', 'abc12345', '--otlp-out', 'spans.jsonl'], spelling: '--otlp-out', instead: 'traces convert abc12345 --out spans.jsonl' },
  {
    argv: ['upload', '--since', '1d', '--dry-run', '--otlp-out', 'preview.jsonl'],
    spelling: '--otlp-out',
    instead: 'traces upload --since 1d --dry-run --out preview.jsonl',
  },
  {
    // analyze keeps no span copy: the replacement is a convert, not a rewritten analyze.
    argv: ['analyze', 'abc12345', '--otlp-out', 'spans.jsonl', '--out', 'r.md'],
    spelling: '--otlp-out',
    instead: 'traces convert <ref> --out F',
  },
  pinned('--metadata', ['export', 'events.json', '--metadata', 'meta.json', '--out', 'spans.jsonl']),
  pinned('--attr', ['export', 'events.json', '--attr', 'task.id=abc', '--out', 'spans.jsonl']),
  { argv: ['watch', '--min-loop', '5'], spelling: '--min-loop', instead: 'traces watch' },
  { argv: ['analyze', 'abc12345', '--min-loop', '4'], spelling: '--min-loop', instead: 'traces analyze abc12345' },
]

/** Step 7: check writes evidence only under --out. */
const STEP_7: readonly MovedCase[] = [
  {
    argv: ['check', 'spans.jsonl', '--contract', 'c.json', '--evidence', 'evidence'],
    spelling: '--evidence',
    instead: 'traces check spans.jsonl --contract c.json --out evidence',
  },
  {
    // 0.x --out was the JSON report: there is no mechanical rewrite, so the row says what --out is now.
    argv: ['check', 'spans.jsonl', '--contract', 'c.json', '--evidence', 'evidence', '--out', 'report.json'],
    spelling: '--evidence',
    instead: 'check … --out DIR: evidence for each trace that did not pass; without --out, check writes nothing',
  },
]

/** Step 12: skills keeps its store, refresh and sweep as code defaults. */
const STEP_12: readonly MovedCase[] = [
  { argv: ['skills', '--no-refresh', '--format', 'json'], spelling: '--no-refresh', instead: 'traces skills --format json' },
  { argv: ['skills', '--since', '7d', '--store', 'skills.json', '--sweep', '5'], spelling: '--store', instead: 'traces skills --since 7d' },
]

/** Step 13: analyze answers first, calls no model and loads no config. */
const STEP_13: readonly MovedCase[] = [
  { argv: ['improve', 'abc12345', '--dir', 'packet'], spelling: 'improve', instead: 'traces analyze abc12345 --out packet' },
  { argv: ['improve', '--last', '5', '--out', 'packet'], spelling: 'improve', instead: 'traces analyze --last 5 --out packet' },
  {
    argv: ['analyze', 'abc12345', '--llm', '--budget', '0.5'],
    spelling: '--llm',
    instead: 'analyze calls no model: traces ask <ref> --question "…" --budget USD [--model ID]',
  },
  {
    argv: ['analyze', 'abc12345', '--config', 'traces.config.mjs'],
    spelling: '--config',
    instead: 'removed: run your own analysts through the SDK, analyzeSpans(spans, { registry })',
  },
]

const MOVED = [...STEP_4, ...STEP_5, ...STEP_6, ...STEP_7, ...STEP_12, ...STEP_13]

/** The visible flags of each command at this step (spec §2.2 and §2.5). */
const SELECT = ['--current', '--last', '--since', '--cwd', '--harness', '--latest-turn']
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  list: ['--last', '--since', '--cwd', '--harness', '--format'],
  facts: ['--current', '--last', '--since', '--until', '--cwd', '--harness', '--latest-turn', '--match', '--no-content', '--format', '--out'],
  analyze: ['--current', '--last', '--since', '--until', '--cwd', '--harness', '--latest-turn', '--format', '--out'],
  ask: [...SELECT, '--question', '--questions', '--budget', '--model'],
  check: ['--contract', '--current', '--last', '--since', '--cwd', '--harness', '--format', '--out'],
  diff: ['--format'],
  watch: ['--once', '--harness', '--cwd'],
  bundle: ['--current', '--harness', '--out'],
  'bundle verify': ['--format'],
  convert: [...SELECT, '--out'],
  upload: ['--current', '--since', '--cwd', '--harness', '--dry-run', '--no-content', '--yes', '--out'],
  skills: ['--since', '--unused', '--format'],
  mcp: ['--current', '--last', '--since', '--cwd', '--harness'],
}

/**
 * The 24 options of §2.5, less the two whose command takes them in a later
 * step: `--share-safe` and `--known-secret-env` (check, step 15). `--help` and
 * `--version` are global.
 */
const OPTIONS = [
  '--current', '--last', '--since', '--until', '--cwd', '--harness', '--latest-turn',
  '--format', '--out', '--match', '--no-content',
  '--question', '--questions', '--budget', '--model',
  '--contract', '--once', '--dry-run', '--yes', '--unused',
]

/** 0.x spellings kept, hidden, until the step that moves each (spec §2.4). */
const HIDDEN_COMMANDS = ['validate', 'verify-safe', 'stream']
const HIDDEN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  ask: ['--dir', '--question-budget', '--question-timeout', '--concurrency'],
  check: ['--junit', '--annotations', '--explain'],
  diff: ['--kind'],
  watch: ['--window', '--interval'],
}

let dir: string
let env: Record<string, string>
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'traces-cli-contract-'))
  // An empty home: a removed spelling must be refused before any store is read.
  env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') }
})

const lines = (text: string): string[] => text.trimEnd().split('\n')
/** The flags a help text lists, one per line. */
const listedFlags = (help: string): string[] => [...help.matchAll(/^ {2}(--[a-z][a-z-]*)/gmu)].map((match) => match[1]!)
const flagsIn = (text: string): string[] => [...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/gu)].map((match) => match[0])

describe('moved spellings', () => {
  it.each(MOVED.map((moved) => [`traces ${moved.argv.join(' ')}`, moved] as const))('%s exits 2 and prints its replacement', async (_argv, { argv, spelling, instead }) => {
    const run = await runCli(argv, { env })
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    const printed = run.stderr.trim().split('\n')
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain(`${spelling} was removed in traces 1.0`)
    expect(printed[0]).toContain(instead)
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
      [['help', 'investigate'], 'Instead: traces help analyze'],
      [['export', '--help'], 'Instead: traces convert --help'],
    ] as const) {
      const run = await runCli(argv, { env })
      expect(run.code).toBe(2)
      expect(run.stderr).toContain(instead)
    }
  })

  it('refuses --budget and --model on analyze only: ask keeps them', async () => {
    const analyze = await runCli(['analyze', 'abc12345', '--model', 'm'], { env })
    expect(analyze.code).toBe(2)
    expect(analyze.stderr).toContain('--model was removed in traces 1.0. Instead: analyze calls no model: traces ask')
    const ask = await runCli(['ask', 'missing.jsonl', '--question', 'q', '--budget', '1', '--model', 'm'], { env })
    expect(ask.stderr).not.toContain('was removed in traces 1.0')
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
  it('lists every moved spelling and changed default with its replacement', async () => {
    const run = await runCli(['help', 'moved'], { env })
    expect(run.code).toBe(0)
    for (const { spelling } of MOVED) expect(run.stdout).toContain(spelling)
    expect(run.stdout).toContain(`removed. The last version with them: ${PIN} <command>`)
    expect(run.stdout).toContain('traces convert X --out f, your scrubber on f, then traces upload f')
    expect(run.stdout).toContain('--harness default claude-code')
    expect(run.stdout).toContain('upload with no selection')
    expect(run.stdout).toContain('facts JSON by default')
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

describe('the command table', () => {
  it('prints global help in at most 40 lines, one row per command, naming only flags commands take', async () => {
    const run = await runCli(['--help'], { env })
    expect(run.code).toBe(0)
    expect(lines(run.stdout).length).toBeLessThanOrEqual(40)
    for (const command of Object.keys(COMMAND_FLAGS)) expect(run.stdout).toContain(`${command} `)
    // A row's example uses only flags its command takes.
    for (const line of lines(run.stdout).filter((row) => /^ {2}\S.* traces [a-z]/u.test(row))) {
      const command = line.slice(line.indexOf(' traces ') + 8).split(' ')[0]!
      for (const flag of flagsIn(line)) expect(COMMAND_FLAGS[command], `${flag} in: ${line}`).toContain(flag)
    }
    // Every flag it names is one some command takes.
    const taken = new Set([...Object.values(COMMAND_FLAGS).flat(), '--help'])
    for (const flag of flagsIn(run.stdout)) expect(taken.has(flag), flag).toBe(true)
    // `traces`, `traces help` and `traces -h` print the same text.
    expect((await runCli([], { env })).stdout).toBe(run.stdout)
    expect((await runCli(['help'], { env })).stdout).toBe(run.stdout)
  })

  it.each(Object.entries(COMMAND_FLAGS))('traces %s --help fits 25 lines and lists exactly its flags', async (command, flags) => {
    const argv = [...command.split(' '), '--help']
    const run = await runCli(argv, { env })
    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    expect(lines(run.stdout).length).toBeLessThanOrEqual(25)
    expect(run.stdout).toMatch(new RegExp(`^Usage: traces ${command}`, 'u'))
    expect(listedFlags(run.stdout).sort()).toEqual([...flags].sort())
    // Each example uses only flags the command lists.
    const examples = run.stdout.slice(run.stdout.indexOf('\nExamples:\n'))
    expect(examples.length).toBeGreaterThan(0)
    for (const example of lines(examples).slice(2)) {
      for (const flag of flagsIn(example.split(' | ')[0]!)) expect(flags, `${flag} in: ${example}`).toContain(flag)
    }
    expect((await runCli(['help', ...command.split(' ')], { env })).stdout).toBe(run.stdout)
  })

  it('takes the 1.0 options and no others', async () => {
    const listed = new Set<string>()
    for (const command of Object.keys(COMMAND_FLAGS)) {
      for (const flag of listedFlags((await runCli([...command.split(' '), '--help'], { env })).stdout)) listed.add(flag)
    }
    expect([...listed].sort()).toEqual([...OPTIONS].sort())
  }, 60_000)

  it('refuses a flag a command does not take, naming the commands that take it', async () => {
    const contract = await runCli(['facts', '--contract', 'x'], { env })
    expect(contract.code).toBe(2)
    expect(contract.stdout).toBe('')
    expect(contract.stderr.trim()).toBe('error: --contract does not apply to facts; it applies to: check')

    const unknown = await runCli(['list', '--frobnicate'], { env })
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown flag --frobnicate for list; traces list --help lists its flags')

    const command = await runCli(['frobnicate'], { env })
    expect(command.code).toBe(2)
    expect(command.stderr).toContain('unknown command frobnicate')
  })

  it('writes a usage error as one JSON object on stderr under --format json, with stdout empty', async () => {
    for (const argv of [['facts', '--contract', 'x', '--format', 'json'], ['list', '--last', 'zero', '--format', 'json']]) {
      const run = await runCli(argv, { env })
      expect(run.code).toBe(2)
      expect(run.stdout).toBe('')
      const printed = lines(run.stderr)
      expect(printed).toHaveLength(1)
      const error = JSON.parse(printed[0]!) as { error: string; code: string }
      expect(error.code).toBe('usage')
      expect(error.error.length).toBeGreaterThan(0)
    }
  })

  it('needs a selection: a reading command never picks its session on its own', async () => {
    const bare = await runCli(['facts'], { env })
    expect(bare.code).toBe(2)
    expect(bare.stderr).toContain('facts needs a ref, --current, --last N or --since T')

    // --cwd and --harness only narrow (agent-eval's printed analyze command adds --last 1).
    const narrowed = await runCli(['analyze', '--harness', 'opencode', '--cwd', dir], { env })
    expect(narrowed.code).toBe(2)
    expect(narrowed.stderr).toContain('--cwd and --harness only narrow')

    const upload = await runCli(['upload', '--dry-run'], { env })
    expect(upload.code).toBe(2)
    expect(upload.stderr).toContain('upload with no selection was removed in traces 1.0. Instead: traces upload --dry-run --since 24h')
  })
})

/** Two spans of one run; `status` is the tool call's OTLP status. */
async function runFile(name: string, status?: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'): Promise<string> {
  const trace = deriveHexId(`cli-contract-${name}`, 16)
  const path = join(dir, `${name}.otlp.jsonl`)
  await writeFile(path, `${[
    llmSpan({
      traceId: trace,
      spanId: deriveHexId(`${name}-llm`, 8),
      parentSpanId: null,
      name: 'turn',
      model: 'glm-5.2',
      inputTokens: 10,
      outputTokens: 2,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
    }),
    toolSpan({
      traceId: trace,
      spanId: deriveHexId(`${name}-tool`, 8),
      parentSpanId: null,
      name: 'bash',
      toolName: 'bash',
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:02.000Z',
      ...(status ? { status: { code: status } } : {}),
    }),
  ].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return path
}

/** The one JSON error object a run wrote to stderr. */
const errorOf = (stderr: string): { error: string; code: string } => JSON.parse(stderr) as { error: string; code: string }

describe('exit codes: 0 yes, 1 no, 2 could not answer, with the reason as code', () => {
  it('check exits 0 on a pass, and 2 for every verdict it could not reach', async () => {
    const run = await runFile('check-run', 'STATUS_CODE_OK')
    const contract = join(dir, 'bash.contract.json')
    await writeFile(contract, JSON.stringify({ name: 'bash-required', tools: { required: ['bash'] } }), 'utf8')

    const passed = await runCli(['check', run, '--contract', contract, '--format', 'json'], { env })
    expect(passed.code).toBe(0)
    expect(JSON.parse(passed.stdout)).toMatchObject({ contract: 'bash-required', status: 'pass', exitCode: 0 })

    const unreadable = await runCli(['check', join(dir, 'missing.otlp.jsonl'), '--contract', contract, '--format', 'json'], { env })
    expect(unreadable.code).toBe(2)
    expect(unreadable.stdout).toBe('')
    expect(errorOf(unreadable.stderr).code).toBe('unreadable')

    // Two sessions in the fixture home share the 8-character prefix 0199abcd.
    const fx = await makeFixtureHome()
    const ambiguous = await runCli(['check', '0199abcd', '--contract', contract, '--format', 'json'], { env: fx.env })
    expect(ambiguous.code).toBe(2)
    expect(ambiguous.stdout).toBe('')
    expect(errorOf(ambiguous.stderr).code).toBe('ambiguous')

    const badContract = await runCli(['check', run, '--contract', join(dir, 'no-such.contract.json'), '--format', 'json'], { env })
    expect(badContract.code).toBe(2)
    expect(errorOf(badContract.stderr).code).toBe('usage')

    const noContract = await runCli(['check', run], { env })
    expect(noContract.code).toBe(2)
    expect(noContract.stderr).toContain('check needs --contract')
  }, 60_000)

  it('diff exits 0 when two runs agree, and 2 when neither records an outcome to agree on', async () => {
    const recorded = await runFile('diff-ok', 'STATUS_CODE_OK')
    const agreed = await runCli(['diff', recorded, recorded], { env })
    expect(agreed.code).toBe(0)

    const unrecorded = await runFile('diff-unset')
    const json = await runCli(['diff', unrecorded, unrecorded, '--format', 'json'], { env })
    expect(json.code).toBe(2)
    expect(json.stdout).toBe('')
    expect(errorOf(json.stderr)).toMatchObject({ code: 'no-outcome' })
    const text = await runCli(['diff', unrecorded, unrecorded], { env })
    expect(text.code).toBe(2)
    expect(text.stderr).toContain('no recorded outcome to call agreement on')
  }, 60_000)
})

describe('hidden spellings', () => {
  it('are absent from help', async () => {
    const global = (await runCli(['--help'], { env })).stdout
    for (const command of HIDDEN_COMMANDS) expect(global).not.toMatch(new RegExp(`(^ {2}|traces )${command}($|\\s)`, 'mu'))
    for (const [command, flags] of Object.entries(HIDDEN_FLAGS)) {
      const help = (await runCli([command, '--help'], { env })).stdout
      for (const flag of flags) expect(help, `${command} --help lists ${flag}`).not.toContain(flag)
    }
    const shown = new Set(Object.values(COMMAND_FLAGS).flat())
    for (const flag of Object.values(HIDDEN_FLAGS).flat().filter((flag) => !shown.has(flag))) expect(global).not.toContain(flag)
  })

  it('still run until their step moves them', async () => {
    const trace = deriveHexId('cli-contract-trace', 16)
    const spans = join(dir, 'hidden.otlp.jsonl')
    await writeFile(spans, `${[
      llmSpan({
        traceId: trace,
        spanId: deriveHexId('llm', 8),
        parentSpanId: null,
        name: 'turn',
        model: 'glm-5.2',
        inputTokens: 10,
        outputTokens: 2,
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:00:01.000Z',
      }),
      toolSpan({
        traceId: trace,
        spanId: deriveHexId('tool', 8),
        parentSpanId: null,
        name: 'bash',
        toolName: 'bash',
        startTime: '2026-01-01T00:00:01.000Z',
        endTime: '2026-01-01T00:00:02.000Z',
      }),
    ].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    expect((await runCli(['validate', spans], { env })).code).toBe(0)
    expect((await runCli(['verify-safe', spans, '--profile', 'share', '--format', 'json'], { env })).code).toBe(0)
    const diff = await runCli(['diff', spans, spans, '--kind', 'TOOL', '--format', 'json'], { env })
    expect(diff.code).toBe(2)
    expect((JSON.parse(diff.stderr) as { code: string }).code).toBe('no-outcome')

    const stream = await runCli(['stream', spans, '--mode', 'findings', '--no-spans'], { env })
    expect(stream.code).toBe(0)
    expect(lines(stream.stdout).map((line) => (JSON.parse(line) as { event: string }).event)).toContain('session')
  }, 120_000)
})

describe('traces --version', () => {
  it('prints the version and commit the build stamped, not a package.json edited after the build', async () => {
    const root = join(dirname(CLI), '..')
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
    // The same build in another tree whose package.json was bumped without a rebuild.
    const bumped = await mkdtemp(join(tmpdir(), 'traces-version-'))
    await cp(join(root, 'dist'), join(bumped, 'dist'), { recursive: true })
    await symlink(join(root, 'node_modules'), join(bumped, 'node_modules'), 'dir')
    await writeFile(join(bumped, 'package.json'), JSON.stringify({ ...pkg, version: '99.0.0' }), 'utf8')

    const run = await runCli(['--version'], { env, cli: join(bumped, 'dist', 'cli.js') })
    expect(run.code).toBe(0)
    const stamp = run.stdout.match(/^traces (\S+) \(([0-9a-f]{12}(?:-dirty)?|unknown)\)\n$/u)
    expect(stamp, run.stdout).not.toBeNull()
    expect(stamp![1]).toBe(pkg.version)
    expect((await runCli(['-v'], { env })).stdout).toBe(run.stdout)
  })
})
