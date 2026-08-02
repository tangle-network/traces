#!/usr/bin/env node
/**
 * Every tracked source file must be TEXT.
 *
 * A single raw control byte — a literal 0x00 where `\x00` was meant — flips a
 * file to `binary` for the whole toolchain. `grep` then answers "binary file
 * matches" and drops it from every sweep, so the file silently stops being
 * searched, reviewed, or audited while still compiling and passing tests. That
 * is the failure this guards: not a compile error, an INVISIBILITY error.
 *
 * Tab, newline and carriage return are the only C0 bytes a source file has any
 * reason to carry literally. Everything else must be written as an escape.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

/** Extensions whose contents are legitimately not text. */
const BINARY_EXTENSIONS = new Set([
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
])

const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d])

/**
 * Tracked files AND untracked ones git would accept (`--others
 * --exclude-standard`). Scanning only the index would clear a brand-new file
 * carrying a raw byte right up until the moment it is committed, which is the
 * one moment the check exists to cover.
 */
function candidateFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'buffer',
  })
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
}

/** Byte offset → 1-based line and column, counted over the bytes before it. */
function position(bytes, offset) {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (bytes[index] === 0x0a) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

const problems = []
for (const path of candidateFiles()) {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (error) {
    // A tracked path that is not readable (a deleted-but-staged file, a broken
    // symlink) is not this check's business; the build and tests catch that.
    if (error?.code === 'ENOENT') continue
    throw error
  }
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte >= 0x20 || ALLOWED_CONTROL_BYTES.has(byte)) continue
    const { line, column } = position(bytes, index)
    const escape = `\\x${byte.toString(16).padStart(2, '0')}`
    problems.push(
      `${path}:${line}:${column} holds a raw 0x${byte.toString(16).padStart(2, '0')} byte. ` +
        `Write it as the escape ${escape} — a literal control byte makes the whole file ` +
        'read as binary, and grep then excludes it from every sweep without saying so.',
    )
    break
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} file(s) are not text:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.error('source text ok: no raw control bytes in any tracked or new file')
