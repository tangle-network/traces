#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const binPath = pkg.bin?.traces

if (binPath !== 'dist/cli.js') {
  throw new Error(`package.json bin.traces must be dist/cli.js, got ${String(binPath)}`)
}

if (!existsSync(binPath)) {
  throw new Error(`missing built CLI at ${binPath}; run pnpm build first`)
}

const firstLine = readFileSync(binPath, 'utf8').split('\n')[0]
if (firstLine !== '#!/usr/bin/env node') {
  throw new Error(`${binPath} is missing the node shebang`)
}

const versionOutput = execFileSync('node', [binPath, '--version'], { encoding: 'utf8' }).trim()
if (versionOutput !== `traces ${pkg.version}`) {
  throw new Error(`unexpected --version output: ${versionOutput}`)
}

const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
const [pack] = JSON.parse(packJson)
const files = new Set(pack.files.map((file) => file.path))

for (const expected of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'install.sh', 'package.json']) {
  if (!files.has(expected)) {
    throw new Error(`npm package is missing ${expected}`)
  }
}

console.log(`package binary ok: ${pkg.name}@${pkg.version} ships ${binPath}`)
