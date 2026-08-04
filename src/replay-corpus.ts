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
 * `info.docker_config.base_image`, or the caller must supply an image map
 * entry for the trajectory (families like SWE-agent record no docker config;
 * their environment identity is resolved externally and passed in, with the
 * resolution source carried on every case). Every excluded case is returned
 * with a machine-readable reason — the batch report surfaces the full
 * exclusion table, never a silently shrunk denominator.
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
  | 'gold-only-submit-step'
  | 'missing-steps-json'
  | 'gold-step-outside-steps'
  | 'cwd-underivable'

/** mini-SWE's end-of-run submit convention: the agent echoes this sentinel
 *  and dumps the diff. A gold label on this step marks a bad SUBMIT DECISION,
 *  not a failed command — there is no executable failure to reproduce, so it
 *  is never a counterfactual replay target (split3's gold labels concentrate
 *  here, which is why a constant accuse-the-submit rule scores well there). */
export const SUBMIT_ACTION_SIGNATURE = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'

/** SWE-agent's end-of-run submit is the bare ACI command `submit`. A bare
 *  `submit` cannot be a meaningful shell action (it would only ever exit 127),
 *  so treating the exact match as a submit decision is safe for every family. */
export function isSubmitAction(action: string): boolean {
  return action.includes(SUBMIT_ACTION_SIGNATURE) || action.trim() === 'submit'
}

export interface ExcludedCase {
  readonly corpus: string
  readonly trajId: string
  readonly reason: ReplayExclusionReason
  readonly detail?: string
}

export type CwdSource = 'run-config' | 'docker-config' | 'pwd-observation' | 'image-map'

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
  /** Where the docker image came from: 'docker-config' when the raw trajectory
   *  recorded it, otherwise the image-map entry's own source label (e.g.
   *  'recorded-crossref', 'mswebench-hub') so verdicts stay auditable. */
  readonly imageSource: string
  /** Per-step timeout the recorded run used, when the raw config carries one. */
  readonly recordedStepTimeoutMs: number | null
}

/** External environment-identity resolution for one trajectory. */
export interface ImageMapEntry {
  readonly image: string
  readonly cwd?: string
  readonly imageSource?: string
}

export type ImageMap = Readonly<Record<string, ImageMapEntry>>

/** Loads and strictly validates a trajId → image-map JSON file. */
export function readImageMap(path: string): ImageMap {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object of trajId → {image, cwd?, imageSource?}`)
  }
  for (const [trajId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = entry as ImageMapEntry
    if (typeof e?.image !== 'string' || e.image.length === 0) {
      throw new Error(`${path}: entry ${trajId} has no non-empty string image`)
    }
    if (e.cwd !== undefined && (typeof e.cwd !== 'string' || !e.cwd.startsWith('/'))) {
      throw new Error(`${path}: entry ${trajId} has a non-absolute cwd`)
    }
    if (e.imageSource !== undefined && typeof e.imageSource !== 'string') {
      throw new Error(`${path}: entry ${trajId} has a non-string imageSource`)
    }
  }
  return parsed as ImageMap
}

export interface ReplayableCase extends CaseResources {
  /** 1-based gold incorrect step ids, ascending. */
  readonly goldIncorrectSteps: readonly number[]
  /** k — the first gold incorrect step that is a real mid-trajectory action;
   *  submit-command golds are skipped (see SUBMIT_ACTION_SIGNATURE). */
  readonly k: number
  /** Gold steps before k skipped because their action is the submit command. */
  readonly submitGoldsSkipped: number
  /** Recorded returncode at k; null when the observation carries none. */
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
  // mini-SWE archives raw trajectories as *.traj.json; SWE-agent as *.traj.
  return entries
    .filter((relative) => relative.endsWith('.traj.json') || relative.endsWith('.traj'))
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
 * `imageMap` supplies environment identity for trajectories whose raw file
 * records no docker_config; the recorded docker_config always wins when both
 * are present.
 */
export function resolveCaseResources(
  corpus: CorpusSpec,
  trajId: string,
  imageMap?: ImageMap,
): ResourceResolution {
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
  const recordedImage = dockerConfig?.base_image
  const mapEntry = imageMap?.[trajId]
  let image: string
  let imageSource: string
  if (typeof recordedImage === 'string' && recordedImage.length > 0) {
    image = recordedImage
    imageSource = 'docker-config'
  } else if (mapEntry) {
    image = mapEntry.image
    imageSource = mapEntry.imageSource ?? 'image-map'
  } else {
    return { resolved: false, reason: 'no-docker-image', detail: rawFiles[0] }
  }
  const stepsPath = join(corpus.preparedDir, 'normalized', trajId, 'steps.json')
  if (!existsSync(stepsPath)) {
    return { resolved: false, reason: 'missing-steps-json', detail: stepsPath }
  }
  const steps = JSON.parse(readFileSync(stepsPath, 'utf8')) as CodeTraceBenchStep[]

  const runConfigCwd = raw.info?.config?.environment?.cwd
  const dockerCwd = dockerConfig?.cwd
  const mapCwd = imageSource !== 'docker-config' ? mapEntry?.cwd : undefined
  let cwd: string
  let cwdSource: CwdSource
  if (typeof runConfigCwd === 'string' && runConfigCwd.length > 0) {
    cwd = runConfigCwd
    cwdSource = 'run-config'
  } else if (typeof dockerCwd === 'string' && dockerCwd.length > 0) {
    cwd = dockerCwd
    cwdSource = 'docker-config'
  } else if (typeof mapCwd === 'string' && mapCwd.length > 0) {
    cwd = mapCwd
    cwdSource = 'image-map'
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
      imageSource,
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
 * gold incorrect step that is a real mid-trajectory action. Gold steps whose
 * action is the submit command are skipped when choosing k (counted per case);
 * a case whose golds are ALL submit steps is excluded as gold-only-submit-step.
 * Exclusion reasons are reported in resolution order:
 * raw trajectory → docker image → gold labels → steps.json → k range → cwd.
 */
export function enumerateReplayableCases(
  corpora: readonly CorpusSpec[],
  imageMap?: ImageMap,
): EnumerationResult {
  const replayable: ReplayableCase[] = []
  const excluded: ExcludedCase[] = []
  let labelEntryCount = 0
  for (const corpus of corpora) {
    for (const entry of readLabelEntries(corpus.labelsPath)) {
      labelEntryCount += 1
      const trajId = entry.traj_id
      const resolution = resolveCaseResources(corpus, trajId, imageMap)
      if (!resolution.resolved) {
        excluded.push({ corpus: corpus.name, trajId, reason: resolution.reason, detail: resolution.detail })
        continue
      }
      const gold = goldIncorrectSteps(entry)
      if (gold.length === 0) {
        excluded.push({ corpus: corpus.name, trajId, reason: 'no-gold-incorrect-step' })
        continue
      }
      const resources = resolution.resources
      let submitGoldsSkipped = 0
      let target: CodeTraceBenchStep | null = null
      let missingGoldId: number | null = null
      for (const goldId of gold) {
        const step = resources.steps.find((s) => s.step_id === goldId)
        if (!step) {
          missingGoldId = goldId
          break
        }
        if (isSubmitAction(step.action)) {
          submitGoldsSkipped += 1
          continue
        }
        target = step
        break
      }
      if (missingGoldId !== null) {
        excluded.push({
          corpus: corpus.name,
          trajId,
          reason: 'gold-step-outside-steps',
          detail: `k=${missingGoldId}, steps=${resources.steps.length}`,
        })
        continue
      }
      if (!target) {
        excluded.push({
          corpus: corpus.name,
          trajId,
          reason: 'gold-only-submit-step',
          detail: `${submitGoldsSkipped} gold step(s), all submit commands`,
        })
        continue
      }
      replayable.push({
        ...resources,
        goldIncorrectSteps: gold,
        k: target.step_id,
        submitGoldsSkipped,
        recordedReturncodeAtK: parseRecordedReturncode(target.observation),
      })
    }
  }
  return { replayable, excluded, labelEntryCount }
}
