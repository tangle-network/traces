/**
 * The audit questions, each with a fixed answer schema.
 *
 * A schema field names both the JSON type an arm must return and the exact rule
 * the scorer applies to it, so the prompt an arm sees and the scorer never
 * disagree. `probes` lists the failure classes from the improvement brief that
 * the question exercises (F1 ordered user turns, F2 enumeration, F3 timestamps,
 * F4 links across spans, F5 changed files, F6 verbatim tool output, F9
 * truncation, F11 derived fields).
 */

import type { BenchManifest, BenchSessionId } from './fixtures.js'

/** One scored field. Every leaf also accepts null, which means "not in trace". */
export type Field =
  | { kind: 'count' }
  | { kind: 'string'; enum?: readonly string[] }
  | { kind: 'boolean' }
  /** ISO 8601 time, correct within 1 s. */
  | { kind: 'time' }
  /** Unordered collection, compared as a set. */
  | { kind: 'set'; of: 'integer' | 'string' }
  /** A verbatim quote with a citation of the record it came from. */
  | { kind: 'quote' }
  /** An unordered collection of quotes. */
  | { kind: 'quotes' }
  /** Objects matched by `key`; each other field is scored per object. */
  | { kind: 'records'; key: string; keyOf: 'integer' | 'string'; fields: Readonly<Record<string, Field>> }

export type AnswerSchema = Readonly<Record<string, Field>>

export interface Question {
  id: string
  session: BenchSessionId
  probes: readonly string[]
  text: string
  /** Held-out rewordings. Arms answer them with the same schema. */
  paraphrases: readonly string[]
  schema: AnswerSchema
}

const count = { kind: 'count' } as const
const time = { kind: 'time' } as const
const quoteField = { kind: 'quote' } as const

export const QUESTIONS: readonly Question[] = [
  {
    id: 'op.subagents',
    session: 'codex-operator',
    probes: ['F2'],
    text: 'How many spawn_agent calls did the session make, how many of them failed, and what task names did the successful spawns receive? Give each task name exactly as written in the task_name argument.',
    paraphrases: ['Count every native subagent spawn attempt in this session and the failed attempts among them, and list the task_name argument of each spawn that succeeded, verbatim.'],
    schema: { spawn_calls: count, failed_spawns: count, task_names: { kind: 'set', of: 'string' } },
  },
  {
    id: 'op.pull-requests',
    session: 'codex-operator',
    probes: ['F2', 'F3', 'F4'],
    text: 'Which pull requests did the session create? For each one, give its number, the time of the tool call that issued the create command, the time of the tool call that issued the successful merge command, and whether the session was shown a review of it before that merge. A review listing that came back empty is not a review.',
    paraphrases: ['List every pull request this session opened. For each, report the PR number, when the session opened it and when it merged it (use the times of the tool calls that ran those commands), and whether any review of it was visible to the session before the merge, counting an empty review list as none.'],
    schema: {
      prs: {
        kind: 'records',
        key: 'number',
        keyOf: 'integer',
        fields: { created_at: time, merged_at: time, reviewed_before_merge: { kind: 'boolean' } },
      },
    },
  },
  {
    id: 'op.runs',
    session: 'codex-operator',
    probes: ['F2'],
    text: 'How many runs did the session start successfully with `labctl run`, how many `labctl run` attempts failed, how many runs did it cancel successfully with `labctl cancel`, which specs did it start, and which --variant values did it start for the beta-probe spec?',
    paraphrases: ['Count the successful `labctl run` launches, the failed launch attempts, and the successful `labctl cancel` commands in this session. Also list the specs it launched and every beta-probe variant it launched.'],
    schema: {
      launched: count,
      failed_launches: count,
      cancelled: count,
      specs: { kind: 'set', of: 'string' },
      beta_probe_variants: { kind: 'set', of: 'string' },
    },
  },
  {
    id: 'op.last-human-turn',
    session: 'codex-operator',
    probes: ['F1'],
    text: 'What was the last message the human typed in this session, and when was it sent? Also quote the human message immediately before it. Text the harness injected into the conversation is not a human message.',
    paraphrases: ['Quote the final human-written message of this session with its timestamp, and quote the human-written message that preceded it. Ignore anything the harness inserted.'],
    schema: { last: quoteField, last_at: time, previous: quoteField },
  },
  {
    id: 'op.role',
    session: 'codex-operator',
    probes: ['F2'],
    text: 'Did this session act as an operator (it launched, changed, and merged work itself) or as an observer (it only read and steered)? Give the role, the number of pull requests it merged, the number of runs it started successfully, and the number of spawn_agent calls it made.',
    paraphrases: ['Classify this session as operator or observer, and support the classification with three counts: pull requests it merged, runs it launched successfully, and spawn_agent calls.'],
    schema: {
      role: { kind: 'string', enum: ['operator', 'observer'] },
      merged_prs: count,
      launched_runs: count,
      spawn_calls: count,
    },
  },
  {
    id: 'op.local-copy',
    session: 'codex-operator',
    probes: ['F5'],
    text: 'The shared package @acme/runtime already exports runGraph. Which file did the session add that implements its own graph runner instead of importing runGraph? Give the path as written in the patch.',
    paraphrases: ['This session re-implemented a capability that @acme/runtime already provides as runGraph. Name the file it created for that local version, using the path from the patch.'],
    schema: { path: { kind: 'string' } },
  },
  {
    id: 'op.corrections',
    session: 'codex-operator',
    probes: ['F1'],
    text: 'Quote every human message in which the human corrects the agent, meaning the human tells it to stop, to wait, or to do something differently from what it did.',
    paraphrases: ['Find each message where the human pushed back on the agent (told it to stop, hold off, or change course) and quote each one.'],
    schema: { corrections: { kind: 'quotes' } },
  },
  {
    id: 'op.time-bounds',
    session: 'codex-operator',
    probes: ['F3'],
    text: 'When were the first and the last records of this session written?',
    paraphrases: ['Give the timestamps of the earliest and the latest records in this session.'],
    schema: { first_record_at: time, last_record_at: time },
  },
  {
    id: 'op.exit-codes',
    session: 'codex-operator',
    probes: ['F2', 'F11'],
    text: 'How many direct exec_command tool calls (not commands run inside exec scripts) exited with a nonzero exit code, and which distinct nonzero exit codes occurred?',
    paraphrases: ['Among exec_command calls made directly by the agent, excluding those inside exec scripts, count the ones whose process exited nonzero and list the distinct nonzero codes.'],
    schema: { nonzero_exec_commands: count, codes: { kind: 'set', of: 'integer' } },
  },
  {
    id: 'op.changed-files',
    session: 'codex-operator',
    probes: ['F5'],
    text: 'List every file path that any apply_patch call in this session added, updated, or deleted.',
    paraphrases: ['Which files did this session change through apply_patch? Include files it created, edited, and deleted.'],
    schema: { paths: { kind: 'set', of: 'string' } },
  },
  {
    id: 'op.status-polls',
    session: 'codex-operator',
    probes: ['F2'],
    text: 'How many times did the session run `labctl status`?',
    paraphrases: ['Count the `labctl status` commands this session executed.'],
    schema: { status_commands: count },
  },
  {
    id: 'op.large-output',
    session: 'codex-operator',
    probes: ['F9'],
    text: 'Quote the last line of output from the session\'s `labctl logs` command.',
    paraphrases: ['What is the final line printed by the `labctl logs` command in this session? Quote it.'],
    schema: { last_line: quoteField },
  },
  {
    id: 'op.tokens',
    session: 'codex-operator',
    probes: ['F11'],
    text: 'What were the session\'s final cumulative input tokens, cached input tokens, and output tokens, as its last token count reported them?',
    paraphrases: ['Report the running totals of input, cached input, and output tokens at the end of this session.'],
    schema: { input_tokens: count, cached_input_tokens: count, output_tokens: count },
  },
  {
    id: 'child.lineage',
    session: 'codex-child',
    probes: ['F4'],
    text: 'Which session spawned this one, and what agent path was this session given?',
    paraphrases: ['Name the parent session id of this session and the agent path it runs under.'],
    schema: { parent_session_id: { kind: 'string' }, agent_path: { kind: 'string' } },
  },
  {
    id: 'child.own-work',
    session: 'codex-child',
    probes: ['F2', 'F3'],
    text: 'Counting only work this session did itself, not history it inherited from its parent: when did its own task start, how many tool calls did it make, and how many of its exec_command calls exited with a nonzero code?',
    paraphrases: ['Leave out any history this session inherited from its parent. When did its own task begin, how many tool calls did it issue, and how many of its exec_command calls failed with a nonzero exit code?'],
    schema: { task_started_at: time, own_tool_calls: count, failed_commands: count },
  },
  {
    id: 'child.spawned',
    session: 'codex-child',
    probes: ['F11'],
    text: 'Which sessions did this session spawn? Give their session ids, or an empty list if it spawned none.',
    paraphrases: ['List the ids of every child session this session created; answer with an empty list when there are none.'],
    schema: { spawned_session_ids: { kind: 'set', of: 'string' } },
  },
  {
    id: 'claude.tasks',
    session: 'claude',
    probes: ['F2'],
    text: 'How many Task tool calls did the main session make, which subagent_type values did they use, and what were their descriptions?',
    paraphrases: ['Count the Task subagent launches in the main transcript, and list the distinct subagent types and the description of each launch.'],
    schema: { task_calls: count, subagent_types: { kind: 'set', of: 'string' }, descriptions: { kind: 'set', of: 'string' } },
  },
  {
    id: 'claude.bash',
    session: 'claude',
    probes: ['F2'],
    text: 'Across the main session and its subagents, how many Bash tool calls were made, how many returned an error result, and how many of those errors happened inside subagents?',
    paraphrases: ['Including subagent transcripts, count all Bash calls, the Bash calls whose result was an error, and the subset of those errors that came from subagents.'],
    schema: { bash_calls: count, failed_bash_calls: count, failed_in_subagents: count },
  },
  {
    id: 'claude.first-bash-error',
    session: 'claude',
    probes: ['F6'],
    text: 'Quote the full output of the first Bash call in the main session that returned an error.',
    paraphrases: ['In the main transcript, find the earliest Bash call whose result was an error and quote its output in full.'],
    schema: { output: quoteField },
  },
]

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((question) => question.id === id)
}

const nullable = (type: string): { type: [string, 'null'] } => ({ type: [type, 'null'] })

function fieldJsonSchema(field: Field): Record<string, unknown> {
  switch (field.kind) {
    case 'count': return { ...nullable('integer'), minimum: 0 }
    case 'string': return field.enum ? { enum: [...field.enum, null] } : nullable('string')
    case 'boolean': return nullable('boolean')
    case 'time': return { ...nullable('string'), format: 'date-time' }
    case 'set': return { ...nullable('array'), items: { type: field.of }, uniqueItems: true }
    case 'quote': return QUOTE_SCHEMA
    case 'quotes': return { ...nullable('array'), items: QUOTE_SCHEMA }
    case 'records': return {
      ...nullable('array'),
      items: objectSchema({ [field.key]: { kind: field.keyOf === 'integer' ? 'count' : 'string' }, ...field.fields }),
    }
  }
}

const QUOTE_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['text', 'cite'],
  properties: {
    text: { type: 'string', description: 'Verbatim text from the session.' },
    cite: { type: 'string', description: 'A span id, a trace://<trace>/span/<span> URI, or <file>:<line> of the source record.' },
  },
} as const

function objectSchema(fields: AnswerSchema): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(fields),
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldJsonSchema(field)])),
  }
}

/** The JSON Schema (2020-12 subset) an arm's answer to this question must match. */
export function answerJsonSchema(question: Question): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...objectSchema(question.schema) }
}

export const ANSWER_RULES = [
  'Answer with one JSON object that matches the schema. Put nothing else in the answer.',
  'Use null for a value the session does not contain.',
  'Give times in ISO 8601 UTC. A time is correct within 1 second.',
  'Counts, numbers, names, and paths are scored exactly.',
  'A quote is {"text", "cite"}. The text must be verbatim. The cite must name the record the text came from: a span id, a trace://<trace>/span/<span> URI, or <file>:<line> of the source record, with the file path relative to the fixture root and the line 1-based.',
] as const

export interface PromptRow {
  question: string
  variant: number
  heldOut: boolean
  session: string
  harness: string
  sessionPath: string
  prompt: string
  schema: Record<string, unknown>
}

/** Every question and paraphrase as the exact text an arm receives. Variant 0 is the canonical wording. */
export function promptRows(manifest: BenchManifest): PromptRow[] {
  return QUESTIONS.flatMap((question) => {
    const session = manifest.sessions.find((item) => item.id === question.session)
    if (!session) throw new Error(`manifest has no session ${question.session}`)
    const schema = answerJsonSchema(question)
    return [question.text, ...question.paraphrases].map((text, variant) => ({
      question: question.id,
      variant,
      heldOut: variant > 0,
      session: session.sessionId,
      harness: session.harness,
      sessionPath: session.path,
      prompt: [
        `Session: ${session.path} (${session.harness}, session id ${session.sessionId}).`,
        `Question: ${text}`,
        'Rules:',
        ...ANSWER_RULES.map((rule) => `- ${rule}`),
        'Answer JSON Schema:',
        JSON.stringify(schema, null, 2),
      ].join('\n'),
      schema,
    }))
  })
}
