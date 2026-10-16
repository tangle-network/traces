import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** The commit this build came from, `-dirty` when tracked files differ from it; `unknown` outside a git checkout. */
function commit(): string {
  try {
    const head = git(['rev-parse', '--short=12', 'HEAD'])
    return git(['status', '--porcelain', '--untracked-files=no']) === '' ? head : `${head}-dirty`
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: true,
  // `traces --version` prints these, so it names the build that runs, not a package.json edited after it.
  define: {
    __TRACES_VERSION__: JSON.stringify(version),
    __TRACES_COMMIT__: JSON.stringify(commit()),
  },
})
