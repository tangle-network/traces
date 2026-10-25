import { relative } from 'node:path'
import { span, type OtlpSpan } from '../otlp.js'
import { toolIoAttributes } from './tool-io.js'
import { SUBAGENT_SPAN_ATTR, SUBAGENT_TASK_ATTR, SYNTHESIZED_SPAN_ATTR, SYNTHESIZED_SOURCE_ATTR } from './provenance.js'
const SPAWN_TYPE_ATTR = 'traces.claude.subagent_type'
const SUBAGENT_TRANSCRIPT_ATTR = 'traces.claude.subagent_transcript'
const SUBAGENT_AGENT_ID_ATTR = 'traces.claude.subagent_agent_id'

/**
 * One span standing for a child transcript, so the parent's `Task` call has
 * something to point at.
 *
 * It is synthesized — no model issued it — and it belongs to the subagent's
 * scope, so neither the parent's tool count nor the parent's record window
 * absorbs it. Its value is evidence: it names the transcript the child's spans
 * came from and the window they cover, which is what a reader checking "which
 * subagents ran" needs and what the parent's TOOL span alone cannot say.
 */
export function subagentLifecycleSpan(
  agent: { file: string; sourceKey: string; agentId: string; meta: { agentType?: string } },
  parsed: { spans: readonly OtlpSpan[] },
  traceId: string,
  parentSpanId: string,
  task: string | null,
  subDir: string,
): OtlpSpan | undefined {
  let first: string | undefined
  let last: string | undefined
  for (const item of parsed.spans) {
    for (const stamp of [item.start_time, item.end_time]) {
      const value = Date.parse(stamp)
      if (!Number.isFinite(value)) continue
      if (first === undefined || value < Date.parse(first)) first = stamp
      if (last === undefined || value > Date.parse(last)) last = stamp
    }
  }
  if (first === undefined || last === undefined) return undefined
  return span({
    traceId,
    // Same prefix as every other span from this transcript, so a reader
    // grouping spans by source keeps the anchor with the spans it stands for.
    spanId: `${agent.sourceKey}:lifecycle`,
    parentSpanId,
    name: 'subagent.lifecycle',
    kind: 'AGENT',
    startTime: first,
    endTime: last,
    // The transcript records what the child did, not whether the parent
    // accepted it; the parent's own tool span carries that status.
    status: 'UNSET',
    service: SERVICE,
    agent: agent.meta.agentType ? `subagent:${agent.meta.agentType}` : 'subagent',
    extra: {
      ...toolIoAttributes({
        input: {
          agent_id: agent.agentId,
          ...(agent.meta.agentType ? { subagent_type: agent.meta.agentType } : {}),
          ...(task ? { task } : {}),
        },
      }),
      [SYNTHESIZED_SPAN_ATTR]: true,
      [SYNTHESIZED_SOURCE_ATTR]: 'claude.subagent_transcript',
      [SUBAGENT_SPAN_ATTR]: true,
      ...(task ? { [SUBAGENT_TASK_ATTR]: task } : {}),
      ...(agent.meta.agentType ? { [SPAWN_TYPE_ATTR]: agent.meta.agentType } : {}),
      [SUBAGENT_AGENT_ID_ATTR]: agent.agentId,
      [SUBAGENT_TRANSCRIPT_ATTR]: relative(subDir, agent.file),
    },
  })
}
