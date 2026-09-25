/**
 * `traces verify-safe <file|dir>`: say whether files are safe to share, using
 * agent-eval's share-safety verdict. It reads and never writes.
 *
 * A `.json` file is parsed whole and a `.jsonl` or `.ndjson` file line by
 * line; any other file is scanned as UTF-8 text. A file that cannot be read, a
 * line that is not JSON, a symlink, or bytes that are not UTF-8 text make the
 * verdict UNKNOWN, because an unread part could hold anything. Findings name
 * the file and JSON Pointer, never the matched value.
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import {
  assessShareSafety,
  combineVerdicts,
  type RedactionProfile,
  type ShareSafetyVerdict,
} from '@tangle-network/agent-eval/traces'

export interface VerifySafeOptions {
  /** Default `share`. */
  profile?: RedactionProfile
  /** Exact secret values; any surviving occurrence in any encoding makes the verdict UNSAFE. */
  knownSecrets?: readonly string[]
}

export interface VerifySafeResult extends ShareSafetyVerdict {
  target: string
  files: number
}

const JSON_LINES = new Set(['.jsonl', '.ndjson'])

export async function verifySafe(target: string, options: VerifySafeOptions = {}): Promise<VerifySafeResult> {
  const profile = options.profile ?? 'share'
  const assess = { profile, knownSecrets: options.knownSecrets }
  const verdicts: ShareSafetyVerdict[] = []
  const unreadable: string[] = []
  const files = await listFiles(target, unreadable)
  for (const file of files) {
    const label = relative(target, file) || basename(file)
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch (error) {
      unreadable.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const text = decodeUtf8(bytes)
    if (text === undefined) {
      unreadable.push(`${label}: not UTF-8 text`)
      continue
    }
    const extension = extname(file).toLowerCase()
    if (JSON_LINES.has(extension)) {
      text.split('\n').forEach((line, index) => {
        if (!line.trim()) return
        const parsed = parseJson(line)
        if (parsed === undefined) unreadable.push(`${label}:${index + 1}: not JSON`)
        else verdicts.push(located(assessShareSafety(parsed.value, assess), `${label}:${index + 1}`))
      })
    } else if (extension === '.json') {
      const parsed = parseJson(text)
      if (parsed === undefined) unreadable.push(`${label}: not JSON`)
      else verdicts.push(located(assessShareSafety(parsed.value, assess), label))
    } else {
      verdicts.push(located(assessShareSafety(text, assess), label))
    }
  }
  if (files.length === 0 && unreadable.length === 0) unreadable.push(`${target}: no files to check`)
  return { ...combineVerdicts(profile, verdicts, unreadable), target, files: files.length }
}

async function listFiles(target: string, unreadable: string[]): Promise<string[]> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(target)
  } catch (error) {
    unreadable.push(`${target}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  if (stat.isFile()) return [target]
  if (!stat.isDirectory()) {
    unreadable.push(`${target}: not a regular file or directory`)
    return []
  }
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push(path)
      else unreadable.push(`${relative(target, path)}: not a regular file`)
    }
  }
  await walk(target)
  return out
}

function decodeUtf8(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

function located(verdict: ShareSafetyVerdict, where: string): ShareSafetyVerdict {
  return {
    ...verdict,
    findings: verdict.findings.map((finding) => ({
      ...finding,
      paths: finding.paths.map((path) => `${where}#${path}`),
    })),
    unreadable: verdict.unreadable.map((entry) => `${where}#${entry}`),
  }
}

/** Exit code for a verdict: 0 SAFE or SAFE_WITH_WARNINGS, 1 UNSAFE, 2 UNKNOWN. */
export function verdictExitCode(verdict: ShareSafetyVerdict): number {
  if (verdict.status === 'UNKNOWN') return 2
  return verdict.status === 'UNSAFE' ? 1 : 0
}

/** Human-readable verdict: status, then one line per finding and unreadable part. */
export function formatVerdict(result: VerifySafeResult): string {
  const lines = [`${result.status}  ${result.target} (${result.files} file(s), profile ${result.profile})`]
  for (const finding of result.findings) {
    lines.push(
      `  ${finding.severity.padEnd(7)} ${finding.category}/${finding.detector} x${finding.count}  ${finding.paths.join(', ')}`,
    )
  }
  for (const entry of result.unreadable) lines.push(`  unread  ${entry}`)
  if (result.status === 'UNSAFE') lines.push('Refuse to share. Redact with the same profile, then run verify-safe again.')
  if (result.status === 'UNKNOWN') lines.push('Refuse to share: part of the input could not be read, so its safety is unknown.')
  return lines.join('\n')
}
