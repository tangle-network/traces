/**
 * The moved table: every 0.x command and flag that traces 1.0 removed or
 * renamed, and what to run instead.
 *
 * The CLI consults it before parsing, so an old spelling exits 2 and prints
 * its row, with the caller's own argv rewritten where the rewrite is
 * mechanical, instead of failing as an unknown flag or running something
 * else. `traces help moved` prints the whole table. A row lands in the step
 * that makes its replacement work, and the table ships through 1.x.
 */

/** The last release that has every command and flag 1.0 removed. */
export const LAST_0X_RELEASE = '@tangle-network/traces@0.23.1'

export interface MovedRow {
  /**
   * The 0.x spellings this row covers. A bare word is a command (the first
   * argument); `--flag` is a flag anywhere in argv; `--flag value` is that
   * flag given that value. A row with none records a changed default, which
   * the command that owns it reports.
   */
  readonly was: readonly string[]
  /** How `traces help moved` names a row with no spelling. */
  readonly label?: string
  /** What replaces it in 1.0, as `traces help moved` prints it. */
  readonly now: string
  /**
   * The spelling was removed with no 1.0 replacement, and the caller's argv
   * still runs unchanged on the last 0.x release: the error prints that
   * command line.
   */
  readonly pinned?: true
  /**
   * The caller's argv in its 1.0 spelling, for a row whose rewrite is
   * mechanical: the error prints it as the command to run instead.
   * `undefined` when this argv has no mechanical rewrite.
   */
  readonly rewrite?: (argv: readonly string[]) => readonly string[] | undefined
}

/** Flags whose value is free text, which may itself look like a flag. */
const FREE_TEXT_FLAGS = new Set(['--question'])

/** Where `flag` is used as a flag in argv. A question's text is never a flag. */
function flagIndexes(argv: readonly string[], flag: string): number[] {
  const at: number[] = []
  for (let i = 1; i < argv.length; i++) {
    if (FREE_TEXT_FLAGS.has(argv[i]!)) {
      i++
      continue
    }
    if (argv[i] === flag) at.push(i)
  }
  return at
}

/** argv without `flag` (and its value, when it takes one). */
function dropFlag(argv: readonly string[], flag: string, takesValue: boolean): string[] {
  const drop = new Set<number>()
  for (const i of flagIndexes(argv, flag)) {
    drop.add(i)
    if (takesValue) drop.add(i + 1)
  }
  return argv.filter((_, i) => !drop.has(i))
}

/** `--flag X` becomes the positional ref `X`, right after the command and any refs already given. */
function flagToPositional(argv: readonly string[], flag: string): string[] {
  const values = flagIndexes(argv, flag).flatMap((i) => (argv[i + 1] === undefined ? [] : [argv[i + 1]!]))
  const rest = dropFlag(argv, flag, true)
  let at = 1
  while (at < rest.length && !rest[at]!.startsWith('-')) at++
  return [...rest.slice(0, at), ...values, ...rest.slice(at)]
}

/** The command an argv names: `traces help <command>` names its second word. */
function commandOf(argv: readonly string[]): string | undefined {
  return argv[0] === 'help' ? argv[1] : argv[0]
}

function renameCommand(argv: readonly string[], to: string): string[] {
  return argv[0] === 'help' ? ['help', to, ...argv.slice(2)] : [to, ...argv.slice(1)]
}

/** `--format` values that named an input kind in 0.x. 1.0 sniffs the input. */
const INPUT_FORMATS = ['auto', 'otlp', 'sandbox-events', 'openinference', 'claude-code', 'codex'] as const
/** Input formats that named a harness: 1.0 forces that reader with `--harness`. */
const HARNESS_FORMATS = new Set<string>(['claude-code', 'codex'])

function withoutInputFormat(argv: readonly string[]): string[] {
  let harness: string | undefined
  const drop = new Set<number>()
  for (const i of flagIndexes(argv, '--format')) {
    const kind = argv[i + 1]
    if (kind === undefined || !(INPUT_FORMATS as readonly string[]).includes(kind)) continue
    drop.add(i)
    drop.add(i + 1)
    if (HARNESS_FORMATS.has(kind)) harness = kind
  }
  const out = argv.filter((_, i) => !drop.has(i))
  if (harness !== undefined && flagIndexes(out, '--harness').length === 0) out.push('--harness', harness)
  return out
}

/** Commands whose `--otlp-out` was their one output, now `--out`. */
const OTLP_OUT_COMMANDS = new Set(['convert', 'export', 'upload'])

export const MOVED: readonly MovedRow[] = [
  {
    was: ['import-codetracebench', 'replay-verify', 'replay-verify-batch', 'verify-findings'],
    now: `removed. The last version with them: npx --yes ${LAST_0X_RELEASE} <command>`,
    pinned: true,
  },
  {
    was: ['--analyzer', '--analyzer-prompt', '--verify-findings', '--replay-corpus', '--verify-out', '--trajectory-dir', '--revision'],
    now: 'removed',
    pinned: true,
  },
  {
    was: ['--redactor'],
    now: 'traces convert X --out f, your scrubber on f, then traces upload f',
  },
  {
    was: ['--format chat-trajectory'],
    now: 'removed (traces@0.23.1)',
    pinned: true,
  },
  { was: ['index'], now: 'traces list --format json' },
  { was: ['inspect'], now: 'traces analyze <ref>' },
  { was: ['evidence'], now: 'traces facts --format json' },
  { was: ['bundle-view'], now: 'traces facts <bundle-dir> --no-content' },
  {
    was: ['--source-bundle'],
    now: 'a positional ref: traces analyze <bundle-dir>',
    rewrite: (argv) => flagToPositional(argv, '--source-bundle'),
  },
  { was: ['--view'], now: 'removed (bundle-view is traces facts <bundle-dir> --no-content)' },
  {
    was: ['--format policy-evidence', '--format intelligence-spans'],
    now: 'removed (traces@0.23.1)',
    pinned: true,
  },
  {
    was: ['--session', '--otlp', '--supervisor-run-dir'],
    now: 'a positional ref: traces analyze X',
    rewrite: (argv) => ['--session', '--otlp', '--supervisor-run-dir'].reduce(flagToPositional, [...argv]),
  },
  {
    was: ['--all'],
    now: 'the default: every harness is read, and --harness ID narrows',
    rewrite: (argv) => dropFlag(argv, '--all', false),
  },
  {
    was: ['--workflow', '--max-workflow-sessions'],
    now: 'the default: a named session brings its spawned children, up to 100',
    rewrite: (argv) => dropFlag(dropFlag(argv, '--workflow', false), '--max-workflow-sessions', true),
  },
  {
    was: INPUT_FORMATS.map((kind) => `--format ${kind}`),
    now: 'removed: the input is sniffed, and --harness ID forces a reader for a file ref',
    rewrite: withoutInputFormat,
  },
  { was: [], label: '--harness default claude-code', now: 'every harness by default; --harness ID narrows' },
  { was: ['investigate'], now: 'traces analyze …', rewrite: (argv) => renameCommand(argv, 'analyze') },
  { was: ['export'], now: 'traces convert <file> (--out FILE, or stdout)', rewrite: (argv) => renameCommand(argv, 'convert') },
  {
    was: ['--otlp-out'],
    now: '--out F on convert and upload --dry-run; analyze and ask keep no span copy, so write one with traces convert <ref> --out F',
    rewrite: (argv) => {
      const command = commandOf(argv)
      if (command === undefined || !OTLP_OUT_COMMANDS.has(command) || flagIndexes(argv, '--out').length > 0) return undefined
      const at = new Set(flagIndexes(argv, '--otlp-out'))
      return argv.map((word, i) => (at.has(i) ? '--out' : word))
    },
  },
  { was: ['--metadata', '--attr'], now: 'removed', pinned: true },
  {
    was: ['--min-loop'],
    now: 'removed: a loop is 3 identical calls',
    rewrite: (argv) => dropFlag(argv, '--min-loop', true),
  },
  { was: [], label: 'upload with no selection', now: 'traces upload --since 24h (upload needs a ref, --current or --since)' },
]

export interface MovedSpelling {
  readonly row: MovedRow
  /** The spelling of the row that argv used. */
  readonly spelling: string
}

/** The first removed spelling `argv` (the arguments after `traces`) uses, if any. */
export function findMoved(argv: readonly string[]): MovedSpelling | undefined {
  return findAllMoved(argv)[0]
}

/** Every removed spelling `argv` uses, in table order. */
function findAllMoved(argv: readonly string[]): MovedSpelling[] {
  const found: MovedSpelling[] = []
  for (const row of MOVED) {
    for (const spelling of row.was) {
      if (uses(argv, spelling)) found.push({ row, spelling })
    }
  }
  return found
}

function uses(argv: readonly string[], spelling: string): boolean {
  if (!spelling.startsWith('--')) {
    return argv[0] === spelling || (argv[0] === 'help' && argv[1] === spelling)
  }
  const [flag, value] = spelling.split(' ')
  return flagIndexes(argv, flag!).some((i) => value === undefined || argv[i + 1] === value)
}

/** The caller's argv on the last 0.x release, for a row that has no 1.0 replacement. */
export function pinnedCommand(argv: readonly string[]): string {
  return ['npx', '--yes', LAST_0X_RELEASE, ...argv].map(shellWord).join(' ')
}

/** `traces` followed by `argv`, as a shell would need it typed. */
export function tracesCommand(argv: readonly string[]): string {
  return ['traces', ...argv].map(shellWord).join(' ')
}

/**
 * The one-line error for a removed spelling. Every removed spelling the argv
 * uses is rewritten at once, so the printed command is 1.0 argv a caller can
 * run; a spelling with no mechanical rewrite is named with its row.
 */
export function movedMessage(found: MovedSpelling, argv: readonly string[]): string {
  const all = findAllMoved(argv)
  const pinned = all.find(({ row }) => row.pinned)
  if (pinned) return `${pinned.spelling} was removed in traces 1.0. The last version with it runs as: ${pinnedCommand(argv)}`
  let rewritten: readonly string[] = argv
  let mechanical = false
  const unwritten: MovedSpelling[] = []
  for (const moved of all) {
    const next = moved.row.rewrite?.(rewritten)
    if (next) {
      rewritten = next
      mechanical = true
    } else {
      unwritten.push(moved)
    }
  }
  const instead = mechanical ? tracesCommand(rewritten) : found.row.now
  const also = unwritten
    .filter(({ spelling }) => mechanical || spelling !== found.spelling)
    .map(({ row, spelling }) => `${spelling}: ${row.now}`)
  return `${found.spelling} was removed in traces 1.0. Instead: ${instead}${also.length > 0 ? ` (${also.join('; ')})` : ''}`
}

/** `traces help moved`. */
export function renderMovedTable(): string {
  const lines = ['Moved in traces 1.0. Each old spelling exits 2 and prints its row.', '']
  for (const row of MOVED) {
    lines.push(`  ${row.label ?? row.was.join(', ')}`)
    lines.push(`      ${row.now}`)
  }
  return `${lines.join('\n')}\n`
}

/** `word` as a shell would need it typed: bare when safe, else single-quoted. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`
}
