/**
 * What `ask` asks with by default: the analyst model and the shape of one
 * question. A leaf module, so that parsing a command line and printing help
 * load neither the analyst engine nor the Runtime kernel, which only `ask`
 * and `analyze --llm` run.
 */

/** Model the CLI's recursive analysts use when neither `--model` nor TRACES_ANALYST_MODEL names one. */
export const DEFAULT_ANALYST_MODEL = 'gpt-5.6-luna'

/**
 * DSPy's RLM shows the model a preview of each input: a value longer than
 * 1,000 characters appears as its first and last 500 only, so the question
 * field stays under 900 characters and whole.
 */
const QUESTION_FIELD_MAX_CHARS = 900

export const ASK_QUESTION_HEADER =
  'Answer QUESTION with the trace tools and follow TRACES ASK RULES in analyst_instructions. ' +
  'The trace list is JSON after PREPARED CONTEXT: there. Cite trace://<trace_id>/span/<span_id>.'

export const QUESTION_LABEL = '\n\nQUESTION: '

/** Longest question that keeps the whole question field inside the preview. */
export const MAX_TRACE_QUESTION_CHARS = QUESTION_FIELD_MAX_CHARS - ASK_QUESTION_HEADER.length - QUESTION_LABEL.length
