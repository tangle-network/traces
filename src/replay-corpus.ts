/**
 * Corpus enumeration for batch replay-verification.
 *
 * A CodeTraceBench corpus is a gold label file (array of trajectory entries
 * with `incorrect_stages[].incorrect_step_ids`) plus a prepared directory:
 *   <prepared>/normalized/<traj_id>/steps.json   CodeTracer-normalized steps
 *   <prepared>/normalized/<traj_id>/task.md      optional task statement
 *   <prepared>/extracted/<traj_id>/swe_raw/**    raw mini-SWE trajectory
 *
 * Only SWE-style trajectories are replayable: the raw trajectory must carry
 * `info.docker_config.base_image`. Every excluded case is returned with a
 * machine-readable reason — the batch report surfaces the full exclusion
 * table, never a silently shrunk denominator.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodeTraceBenchStep } from './codetracebench.js'
import { parseObservationOutput, parseRecordedReturncode } from './replay-verify.js'

export interface CorpusSpec {
  readonly name: string
  readonly labelsPath: string
  readonly preparedDir: string
}

/** Parses `name=<labelsPath>::<preparedDir>` (paths may contain `=`, not `::`). */
export function parseCorpusFlag(value: string): CorpusSpec {
  const eq = value.indexOf('=')
  if (eq <= 0) throw new Error(`--corpus must be name=<labels>::<prepared>, got: ${value}`)
  const name = value.slice(0, eq)
  const rest = value.slice(eq + 1)
  const sep = rest.indexOf('::')
  if (sep <= 0 || sep === rest.length - 2) {
    throw new Error(`--corpus must be name=<labels>::<prepared>, got: ${value}`)
  }
  return { name, labelsPath: rest.slice(0, sep), preparedDir: rest.slice(sep + 2) }
}

export type ReplayExclusionReason =
  | 'no-swe-raw-trajectory'
  | 'ambiguous-swe-raw-trajectory'
  | 'unreadable-raw-trajectory'
  | 'no-docker-image'
  | 'no-gold-incorrect-step'
  | 'missing-steps-json'
  | 'gold-step-outside-steps'
  | 'cwd-underivable'

export interface ExcludedCase {
  readonly corpus: string
  readonly trajId: string
  readonly reason: ReplayExclusionReason
  readonly detail?: string
}

export type CwdSource = 'run-config' | 'docker-config' | 'pwd-observation'

/** Everything needed to invoke replay-verify for one trajectory. */
export interface CaseResources {
  readonly corpus: string
  readonly trajId: string
  readonly stepsPath: string
  readonly steps: readonly CodeTraceBenchStep[]
  readonly taskStatement: string | null
  readonly image: string
  readonly cwd: string
  readonly cwdSource: CwdSource
  /** Per-step timeout the recorded run used, when the raw config carries one. */
  readonly recordedStepTimeoutMs: number | null
}

export interface ReplayableCase extends CaseResources {
  /** 1-based gold incorrect step ids, ascending. */
  readonly goldIncorrectSteps: readonly number[]
  /** k — the first gold incorrect step; the batch replays the prefix to here. */
  readonly k: number
  /** Recorded returncode at k; null means the gold step carries no
   *  verifiable failure signature (typically an end-of-run submit step). */
  readonly recordedReturncodeAtK: number | null
}

interface LabelEntry {
  readonly traj_id: string
  readonly incorrect_stages?: readonly { readonly incorrect_step_ids?: readonly number[] }[]
}

export function readLabelEntries(labelsPath: string): LabelEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(labelsPath, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${labelsPath} is not a JSON array of label entries`)
  for (const entry of parsed) {
    if (typeof (entry as LabelEntry).traj_id !== 'string') {
      throw new Error(`${labelsPath} has an entry without a string traj_id`)
    }
  }
  return parsed as LabelEntry[]
}

export function goldIncorrectSteps(entry: LabelEntry): number[] {
  const ids = new Set<number>()
  for (const stage of entry.incorrect_stages ?? []) {
    for (const id of stage.incorrect_step_ids ?? []) ids.add(id)
  }
  return [...ids].sort((a, b) => a - b)
}

interface RawTrajInfo {
  readonly docker_config?: { readonly base_image?: unknown; readonly cwd?: unknown }
  readonly config?: { readonly environment?: { readonly cwd?: unknown; readonly timeout?: unknown } }
}

interface RawTrajFile {
  readonly info?: RawTrajInfo
  readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[]
}

function findRawTrajFiles(sweRawDir: string): string[] {
  if (!existsSync(sweRawDir)) return []
  const entries = readdirSync(sweRawDir, { recursive: true, encoding: 'utf8' })
  return entries
    .filter((relative) => relative.endsWith('.traj.json'))
    .map((relative) => join(sweRawDir, relative))
    .sort()
}

/** First non-empty output line of the trajectory's first bare `pwd` step. */
function cwdFromPwdObservation(steps: readonly CodeTraceBenchStep[]): string | null {
  for (const step of steps) {
    if (step.action.trim() !== 'pwd') continue
    const line = parseObservationOutput(step.observation)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('/'))
    if (line) return line
  }
  return null
}

function taskStatementOf(preparedDir: string, trajId: string, raw: RawTrajFile): string | null {
  const taskPath = join(preparedDir, 'normalized', trajId, 'task.md')
  if (existsSync(taskPath)) {
    const text = readFileSync(taskPath, 'utf8').trim()
    if (text.length > 0) return text
  }
  const userMessage = raw.messages?.find((m) => m.role === 'user')
  if (typeof userMessage?.content === 'string' && userMessage.content.trim().length > 0) {
    return userMessage.content.trim()
  }
  return null
}

export type ResourceResolution =
  | { readonly resolved: true; readonly resources: CaseResources }
  | { readonly resolved: false; readonly reason: ReplayExclusionReason; readonly detail?: string }

/**
 * Resolves the replay resources for one trajectory, independent of gold
 * labels — the analyst wire uses this with a finding-supplied step instead.
 */
export function resolveCaseResources(corpus: CorpusSpec, trajId: string): ResourceResolution {
  const sweRawDir = join(corpus.preparedDir, 'extracted', trajId, 'swe_raw')
  const rawFiles = findRawTrajFiles(sweRawDir)
  if (rawFiles.length === 0) {
    return { resolved: false, reason: 'no-swe-raw-trajectory', detail: sweRawDir }
  }
  if (rawFiles.length > 1) {
    return { resolved: false, reason: 'ambiguous-swe-raw-trajectory', detail: rawFiles.join(', ') }
  }
  let raw: RawTrajFile
  try {
    raw = JSON.parse(readFileSync(rawFiles[0]!, 'utf8')) as RawTrajFile
  } catch (err) {
    return {
      resolved: false,
      reason: 'unreadable-raw-trajectory',
      detail: `${rawFiles[0]}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const dockerConfig = raw.info?.docker_config
  const image = dockerConfig?.base_image
  if (typeof image !== 'string' || image.length === 0) {
    return { resolved: false, reason: 'no-docker-image', detail: rawFiles[0] }
  }
  const stepsPath = join(corpus.preparedDir, 'normalized', trajId, 'steps.json')
  if (!existsSync(stepsPath)) {
    return { resolved: false, reason: 'missing-steps-json', detail: stepsPath }
  }
  const steps = JSON.parse(readFileSync(stepsPath, 'utf8')) as CodeTraceBenchStep[]

  const runConfigCwd = raw.info?.config?.environment?.cwd
  const dockerCwd = dockerConfig?.cwd
  let cwd: string
  let cwdSource: CwdSource
  if (typeof runConfigCwd === 'string' && runConfigCwd.length > 0) {
    cwd = runConfigCwd
    cwdSource = 'run-config'
  } else if (typeof dockerCwd === 'string' && dockerCwd.length > 0) {
    cwd = dockerCwd
    cwdSource = 'docker-config'
  } else {
    const observed = cwdFromPwdObservation(steps)
    if (!observed) return { resolved: false, reason: 'cwd-underivable' }
    cwd = observed
    cwdSource = 'pwd-observation'
  }

  const recordedTimeout = raw.info?.config?.environment?.timeout
  return {
    resolved: true,
    resources: {
      corpus: corpus.name,
      trajId,
      stepsPath,
      steps,
      taskStatement: taskStatementOf(corpus.preparedDir, trajId, raw),
      image,
      cwd,
      cwdSource,
      recordedStepTimeoutMs:
        typeof recordedTimeout === 'number' && recordedTimeout > 0 ? recordedTimeout * 1000 : null,
    },
  }
}

export interface EnumerationResult {
  readonly replayable: ReplayableCase[]
  readonly excluded: ExcludedCase[]
  readonly labelEntryCount: number
}

/**
 * Replayable = SWE-style raw trajectory with a docker image AND at least one
 * gold incorrect step. Exclusion reasons are reported in resolution order:
 * raw trajectory → docker image → gold labels → steps.json → k range → cwd.
 */
export function enumerateReplayableCases(corpora: readonly CorpusSpec[]): EnumerationResult {
  const replayable: ReplayableCase[] = []
  const excluded: ExcludedCase[] = []
  let labelEntryCount = 0
  for (const corpus of corpora) {
    for (const entry of readLabelEntries(corpus.labelsPath)) {
      labelEntryCount += 1
      const trajId = entry.traj_id
      const resolution = resolveCaseResources(corpus, trajId)
      if (!resolution.resolved) {
        excluded.push({ corpus: corpus.name, trajId, reason: resolution.reason, detail: resolution.detail })
        continue
      }
      const gold = goldIncorrectSteps(entry)
      if (gold.length === 0) {
        excluded.push({ corpus: corpus.name, trajId, reason: 'no-gold-incorrect-step' })
        continue
      }
      const k = gold[0]!
      const resources = resolution.resources
      const target = resources.steps.find((s) => s.step_id === k)
      if (!target) {
        excluded.push({
          corpus: corpus.name,
          trajId,
          reason: 'gold-step-outside-steps',
          detail: `k=${k}, steps=${resources.steps.length}`,
        })
        continue
      }
      replayable.push({
        ...resources,
        goldIncorrectSteps: gold,
        k,
        recordedReturncodeAtK: parseRecordedReturncode(target.observation),
      })
    }
  }
  return { replayable, excluded, labelEntryCount }
}
