/**
 * `record` on the facts sheet: each fact's `{file, line}` in the session files,
 * so an agent quotes or cites without searching them. Run as a user runs it
 * (`traces facts <file> --format json`, `--match`) on the audit benchmark's
 * fixtures, and checked against the benchmark's gold, which comes from the
 * generator's plan rather than from any reader.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

const execFileAsync = promisify(execFile)
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')
const bench = (...args: string[]) =>
  execFileAsync(process.execPath, ['--import', tsx, join(process.cwd(), 'bench', 'audit', 'cli.ts'), ...args], { maxBuffer: 32 * 1024 * 1024 })

interface RecordLine { file: string; line: number }
/** A sheet record: `file` only when it is not the session's `recordFile`. */
interface SheetRecord { file?: string; line: number }
interface Quote { text: string; cite: string }
interface Exit { code: number | null; inScript: boolean; at: string; spanId: string; record: SheetRecord | null }
interface Facts {
  recordFile: string
  humanTurns: { value: Array<{ text: string; record: SheetRecord | null }> }
  firstFailure: { spanId?: string; record?: SheetRecord | null }
  commands: { value: Array<{ command: string; runs: number; failed: number; record: SheetRecord | null; nonZeroExits: Exit[] }> }
  changedFiles: { value: Array<{ path: string; record: SheetRecord | null }> }
}
interface Match { kind: string; text: string; record?: RecordLine | null; lastLine?: string | null }

let fixtures: string
let gold: Record<string, Record<string, unknown>>
let paths: Record<string, string>
const env = (): Record<string, string> => ({ HOME: join(fixtures, '..', 'home') })

beforeAll(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'traces-facts-citations-')))
  fixtures = join(dir, 'fixtures')
  await bench('fixtures', '--out', fixtures)
  await bench('gold', '--out', join(dir, 'gold.json'))
  gold = JSON.parse(await readFile(join(dir, 'gold.json'), 'utf8')) as typeof gold
  const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8')) as { sessions: Array<{ id: string; path: string }> }
  paths = Object.fromEntries(manifest.sessions.map((session) => [session.id, join(fixtures, session.path)]))
}, 120_000)

async function facts(session: string, ...flags: string[]): Promise<Facts> {
  const run = await runCli(['facts', paths[session]!, '--format', 'json', ...flags], { env: env() })
  expect(run.code, run.stderr).toBe(0)
  return (JSON.parse(run.stdout) as { sessions: Facts[] }).sessions[0]!
}

/** The gold's `<file>:<line>` as the absolute record `record` names. */
const cited = (quote: Quote): RecordLine => {
  const at = quote.cite.lastIndexOf(':')
  return { file: join(fixtures, quote.cite.slice(0, at)), line: Number(quote.cite.slice(at + 1)) }
}

/** A sheet record as the absolute record it names. */
const absolute = (facts: Facts, record: SheetRecord | null | undefined): RecordLine | null =>
  record == null ? null : { file: record.file ?? facts.recordFile, line: record.line }

async function recordText(record: RecordLine): Promise<string> {
  return (await readFile(record.file, 'utf8')).split('\n')[record.line - 1]!
}

describe('facts cites each fact by the record it came from', () => {
  it('cites the last two human turns at the records the gold quotes', async () => {
    const operator = await facts('codex-operator')
    const answer = gold['op.last-human-turn'] as { last: Quote; previous: Quote }
    const [previous, last] = operator.humanTurns.value.slice(-2)
    expect(last!.text).toBe(answer.last.text)
    expect(operator.recordFile).toBe(paths['codex-operator'])
    expect(absolute(operator, last!.record)).toEqual(cited(answer.last))
    expect(previous!.text).toBe(answer.previous.text)
    expect(absolute(operator, previous!.record)).toEqual(cited(answer.previous))
    expect(operator.humanTurns.value.every((turn) => turn.record !== null)).toBe(true)
  })

  it('cites the first failure at the result the gold quotes', async () => {
    const claude = await facts('claude')
    expect(absolute(claude, claude.firstFailure.record)).toEqual(cited((gold['claude.first-bash-error'] as { output: Quote }).output))
  })

  it('lists each non-zero exit by command, with the codes the gold counts and the record of each', async () => {
    const operator = await facts('codex-operator')
    const answer = gold['op.exit-codes'] as { nonzero_exec_commands: number; codes: number[] }
    const exits = operator.commands.value.flatMap((row) => row.nonZeroExits).filter((exit) => !exit.inScript)
    expect(exits).toHaveLength(answer.nonzero_exec_commands)
    expect(new Set(exits.map((exit) => exit.code))).toEqual(new Set(answer.codes))
    for (const row of operator.commands.value) expect(row.nonZeroExits).toHaveLength(row.failed)
    for (const exit of exits) {
      expect(exit.record).not.toBeNull()
      expect(await recordText(absolute(operator, exit.record)!)).toContain(`Process exited with code ${exit.code}`)
    }
    expect(operator.commands.value.every((row) => row.record !== null)).toBe(true)
  })

  it('cites the patch that added the local copy', async () => {
    const operator = await facts('codex-operator')
    const path = (gold['op.local-copy'] as { path: string }).path
    const file = operator.changedFiles.value.find((entry) => entry.path === path)
    expect(file?.record).not.toBeNull()
    expect(await recordText(absolute(operator, file!.record)!)).toContain(`Add File: ${path}`)
    expect(operator.changedFiles.value.every((entry) => entry.record !== null)).toBe(true)
  })

  it('gives a matched command the last line of its whole output, and that output\'s record', async () => {
    const answer = (gold['op.large-output'] as { last_line: Quote }).last_line
    const run = await runCli(['facts', paths['codex-operator']!, '--match', '^labctl logs', '--format', 'json'], { env: env() })
    expect(run.code, run.stderr).toBe(0)
    const [match] = (JSON.parse(run.stdout) as { matches: Match[] }).matches
    expect(match!.kind).toBe('command')
    expect(match!.lastLine).toBe(answer.text)
    expect(match!.record).toEqual(cited(answer))
    const text = await runCli(['facts', paths['codex-operator']!, '--match', '^labctl logs'], { env: env() })
    expect(text.stdout).toContain(`  ${cited(answer).file}:${cited(answer).line}  last: ${answer.text}`)
  })

  it('cites nothing under --no-content', async () => {
    const run = await runCli(['facts', paths['codex-operator']!, '--format', 'json', '--no-content'], { env: env() })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).not.toContain('"record"')
    expect(run.stdout).not.toContain('"recordFile"')
  })
})
