/**
 * Every `traces …` command line the shipped markdown teaches still runs: no
 * guide, skill or README may teach a spelling the moved table rejects, a flag
 * its command does not take, or a reading command with no selection.
 *
 * Command lines come from fenced code blocks and from inline code that starts
 * with `traces ` (a bare inline `traces analyze` names the command, so only
 * its spelling is checked). Each argv goes through the moved table's own
 * matcher (`findMoved`), and its flags are checked against the flags the
 * built CLI's `traces <command> --help` lists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findMoved, movedMessage } from '../src/moved.js'
import { CLI, runCli } from './run-cli.js'

const ROOT = join(dirname(CLI), '..')

/** Spellings kept, hidden from help, until the step that moves each (spec §2.4); value-taking ones say so. */
const HIDDEN_FLAGS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  ask: { '--dir': true, '--question-budget': true, '--question-timeout': true, '--concurrency': true },
  check: { '--junit': true, '--annotations': false, '--explain': false },
  diff: { '--kind': true },
  watch: { '--window': true, '--interval': true },
}

/** Commands that read sessions and need a selection (spec §2.1), with the flags that select. */
const SELECTORS: Readonly<Record<string, readonly string[]>> = {
  facts: ['--current', '--last', '--since'],
  analyze: ['--current', '--last', '--since'],
  ask: ['--current', '--last', '--since'],
  check: ['--current', '--last', '--since', '--explain'],
  convert: ['--current', '--last', '--since'],
  mcp: ['--current', '--last', '--since'],
  bundle: ['--current'],
  upload: ['--current', '--since'],
}

function markdownFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...markdownFiles(path))
    else if (name.endsWith('.md')) found.push(path)
  }
  return found
}

type Token = { readonly word: string } | { readonly op: string }

const OPERATORS = ['2>&1', '$(', '||', '&&', '>>', '2>', '|', ';', '>', '<', '&', '(', ')']

/** A shell line as words and operators. A `<placeholder>` is part of a word, not a redirect. */
function tokens(line: string): Token[] {
  const out: Token[] = []
  let word: string | null = null
  const end = () => {
    if (word !== null) out.push({ word })
    word = null
  }
  for (let i = 0; i < line.length;) {
    const c = line[i]!
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const stop = close < 0 ? line.length : close
      word = (word ?? '') + line.slice(i + 1, stop)
      i = stop + 1
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) j++
        text += line[j]
        j++
      }
      word = (word ?? '') + text
      i = j + 1
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[i + 1]
      i += 2
    } else if (/\s/u.test(c)) {
      end()
      i++
    } else if (c === '#' && word === null) {
      break
    } else if (c === '<' && /^<[^\s<>]+>/u.test(line.slice(i))) {
      const close = line.indexOf('>', i)
      word = (word ?? '') + line.slice(i, close + 1)
      i = close + 1
    } else {
      const op = OPERATORS.find((o) => line.startsWith(o, i) && (!o.startsWith('2') || word === null))
      if (op) {
        end()
        out.push({ op })
        i += op.length
      } else {
        word = (word ?? '') + c
        i++
      }
    }
  }
  end()
  return out
}

/** The argv of every `traces` invocation on a shell line; a pinned 0.x `npx` line is the old release, on purpose. */
function invocations(line: string): string[][] {
  const words = tokens(line.replace(/^\s*\$\s+/u, ''))
  const found: string[][] = []
  let atCommand = true
  for (let i = 0; i < words.length; i++) {
    const token = words[i]!
    // `claude mcp add traces -- traces mcp …`: what follows `--` is a command line of its own.
    if ('op' in token || token.word === '--') {
      atCommand = true
      continue
    }
    if (!atCommand) continue
    atCommand = false
    let start = -1
    if (token.word === 'traces' || token.word.endsWith('/traces')) start = i + 1
    else if (token.word === 'npx' || token.word === 'pnpx') {
      let j = i + 1
      while (j < words.length && 'word' in words[j]! && (words[j] as { word: string }).word.startsWith('-')) j++
      const pkg = words[j] && 'word' in words[j]! ? (words[j] as { word: string }).word : ''
      if (/^@tangle-network\/traces(@|$)/u.test(pkg) && !/@0\./u.test(pkg)) start = j + 1
    }
    if (start < 0) continue
    const argv: string[] = []
    let j = start
    while (j < words.length && 'word' in words[j]!) argv.push((words[j++] as { word: string }).word)
    found.push(argv)
    i = j - 1
  }
  return found
}

interface Taught {
  readonly where: string
  readonly argv: readonly string[]
  /** Inline code that only names the command, as prose does. */
  readonly named: boolean
}

function taughtCommands(): Taught[] {
  const files = [join(ROOT, 'README.md'), ...['docs', 'skills', 'examples', 'diagnosis-kit'].flatMap((dir) => markdownFiles(join(ROOT, dir)))]
  const taught: Taught[] = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let fenced = false
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n]!
      if (/^\s*(```|~~~)/u.test(line)) {
        fenced = !fenced
        continue
      }
      const where = `${relative(ROOT, file)}:${n + 1}`
      if (fenced) {
        let joined = line
        while (joined.endsWith('\\') && n + 1 < lines.length) joined = `${joined.slice(0, -1)} ${lines[++n]}`
        for (const argv of invocations(joined)) taught.push({ where, argv, named: false })
        continue
      }
      for (const [, code] of line.matchAll(/`([^`]+)`/gu)) {
        if (!/^(\$\s+)?(traces|npx)\s/u.test(code!)) continue
        for (const argv of invocations(code!.replace(/\\\|/gu, '|'))) {
          taught.push({ where, argv, named: argv.length <= (argv[0] === 'bundle' && argv[1] === 'verify' ? 2 : 1) })
        }
      }
    }
  }
  return taught
}

function commandOf(argv: readonly string[]): string | undefined {
  return argv[0] === 'bundle' && argv[1] === 'verify' ? 'bundle verify' : argv[0]
}

/** A command's flags as its own help lists them, each with whether it takes a value. */
async function flagsOf(command: string): Promise<Map<string, boolean> | undefined> {
  const help = await runCli([...command.split(' '), '--help'])
  if (help.code !== 0) return undefined
  const flags = new Map<string, boolean>([['--help', false], ['-h', false]])
  for (const [, flag, value] of help.stdout.matchAll(/^ {2}(--[a-z][a-z-]*)(?: (\S+))? +\S/gmu)) flags.set(flag!, value !== undefined)
  if (flags.has('--yes')) flags.set('-y', false)
  for (const [flag, takesValue] of Object.entries(HIDDEN_FLAGS[command] ?? {})) flags.set(flag, takesValue)
  return flags
}

describe('the command lines the shipped markdown teaches', () => {
  it('use no moved spelling, only flags their command takes, and a selection where one is needed', async () => {
    const taught = taughtCommands()
    expect(taught.length).toBeGreaterThan(100)
    const flagsByCommand = new Map<string, Map<string, boolean> | undefined>()
    const problems: string[] = []
    for (const { where, argv, named } of taught) {
      const line = `${where}: traces ${argv.join(' ')}`
      const moved = findMoved(argv)
      if (moved) {
        problems.push(`${line}\n  ${movedMessage(moved, argv)}`)
        continue
      }
      const command = commandOf(argv)
      if (command === undefined || command.startsWith('-') || command.startsWith('<') || command === 'help' || command === 'version') continue
      if (!flagsByCommand.has(command)) flagsByCommand.set(command, await flagsOf(command))
      const flags = flagsByCommand.get(command)
      if (!flags) {
        problems.push(`${line}\n  unknown command ${command}`)
        continue
      }
      const refs: string[] = []
      for (let i = command.split(' ').length; i < argv.length; i++) {
        const word = argv[i]!
        if (!word.startsWith('-')) {
          refs.push(word)
          continue
        }
        if (!flags.has(word)) problems.push(`${line}\n  ${word} is not a flag of ${command}`)
        if (flags.get(word)) i++
      }
      const selectors = SELECTORS[command]
      if (selectors && !named && refs.length === 0 && !argv.includes('--help') && !selectors.some((flag) => argv.includes(flag))) {
        problems.push(`${line}\n  ${command} needs a ref or ${selectors.join(', ')}`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  }, 120_000)
})
