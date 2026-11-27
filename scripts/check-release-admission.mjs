#!/usr/bin/env node
/**
 * A release candidate passes npm admission before it is tagged.
 *
 * The Publish workflow admits the packed artifact only after a `v*` tag is pushed, so a refusal
 * there leaves a tag that published nothing, and readers of the newest tag see a version npm
 * never served. This check runs the same admission, with the Agent Runtime policy commit the
 * workflow pins, whenever `package.json` names a version npm does not have. A release commit
 * that admission refuses fails the gate and is never tagged. A version npm already has is not a
 * release candidate, and the check says so and passes.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fail(message) {
  console.error(`check:release: ${message}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const workflow = readFileSync('.github/workflows/publish.yml', 'utf8')
const policyRef = /repository: tangle-network\/agent-runtime\s+ref: ([0-9a-f]{40})/u.exec(workflow)?.[1]
if (!policyRef) fail('.github/workflows/publish.yml pins no Agent Runtime admission commit')

const response = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}`, {
  headers: { accept: 'application/json', 'cache-control': 'no-cache' },
})
if (!response.ok) fail(`the npm registry answered ${response.status} for ${pkg.name}; admission could not be checked`)
const registry = await response.json()
if (registry.versions?.[pkg.version]) {
  console.log(`check:release: ${pkg.name}@${pkg.version} is published; this commit is not a release candidate`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'traces-admission-'))
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'], ...options })
try {
  run('pnpm', ['pack', '--pack-destination', work])
  const archive = readdirSync(work).find((name) => name.endsWith('.tgz'))
  if (!archive) fail('pnpm pack wrote no archive')
  const policy = join(work, 'policy')
  run('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', 'https://github.com/tangle-network/agent-runtime.git', policy])
  run('git', ['-C', policy, 'sparse-checkout', 'set', '--no-cone', '/scripts/', '/package.json'])
  run('git', ['-C', policy, 'checkout', '-q', policyRef])
  const parser = JSON.parse(readFileSync(join(policy, 'package.json'), 'utf8')).devDependencies['oxc-parser']
  run('npm', ['install', '--prefix', join(work, 'deps'), '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', `oxc-parser@${parser}`])
  symlinkSync(join(work, 'deps', 'node_modules'), join(policy, 'node_modules'))
  try {
    execFileSync(process.execPath, [join(policy, 'scripts', 'check-version-bump.mjs'), '--archive', join(work, archive)], { stdio: 'inherit' })
  } catch {
    fail(`admission refused ${pkg.name}@${pkg.version}: change the version or the change, and tag nothing until this passes`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
