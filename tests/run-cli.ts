import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The built CLI, the program a user runs. */
export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js')

export interface CliRun {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export interface CliOptions {
  /** The whole environment of the run, beside PATH and TMPDIR: no variable of the caller's leaks in. */
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Another build of the CLI to run instead of this checkout's `dist/cli.js`. */
  readonly cli?: string
  /** Written to the CLI's stdin, which is then closed (an MCP client's requests). */
  readonly input?: string
}

/**
 * Spawn `node dist/cli.js` with `argv` and return what it printed and its exit
 * code. The environment is built from scratch, so a CODEX_HOME or session
 * variable on the machine running the tests cannot change what is selected.
 */
export function runCli(argv: readonly string[], options: CliOptions = {}): Promise<CliRun> {
  const cli = options.cli ?? CLI
  if (!existsSync(cli)) throw new Error(`${cli} is missing; run \`pnpm build\` before these tests`)
  const env = cliEnv(options)
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...argv], {
      cwd: options.cwd ?? process.cwd(),
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error)
        return
      }
      resolve({ stdout, stderr, code: typeof error?.code === 'number' ? error.code : 0 })
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

function cliEnv(options: CliOptions): Record<string, string> {
  return { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', NO_COLOR: '1', ...options.env }
}

/**
 * The environment that gives a spawned CLI a faked clock (`fixtures/clock.mjs`):
 * it reads `now` and stands still, or with `stepMs` jumps that far at each
 * 5-second poll timer, so a watch's next pass runs at once.
 */
export function fakeClock(now: string, stepMs?: number): Record<string, string> {
  const clock = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'clock.mjs')).href
  return { NODE_OPTIONS: `--import=${clock}`, FAKE_CLOCK_NOW: now, ...(stepMs ? { FAKE_CLOCK_STEP_MS: String(stepMs) } : {}) }
}

/**
 * Spawn a CLI that runs until interrupted (`traces watch` without `--once`),
 * and send it SIGINT once `done(stdout)` says it printed enough.
 */
export function runCliUntil(argv: readonly string[], done: (stdout: string) => boolean, options: CliOptions = {}): Promise<CliRun> {
  const cli = options.cli ?? CLI
  if (!existsSync(cli)) throw new Error(`${cli} is missing; run \`pnpm build\` before these tests`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: options.cwd ?? process.cwd(), env: cliEnv(options) })
    let stdout = ''
    let stderr = ''
    let stopped = false
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      if (!stopped && done(stdout)) {
        stopped = true
        child.kill('SIGINT')
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}
