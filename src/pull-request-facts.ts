/**
 * Which pull requests a session created, and which it merged.
 *
 * The spans already hold the answer and no reader was extracting it. A Codex
 * `CommandExecution` item becomes a `command.execution` span carrying the
 * script, its exit code and its output; a Claude Code `Bash` call becomes a
 * TOOL span with the same three things under the same I/O keys. A `gh pr
 * create` is therefore visible, and so is the pull-request URL `gh` printed
 * back — which is the only place the new PR's number appears.
 *
 * Three rules keep the reading honest:
 *
 *   1. The command is found by scanning the script the way a shell would
 *      ({@link shellCommands}), not by matching text. A `gh pr create` quoted
 *      inside a heredoc body or a commit message never ran and is not counted.
 *   2. A pull request is named by its number when the command or an output that
 *      joins to it shows one, and by its head branch when it does not — the
 *      identity the command itself supplies. A call with neither stays a
 *      recorded event with a null identifier and a stated reason.
 *   3. Every entry names the span its command came from, plus the span whose
 *      output supplied the number, so the reading can be checked against the
 *      raw spans rather than trusted.
 *
 * A command that never reached `gh` is not an event: a failed
 * `git push … && gh pr create` exited non-zero without running `gh`, so it
 * counts only when the exit code is zero or the output shows `gh` itself
 * answering.
 */

import type { OtlpSpan } from './otlp.js'
import { isInnerToolCall } from './adapters/tool-io.js'
import { commandTextFromInput, isCodeModeScript, shellCommands } from './shell-commands.js'

/** The `gh` executables an audit recognizes, including the wrapper this project uses. */
const GH_NAMES: ReadonlySet<string> = new Set(['gh', 'gh-drew'])

/** `gh pr create` flags that consume the following word. */
const CREATE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-H', '--head', '-B', '--base', '-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file',
  '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template',
])

/** `gh pr merge` flags that consume the following word. */
const MERGE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-t', '--subject', '-b', '--body', '-F', '--body-file', '--match-head-commit', '-R', '--repo', '-A', '--author-email',
])

/**
 * Terminal control sequences a command's output may carry: a CSI sequence
 * (`ESC [ … letter`) and an OSC string (`ESC ] … BEL`). Written as escapes so
 * the source stays free of raw control bytes.
 */
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007/g
const PR_URL_LINE = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?$/
const PR_NUMBER = /https?:\/\/[^/\s"']+\/[^/\s"']+\/[^/\s"']+\/pull\/(\d+)|(?:^|\s)#(\d+)\b/g
const MERGED_NUMBER =
  /(?:(?:Squashed and merged|Rebased and merged|Merged) pull request|Pull request)\s+(?:[\w.\-]+\/[\w.\-]+)?#(\d+)/

/** Output that shows `gh pr create` itself answered, however it answered. */
const CREATE_REACHED_GH =
  /createPullRequest|pull request create failed|must first push the current branch|a pull request for branch|already exists|Creating pull request for|No commits between|Head ref must be a branch|GraphQL:|HTTP 4\d\d/i

/** Output that shows `gh pr merge` itself answered. */
const MERGE_REACHED_GH =
  /mergePullRequest|pull request|Merged|not mergeable|GraphQL:|failed to run git|base branch policy|approving review is required|HTTP 4\d\d/i

/** Any pull-request URL, anywhere in a command's output. Host-agnostic: `gh`
 *  serves GitHub Enterprise hosts under the same `/owner/repo/pull/N` path. */
const PULL_REQUEST_URL = /https?:\/\/[^/\s"']+\/[^/\s"']+\/[^/\s"']+\/pull\/\d+/

/** A branch name a `git push` named in its own output. */
const PUSH_TRACKING = /branch '([^']+)' set up to track/
const PUSH_NEW_BRANCH = /\[new branch\]\s+\S+\s+->\s+(\S+)/

/**
 * One result a Codex code-mode script printed. `text(await tools.exec_command(…))`
 * writes `{"chunk_id", "exit_code" or "session_id", "output"}`: an exit code once
 * the command ended, a session id while it still runs, and the command's output
 * as an escaped string, so a URL in it is never on a line of its own.
 */
interface ScriptResult {
  readonly sessionId: string | null
  readonly exitCode: number | null
  readonly output: string
}

const SCRIPT_RESULT_START = '{"chunk_id"'

/** Where the JSON object that opens at `start` closes (exclusive), honoring strings; -1 when it never closes. */
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return index + 1
  }
  return -1
}

/** The tool results a code-mode script's output holds, in order. A result cut off by truncation ends the list. */
function scriptResults(output: string): ScriptResult[] {
  const results: ScriptResult[] = []
  for (let from = output.indexOf(SCRIPT_RESULT_START); from !== -1; from = output.indexOf(SCRIPT_RESULT_START, from + 1)) {
    const end = jsonObjectEnd(output, from)
    if (end === -1) break
    let value: Record<string, unknown>
    try {
      value = JSON.parse(output.slice(from, end)) as Record<string, unknown>
    } catch {
      continue
    }
    const session = value.session_id
    results.push({
      sessionId: typeof session === 'number' || typeof session === 'string' ? String(session) : null,
      exitCode: typeof value.exit_code === 'number' ? value.exit_code : null,
      output: typeof value.output === 'string' ? value.output : '',
    })
    from = end - 1
  }
  return results
}

/** One pull request the agent created or merged, with the evidence that named it. */
export interface PullRequestFact {
  /** The PR number when one is known, else the head branch. Null when neither is. */
  readonly identifier: string | null
  readonly number: string | null
  readonly headBranch: string | null
  /** Explicit command repository or a successful command's PR URL; never the session's cwd. */
  readonly repository: string | null
  readonly url: string | null
  readonly repositoryUnavailable: string | null
  /** The `gh` command, as the scanner read it. */
  readonly command: string
  /** How `identifier` was arrived at, naming the span that supplied it. */
  readonly evidence: string
  /** The command span, plus any span whose output supplied the number. */
  readonly spanIds: readonly string[]
  /** When the command ran (its tool call's start): the first run that succeeded, else the first run. */
  readonly at: string
  /** Why `identifier` is null. Null when the pull request was identified. */
  readonly unavailable: string | null
}

export interface PullRequestFacts {
  readonly created: readonly PullRequestFact[]
  readonly merged: readonly PullRequestFact[]
}

export interface PullRequestReading {
  /** Null exactly when `unavailable` explains why the spans cannot support it. */
  readonly facts: PullRequestFacts | null
  readonly spanIds: readonly string[]
  readonly unavailable: string | null
  readonly partial: string | null
  /** Spans carrying an executed command: the denominator of this reading. */
  readonly commandSpans: number
}

interface CommandRecord {
  readonly spanId: string
  readonly at: string
  readonly script: string
  readonly output: string
  /** The output, then each result a code-mode script printed, decoded: what the commands themselves printed. */
  readonly text: string
  /** Process sessions the call left running: Codex's text header, or a script result with a session and no exit code. */
  readonly running: readonly string[]
  /** Not known to have succeeded: a non-zero exit, or a code-mode script, whose status is the script's, not the command's. */
  readonly failed: boolean
  readonly inputTruncated: boolean
  readonly outputTruncated: boolean
}

interface PullRequestEvent {
  action: 'create' | 'merge'
  number: string | null
  headBranch: string | null
  repository: string | null
  url: string | null
  repositoryUnavailable: string | null
  command: string
  evidence: string
  spanIds: string[]
  at: string
  failed: boolean
  recordIndex: number
  outputTruncated: boolean
}

function stringAttribute(span: OtlpSpan, key: string): string | null {
  const value = span.attributes[key]
  return typeof value === 'string' ? value : null
}

function basename(word: string): string {
  const cut = word.lastIndexOf('/')
  return cut === -1 ? word : word.slice(cut + 1)
}

/**
 * Commands the spans record, in trace order. `spans` must already be ordered.
 *
 * A harness that records both levels records one command twice: the call the
 * model issued, and the inner span for what that call actually ran. Only the
 * inner span carries the exit code and the command's own output, so when both
 * are present the outer call is dropped — otherwise a `git push && gh pr
 * create` whose push failed would be read once as reaching `gh` (the outer span
 * has no exit code) and once as not reaching it.
 */
function commandRecords(spans: readonly OtlpSpan[]): CommandRecord[] {
  const scripted = new Map<OtlpSpan, string>()
  const codeMode = new Set<OtlpSpan>()
  for (const span of spans) {
    const input = stringAttribute(span, 'input.value')
    if (input === null) continue
    const script = commandTextFromInput(input)
    if (script === undefined) continue
    scripted.set(span, script)
    if (isCodeModeScript(input)) codeMode.add(span)
  }
  const innerParents = new Set<string>()
  const innerScripts = new Set<string>()
  for (const [span, script] of scripted) {
    if (!isInnerToolCall(span.attributes)) continue
    if (span.parent_span_id !== null) innerParents.add(span.parent_span_id)
    innerScripts.add(script)
  }
  const records: CommandRecord[] = []
  for (const [span, script] of scripted) {
    const outer = !isInnerToolCall(span.attributes)
    if (outer && (innerParents.has(span.span_id) || innerScripts.has(script))) continue
    const exit = span.attributes['process.exit_code']
    const exitCode = typeof exit === 'number' ? exit : null
    const output = stringAttribute(span, 'output.value') ?? ''
    const results = codeMode.has(span) ? scriptResults(output) : []
    const header = RUNNING_SESSION.exec(output)?.[1]
    records.push({
      spanId: span.span_id,
      at: span.start_time,
      script,
      output,
      text: [output, ...results.map((result) => result.output)].join('\n'),
      running: [
        ...(header === undefined ? [] : [header]),
        ...results.filter((result) => result.sessionId !== null && result.exitCode === null).map((result) => result.sessionId!),
      ],
      failed: codeMode.has(span) || (exitCode === null ? span.status.code === 'ERROR' : exitCode !== 0),
      inputTruncated: span.attributes['traces.input.truncated'] === true,
      outputTruncated: span.attributes['traces.output.truncated'] === true,
    })
  }
  return records
}

/** Flags and positional words of one `gh pr …` argument list. */
function parseFlags(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const cut = arg.indexOf('=')
      flags.set(arg.slice(0, cut), arg.slice(cut + 1))
    } else if (arg.startsWith('-R') && arg.length > 2 && valueFlags.has('-R')) {
      flags.set('-R', arg.slice(2))
    } else if (valueFlags.has(arg)) {
      flags.set(arg, args[index + 1] ?? true)
      index += 1
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags.set(arg, true)
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function flagValue(flags: Map<string, string | true>, ...names: readonly string[]): string | null {
  for (const name of names) {
    const value = flags.get(name)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** Pull-request URLs `gh` printed on a line of their own, in order. */
function printedPullRequestReferences(output: string): Array<{ number: string; repository: string; url: string }> {
  const references: Array<{ number: string; repository: string; url: string }> = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '').split('\r').pop()!.trim()
    const match = PR_URL_LINE.exec(line)
    const reference = match ? urlReference(line) : null
    if (reference) references.push(reference)
  }
  return references
}

/** Every pull-request number one line of text states, by URL or by `#N`. */
function numbersInLine(line: string): string[] {
  const found: string[] = []
  for (const match of line.matchAll(PR_NUMBER)) found.push(match[1] ?? match[2]!)
  return found
}

/**
 * The head branch of a `gh pr create` that did not pass `--head`: the branch the
 * same script pushed or created just before it, else the branch the push output
 * names. `gh` otherwise defaults to the checked-out branch, which no span carries.
 */
function inferHeadBranch(commands: readonly string[][], upTo: number, output: string): string | null {
  for (let index = upTo - 1; index >= 0; index -= 1) {
    const words = commands[index]!
    if (basename(words[0] ?? '') !== 'git' || words.length < 2) continue
    const sub = words[1]
    const rest = words.slice(2)
    if (sub === 'push') {
      const positional = rest.filter((word) => !word.startsWith('-'))
      const ref = positional[positional.length - 1]
      if (positional.length >= 2 && ref !== undefined && ref !== 'HEAD') {
        const branch = (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref).replace(/^\+/, '')
        if (branch.length > 0) return branch
      }
    }
    if (sub === 'checkout' || sub === 'switch') {
      for (let position = 0; position < rest.length - 1; position += 1) {
        if (['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(rest[position]!)) return rest[position + 1]!
      }
    }
    if (sub === 'worktree' && rest[0] === 'add') {
      for (let position = 1; position < rest.length - 1; position += 1) {
        if (rest[position] === '-b' || rest[position] === '-B') return rest[position + 1]!
      }
    }
  }
  return PUSH_TRACKING.exec(output)?.[1] ?? PUSH_NEW_BRANCH.exec(output)?.[1] ?? null
}

/** Whether the shell reached `gh` at all, for a command not known to have succeeded. */
function reachedGh(record: CommandRecord, action: 'create' | 'merge', sawNumber: boolean): boolean {
  if (!record.failed) return true
  if (sawNumber || PULL_REQUEST_URL.test(record.text)) return true
  return action === 'create' ? CREATE_REACHED_GH.test(record.text) : MERGE_REACHED_GH.test(record.text)
}

/** A pull-request number a record printed, or a later poll of a process it left running printed (`spanId`). */
interface Printed {
  readonly number: string
  readonly pollSpanId: string | null
  readonly repository?: string
  readonly url?: string
}

function explicitRepository(value: string | null): string | null {
  if (!value) return null
  const raw = value.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const parts = raw.split('/')
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) return null
  return parts[0] === 'github.com' ? parts.slice(1).join('/') : raw
}

function urlReference(value: string): { number: string; repository: string; url: string } | null {
  try {
    const url = new URL(value)
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(url.pathname)
    if (!match || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return { number: match[3]!, repository: `${url.hostname === 'github.com' ? '' : `${url.host}/`}${match[1]}/${match[2]}`,
      url: `${url.origin}/${match[1]}/${match[2]}/pull/${match[3]}` }
  } catch { return null }
}

function repositoryIdentity(repository: string | null, printed: { repository?: string; url?: string } | null): {
  repository: string | null; url: string | null; repositoryUnavailable: string | null
} {
  if (repository && printed?.repository && repository !== printed.repository) return {
    repository: null, url: null, repositoryUnavailable: 'the command repository and returned PR URL disagree',
  }
  const resolved = printed?.repository ?? repository
  return { repository: resolved, url: printed?.url ?? null,
    repositoryUnavailable: resolved ? null : 'no explicit --repo/-R, target PR URL, or joined command output establishes the repository' }
}

function createEvent(
  record: CommandRecord,
  recordIndex: number,
  words: readonly string[],
  commands: readonly string[][],
  commandIndex: number,
  printed: Printed | null,
): PullRequestEvent | null {
  const { flags } = parseFlags(words.slice(3), CREATE_VALUE_FLAGS)
  if (flags.has('--help') || flags.has('-h')) return null
  if (!reachedGh(record, 'create', printed !== null)) return null
  const printedNumber = printed?.number ?? null
  const identity = repositoryIdentity(explicitRepository(flagValue(flags, '--repo', '-R')), printed)
  const headFlag = flagValue(flags, '--head', '-H')
  const headBranch = headFlag ?? inferHeadBranch(commands, commandIndex, record.text)
  const evidence =
    printed?.pollSpanId
      ? `the pull-request URL a later poll of this backgrounded command printed, in span ${printed.pollSpanId}`
      : printedNumber !== null
      ? `the pull-request URL this command printed, in span ${record.spanId}`
      : headFlag !== null
        ? 'the --head branch given to the command'
        : headBranch !== null
          ? 'the branch this same command pushed or created before calling gh'
          : 'none: the command named no head branch and printed no pull-request URL'
  return {
    action: 'create',
    ...identity,
    number: printedNumber,
    headBranch,
    command: words.join(' '),
    evidence,
    spanIds: printed?.pollSpanId ? [record.spanId, printed.pollSpanId] : [record.spanId],
    at: record.at,
    failed: record.failed,
    recordIndex,
    outputTruncated: record.outputTruncated,
  }
}

function mergeEvent(
  record: CommandRecord,
  recordIndex: number,
  words: readonly string[],
): PullRequestEvent | null {
  const { flags, positional } = parseFlags(words.slice(3), MERGE_VALUE_FLAGS)
  if (flags.has('--help') || flags.has('-h')) return null
  const target = positional[0] ?? null
  const numberInCommand =
    target === null ? null : (/^#?(\d+)$/.exec(target)?.[1] ?? numbersInLine(target)[0] ?? null)
  const numberInOutput = numberInCommand === null ? (MERGED_NUMBER.exec(record.text)?.[1] ?? null) : null
  const number = numberInCommand ?? numberInOutput
  const targetReference = target ? urlReference(target) : null
  const printed = printedPullRequestReferences(record.text).filter((reference) => reference.number === number)
  const unique = [...new Map(printed.map((reference) => [reference.url, reference])).values()]
  const printedReference = targetReference ?? (unique.length === 1 ? unique[0]! : null)
  const identity = repositoryIdentity(explicitRepository(flagValue(flags, '--repo', '-R')), printedReference)
  if (!reachedGh(record, 'merge', number !== null)) return null
  const evidence =
    numberInCommand !== null
      ? 'the pull request the command names'
      : numberInOutput !== null
        ? `the merge line this command printed, in span ${record.spanId}`
        : target !== null
          ? 'the branch the command names; no output that joins to it stated a number'
          : 'none: the command named neither a pull request nor a branch'
  return {
    action: 'merge',
    ...identity,
    number,
    headBranch: number === null ? target : null,
    command: words.join(' '),
    evidence,
    spanIds: [record.spanId],
    at: record.at,
    failed: record.failed,
    recordIndex,
    outputTruncated: record.outputTruncated,
  }
}

function eventsFromRecord(record: CommandRecord, recordIndex: number, polled: readonly Printed[]): PullRequestEvent[] {
  if (!/\bpr\b/.test(record.script)) return []
  const commands = shellCommands(record.script)
  const printed: Printed[] = [...printedPullRequestReferences(record.text).map((reference) => ({ ...reference, pollSpanId: null })), ...polled]
  const events: PullRequestEvent[] = []
  let createIndex = 0
  for (let index = 0; index < commands.length; index += 1) {
    const words = commands[index]!
    if (words.length < 3 || !GH_NAMES.has(basename(words[0]!)) || words[1] !== 'pr') continue
    const action = words[2]
    if (action === 'create') {
      const printedNumber = printed[createIndex] ?? null
      createIndex += 1
      const event = createEvent(record, recordIndex, words, commands, index, printedNumber)
      if (event) events.push(event)
      continue
    }
    if (action !== 'merge') continue
    const event = mergeEvent(record, recordIndex, words)
    if (event) events.push(event)
  }
  return events
}

/**
 * A number a later command's output states for this head branch.
 *
 * `gh pr create` prints the new URL, but a script that redirected or swallowed
 * its stdout leaves the branch as the only identity — until a later `gh pr
 * view`, `gh pr list` or merge names the same branch beside a number. The join
 * demands both on one line and exactly one distinct number there, so a listing
 * of many branches identifies none of them.
 */
function numberFromLaterOutput(
  records: readonly CommandRecord[],
  after: number,
  headBranch: string,
): { number: string; spanId: string } | null {
  for (let index = after + 1; index < records.length; index += 1) {
    const record = records[index]!
    const found = new Set<string>()
    for (const raw of `${record.script}\n${record.text}`.split('\n')) {
      const line = raw.replace(ANSI, '')
      if (!line.includes(headBranch)) continue
      for (const number of numbersInLine(line)) found.add(number)
    }
    if (found.size === 1) return { number: [...found][0]!, spanId: record.spanId }
  }
  return null
}

function identify(event: PullRequestEvent): PullRequestFact {
  const identifier = event.number ?? event.headBranch
  return {
    identifier,
    number: event.number,
    headBranch: event.headBranch,
    repository: event.repository,
    url: event.url ?? (event.repository && event.number
      ? `https://${event.repository.split('/').length === 2 ? 'github.com/' : ''}${event.repository}/pull/${event.number}` : null),
    repositoryUnavailable: event.repositoryUnavailable,
    command: event.command,
    evidence: event.evidence,
    spanIds: [...new Set(event.spanIds)],
    at: event.at,
    unavailable:
      identifier === null
        ? 'the command named no pull-request number and no head branch, and no output that joins to it stated one'
        : null,
  }
}

/**
 * One entry per identity: a failed create and its retry, or a refused merge and
 * the one that went through, are one pull request. Its command and time are the
 * first run that succeeded, else the first run.
 */
function distinct(events: readonly PullRequestEvent[]): PullRequestFact[] {
  const groups = new Map<string, PullRequestEvent[]>()
  for (const event of events) {
    const key = JSON.stringify([event.repository, event.number ?? event.headBranch ?? `command:${event.command}`])
    groups.set(key, [...(groups.get(key) ?? []), event])
  }
  return [...groups.values()].map((group) => {
    const shown = group.find((event) => !event.failed) ?? group[0]!
    return { ...identify(shown), spanIds: [...new Set(group.flatMap((event) => event.spanIds))] }
  })
}

/** `exec_command` left a process running and named its session; a later `write_stdin` polls it. */
const RUNNING_SESSION = /Process running with session ID (\d+)/

/** Whether a tool call's input polls process `session`: a `write_stdin` argument list, or a code-mode script calling it. */
function pollsSession(input: string, session: string): boolean {
  if (!input.includes(session)) return false
  if (isCodeModeScript(input) || input.includes('write_stdin(')) {
    return new RegExp(`write_stdin\\(\\s*\\{[^}]*\\bsession_id["']?\\s*:\\s*${session}\\b`, 'u').test(input)
  }
  try {
    return String((JSON.parse(input) as { session_id?: unknown }).session_id) === session
  } catch {
    return false
  }
}

/**
 * The pull-request numbers later polls of the processes a record left running
 * printed, in the order it left them. A `gh pr create` that is still running
 * when its call returns prints no URL; the first later poll of the same process
 * session that prints exactly one names its number. A code-mode poll prints the
 * results it read, decoded the same way.
 */
function polledNumbers(spans: readonly OtlpSpan[], record: CommandRecord): Printed[] {
  const found: Printed[] = []
  for (const session of record.running) {
    for (const span of spans) {
      if (span.start_time < record.at || span.span_id === record.spanId) continue
      const input = stringAttribute(span, 'input.value')
      if (input === null || !pollsSession(input, session)) continue
      const output = stringAttribute(span, 'output.value') ?? ''
      const text = [output, ...scriptResults(output).map((result) => result.output)].join('\n')
      const references = [...new Map(printedPullRequestReferences(text).map((reference) => [reference.url, reference])).values()]
      if (references.length !== 1) continue
      found.push({ ...references[0]!, pollSpanId: span.span_id })
      break
    }
  }
  return found
}

/**
 * Read every pull request the spans show the agent creating or merging.
 *
 * `spans` must be in trace order: a number a later command states is joined to
 * the create it belongs to by position, and that ordering is the position.
 */
export function readPullRequests(spans: readonly OtlpSpan[]): PullRequestReading {
  const records = commandRecords(spans)
  if (records.length === 0) {
    return {
      facts: null,
      spanIds: [],
      commandSpans: 0,
      partial: null,
      unavailable:
        'no span in this trace carries an executed command (an input.value with a command or cmd field), ' +
        'so whether the agent created or merged a pull request cannot be read from these spans',
    }
  }

  const events: PullRequestEvent[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    const creates = /\bpr\b/.test(record.script) && record.running.length > 0
    events.push(...eventsFromRecord(record, index, creates ? polledNumbers(spans, record) : []))
  }

  // A create shown only by head branch takes the number another create for the
  // same branch produced: a failed first attempt and its retry are one PR.
  const numberByBranch = new Map<string, string>()
  for (const event of events) {
    if (event.action !== 'create' || event.number === null || event.headBranch === null) continue
    if (!numberByBranch.has(JSON.stringify([event.repository, event.headBranch]))) numberByBranch.set(JSON.stringify([event.repository, event.headBranch]), event.number)
  }
  let unjoinedTruncated = 0
  for (const event of events) {
    if (event.number !== null || event.headBranch === null) continue
    const sibling = numberByBranch.get(JSON.stringify([event.repository, event.headBranch]))
    if (sibling !== undefined) {
      event.number = sibling
      event.evidence = `${event.evidence}, resolved to the number another create for this branch printed`
      continue
    }
    const later = numberFromLaterOutput(records, event.recordIndex, event.headBranch)
    if (later !== null) {
      event.number = later.number
      // The old branch-only join establishes a number, not its repository.
      event.repository = null
      event.url = null
      event.repositoryUnavailable = 'branch-only later output does not establish the PR repository'
      event.spanIds.push(later.spanId)
      event.evidence = `${event.evidence}, resolved to the number a later output states for this branch, in span ${later.spanId}`
      continue
    }
    if (event.outputTruncated) unjoinedTruncated += 1
  }

  const created = distinct(events.filter((event) => event.action === 'create'))
  const merged = distinct(events.filter((event) => event.action === 'merge'))
  const truncatedCommands = records.filter((record) => record.inputTruncated && /\bpr\b/.test(record.script)).length
  const notes: string[] = []
  if (truncatedCommands > 0) {
    notes.push(
      `${truncatedCommands} command span(s) mentioning a pull request had truncated input; ` +
        'a gh command past the cut is not in this list',
    )
  }
  if (unjoinedTruncated > 0) {
    notes.push(
      `${unjoinedTruncated} entr(y|ies) kept a branch identity while the output that could have named its number was truncated`,
    )
  }
  return {
    facts: { created, merged },
    spanIds: [...new Set([...created, ...merged].flatMap((fact) => fact.spanIds))],
    commandSpans: records.length,
    unavailable: null,
    partial: notes.length > 0 ? notes.join('; ') : null,
  }
}
