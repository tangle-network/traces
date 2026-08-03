/**
 * Counterfactual patch synthesis: one LLM call per case that turns a gold
 * incorrect step into a corrected shell command for replay-verify arm B.
 *
 * The caller is a typed outcome boundary ({ succeeded, value, error }) so a
 * provider failure is a per-case report row, never a thrown batch abort and
 * never a silent empty fix.
 */

import type { CodeTraceBenchStep } from './codetracebench.js'
import { parseObservationOutput, parseRecordedReturncode } from './replay-verify.js'

export interface ChatUsage {
  readonly promptTokens: number
  readonly completionTokens: number
}

export type ChatOutcome =
  | { readonly succeeded: true; readonly value: { content: string; usage: ChatUsage | null } }
  | { readonly succeeded: false; readonly error: string }

export interface ChatCompletionCaller {
  complete(system: string, user: string): Promise<ChatOutcome>
}

export interface ZaiChatCallerOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly maxTokens?: number
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

interface ChatCompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[]
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown }
  readonly error?: { readonly message?: unknown }
}

/** OpenAI-compatible /chat/completions caller (z.ai coding endpoint shape). */
export function zaiChatCaller(options: ZaiChatCallerOptions): ChatCompletionCaller {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async complete(system: string, user: string): Promise<ChatOutcome> {
      // Reasoning models spend output budget on reasoning before content; a cap
      // that fits the answer alone returns finish_reason=length with EMPTY
      // content. Base cap follows the engine's glm-5.2 floor; one doubled retry
      // covers long-reasoning cases without masking real provider errors.
      const baseCap = options.maxTokens ?? 16_384
      let lastError = 'empty completion content'
      for (const cap of [baseCap, baseCap * 2]) {
        const outcome = await callOnce(cap)
        if (outcome.succeeded) return outcome
        lastError = outcome.error
        if (!/finish_reason":"length/.test(outcome.error)) return outcome
      }
      return { succeeded: false, error: lastError }

      async function callOnce(maxTokens: number): Promise<ChatOutcome> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000)
      try {
        const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        })
        const bodyText = await response.text()
        if (!response.ok) {
          return { succeeded: false, error: `HTTP ${response.status}: ${bodyText.slice(0, 400)}` }
        }
        const body = JSON.parse(bodyText) as ChatCompletionResponse
        if (body.error) {
          return { succeeded: false, error: String(body.error.message ?? 'provider error') }
        }
        const content = body.choices?.[0]?.message?.content
        if (typeof content !== 'string' || content.length === 0) {
          return { succeeded: false, error: `empty completion content: ${bodyText.slice(0, 400)}` }
        }
        const promptTokens = body.usage?.prompt_tokens
        const completionTokens = body.usage?.completion_tokens
        const usage =
          typeof promptTokens === 'number' && typeof completionTokens === 'number'
            ? { promptTokens, completionTokens }
            : null
        return { succeeded: true, value: { content, usage } }
      } catch (err) {
        return { succeeded: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        clearTimeout(timer)
      }
      }
    },
  }
}

export interface FixPromptInput {
  readonly taskStatement: string | null
  readonly steps: readonly CodeTraceBenchStep[]
  /** 1-based step_id of the gold incorrect step. */
  readonly k: number
  /** Steps of context on each side of k (default 3). */
  readonly contextRadius?: number
}

/** Head+tail excerpt with an elision marker; identity below the limit. */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n… [${text.length - limit} chars elided] …\n${text.slice(-half)}`
}

function renderStep(step: CodeTraceBenchStep, marker: string): string {
  const rc = parseRecordedReturncode(step.observation)
  const output = clipText(parseObservationOutput(step.observation).trim(), 1600)
  return [
    `### step ${step.step_id}${marker}`,
    '```sh',
    clipText(step.action, 2000),
    '```',
    `returncode: ${rc ?? 'none recorded'}`,
    output.length > 0 ? `output:\n\`\`\`\n${output}\n\`\`\`` : 'output: (empty)',
  ].join('\n')
}

/** Shared user-prompt sections: task statement, ±radius context, failing step. */
function promptBody(input: FixPromptInput): string[] {
  const radius = input.contextRadius ?? 3
  const target = input.steps.find((s) => s.step_id === input.k)
  if (!target) throw new Error(`replay-fix: no step with step_id ${input.k}`)
  const context = input.steps.filter(
    (s) => s.step_id !== input.k && Math.abs(s.step_id - input.k) <= radius,
  )
  return [
    '## Task the agent was solving',
    input.taskStatement ? clipText(input.taskStatement, 4000) : '(no task statement recorded)',
    '',
    '## Surrounding steps',
    ...context.map((s) => renderStep(s, '')),
    '',
    '## Failing step to correct',
    renderStep(target, ' (INCORRECT — correct this one)'),
  ]
}

export function buildFixPrompt(input: FixPromptInput): { system: string; user: string } {
  const system = [
    'You repair one failed shell command from a recorded coding-agent trajectory.',
    'The trajectory replays inside the original docker image; every command runs as a fresh /bin/sh subshell from a fixed working directory.',
    'You are given the failing step, its recorded output, surrounding steps, and the task statement.',
    'Reply with exactly ONE corrected shell command (compound commands with && or pipes are fine) inside a single ```sh fenced block.',
    'The corrected command must accomplish the failing step\'s intent and exit 0. No prose outside the fenced block.',
  ].join('\n')
  const user = [
    ...promptBody(input),
    '',
    'Output the single corrected replacement for the failing step now.',
  ].join('\n')
  return { system, user }
}

/** One prior attempt of the fix loop, rendered into the retry prompt. */
export interface FailedFixAttempt {
  readonly attempt: number
  /** Null when the model call itself failed before producing a command. */
  readonly command: string | null
  readonly exitCode: number | null
  readonly stdoutTail: string | null
  readonly stderrTail: string | null
  readonly llmError: string | null
}

function renderFailedAttempt(prior: FailedFixAttempt): string {
  if (prior.command === null) {
    return [
      `### attempt ${prior.attempt}`,
      `model call failed before producing a command: ${prior.llmError ?? 'unknown error'}`,
    ].join('\n')
  }
  const stdout = (prior.stdoutTail ?? '').trim()
  const stderr = (prior.stderrTail ?? '').trim()
  return [
    `### attempt ${prior.attempt}`,
    '```sh',
    clipText(prior.command, 2000),
    '```',
    `exit code: ${prior.exitCode ?? 'not executed'}`,
    stdout.length > 0 ? `stdout:\n\`\`\`\n${stdout}\n\`\`\`` : 'stdout: (empty)',
    stderr.length > 0 ? `stderr:\n\`\`\`\n${stderr}\n\`\`\`` : 'stderr: (empty)',
  ].join('\n')
}

/**
 * Retry prompt for fix-loop attempts ≥2: the original context plus every prior
 * attempt with its REAL executed output, and permission to answer with a short
 * script (the block still executes as one /bin/sh unit).
 */
export function buildRetryFixPrompt(
  input: FixPromptInput,
  priorAttempts: readonly FailedFixAttempt[],
  maxScriptCommands = 5,
): { system: string; user: string } {
  if (priorAttempts.length === 0) {
    throw new Error('replay-fix: buildRetryFixPrompt requires at least one prior attempt')
  }
  const system = [
    'You repair one failed shell command from a recorded coding-agent trajectory.',
    'The trajectory replays inside the original docker image; every command runs as a fresh /bin/sh subshell from a fixed working directory.',
    'Earlier corrected commands were executed for real and failed; their actual output is included below.',
    `Reply with a corrected fix inside a single \`\`\`sh fenced block: either one command, or a short script of at most ${maxScriptCommands} commands (one per line).`,
    'The whole block executes as ONE /bin/sh unit from the fixed working directory and must exit 0.',
    'Do not repeat a command that already failed. Keep reasoning brief. No prose outside the fenced block.',
  ].join('\n')
  const user = [
    ...promptBody(input),
    '',
    '## Previous fix attempts (executed for real — all failed)',
    ...priorAttempts.map((prior) => renderFailedAttempt(prior)),
    '',
    `Output a corrected fix now — one \`\`\`sh block, at most ${maxScriptCommands} commands.`,
  ].join('\n')
  return { system, user }
}

/** Non-empty, non-comment lines of a fix script — the loop's script-size cap. */
export function countScriptCommands(script: string): number {
  return script
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#')).length
}

/** Last fenced code block, else the whole trimmed content; null when empty. */
export function extractFixCommand(content: string): string | null {
  const blocks = [...content.matchAll(/```(?:sh|bash|shell)?\n([\s\S]*?)```/g)]
  const candidate = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : content
  const command = candidate.trim()
  if (command.length === 0 || command.includes('```')) return null
  return command
}

export type FixGenerationOutcome =
  | { readonly succeeded: true; readonly value: { command: string; usage: ChatUsage | null } }
  | { readonly succeeded: false; readonly error: string }

export async function generateFixCommand(
  caller: ChatCompletionCaller,
  input: FixPromptInput,
): Promise<FixGenerationOutcome> {
  const { system, user } = buildFixPrompt(input)
  const outcome = await caller.complete(system, user)
  if (!outcome.succeeded) return outcome
  const command = extractFixCommand(outcome.value.content)
  if (command === null) {
    return {
      succeeded: false,
      error: `completion carried no usable command: ${clipText(outcome.value.content, 300)}`,
    }
  }
  return { succeeded: true, value: { command, usage: outcome.value.usage } }
}
