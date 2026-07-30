import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isMissingPathError } from '../json.js'
import type { SessionRef } from '../types.js'
import {
  ClaudeTaskScopeError,
  workflowRunIdForSubagent,
  type WorkflowRunBinding,
} from './claude-workflow.js'

export interface WorkflowSubagentLocation {
  runId: string
  transcriptDir: string
}

export interface ClaudeSubagentSources {
  files: readonly string[]
  workflowByFile: ReadonlyMap<string, WorkflowSubagentLocation>
}

async function listSubagentFiles(root: string, signal?: AbortSignal): Promise<string[]> {
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

async function workflowTranscriptDirectories(
  ref: SessionRef,
  bindings: ReadonlyMap<string, readonly WorkflowRunBinding[]>,
): Promise<string[]> {
  const allowedRoot = workflowStorageRoot(ref)
  const allowedRealRoot = await realpath(allowedRoot)
  const directories = new Map<string, string>()
  for (const runBindings of bindings.values()) {
    for (const binding of runBindings) {
      const directory = resolve(binding.transcriptDir)
      if (!pathIsWithin(allowedRoot, directory)) {
        throw new ClaudeTaskScopeError(
          `Claude Workflow transcript directory escapes ${allowedRoot}: ${directory}`,
        )
      }
      let realDirectory: string
      try {
        realDirectory = await realpath(directory)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      if (!pathIsWithin(allowedRealRoot, realDirectory)) {
        throw new ClaudeTaskScopeError(
          `Claude Workflow transcript directory escapes ${allowedRoot}: ${directory}`,
        )
      }
      directories.set(realDirectory, directory)
    }
  }
  return [...directories.values()].sort()
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

  for (const transcriptDir of await workflowTranscriptDirectories(ref, bindings)) {
    signal?.throwIfAborted()
    const runId = basename(transcriptDir)
    for (const file of await listSubagentFiles(transcriptDir, signal)) {
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
      workflowByPath.set(path, { runId, transcriptDir })
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
