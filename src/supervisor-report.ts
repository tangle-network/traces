import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * Supervision-tree view: what the TREE did (steers, spawn waves, concurrency,
 * idle wall, cost by role, accepted vs rejected), as opposed to the rest of
 * this CLI, which reports what happened inside one harness session.
 *
 * Eval owns Runtime run discovery and analysis. Traces adds coordination-log
 * evidence through its reader, then prints a single report or a rollup.
 */
export async function writeSupervisorReport(runDir: string, out?: string): Promise<void> {
  const { analyzeSupervisorRun, findSupervisorRunDirs, isRuntimeSupervisorRunDir, renderSupervisorRollupMarkdown, renderSupervisorRunMarkdown, rollupSupervisorRuns } = await import('@tangle-network/agent-eval/supervisor-run')
  const { fileRunContextSupervisorRunReader } = await import('./supervisor-run-context.js')
  const single = await isRuntimeSupervisorRunDir(runDir)
  const runDirs = single ? [runDir] : await findSupervisorRunDirs(runDir)
  if (runDirs.length === 0) {
    throw new Error(
      `no supervisor run found at ${runDir} — expected a Runtime run containing ` +
        'spawn-journal.jsonl, observer.jsonl, or failure.json, or a parent directory containing such runs',
    )
  }
  const reports = await Promise.all(
    runDirs.map((dir) => analyzeSupervisorRun(fileRunContextSupervisorRunReader(dir))),
  )
  const markdown = single
    ? renderSupervisorRunMarkdown(reports[0]!)
    : renderSupervisorRollupMarkdown(rollupSupervisorRuns(reports), `Supervisor rollup — ${runDir}`)
  if (out) {
    const path = resolve(out, 'report.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, markdown, 'utf8')
    console.log(`supervisor report → ${path}  (${runDirs.length === 1 ? '1 run' : `${runDirs.length} runs`})`)
  } else {
    console.log(markdown)
  }
}
