import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    NO_COLOR: '1',
    ...options.env,
  }
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
