import { readFileSync } from 'node:fs'

let cached: string | undefined

/** This package's version from its own package.json. A missing version is an error, never a guess. */
export function tracesVersion(): string {
  if (cached) return cached
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json is missing version')
  cached = pkg.version
  return cached
}
