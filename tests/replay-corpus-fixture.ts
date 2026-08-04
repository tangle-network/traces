import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodeTraceBenchStep } from '../src/codetracebench.js'
import type { CorpusSpec } from '../src/replay-corpus.js'

export function fixtureStep(
  id: number,
  action: string,
  returncode: number | null,
  output = '',
): CodeTraceBenchStep {
  return {
    step_id: id,
    action,
    observation:
      returncode === null
        ? null
        : `\n<returncode>${returncode}</returncode>\n<output>\n${output}\n</output>`,
    action_ref: null,
    observation_ref: null,
  }
}

export interface FixtureTrajectory {
  readonly trajId: string
  readonly steps?: CodeTraceBenchStep[]
  readonly goldIncorrectSteps?: number[]
  /** undefined = no swe_raw dir at all (terminal-bench-style case). */
  readonly raw?: {
    readonly baseImage?: string
    readonly runConfigCwd?: string
    readonly dockerCwd?: string
    readonly timeoutSeconds?: number
    readonly taskMessage?: string
  }
  /** SWE-agent layout: swe_raw/swe_agent__multi/<instance>/<instance>.traj
   *  whose info carries no docker_config. */
  readonly sweagentRaw?: { readonly instance: string }
  readonly taskMd?: string
}

/** Writes a labels file + prepared dir mirroring the CodeTraceBench layout. */
export function writeFixtureCorpus(
  root: string,
  name: string,
  trajectories: readonly FixtureTrajectory[],
): CorpusSpec {
  const preparedDir = join(root, `${name}-prepared`)
  const labels = trajectories.map((traj) => ({
    traj_id: traj.trajId,
    incorrect_stages:
      traj.goldIncorrectSteps && traj.goldIncorrectSteps.length > 0
        ? [{ stage_id: 1, incorrect_step_ids: traj.goldIncorrectSteps }]
        : [],
  }))
  const labelsPath = join(root, `${name}-labels.json`)
  writeFileSync(labelsPath, JSON.stringify(labels, null, 2))
  for (const traj of trajectories) {
    const normalized = join(preparedDir, 'normalized', traj.trajId)
    mkdirSync(normalized, { recursive: true })
    writeFileSync(join(normalized, 'steps.json'), JSON.stringify(traj.steps ?? []))
    if (traj.taskMd) writeFileSync(join(normalized, 'task.md'), traj.taskMd)
    if (traj.raw) {
      const rawDir = join(preparedDir, 'extracted', traj.trajId, 'swe_raw', 'agent')
      mkdirSync(rawDir, { recursive: true })
      const environment: Record<string, unknown> = {}
      if (traj.raw.runConfigCwd !== undefined) environment.cwd = traj.raw.runConfigCwd
      if (traj.raw.timeoutSeconds !== undefined) environment.timeout = traj.raw.timeoutSeconds
      writeFileSync(
        join(rawDir, `${traj.trajId}.traj.json`),
        JSON.stringify({
          info: {
            docker_config:
              traj.raw.baseImage !== undefined || traj.raw.dockerCwd !== undefined
                ? { base_image: traj.raw.baseImage, cwd: traj.raw.dockerCwd }
                : undefined,
            config: { environment },
          },
          messages: traj.raw.taskMessage
            ? [
                { role: 'system', content: 'You are mini-SWE.' },
                { role: 'user', content: traj.raw.taskMessage },
              ]
            : [],
        }),
      )
    } else if (traj.sweagentRaw) {
      const rawDir = join(
        preparedDir,
        'extracted',
        traj.trajId,
        'swe_raw',
        'swe_agent__multi',
        traj.sweagentRaw.instance,
      )
      mkdirSync(rawDir, { recursive: true })
      writeFileSync(
        join(rawDir, `${traj.sweagentRaw.instance}.traj`),
        JSON.stringify({
          environment: 'swe_main',
          trajectory: (traj.steps ?? []).map((s) => ({ action: s.action })),
          history: [],
          info: { exit_status: 'submitted', submission: '' },
        }),
      )
    } else {
      mkdirSync(join(preparedDir, 'extracted', traj.trajId), { recursive: true })
    }
  }
  return { name, labelsPath, preparedDir }
}
