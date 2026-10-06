import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isMissingPathError } from '../json.js'
import type { SessionRef } from '../types.js'
import {
  ClaudeTaskScopeError,
  workflowRunIdForSubagent,
  type WorkflowRunBinding,
} from './claude-workflow.js'

interface WorkflowSubagentLocation {
  runId: string
  transcriptDir: string
  /** The parent's recorded path, retained when the native subtree was copied. */
  sourceTranscriptDir?: string
}

export interface ClaudeSubagentSources {
  files: readonly string[]
  workflowByFile: ReadonlyMap<string, WorkflowSubagentLocation>
}

interface WorkflowTranscriptDirectory extends WorkflowSubagentLocation {
  copiedWorkflow?: boolean
}

async function listSubagentFiles(
  root: string,
  signal?: AbortSignal,
  copiedWorkflow: boolean = false,
): Promise<string[]> {
  const pending = [root]
  const files: string[] = []
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const dir = pending.pop()
    if (!dir) continue
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw error
    }
    signal?.throwIfAborted()
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (copiedWorkflow && entry.isSymbolicLink()) {
        throw new ClaudeTaskScopeError(
          `Claude Workflow subagent does not match copied source: ${path}`,
        )
      }
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && /^agent-.*\.jsonl$/.test(entry.name)) {
        files.push(path)
      }
    }
  }
  return files.sort()
}

function pathIsWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (
    path !== '..'
    && !path.startsWith('../')
    && !path.startsWith('..\\')
    && !isAbsolute(path)
  )
}

function workflowStorageRoot(ref: SessionRef): string {
  const nativeRoot = resolve(homedir(), '.claude', 'projects')
  return pathIsWithin(nativeRoot, ref.path) ? nativeRoot : dirname(resolve(ref.path))
}

function relocatedWorkflowDirectory(
  ref: SessionRef,
  binding: WorkflowRunBinding,
): { sessionRoot: string; transcriptDir: string } | undefined {
  const source = binding.transcriptDir
  if (resolve(source) !== source || source.includes('\\')) return undefined
  const parts = source.split('/').slice(-7)
  const sessionId = parts[3]
  if (
    parts[0] !== '.claude'
    || parts[1] !== 'projects'
    || !parts[2]
    || !sessionId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
    || parts[4] !== 'subagents'
    || parts[5] !== 'workflows'
    || parts[6] !== binding.runId
  ) return undefined
  const sessionRoot = join(dirname(resolve(ref.path)), sessionId)
  return {
    sessionRoot,
    transcriptDir: join(sessionRoot, 'subagents', 'workflows', binding.runId),
  }
}

async function workflowTranscriptDirectories(
  ref: SessionRef,
  bindings: ReadonlyMap<string, readonly WorkflowRunBinding[]>,
): Promise<WorkflowTranscriptDirectory[]> {
  const allowedRoot = workflowStorageRoot(ref)
  const allowedRealRoot = await realpath(allowedRoot)
  const directories = new Map<string, WorkflowTranscriptDirectory>()
  for (const runBindings of bindings.values()) {
    for (const binding of runBindings) {
      let directory = resolve(binding.transcriptDir)
      let relocation: ReturnType<typeof relocatedWorkflowDirectory>
      if (!pathIsWithin(allowedRoot, directory)) {
        relocation = relocatedWorkflowDirectory(ref, binding)
        if (!relocation || !pathIsWithin(allowedRoot, relocation.transcriptDir)) {
          throw new ClaudeTaskScopeError(
            `Claude Workflow transcript directory escapes ${allowedRoot}: ${directory}`,
          )
        }
        directory = relocation.transcriptDir
      }
      let realDirectory: string
      try {
        realDirectory = await realpath(directory)
      } catch (error) {
        if (isMissingPathError(error)) {
          if (relocation) {
            throw new ClaudeTaskScopeError(
              `Cannot relocate Claude Workflow run ${binding.runId}: copied transcript directory is missing: ${directory}`,
            )
          }
          continue
        }
        throw error
      }
      if (!pathIsWithin(allowedRealRoot, realDirectory)) {
        throw new ClaudeTaskScopeError(
          `Claude Workflow transcript directory escapes ${allowedRoot}: ${directory}`,
        )
      }
      if (relocation) {
        const copiedRoot = dirname(resolve(ref.path))
        const copiedRealRoot = await realpath(copiedRoot)
        const sessionRealRoot = await realpath(relocation.sessionRoot)
        const expectedSessionRealRoot = resolve(
          copiedRealRoot,
          relative(copiedRoot, relocation.sessionRoot),
        )
        const expectedRealDirectory = resolve(copiedRealRoot, relative(copiedRoot, directory))
        if (
          sessionRealRoot !== expectedSessionRealRoot
          || realDirectory !== expectedRealDirectory
        ) {
          throw new ClaudeTaskScopeError(
            `Claude Workflow transcript directory does not match copied session subtree ${relocation.sessionRoot}: ${directory}`,
          )
        }
      }
      const previous = directories.get(realDirectory)
      if (
        previous
        && (
          previous.runId !== binding.runId
          || resolve(previous.sourceTranscriptDir ?? previous.transcriptDir)
            !== resolve(binding.transcriptDir)
        )
      ) {
        throw new ClaudeTaskScopeError(
          `Claude Workflow transcript directory ${directory} has conflicting source bindings`,
        )
      }
      directories.set(realDirectory, {
        runId: binding.runId,
        transcriptDir: directory,
        sourceTranscriptDir: binding.transcriptDir,
        ...(relocation ? { copiedWorkflow: true } : {}),
      })
    }
  }
  return [...directories.values()].sort(
    (left, right) => left.transcriptDir.localeCompare(right.transcriptDir),
  )
}

export async function collectClaudeSubagentSources(
  ref: SessionRef,
  bindings: ReadonlyMap<string, readonly WorkflowRunBinding[]>,
  signal?: AbortSignal,
): Promise<ClaudeSubagentSources> {
  const subDir = join(ref.path.replace(/\.jsonl$/, ''), 'subagents')
  const filesByPath = new Map<string, string>()
  const workflowByPath = new Map<string, WorkflowSubagentLocation>()
  for (const file of await listSubagentFiles(subDir, signal)) {
    const path = resolve(file)
    filesByPath.set(path, file)
    const runId = workflowRunIdForSubagent(subDir, file)
    if (runId) {
      workflowByPath.set(path, {
        runId,
        transcriptDir: dirname(file),
      })
    }
  }

  for (const location of await workflowTranscriptDirectories(ref, bindings)) {
    signal?.throwIfAborted()
    const { runId, transcriptDir } = location
    const files = await listSubagentFiles(transcriptDir, signal, location.copiedWorkflow)
    for (const file of files) {
      const path = resolve(file)
      filesByPath.set(path, file)
      const previous = workflowByPath.get(path)
      if (
        previous
        && (
          previous.runId !== runId
          || resolve(previous.transcriptDir) !== resolve(transcriptDir)
        )
      ) {
        throw new ClaudeTaskScopeError(
          `Claude Workflow subagent ${file} belongs to multiple transcript directories`,
        )
      }
      workflowByPath.set(path, location)
    }
  }

  const files = [...filesByPath.values()].sort()
  const workflowByFile = new Map<string, WorkflowSubagentLocation>()
  for (const [path, location] of workflowByPath) {
    const file = filesByPath.get(path)
    if (file) workflowByFile.set(file, location)
  }
  return { files, workflowByFile }
}
