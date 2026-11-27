/**
 * Where a bare run id resolves, and which hosts a ref that names nothing here is asked of.
 *
 * `TRACES_RUN_ROOTS` (directories joined by the path delimiter) and `TRACES_REMOTES` (host names,
 * comma or space separated) win when set, even to an empty value. Otherwise the install's config
 * file, `${XDG_CONFIG_HOME:-~/.config}/traces/config.json`, which `install.sh --run-root DIR` and
 * `--remote HOST` write: `{ "runRoots": ["/runs"], "remotes": ["host"] }`. No config means neither.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export interface TracesConfig {
  /** Directories whose children are Runtime run directories, each named by its run id. */
  readonly runRoots: readonly string[]
  /** SSH hosts whose own traces answers a ref that names nothing on this machine. */
  readonly remotes: readonly string[]
}

type Env = Readonly<Record<string, string | undefined>>

export function tracesConfigPath(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'traces', 'config.json')
}

/** The config file's lists. A malformed file is named, never read as empty. */
function fileConfig(env: Env): Partial<Record<keyof TracesConfig, string[]>> {
  const path = tracesConfigPath(env)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config: Partial<Record<keyof TracesConfig, string[]>> = {}
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object`)
  for (const key of ['runRoots', 'remotes'] as const) {
    const value = (parsed as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error(`${path}: ${key} must be a list of non-empty strings`)
    }
    config[key] = value
  }
  return config
}

export function readTracesConfig(env: Env = process.env): TracesConfig {
  const file = env.TRACES_RUN_ROOTS !== undefined && env.TRACES_REMOTES !== undefined ? {} : fileConfig(env)
  const runRoots = env.TRACES_RUN_ROOTS !== undefined ? env.TRACES_RUN_ROOTS.split(delimiter).filter(Boolean) : file.runRoots ?? []
  const remotes = env.TRACES_REMOTES !== undefined ? env.TRACES_REMOTES.split(/[\s,]+/u).filter(Boolean) : file.remotes ?? []
  return { runRoots, remotes }
}
