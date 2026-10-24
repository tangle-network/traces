import type { SessionFact, SessionFacts } from './session-facts.js'

/**
 * A sheet with every fact that carries the person's text withheld, for
 * `--no-content`: paths, turns, replies, commands, assignment text, error
 * prose and the text of a limit notice. Counts and times stay.
 */
export function withholdContent(facts: SessionFacts): SessionFacts {
  const withheld = <T>(): SessionFact<T> => ({
    value: null, spanIds: [], unavailable: 'Content was not requested.',
  })
  return {
    ...facts,
    cwd: withheld(),
    repo: withheld(),
    humanTurns: withheld(),
    finalMessages: withheld(),
    changedFiles: withheld(),
    commands: withheld(),
    pullRequests: withheld(),
    subagents: {
      ...facts.subagents,
      value: facts.subagents.value?.map((entry) => ({
        ...entry, taskName: null, taskNameUnavailable: 'Assignment text was not requested.', agentType: null,
      })) ?? null,
    },
    firstFailure: facts.firstFailure.status === 'found'
      ? { ...facts.firstFailure, message: null, classification: facts.firstFailure.classification ? { ...facts.firstFailure.classification, reason: 'Content was not requested.' } : null }
      : facts.firstFailure,
    measurements: {
      ...facts.measurements,
      waste: {
        ...facts.measurements.waste,
        failingStreaks: {
          ...facts.measurements.waste.failingStreaks,
          value: facts.measurements.waste.failingStreaks.value?.map((streak) => ({ ...streak, command: null })) ?? null,
        },
      },
      limitStop: {
        ...facts.measurements.limitStop,
        value: facts.measurements.limitStop.value ? { ...facts.measurements.limitStop.value, text: null } : null,
      },
    },
  }
}
