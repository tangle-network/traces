/**
 * Ask another host's traces. A command whose bare ref names no path, run or session on this machine
 * runs, argv unchanged, on each configured remote (`TRACES_REMOTES`, or the install's config) over SSH,
 * until one holds the ref. The remote reads its own records with its own run roots, so nothing is
 * copied here; its stdout, stderr and exit code are this command's.
 *
 * The remote runs the traces its install put under `~/.local/bin`, else the one on its PATH, with
 * `TRACES_FORWARDED=1` so it never forwards again. `TRACES_SSH` replaces `ssh` (words split on spaces).
 */
import { spawn } from 'node:child_process'

export const FORWARDED_ENV = 'TRACES_FORWARDED'

/** ssh's own failure: the host was not reached, so its answer is unknown. */
const SSH_FAILED = 255
/** The remote shell's command-not-found: the host holds no traces to ask. */
const NOT_INSTALLED = 127

/** POSIX single quoting: the remote shell sees each argument as one word. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/gu, `'\\''`)}'`
}

const REMOTE_SCRIPT =
  'for t in "$HOME/.local/bin/traces" "$(command -v traces 2>/dev/null)"; do ' +
  '[ -n "$t" ] && [ -x "$t" ] && exec "$t" "$@"; done; ' +
  'echo "traces is not installed on $(hostname); run its install.sh there" >&2; exit 127'

/** The command line the remote's login shell runs for `argv`. */
export function remoteCommand(argv: readonly string[]): string {
  return ['exec', 'env', `${FORWARDED_ENV}=1`, 'sh', '-c', shellQuote(REMOTE_SCRIPT), 'traces', ...argv.map(shellQuote)].join(' ')
}

export function isForwarded(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[FORWARDED_ENV] === '1'
}

/** The remote's own answer that it holds no such ref (text or JSON error), which sends the command to the next host. */
function namesNothing(stderr: string, ref: string): boolean {
  return stderr.includes(`starts with or ends with "${ref}"`) || stderr.includes(`starts with or ends with \\"${ref}\\"`)
}

interface HostRun {
  readonly code: number
  readonly stderr: string
}

/** One host's run: stdout streams through; stderr is held until the run is known to be an answer. */
function runOn(host: string, argv: readonly string[]): Promise<HostRun> {
  const [ssh = 'ssh', ...sshArgs] = (process.env.TRACES_SSH || 'ssh').split(/\s+/u).filter(Boolean)
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, [...sshArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remoteCommand(argv)], {
      stdio: ['inherit', 'inherit', 'pipe'],
    })
    const held: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => held.push(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 2 : 0), stderr: Buffer.concat(held).toString('utf8') }))
  })
}

/** What the remotes said: one answered (its exit code is the command's), or none did. */
export type RemoteOutcome = { readonly code: number } | { readonly unanswered: readonly string[] }

/**
 * Run `argv` on the first remote that holds `ref`. A remote that answers that it holds nothing by
 * that name, that ssh could not reach, or that has no traces installed is skipped; the last two are
 * named in `unanswered`, so the caller can say why no host answered.
 */
export async function forwardToRemotes(remotes: readonly string[], argv: readonly string[], ref: string): Promise<RemoteOutcome> {
  const unanswered: string[] = []
  for (const host of remotes) {
    const run = await runOn(host, argv)
    if (run.code === 2 && namesNothing(run.stderr, ref)) continue
    if (run.code === SSH_FAILED || run.code === NOT_INSTALLED) {
      unanswered.push(`${host} (${run.stderr.trim().split('\n').at(-1) || (run.code === SSH_FAILED ? 'ssh failed' : 'traces not installed')})`)
      continue
    }
    process.stderr.write(run.stderr)
    return { code: run.code }
  }
  return { unanswered }
}
