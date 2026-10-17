/**
 * `install.sh` never overwrites another program's `traces`. Homebrew ships an
 * unrelated `traces`, and a non-interactive shell on a Mac resolved it first;
 * the installer refuses a prefix whose `bin/traces` is not npm's link to this
 * package, names what is there, and never runs npm.
 *
 * The one faked boundary is `npm`: a stub first on PATH answers `prefix -g`,
 * records every call, and plays the install by linking the package.
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CLI } from './run-cli.js'

const INSTALL = join(dirname(CLI), '..', 'install.sh')
const run = promisify(execFile)

interface Installer {
  readonly prefix: string
  readonly calls: string
  readonly env: NodeJS.ProcessEnv
}

/** A prefix and a stub npm that logs its argv and, on install, links `bin/traces` the way npm does. */
async function installer(): Promise<Installer> {
  const root = await mkdtemp(join(tmpdir(), 'traces-install-'))
  const prefix = join(root, 'prefix')
  const stubs = join(root, 'stubs')
  const calls = join(root, 'npm-calls.log')
  await mkdir(join(prefix, 'bin'), { recursive: true })
  await mkdir(stubs, { recursive: true })
  await writeFile(join(stubs, 'npm'), [
    '#!/bin/sh',
    `echo "$*" >> '${calls}'`,
    `if [ "$1" = prefix ]; then echo '${prefix}'; exit 0; fi`,
    'if [ "$1" = install ]; then',
    `  pkg='${prefix}/lib/node_modules/@tangle-network/traces'`,
    '  mkdir -p "$pkg/dist"',
    '  printf \'#!/bin/sh\\necho "traces 1.0.0 (stub)"\\n\' > "$pkg/dist/cli.js"',
    '  chmod +x "$pkg/dist/cli.js"',
    `  ln -sfn ../lib/node_modules/@tangle-network/traces/dist/cli.js '${prefix}/bin/traces'`,
    'fi',
    '',
  ].join('\n'))
  await chmod(join(stubs, 'npm'), 0o755)
  return { prefix, calls, env: { ...process.env, PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root } }
}

async function install(at: Installer): Promise<{ code: number; stdout: string; stderr: string; npm: string }> {
  const result = await run('bash', [INSTALL, '--prefix', at.prefix], { env: at.env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  )
  return { ...result, npm: await readFile(at.calls, 'utf8').catch(() => '') }
}

describe('install.sh', () => {
  it('refuses a prefix holding another program\'s traces, names it, and never runs npm install', async () => {
    const at = await installer()
    const foreign = join(at.prefix, 'bin', 'traces')
    await writeFile(foreign, '#!/bin/sh\necho "traces 0.4.1"\n')
    await chmod(foreign, 0o755)

    const result = await install(at)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${foreign} belongs to another program`)
    expect(result.stderr).toContain('brew uninstall market-dot-dev/tap/traces')
    expect(result.stderr).toContain('--prefix')
    expect(result.npm).not.toMatch(/^install/mu)
    expect(await readFile(foreign, 'utf8')).toContain('0.4.1')
  })

  it('names where a foreign link points', async () => {
    const at = await installer()
    await symlink('../Cellar/traces/0.4.1/bin/traces', join(at.prefix, 'bin', 'traces'))

    const result = await install(at)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('(../Cellar/traces/0.4.1/bin/traces)')
    expect(result.npm).not.toMatch(/^install/mu)
  })

  it('upgrades over its own npm link', async () => {
    const at = await installer()
    await symlink('../lib/node_modules/@tangle-network/traces/dist/cli.js', join(at.prefix, 'bin', 'traces'))

    const result = await install(at)
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.npm).toContain(`install -g @tangle-network/traces@latest --prefix ${at.prefix}`)
    expect(result.stdout).toContain('traces 1.0.0 (stub)')
  })
})
