import { readFileSync } from 'node:fs'

/**
 * Stamped by the build (`tsup.config.ts` `define`), so a built CLI reports the
 * version and commit it was built from, never a package.json edited after the
 * build. Both are absent when the source runs directly under tsx.
 */
declare const __TRACES_VERSION__: string | undefined
declare const __TRACES_COMMIT__: string | undefined

let fromSource: string | undefined

/** This package's version: the build's stamp, or the source tree's package.json. A missing version is an error, never a guess. */
export function tracesVersion(): string {
  if (typeof __TRACES_VERSION__ === 'string') return __TRACES_VERSION__
  if (fromSource) return fromSource
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json is missing version')
  fromSource = pkg.version
  return fromSource
}

/** The commit the build came from (`-dirty` when tracked files differed), `unknown` outside git, `source` under tsx. */
export function tracesCommit(): string {
  return typeof __TRACES_COMMIT__ === 'string' ? __TRACES_COMMIT__ : 'source'
}
