/**
 * Provenance markers for spans an adapter did NOT take from an action the agent
 * performed inside the parsed scope.
 *
 * Three cases, and all of them used to be invisible:
 *
 *   - SYNTHESIZED — the adapter built the span from harness lifecycle events,
 *     not from a call the model issued. A Codex subagent's start/finish stream
 *     is one span per child thread; recording it as a TOOL call named
 *     `tool.Agent` made every tool-call count high by exactly the number of
 *     child threads, and nothing on the span let a counter tell the difference.
 *   - INHERITED — the record belongs to context this session carries but did
 *     not produce: the prefix a fork copies from its parent, and the history a
 *     `compacted` record retains. Keeping the human's words is the point;
 *     counting them as turns of THIS scope is not.
 *   - SUBAGENT — the record came from a child agent's OWN transcript, folded
 *     into the parent's trace by an adapter that reads the whole session tree.
 *     Claude Code writes one file per spawned agent under the session
 *     directory and the adapter parses all of them into one trace, so the
 *     parent's TOOL spans and the children's sat in the same trace with
 *     nothing to tell them apart: one measured session showed 2,675 tool spans
 *     where the session's own agent made 332. The subagent did that work; the
 *     parent did not, and a fact about the parent must not claim it.
 *
 * All three markers are additive attributes. A count that means "what the agent
 * did in this scope" filters them out; a reader that wants the context selects
 * them. They are harness-neutral on purpose: the sheet that reads them must not
 * carry a rule per harness.
 */

/** `true` on a span the adapter synthesized from lifecycle events. */
export const SYNTHESIZED_SPAN_ATTR = 'traces.span.synthesized'

/** What the synthesized span was built from, e.g. `codex.sub_agent_activity`. */
export const SYNTHESIZED_SOURCE_ATTR = 'traces.span.synthesized_from'

/** `true` on a span carrying context from outside the parsed scope. */
export const INHERITED_SPAN_ATTR = 'traces.session.inherited'

/** Where the inherited record came from: `pre-task-prefix` or `compacted`. */
export const INHERITED_SOURCE_ATTR = 'traces.session.inherited_source'

export type InheritedSpanSource = 'pre-task-prefix' | 'compacted'

/** Count of inherited spans in the batch, stamped on the root span. */
export const INHERITED_SPAN_COUNT_ATTR = 'traces.session.inherited_span_count'

/** Inherited records the adapter's per-session cap dropped, stamped on the root. */
export const INHERITED_SPANS_OMITTED_ATTR = 'traces.session.inherited_spans_omitted'

/** `true` on a span an adapter read from a subagent's own transcript. */
export const SUBAGENT_SPAN_ATTR = 'traces.span.subagent'

/**
 * The task the subagent whose record produced this span was given — the brief
 * the parent's spawn call named, as the harness recorded it. Absent when the
 * harness recorded no name for that child.
 */
export const SUBAGENT_TASK_ATTR = 'traces.span.subagent_task'

/** Count of subagent spans in the batch, stamped on the root span. */
export const SUBAGENT_SPAN_COUNT_ATTR = 'traces.session.subagent_span_count'

/** `true` on the tool call with which this scope's agent spawned a subagent. */
export const SUBAGENT_SPAWN_ATTR = 'traces.agent.spawn'

/** The task name that spawn call gave the child. Absent when it named none. */
export const SUBAGENT_SPAWN_TASK_ATTR = 'traces.agent.spawn_task'

export function isSynthesizedSpan(attributes: Readonly<Record<string, unknown>>): boolean {
  return attributes[SYNTHESIZED_SPAN_ATTR] === true
}

export function isInheritedSpan(attributes: Readonly<Record<string, unknown>>): boolean {
  return attributes[INHERITED_SPAN_ATTR] === true
}

export function isSubagentSpan(attributes: Readonly<Record<string, unknown>>): boolean {
  return attributes[SUBAGENT_SPAN_ATTR] === true
}

export function isSubagentSpawn(attributes: Readonly<Record<string, unknown>>): boolean {
  return attributes[SUBAGENT_SPAWN_ATTR] === true
}
