/**
 * Provenance markers for spans an adapter did NOT take from an action the agent
 * performed inside the parsed scope.
 *
 * Two cases, and both used to be invisible:
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
 *
 * Both markers are additive attributes. A count that means "what the agent did
 * in this scope" filters them out; a reader that wants the context selects them.
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

export function isSynthesizedSpan(attributes: Readonly<Record<string, unknown>>): boolean {
  return attributes[SYNTHESIZED_SPAN_ATTR] === true
}

export function isInheritedSpan(attributes: Readonly<Record<string, unknown>>): boolean {
  return attributes[INHERITED_SPAN_ATTR] === true
}
