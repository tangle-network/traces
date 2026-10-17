/** The kit runs the public `traces` CLI built from this checkout (`pnpm build`), never its source. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

export interface TracesRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** `traces <argv…>`: what it printed and its exit code (0 yes, 1 no, 2 could not answer). */
export function traces(argv: readonly string[]): TracesRun {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing; run \`pnpm build\` in the traces checkout first`)
  const run = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (run.error) throw run.error
  return { code: run.status ?? 2, stdout: run.stdout, stderr: run.stderr }
}

/** The one-line reason a run printed on stderr, for an error message. */
export function reason(run: TracesRun): string {
  return run.stderr.trim().split('\n').at(-1) || `exit ${run.code}`
}
