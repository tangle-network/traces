/**
 * The SDK is the committed list below (spec §5): named functions and types.
 *
 * The built package is held to it twice: `dist/index.js` at run time, and
 * `dist/index.d.ts` as the TypeScript compiler reads it, through a consumer
 * file that imports every listed name and must type-check. A name joins only
 * when a command is built on it, it is the analyst extension point, or a named
 * consumer imports it (agent-dev-container's Intelligence API imports
 * `buildTraceFindingPacket`).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CLI } from './run-cli.js'

const ROOT = join(dirname(CLI), '..')

const VALUES = [
  // read
  'buildSpanRunTree',
  'collectSessionSelection',
  'describeSessionRelationship',
  'scanSessions',
  'parseSession',
  'knownHarnesses',
  'readOtlpInput',
  'writeOtlpFile',
  // facts
  'computeSessionFacts',
  'buildSessionFactsReport',
  'renderSessionFacts',
  // analyze
  'analyzeSpans',
  'runTraceInvestigation',
  'buildTraceFindingPacket',
  // ask
  'runTraceQuestions',
  'analysisEngineFromEnv',
  // check
  'conformanceOfSpans',
  // diff
  'diffRuns',
  'renderRunDiff',
  // watch
  'streamSessions',
  // share
  'redactSpans',
  'assessSpans',
  'verifySafe',
  'planUpload',
  'executeUpload',
  // bundle
  'assembleSessionBundle',
  'verifySessionBundle',
  // meta
  'tracesVersion',
] as const

const TYPES = [
  'SpanRunSnapshot',
  'SpanRunNode',
  'SessionSeedGroup',
  'SessionSelection',
  'SessionSelectionRow',
  'CollectSessionSelectionOptions',
  'SessionRelationship',
  'SessionWorkflowSummary',
  'SessionWorkflowIssue',
  'OtlpSpan',
  'SessionRef',
  'ScanOptions',
  'ScannedSession',
  'HarnessTraceAdapter',
  'OtlpInput',
  'SessionFact',
  'SessionFacts',
  'SessionFactsReport',
  'SessionTurnFact',
  'AnalyzeOptions',
  'AnalyzeResult',
  'TraceInvestigationOptions',
  'TraceInvestigationResult',
  'TraceFindingPacket',
  'BuildTraceFindingPacketOptions',
  'TraceQuestion',
  'TraceQuestionsResult',
  'RunDiffReport',
  'TraceStreamEvent',
  'TraceLiveFinding',
  'UploadPlan',
  'UploadBackend',
  'VerifySafeResult',
  'SessionBundleManifest',
] as const

const sorted = (names: readonly string[]): string[] => [...names].sort()

/** The emitted declarations' exports, split into values and types, and the diagnostics of a file that imports all of them. */
function readDeclarations(): { values: string[]; types: string[]; consumerErrors: string[] } {
  const declarations = join(ROOT, 'dist', 'index.d.ts')
  const consumer = join(ROOT, 'tests', 'sdk-surface.consumer.ts')
  const consumerText = [
    `import type { ${TYPES.map((name) => `${name} as T_${name}`).join(', ')} } from '../dist/index.js'`,
    `import { ${VALUES.join(', ')} } from '../dist/index.js'`,
    `export type Types = [${TYPES.map((name) => (name === 'SessionFact' ? `T_${name}<unknown>` : `T_${name}`)).join(', ')}]`,
    `export const values = [${VALUES.join(', ')}] as const`,
    '',
  ].join('\n')
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
  }
  const host = ts.createCompilerHost(options, true)
  const { fileExists, readFile, getSourceFile } = host
  host.fileExists = (name) => name === consumer || fileExists.call(host, name)
  host.readFile = (name) => (name === consumer ? consumerText : readFile.call(host, name))
  host.getSourceFile = (name, language, ...rest) =>
    name === consumer ? ts.createSourceFile(name, consumerText, language, true) : getSourceFile.call(host, name, language, ...rest)
  const program = ts.createProgram([consumer], options, host)
  const checker = program.getTypeChecker()
  const consumerFile = program.getSourceFile(consumer)!
  const consumerErrors = [...program.getSyntacticDiagnostics(consumerFile), ...program.getSemanticDiagnostics(consumerFile)]
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  const declarationFile = program.getSourceFile(declarations)
  if (!declarationFile) throw new Error(`${declarations} was not loaded: run pnpm build first`)
  const values: string[] = []
  const types: string[] = []
  for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(declarationFile)!)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    ;(target.flags & ts.SymbolFlags.Value ? values : types).push(symbol.name)
  }
  return { values, types, consumerErrors }
}

describe('the SDK surface', () => {
  it('exports the committed surface by name', () => {
    expect(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')).not.toMatch(/^export \*/mu)
  })

  it('dist/index.js exports exactly the committed functions', async () => {
    const sdk = (await import(pathToFileURL(join(ROOT, 'dist', 'index.js')).href)) as Record<string, unknown>
    expect(sorted(Object.keys(sdk))).toEqual(sorted(VALUES))
    for (const name of VALUES) expect(typeof sdk[name], name).toBe('function')
  })

  it('dist/index.d.ts declares exactly the committed values and types, and a consumer importing all of them type-checks', () => {
    const { values, types, consumerErrors } = readDeclarations()
    expect(sorted(values)).toEqual(sorted(VALUES))
    expect(sorted(types)).toEqual(sorted(TYPES))
    expect(consumerErrors).toEqual([])
  })

  it('docs/sdk.md names every export', () => {
    const page = readFileSync(join(ROOT, 'docs', 'sdk.md'), 'utf8')
    for (const name of [...VALUES, ...TYPES]) expect(page, name).toContain(`\`${name}\``)
  })
})
