import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError } from './commands.js'
import type { SessionFacts } from './session-facts.js'

export type OwnerRow = Readonly<Record<string, unknown>>
export type Registry = { readonly root: string }
export interface GraphOwner {
  graphRegistry(root: string): Registry
  listGraphRuns(registry: Registry): Promise<OwnerRow[]>
  graphDigest?: (content: unknown) => string
  taskShapeDigest?: (shape: unknown) => string
  graphCorpusSummary?: (registry: Registry, options?: Record<string, unknown>) => Promise<Record<string, unknown>>
  graphFromSessionFacts?: (facts: readonly SessionFacts[], options: Record<string, unknown>) => {
    graph: unknown; record: OwnerRow
  }
  recordStoredGraphRun?: (registry: Registry, graph: unknown, record: OwnerRow, options?: { preserveLabels?: boolean }) => Promise<unknown>
}

export async function graphOwner(moduleRef?: string): Promise<GraphOwner> {
  const module = moduleRef === undefined ? '@tangle-network/agent-runtime/kernel'
    : moduleRef.startsWith('file:') ? moduleRef
      : isAbsolute(moduleRef) || moduleRef.startsWith('.') ? pathToFileURL(resolve(moduleRef)).href : moduleRef
  let owner: Record<string, unknown>
  try { owner = await import(module) as Record<string, unknown> } catch (error) {
    throw new CliError(`cannot load Runtime public module ${module}: ${String(error)}`, 'setup')
  }
  for (const name of ['graphRegistry', 'graphCorpusSummary', 'listGraphRuns']) {
    if (typeof owner[name] !== 'function') throw new CliError(
      `Runtime public module lacks ${name}; install a Runtime release with graph registry exports, or pass --runtime-module /path/to/dist/kernel.js`, 'setup')
  }
  return owner as unknown as GraphOwner
}

export function graphRecordObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
