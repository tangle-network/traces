/**
 * Finding-to-replay wire: the entry point the analyst product calls to turn
 * a cited incorrect-steps finding into an executed replay-verify proof.
 *
 * A CodeTraceBench analyst finding names its trajectory and carries a subject
 * of the form `incorrect-steps-<first>-<last>-<escaped|unescaped>-consequence-<step>`.
 * The wire maps that to a replay-verify invocation: `--at` = the finding's
 * first incorrect step (which may differ from the gold label), the docker
 * image and cwd from the trajectory's raw config, and — optionally — an arm-B
 * corrected command from the counterfactual fix generator.
 */

import {
  type CaseResources,
  type CorpusSpec,
  resolveCaseResources,
} from './replay-corpus.js'
import { type ChatCompletionCaller, generateFixCommand } from './replay-fix.js'
import {
  type ReplayExecBackend,
  type ReplayVerdict,
  replayVerify,
} from './replay-verify.js'

export interface IncorrectStepsSubject {
  readonly firstStep: number
  readonly lastStep: number
  readonly escapeStatus: 'escaped' | 'unescaped'
  readonly consequenceStep: number
}

const SUBJECT_PATTERN = /^incorrect-steps-(\d+)-(\d+)-(escaped|unescaped)-consequence-(\d+)$/

/** Null when the subject is not an incorrect-steps finding subject. */
export function parseIncorrectStepsSubject(subject: string): IncorrectStepsSubject | null {
  const match = SUBJECT_PATTERN.exec(subject)
  if (!match) return null
  return {
    firstStep: Number(match[1]),
    lastStep: Number(match[2]),
    escapeStatus: match[3] as 'escaped' | 'unescaped',
    consequenceStep: Number(match[4]),
  }
}

export interface AnalystReplayFinding {
  readonly trajId: string
  readonly subject: string
}

export interface ResolvedReplayInvocation {
  readonly resources: CaseResources
  readonly subject: IncorrectStepsSubject
  /** 1-based step_id replay-verify receives as --at: the finding's first incorrect step. */
  readonly at: number
}

/**
 * Maps a finding onto replay resources, searching the given corpora for the
 * trajectory. Throws with the precise reason when the finding cannot be
 * replayed (malformed subject, unknown trajectory, non-SWE case, step out of
 * range) — the analyst product surfaces that reason instead of a proof.
 */
export function resolveFindingInvocation(
  finding: AnalystReplayFinding,
  corpora: readonly CorpusSpec[],
): ResolvedReplayInvocation {
  const subject = parseIncorrectStepsSubject(finding.subject)
  if (!subject) {
    throw new Error(
      `replay-wire: subject '${finding.subject}' is not incorrect-steps-<first>-<last>-<escaped|unescaped>-consequence-<step>`,
    )
  }
  const failures: string[] = []
  for (const corpus of corpora) {
    const resolution = resolveCaseResources(corpus, finding.trajId)
    if (resolution.resolved) {
      const at = subject.firstStep
      const step = resolution.resources.steps.find((s) => s.step_id === at)
      if (!step) {
        throw new Error(
          `replay-wire: finding step ${at} is outside ${finding.trajId} ` +
            `(${resolution.resources.steps.length} steps)`,
        )
      }
      return { resources: resolution.resources, subject, at }
    }
    failures.push(`${corpus.name}: ${resolution.reason}`)
  }
  throw new Error(
    `replay-wire: trajectory ${finding.trajId} is not replayable in any corpus — ${failures.join('; ')}`,
  )
}

export interface ReplayFindingOptions {
  readonly corpora: readonly CorpusSpec[]
  readonly out: string
  /** Generates the arm-B corrected command; omit to run arm A only. */
  readonly fixCaller?: ChatCompletionCaller
  /** Pre-supplied arm-B command; mutually exclusive with fixCaller. */
  readonly fixCommand?: string
  readonly stepTimeoutMs?: number
  readonly prefixLimit?: number
  readonly backend?: ReplayExecBackend
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly onProgress?: (message: string) => void
}

export interface ReplayFindingResult {
  readonly invocation: ResolvedReplayInvocation
  readonly fixCommand: string | null
  readonly verdict: ReplayVerdict
}

/**
 * The shape the analyst product calls: finding in, executed proof out.
 * Note the caller supplies the image via resources; when no injected backend
 * is given the image must already be replay-ready (uid-1000 derived) — batch
 * preparation lives in replay-batch's ImagePreparer.
 */
export async function replayVerifyFinding(
  finding: AnalystReplayFinding,
  options: ReplayFindingOptions,
): Promise<ReplayFindingResult> {
  if (options.fixCaller && options.fixCommand !== undefined) {
    throw new Error('replay-wire: pass fixCaller or fixCommand, not both')
  }
  const invocation = resolveFindingInvocation(finding, options.corpora)
  let fixCommand: string | null = options.fixCommand ?? null
  if (options.fixCaller) {
    const generated = await generateFixCommand(options.fixCaller, {
      taskStatement: invocation.resources.taskStatement,
      steps: invocation.resources.steps,
      k: invocation.at,
    })
    if (!generated.succeeded) {
      throw new Error(`replay-wire: fix generation failed — ${generated.error}`)
    }
    fixCommand = generated.value.command
  }
  const verdict = await replayVerify({
    stepsPath: invocation.resources.stepsPath,
    image: invocation.resources.image,
    at: invocation.at,
    fixCommand: fixCommand ?? undefined,
    cwd: invocation.resources.cwd,
    out: options.out,
    caseId: invocation.resources.trajId,
    stepTimeoutMs:
      options.stepTimeoutMs ?? invocation.resources.recordedStepTimeoutMs ?? undefined,
    prefixLimit: options.prefixLimit,
    backend: options.backend,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    onProgress: options.onProgress,
  })
  return { invocation, fixCommand, verdict }
}
