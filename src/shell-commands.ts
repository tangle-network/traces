/**
 * Split one shell script into the simple commands it would actually run.
 *
 * A trace records a command as the script the agent handed to `/bin/zsh -lc`,
 * and one script routinely runs several commands: `git push && gh pr create`,
 * a `cat > file <<'EOF' … EOF` heredoc followed by a `gh` call, a `sh -c`
 * wrapper around another script. Asking "did this session create a pull
 * request?" with a regular expression over that text answers yes for a heredoc
 * body that merely mentions `gh pr create`, and no for a command hidden behind
 * a `$( … )` substitution.
 *
 * This scanner answers the question the way the shell would: it walks the
 * script once, tracking quoting, comments, redirections and heredoc bodies, and
 * returns the word list of every simple command it finds — recursing into
 * command substitutions, subshells, and the `-c` argument of a nested shell.
 *
 * It is a reader, not an interpreter. Variables are not expanded, globs are not
 * matched, and a word built from a variable comes back as the literal text of
 * the script. A caller therefore learns which command *names* ran with which
 * *literal* arguments, which is exactly what an audit of `gh pr create` needs
 * and is never mistaken for a claim about what the shell computed.
 */

/** Interpreters whose `-c` argument is another script worth scanning. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox'])

/**
 * Words that precede a command without being it. `env FOO=1 gh pr create` runs
 * `gh`, and an audit that stopped at `env` would miss it.
 */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'doas', 'nice', 'stdbuf', 'setsid', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(',
])

/** A leading `NAME=value` word is an environment assignment, not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Recursion limit for `$( … )`, backticks, subshells and nested `sh -c`. */
export const MAX_SHELL_DEPTH = 4

/** Words a scanned script may grow to before the scanner stops, so a pathological
 *  input cannot make one span's parse unbounded. */
const MAX_WORDS = 20_000

function basename(word: string): string {
  const cut = word.lastIndexOf('/')
  return cut === -1 ? word : word.slice(cut + 1)
}

class ShellScanner {
  private readonly text: string
  private readonly length: number
  private readonly depth: number
  private readonly commands: string[][] = []
  private word: string[] = []
  private wordStarted = false
  private current: string[] = []
  private words = 0
  private heredocs: Array<{ delimiter: string; stripTabs: boolean }> = []

  constructor(text: string, depth: number) {
    this.text = text
    this.length = text.length
    this.depth = depth
  }

  run(): string[][] {
    let index = 0
    while (index < this.length && this.words < MAX_WORDS) {
      index = this.step(index)
    }
    this.endCommand()
    return this.commands
  }

  private step(index: number): number {
    const text = this.text
    const char = text[index]!
    if (char === '\\') {
      if (index + 1 >= this.length) return index + 1
      if (text[index + 1] !== '\n') this.push(text[index + 1]!)
      return index + 2
    }
    if (char === "'") return this.readSingleQuote(index)
    if (char === '"') return this.readDoubleQuote(index)
    if (char === '`') return this.readBackTick(index)
    if (char === '$' && text[index + 1] === '(' && text[index + 2] === '(') {
      // Arithmetic expansion holds no commands; keep it in the word verbatim.
      const close = text.indexOf('))', index + 3)
      const end = close === -1 ? this.length : close + 2
      this.pushText(text.slice(index, end))
      return end
    }
    if (char === '$' && text[index + 1] === '(') return this.readSubstitution(index + 2)
    if (char === '$' && text[index + 1] === '{') {
      const end = this.findBalanced(index + 2, '{', '}') + 1
      this.pushText(text.slice(index, end))
      return end
    }
    if (char === '#' && !this.wordStarted) {
      const newline = text.indexOf('\n', index)
      return newline === -1 ? this.length : newline
    }
    if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') return this.readHeredocHeader(index)
    if (char === '>' || char === '<') return this.readRedirect(index)
    if (char === '\n') {
      this.endCommand()
      return this.heredocs.length > 0 ? this.skipHeredocBodies(index + 1) : index + 1
    }
    if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
      this.endCommand()
      return index + 1
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      this.endWord()
      return index + 1
    }
    // `2>file` and `1>&2`: the digits belong to the redirection, not to a word.
    if (char >= '0' && char <= '9' && !this.wordStarted && (text[index + 1] === '>' || text[index + 1] === '<')) {
      return this.readRedirect(index + 1)
    }
    this.push(char)
    return index + 1
  }

  private push(char: string): void {
    this.word.push(char)
    this.wordStarted = true
  }

  private pushText(text: string): void {
    if (text.length > 0) this.word.push(text)
    this.wordStarted = true
  }

  private endWord(): void {
    if (!this.wordStarted) return
    this.current.push(this.word.join(''))
    this.words += 1
    this.word = []
    this.wordStarted = false
  }

  private endCommand(): void {
    this.endWord()
    if (this.current.length > 0) this.commands.push(this.normalize(this.current))
    this.current = []
  }

  /** Drop the leading assignments and prefix words so `w[0]` is the command name. */
  private normalize(words: string[]): string[] {
    let start = 0
    while (start < words.length) {
      const word = words[start]!
      if (ASSIGNMENT.test(word) || COMMAND_PREFIXES.has(basename(word))) start += 1
      else break
    }
    // `env`-style prefixes may be the whole command (`exec`, a bare `{`); keep
    // the original words rather than returning an empty command.
    return start === 0 || start >= words.length ? words : words.slice(start)
  }

  private readSingleQuote(index: number): number {
    const end = this.text.indexOf("'", index + 1)
    const stop = end === -1 ? this.length : end
    this.pushText(this.text.slice(index + 1, stop))
    this.wordStarted = true
    return stop + 1
  }

  private readDoubleQuote(index: number): number {
    let cursor = index + 1
    this.wordStarted = true
    while (cursor < this.length) {
      const char = this.text[cursor]!
      if (char === '"') return cursor + 1
      if (char === '\\') {
        if (cursor + 1 < this.length && this.text[cursor + 1] !== '\n') this.push(this.text[cursor + 1]!)
        cursor += 2
        continue
      }
      if (char === '`') {
        cursor = this.readBackTick(cursor)
        continue
      }
      if (char === '$' && this.text[cursor + 1] === '(') {
        cursor = this.readSubstitution(cursor + 2)
        continue
      }
      this.push(char)
      cursor += 1
    }
    return this.length
  }

  /** Scan the commands inside `$( … )` and continue after the closing paren. */
  private readSubstitution(index: number): number {
    const end = this.findBalanced(index, '(', ')')
    this.descend(this.text.slice(index, end))
    this.wordStarted = true
    return end + 1
  }

  private readBackTick(index: number): number {
    const end = this.text.indexOf('`', index + 1)
    const stop = end === -1 ? this.length : end
    this.descend(this.text.slice(index + 1, stop))
    this.wordStarted = true
    return stop + 1
  }

  private descend(script: string): void {
    if (this.depth >= MAX_SHELL_DEPTH || script.length === 0) return
    for (const command of shellCommands(script, this.depth + 1)) this.commands.push(command)
  }

  private findBalanced(index: number, open: string, close: string): number {
    let depth = 1
    let cursor = index
    while (cursor < this.length) {
      const char = this.text[cursor]!
      if (char === '\\') cursor += 2
      else if (char === open) {
        depth += 1
        cursor += 1
      } else if (char === close) {
        depth -= 1
        if (depth === 0) return cursor
        cursor += 1
      } else cursor += 1
    }
    return this.length
  }

  /** `<<EOF`, `<<-'EOF'`: record the delimiter; the body is skipped at the newline. */
  private readHeredocHeader(index: number): number {
    this.endWord()
    let cursor = index + 2
    let stripTabs = false
    if (this.text[cursor] === '-') {
      stripTabs = true
      cursor += 1
    }
    while (cursor < this.length && (this.text[cursor] === ' ' || this.text[cursor] === '\t')) cursor += 1
    const delimiter: string[] = []
    while (cursor < this.length) {
      const char = this.text[cursor]!
      if (char === "'" || char === '"') {
        const end = this.text.indexOf(char, cursor + 1)
        const stop = end === -1 ? this.length : end
        delimiter.push(this.text.slice(cursor + 1, stop))
        cursor = stop + 1
        continue
      }
      if (char === '\\' && cursor + 1 < this.length) {
        delimiter.push(this.text[cursor + 1]!)
        cursor += 2
        continue
      }
      if (' \t\n;&|<>()'.includes(char)) break
      delimiter.push(char)
      cursor += 1
    }
    if (delimiter.length > 0) this.heredocs.push({ delimiter: delimiter.join(''), stripTabs })
    return cursor
  }

  private skipHeredocBodies(index: number): number {
    let cursor = index
    for (const { delimiter, stripTabs } of this.heredocs) {
      while (cursor < this.length) {
        const newline = this.text.indexOf('\n', cursor)
        const rawLine = newline === -1 ? this.text.slice(cursor) : this.text.slice(cursor, newline)
        const line = (stripTabs ? rawLine.replace(/^\t+/, '') : rawLine).replace(/\r$/, '')
        cursor = newline === -1 ? this.length : newline + 1
        if (line === delimiter) break
      }
    }
    this.heredocs = []
    return cursor
  }

  /** Consume a redirection operator and its target so the target is not read as an argument. */
  private readRedirect(index: number): number {
    this.endWord()
    let cursor = index
    while (cursor < this.length && '<>&'.includes(this.text[cursor]!)) cursor += 1
    while (cursor < this.length && (this.text[cursor] === ' ' || this.text[cursor] === '\t')) cursor += 1
    while (cursor < this.length && !' \t\n;&|()<>'.includes(this.text[cursor]!)) {
      const char = this.text[cursor]!
      if (char === "'" || char === '"') {
        const close = this.text.indexOf(char, cursor + 1)
        cursor = (close === -1 ? this.length : close) + 1
        continue
      }
      cursor += char === '\\' ? 2 : 1
    }
    return cursor
  }
}

/**
 * Every simple command in `script`, as word lists, in the order the scanner
 * meets them. Commands inside substitutions and nested shells are included.
 */
export function shellCommands(script: string, depth = 0): string[][] {
  if (depth > MAX_SHELL_DEPTH || script.length === 0) return []
  const commands = new ShellScanner(script, depth).run()
  const out: string[][] = []
  for (const words of commands) {
    out.push(words)
    const name = basename(words[0] ?? '')
    if (!SHELLS.has(name) || depth >= MAX_SHELL_DEPTH) continue
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]!
      if (!word.startsWith('-') || word.startsWith('--') || !word.slice(1).includes('c')) continue
      const nested = words[index + 1]
      if (nested !== undefined) out.push(...shellCommands(nested, depth + 1))
      break
    }
  }
  return out
}

/**
 * A command a Codex code-mode script ran: `tools.exec_command({cmd: …})` with
 * the command as a string literal, double- or single-quoted or a template
 * literal, or as a variable (`{cmd: c}`, `{cmd}`). A template's `${…}` parts
 * stay as their literal text, the way a shell variable does in
 * {@link shellCommands}, unless a loop over literals binds them (see
 * {@link codeModeCommands}). A variable no such loop binds is not read: the
 * script names no literal command.
 */
const CODE_MODE_COMMAND =
  /\bexec_command\(\s*\{\s*(?:["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*)|(cmd)\s*[,}])/gu

/** `for (const x of [...])` or `for (const x of list)`, up to the `{` that opens its body. */
const FOR_OF = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*\)\s*\{/gu

/** One element of an array of literals: a string without substitutions, or a number. */
const ARRAY_ELEMENT = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`|-?\d+(?:\.\d+)?)\s*(?:,|$)/uy

/** Commands one call site may expand to; a loop past this runs a count no reader should guess. */
const MAX_LOOP_COMMANDS = 64

const STRING_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }

/** The text of a JavaScript string literal, quotes included in `literal`. */
function stringLiteralText(literal: string): string {
  return literal.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/gu, (_, escape: string) =>
    escape.length > 1 ? String.fromCodePoint(Number.parseInt(escape.replace(/[ux{}]/gu, ''), 16)) : STRING_ESCAPES[escape] ?? escape)
}

/** The values of `[…]` when every element is a literal; undefined otherwise. */
function literalArray(source: string): string[] | undefined {
  const inner = source.slice(1, -1)
  const values: string[] = []
  ARRAY_ELEMENT.lastIndex = 0
  while (inner.slice(ARRAY_ELEMENT.lastIndex).trim() !== '') {
    const match = ARRAY_ELEMENT.exec(inner)
    if (!match) return undefined
    values.push(/^-?\d/u.test(match[1]!) ? match[1]! : stringLiteralText(match[1]!))
  }
  return values
}

/** Where the quote opened at `start` closes; -1 when it never does. */
function quoteEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1
    else if (text[index] === text[start]) return index
  }
  return -1
}

/** Where the block opened by the `{` at `open` closes, skipping strings and comments; -1 when it never does. */
function blockEnd(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"' || char === "'" || char === '`') index = quoteEnd(text, index)
    else if (char === '/' && text[index + 1] === '/') index = text.indexOf('\n', index)
    else if (char === '/' && text[index + 1] === '*') index = text.includes('*/', index + 2) ? text.indexOf('*/', index + 2) + 1 : -1
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return index
    if (index < 0) return -1
  }
  return -1
}

interface LiteralLoop {
  readonly variable: string
  /** Undefined when the loop does not run over literals the script names. */
  readonly values: readonly string[] | undefined
  readonly start: number
  readonly end: number
}

/** Every `for…of` loop of a script, with its values when it runs over an array literal, inline or bound by name. */
function forOfLoops(script: string): LiteralLoop[] {
  const loops: LiteralLoop[] = []
  for (const match of script.matchAll(FOR_OF)) {
    const open = match.index + match[0].length - 1
    const end = blockEnd(script, open)
    if (end === -1) continue
    let source = match[2]!
    if (!source.startsWith('[')) {
      const name = source.replace(/\$/gu, '\\$')
      source = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(\\[[^\\]]*\\])`, 'u').exec(script)?.[1] ?? ''
    }
    loops.push({ variable: match[1]!, values: source.startsWith('[') ? literalArray(source) : undefined, start: match.index, end })
  }
  return loops
}

/**
 * The commands a Codex code-mode script's `exec_command` calls ran, in call
 * order. A call inside `for (const x of [...])` loops over literals (inline, or
 * an array the script binds by name) runs once per element: `${x}` in its
 * template takes each value, and `{cmd: x}` is each value. A call inside a loop
 * over anything else ran a count the script does not state, so it is read once,
 * as written.
 */
function codeModeCommands(script: string): string[] {
  const loops = forOfLoops(script)
  const commands: string[] = []
  for (const match of script.matchAll(CODE_MODE_COMMAND)) {
    const written = match[1] ?? match[2]!
    const literal = /^["'`]/u.test(written)
    const around = loops.filter((loop) => loop.start < match.index && match.index < loop.end)
    let bindings: Array<Record<string, string>> | undefined = [{}]
    for (const loop of around) {
      if (loop.values === undefined || bindings.length * loop.values.length > MAX_LOOP_COMMANDS) {
        bindings = undefined
        break
      }
      bindings = bindings.flatMap((bound) => loop.values!.map((value) => ({ ...bound, [loop.variable]: value })))
    }
    if (bindings === undefined) {
      if (literal) commands.push(stringLiteralText(written))
      continue
    }
    for (const bound of bindings) {
      if (!literal) {
        if (bound[written] !== undefined) commands.push(bound[written])
        continue
      }
      const text = stringLiteralText(written)
      commands.push(written.startsWith('`') ? text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/gu, (part, name: string) => bound[name] ?? part) : text)
    }
  }
  return commands.filter((command) => command.length > 0)
}

/**
 * True when a tool span's `input.value` is a Codex code-mode script: the
 * JavaScript an `exec` call ran, not a JSON argument list. Its recorded status
 * is the script's ("Script completed"), not each command's exit code.
 */
export function isCodeModeScript(input: string): boolean {
  const trimmed = input.trimStart()
  return !trimmed.startsWith('{') && !trimmed.startsWith('*** Begin Patch') && trimmed.includes('exec_command(')
}

/**
 * The script a tool span recorded, from its `input.value`.
 *
 * Adapters store a command as JSON — `{"command": ["/bin/zsh", "-lc", "…"]}`
 * for a Codex `CommandExecution` item, `{"command": "…"}` for a Claude Code
 * `Bash` call, `{"cmd": "…"}` for a Codex `exec_command` argument list. An argv
 * array whose head is a shell keeps only the script that shell was given; any
 * other array is joined back into one command line. A Codex code-mode script
 * yields the commands its `exec_command` calls name, one line each. Any other
 * value, or JSON without a command field, yields undefined: the span records
 * something other than an executed command, and guessing from its text is how
 * a heredoc body becomes a pull request.
 */
export function commandTextFromInput(input: string): string | undefined {
  const trimmed = input.trim()
  if (isCodeModeScript(trimmed)) {
    const commands = codeModeCommands(trimmed)
    return commands.length > 0 ? commands.join('\n') : undefined
  }
  if (!trimmed.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  const value = record.command ?? record.cmd
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!Array.isArray(value) || value.length === 0) return undefined
  const words = value.filter((entry): entry is string => typeof entry === 'string')
  if (words.length !== value.length) return undefined
  const head = basename(words[0] ?? '')
  if (SHELLS.has(head)) {
    const flag = words.findIndex((word, position) => position > 0 && /^-[a-z]*c$/.test(word))
    if (flag !== -1 && words[flag + 1] !== undefined) return words[flag + 1]
  }
  return words.join(' ')
}

/** A `sh -c <script>` wrapper: the commands it runs are listed after it. */
function isShellWrapper(words: readonly string[]): boolean {
  if (!SHELLS.has(basename(words[0] ?? ''))) return false
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!
    if (!word.startsWith('-') || word.startsWith('--') || !word.slice(1).includes('c')) continue
    return words[index + 1] !== undefined
  }
  return false
}

/**
 * The simple commands `script` runs, one line each with its words joined by a
 * space, leaving out a `sh -c` wrapper whose own commands are listed. A search
 * anchored at `^traces ` then matches `traces facts …` wherever it ran, and
 * never `tangle traces list`.
 */
export function commandLines(script: string): string[] {
  return simpleCommands(script).map((words) => words.join(' '))
}

/** The simple commands `script` runs, as word lists, leaving out a `sh -c` wrapper whose own commands are listed. */
export function simpleCommands(script: string): string[][] {
  return shellCommands(script).filter((words) => words.length > 0 && !isShellWrapper(words))
}
