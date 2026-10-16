/**
 * The moved table: every 0.x command and flag that traces 1.0 removed or
 * renamed, and what to run instead.
 *
 * The CLI consults it before dispatch, so an old spelling exits 2 and prints
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
   * flag given that value.
   */
  readonly was: readonly string[]
  /** What replaces it in 1.0, as `traces help moved` prints it. */
  readonly now: string
  /**
   * The spelling was removed with no 1.0 replacement, and the caller's argv
   * still runs unchanged on the last 0.x release: the error prints that
   * command line.
   */
  readonly pinned?: true
}

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
]

/** Flags whose value is free text, which may itself look like a flag. */
const FREE_TEXT_FLAGS = new Set(['--question'])

export interface MovedSpelling {
  readonly row: MovedRow
  /** The spelling of the row that argv used. */
  readonly spelling: string
}

/** The first removed spelling `argv` (the arguments after `traces`) uses, if any. */
export function findMoved(argv: readonly string[]): MovedSpelling | undefined {
  for (const row of MOVED) {
    for (const spelling of row.was) {
      if (uses(argv, spelling)) return { row, spelling }
    }
  }
  return undefined
}

function uses(argv: readonly string[], spelling: string): boolean {
  if (!spelling.startsWith('--')) {
    return argv[0] === spelling || (argv[0] === 'help' && argv[1] === spelling)
  }
  const [flag, value] = spelling.split(' ')
  for (let i = 1; i < argv.length; i++) {
    if (FREE_TEXT_FLAGS.has(argv[i]!)) {
      i++
      continue
    }
    if (argv[i] === flag && (value === undefined || argv[i + 1] === value)) return true
  }
  return false
}

/** The caller's argv on the last 0.x release, for a row that has no 1.0 replacement. */
export function pinnedCommand(argv: readonly string[]): string {
  return ['npx', '--yes', LAST_0X_RELEASE, ...argv].map(shellWord).join(' ')
}

/** The one-line error for a removed spelling. */
export function movedMessage({ row, spelling }: MovedSpelling, argv: readonly string[]): string {
  return row.pinned
    ? `${spelling} was removed in traces 1.0. The last version with it runs as: ${pinnedCommand(argv)}`
    : `${spelling} was removed in traces 1.0. Instead: ${row.now}`
}

/** `traces help moved`. */
export function renderMovedTable(): string {
  const lines = ['Moved in traces 1.0. Each old spelling exits 2 and prints its row.', '']
  for (const row of MOVED) {
    lines.push(`  ${row.was.join(', ')}`)
    lines.push(`      ${row.now}`)
  }
  return `${lines.join('\n')}\n`
}

/** `word` as a shell would need it typed: bare when safe, else single-quoted. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`
}
