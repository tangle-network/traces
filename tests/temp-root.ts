import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Most suites make temp dirs and never remove them: a Beelink held 802 leaked
 * `traces-round-trip-*` dirs (6.6 GB) on 2026-10-15. Each run gets its own
 * TMPDIR, set before the workers start so they and the CLI processes they
 * spawn inherit it, and teardown removes the whole tree. A test that forgets
 * its cleanup then leaks nothing past the run.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'traces-vitest-'))
  process.env.TMPDIR = root
  return () => rmSync(root, { recursive: true, force: true })
}
