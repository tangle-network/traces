/**
 * `traces bundle-view` — project a full session bundle down to one view.
 *
 * A bundle has two consumers with opposite needs. An AUDITOR cites the
 * session and needs every source byte. A WRITER must reach its own conclusion
 * about the session and therefore must not be able to read the conclusion the
 * session already reached — which the transcript holds verbatim, including the
 * shell call that authored an earlier report.
 *
 * Serving both from one directory cannot work, and policing it by grep cannot
 * work either: a check that looks for the earlier report FILE passes while its
 * CONTENT sits in the transcript. So the two consumers get two directories.
 * The evidence-only view is a projection of the full bundle: an explicit
 * allow-list of counted artifacts, every other path excluded by name with its
 * reason and its hash, and a content check that proves no excluded file's text
 * survived into the view.
 *
 * The allow-list is the structure. The content check is the proof that the
 * structure is right: before anything is written, every candidate is compared
 * against every excluded file, and a candidate that repeats one is dropped
 * from the view and named in the manifest. So the written view never carries
 * text from a file the view says it removed.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  hashSessionBundleFiles,
  listSessionBundleFiles,
  readSessionBundleManifest,
  writeSessionBundleManifest,
  type SessionBundleExclusion,
  type SessionBundleExclusionRule,
  type SessionBundleLeakCheck,
  type SessionBundleManifest,
  type SessionBundleView,
} from './bundle.js'
import { POLICY_EVIDENCE_NOTE } from './evidence.js'

/**
 * Bundle-relative paths the evidence-only view carries. Everything else is
 * excluded, so a path added to the bundle later is dropped until someone puts
 * it here on purpose: the view can only get narrower by accident, never wider.
 *
 * Each entry states what the artifact is MADE of, because that is the reason
 * it is safe: counts, names, identifiers, timestamps and hashes, derived by
 * code from the spans — never a run of words the session wrote.
 *
 * `owned` marks the artifacts whose schema THIS package defines and whose every
 * field it derives. Those two classes fail differently under the content check:
 * an owned artifact that repeats session text is a defect in traces and stops
 * the projection, while a repo ledger file is free-form by convention and its
 * text is a fact about that repo, so it is dropped from the view and named in
 * the manifest instead.
 */
interface AllowListEntry {
  readonly path: string
  readonly owned: boolean
  readonly carries: string
}

const EVIDENCE_ONLY_ALLOW_LIST: readonly AllowListEntry[] = [
  {
    path: 'derived/session-index.json',
    owned: true,
    carries: 'per-session counts, tool names, models, and nearby-context file metadata',
  },
  {
    path: 'derived/evidence.jsonl',
    owned: true,
    carries: 'execution statistics, token and tool totals, loop and error counts',
  },
  {
    path: 'ledger/current.json',
    owned: false,
    carries: 'the repo ledger current-state record',
  },
  {
    path: 'ledger/scorecard.json',
    owned: false,
    carries: 'the repo ledger scorecard rows',
  },
  {
    path: 'ledger/skill-runs.jsonl',
    owned: false,
    carries: 'skill-run rows: skill name, timestamp, and outcome fields',
  },
]

interface ExclusionRuleEntry {
  readonly matches: (path: string) => boolean
  readonly rule: SessionBundleExclusionRule
  readonly reason: string
}

/**
 * Why each excluded path is excluded, in the words a reader of the manifest
 * needs. The last entry is the default deny, and it must stay last.
 */
const EXCLUSION_RULES: readonly ExclusionRuleEntry[] = [
  {
    matches: (path) => path === 'session/transcript.jsonl' || path.startsWith('session/'),
    rule: 'session-source',
    reason:
      'raw session text: the transcript and any subagent transcript hold every word the session wrote, ' +
      'including the shell call that authored an earlier report',
  },
  {
    matches: (path) => path === 'derived/report.md',
    rule: 'session-text-derived',
    reason: 'the deterministic report quotes the session verbatim: the first prompt line and evidence excerpts per finding',
  },
  {
    matches: (path) => path === 'derived/trace.otlp.jsonl',
    rule: 'session-text-derived',
    reason: 'spans carry input.value, output.value and content: the full prompt and response text of every turn',
  },
  {
    matches: (path) => path === 'ledger/progress.md',
    rule: 'authored-prose',
    reason: 'progress notes are written at session close and restate what the session concluded',
  },
  {
    matches: (path) => /^ledger\/handoff-.*\.md$/.test(path),
    rule: 'authored-prose',
    reason: 'a handoff is the session conclusion in prose',
  },
  {
    matches: (path) => path.startsWith('ledger/reflections/'),
    rule: 'authored-prose',
    reason: 'a reflection is the session conclusion in prose',
  },
  {
    matches: (path) => path === 'ledger/experiments.jsonl',
    rule: 'authored-prose',
    reason: 'experiment rows carry free-text verdict and note fields that restate what the session concluded',
  },
  {
    matches: (path) => path === 'repo/git-log.txt',
    rule: 'authored-prose',
    reason: 'commit subjects are prose the session authored',
  },
  {
    matches: () => true,
    rule: 'not-allow-listed',
    reason: 'the evidence-only view carries an explicit allow-list of counted artifacts, and this path is not on it',
  },
]

/**
 * Words per content signature: the width at which a shared run reads as a
 * quotation rather than a coincidence.
 *
 * Measured over one real 170-file bundle: the deterministic report shares 509
 * of its 747 runs with the transcript, while the two counted artifacts the
 * view carries hold no eight-word run of prose at all.
 */
const SIGNATURE_WORDS = 8

/**
 * How many of those words must be letters for the run to count as prose.
 *
 * `input 0 output 0 reasoning 0 cached 0` is a token-usage block, not a
 * sentence, so any two files that ever printed one would share it. Requiring 7
 * letters of 8 keeps the quotations and drops the structural runs: on that same
 * bundle it cut one ledger file's recorded overlap from 47 runs to the 22 that
 * are sentences.
 */
const MIN_WORD_TOKENS = 7

/**
 * Identifiers are not prose. A session file path, a URL, a UUID and a SHA
 * appear on both sides of every comparison because both sides describe the
 * same session, and counting those as leaked text would exclude the counted
 * artifacts and leave the view empty. Scrubbing them from BOTH sides before
 * signing leaves only words someone chose.
 */
function scrubIdentifiers(line: string): string {
  return line
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
    .replace(/\/?(?:[\w.@+~-]+\/)+[\w.@+~-]*/g, ' ')
    .replace(/\b[0-9a-f-]{8,}\b/gi, ' ')
}

/**
 * Prose this package writes into every derived artifact, whatever the session.
 *
 * A constant is not session text, but it reads as one to a content check when
 * the session happened to work on this package's own source. Subtracting these
 * from the comparison keeps the check about words the SESSION produced. Each
 * entry is imported from the code that emits it, so the two cannot drift.
 */
const PACKAGE_CONSTANT_PROSE: readonly string[] = [POLICY_EVIDENCE_NOTE]

function stripPackageConstants(text: string): string {
  let out = text
  for (const constant of PACKAGE_CONSTANT_PROSE) out = out.split(constant).join(' ')
  return out
}

function collectJsonStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) collectJsonStrings(item, into)
  else if (value !== null && typeof value === 'object') {
    // Values only. A field NAME is schema this package or a ledger convention
    // chose, so `stddev null min null max` would otherwise read as a shared
    // sentence between a counted artifact and any transcript that printed one.
    for (const item of Object.values(value)) collectJsonStrings(item, into)
  }
}

/**
 * The text of one line that a person or a model could have written.
 *
 * A JSON line yields its string VALUES; anything else yields the line itself.
 * Probing with a parse is the point: "this line is not JSON" is an answer, not
 * a failure, and the line is then compared as plain text.
 */
function proseFragments(line: string): string[] {
  const trimmed = line.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const strings: string[] = []
      collectJsonStrings(parsed, strings)
      return strings
    } catch {
      // not JSON after all → compared as plain text below
    }
  }
  return [line]
}

/**
 * Distinct signatures in one text: every run of `SIGNATURE_WORDS` consecutive
 * words, lowercased, taken WITHIN one line's prose. Signatures never span a
 * newline, so memory stays bounded by the longest line rather than the file,
 * and a structure whose every line is a key and a number produces no
 * signatures at all — which is the true statement about it: it holds no prose.
 */
export function sessionTextSignatures(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of stripPackageConstants(text).split('\n')) {
    for (const fragment of proseFragments(line)) {
      const words = scrubIdentifiers(fragment)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
      for (let i = 0; i + SIGNATURE_WORDS <= words.length; i++) {
        const window = words.slice(i, i + SIGNATURE_WORDS)
        if (window.filter((word) => /^[a-z]+$/.test(word)).length < MIN_WORD_TOKENS) continue
        out.add(window.join(' '))
      }
    }
  }
  return out
}

export interface SessionTextLeak {
  /** Bundle-relative path of the carried file that repeats excluded text. */
  readonly viewPath: string
  /** Bundle-relative paths of the excluded files the repeated text came from. */
  readonly sources: readonly string[]
  /** Distinct signatures this file shares with those sources. */
  readonly signatures: number
  /**
   * One matched signature, for a diagnostic message only. It is a fragment of
   * the excluded text, so it must never be written into a view artifact.
   */
  readonly example: string
}

export interface FindSessionTextLeaksOptions {
  /** Directory holding the carried files. */
  readonly viewDir: string
  /** Directory holding the excluded files. */
  readonly sourceDir: string
  /** Bundle-relative paths under `viewDir` to check. */
  readonly carriedPaths: readonly string[]
  /** Bundle-relative paths under `sourceDir` whose text must not appear in the view. */
  readonly excludedPaths: readonly string[]
}

export interface SessionTextLeakReport {
  /** One entry per carried file that repeats excluded text. Empty is the pass. */
  readonly leaks: readonly SessionTextLeak[]
  readonly carried: readonly { readonly path: string; readonly signatures: number }[]
  readonly comparedSources: readonly string[]
  readonly sourceSignatures: number
}

/**
 * Compare a set of carried files against the files a view excluded.
 *
 * The signature index is built from the CARRIED files, which are small, and
 * the excluded files are then read one at a time and tested against it — the
 * cheap direction, since a transcript can be orders of magnitude larger than
 * everything a view keeps. Every excluded file is scanned to the end, so the
 * per-file counts are totals rather than "however many we saw before stopping".
 */
export async function findSessionTextLeaks(
  opts: FindSessionTextLeaksOptions,
): Promise<SessionTextLeakReport> {
  const index = new Map<string, string>()
  const carried: { path: string; signatures: number }[] = []
  for (const path of opts.carriedPaths) {
    const signatures = sessionTextSignatures(await readFile(join(opts.viewDir, path), 'utf8'))
    carried.push({ path, signatures: signatures.size })
    for (const signature of signatures) if (!index.has(signature)) index.set(signature, path)
  }

  const hits = new Map<string, { matched: Set<string>; sources: Set<string>; example: string }>()
  const comparedSources: string[] = []
  let sourceSignatures = 0
  for (const sourcePath of opts.excludedPaths) {
    const signatures = sessionTextSignatures(await readFile(join(opts.sourceDir, sourcePath), 'utf8'))
    comparedSources.push(sourcePath)
    sourceSignatures += signatures.size
    for (const signature of signatures) {
      const viewPath = index.get(signature)
      if (viewPath === undefined) continue
      const hit = hits.get(viewPath) ?? { matched: new Set<string>(), sources: new Set<string>(), example: signature }
      hit.matched.add(signature)
      hit.sources.add(sourcePath)
      hits.set(viewPath, hit)
    }
  }
  const leaks: SessionTextLeak[] = [...hits].map(([viewPath, hit]) => ({
    viewPath,
    sources: [...hit.sources].sort(),
    signatures: hit.matched.size,
    example: hit.example,
  }))
  return { leaks, carried, comparedSources, sourceSignatures }
}

export type EvidenceOnlyVerdict =
  | { readonly carried: true; readonly owned: boolean; readonly carries: string }
  | { readonly carried: false; readonly rule: SessionBundleExclusionRule; readonly reason: string }

/** Classify one bundle-relative path against the evidence-only view. */
export function classifyEvidenceOnlyPath(path: string): EvidenceOnlyVerdict {
  const allowed = EVIDENCE_ONLY_ALLOW_LIST.find((entry) => entry.path === path)
  if (allowed) return { carried: true, owned: allowed.owned, carries: allowed.carries }
  const rule = EXCLUSION_RULES.find((entry) => entry.matches(path))!
  return { carried: false, rule: rule.rule, reason: rule.reason }
}

/**
 * Limits of the evidence-only view, carried in its manifest so a reader meets
 * the boundary in the artifact instead of discovering it.
 */
const EVIDENCE_ONLY_LIMITS: readonly string[] = [
  'the exclusion is verbatim-tight, not paraphrase-tight: a conclusion restated in different words inside a carried artifact is not detectable by content signatures',
  'ledger prose (progress, handoffs, reflections) and experiment free-text fields are excluded whole; a measured experiment result is readable only from the full bundle, under audit rules',
  'the view carries counts, names, identifiers, timestamps and hashes; a question that needs the words of a turn cannot be answered from it',
]

export interface ProjectSessionBundleOptions {
  /** Directory holding the FULL bundle to project. */
  readonly bundleDir: string
  /** View directory to create. Must be new or empty: one directory, one view. */
  readonly outDir: string
  readonly view: SessionBundleView
  readonly generatedAt?: string
}

export interface ProjectSessionBundleResult {
  readonly directory: string
  readonly manifestPath: string
  readonly manifest: SessionBundleManifest
  readonly leakCheck: SessionBundleLeakCheck
}

/**
 * Project a full bundle into a narrower view.
 *
 * Every file is verified against the source manifest's hash first: a bundle
 * whose bytes have drifted from its own manifest cannot be projected, because
 * the classification is only meaningful over the files this package wrote.
 * The content check then runs before anything is written, so a candidate that
 * repeats an excluded source is dropped instead of copied.
 */
export async function projectSessionBundle(
  opts: ProjectSessionBundleOptions,
): Promise<ProjectSessionBundleResult> {
  if (opts.view !== 'evidence-only') {
    throw new Error(
      `unsupported bundle view ${JSON.stringify(opts.view)}. ` +
        'The full view IS the bundle `traces bundle` assembles, so there is nothing to project into it; ' +
        'the projectable view is "evidence-only".',
    )
  }
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const sourceDir = resolve(opts.bundleDir)
  const source = await readSessionBundleManifest(sourceDir)
  if (source.view !== 'full') {
    throw new Error(
      `${sourceDir} is already the ${source.view} view — project from the full bundle, not from a view of it`,
    )
  }

  const outDir = resolve(opts.outDir)
  await mkdir(outDir, { recursive: true })
  if ((await readdir(outDir)).length > 0) {
    throw new Error(
      `view output directory ${outDir} is not empty — pass a new directory so one directory holds exactly one view`,
    )
  }

  const sourceHashes = new Map(source.files.map((file) => [file.path, file] as const))
  const carriedPaths: string[] = []
  const carries = new Map<string, string>()
  const excluded: SessionBundleExclusion[] = []
  const candidates: {
    path: string
    bytes: Buffer
    sha256: string
    carries: string
    owned: boolean
  }[] = []
  for (const path of await listSessionBundleFiles(sourceDir)) {
    // manifest.json is rewritten for the view, never copied: it names the view
    // it describes, and a copied one would name the wrong view.
    if (path === 'manifest.json') continue
    const bytes = await readFile(join(sourceDir, path))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const recorded = sourceHashes.get(path)
    if (!recorded) {
      throw new Error(
        `${join(sourceDir, path)} is not listed in the bundle manifest — the bundle changed after assembly ` +
          'and cannot be projected; re-run `traces bundle`',
      )
    }
    if (recorded.sha256 !== sha256) {
      throw new Error(
        `${join(sourceDir, path)} does not match its manifest hash (${recorded.sha256} recorded, ${sha256} on disk) — ` +
          'the bundle changed after assembly and cannot be projected; re-run `traces bundle`',
      )
    }
    const verdict = classifyEvidenceOnlyPath(path)
    if (!verdict.carried) {
      excluded.push({ path, bytes: bytes.length, sha256, rule: verdict.rule, reason: verdict.reason })
      continue
    }
    candidates.push({ path, bytes, sha256, carries: verdict.carries, owned: verdict.owned })
  }

  // The content check runs BEFORE anything is written, so a file that repeats
  // an excluded source never reaches the view directory at all.
  const report = await findSessionTextLeaks({
    viewDir: sourceDir,
    sourceDir,
    carriedPaths: candidates.map((candidate) => candidate.path),
    excludedPaths: excluded.map((entry) => entry.path),
  })
  const leakByPath = new Map(report.leaks.map((leak) => [leak.viewPath, leak] as const))
  const ownedLeak = report.leaks.find((leak) => candidates.some((c) => c.path === leak.viewPath && c.owned))
  if (ownedLeak) {
    throw new Error(
      `${ownedLeak.viewPath} repeats ${ownedLeak.signatures} ${SIGNATURE_WORDS}-word run(s) found in ` +
        `${ownedLeak.sources.join(', ')}, for example "${ownedLeak.example}". That artifact is derived by ` +
        'traces and must carry counts only, so this is a defect in the derivation, not a property of the ' +
        'session. No view was written.',
    )
  }

  for (const candidate of candidates) {
    const leak = leakByPath.get(candidate.path)
    if (leak) {
      excluded.push({
        path: candidate.path,
        bytes: candidate.bytes.length,
        sha256: candidate.sha256,
        rule: 'content-signature',
        reason:
          `the content check found ${leak.signatures} ${SIGNATURE_WORDS}-word run(s) this file shares with ` +
          `${leak.sources.join(', ')}; carrying it would put back text the view removes`,
        contentMatch: { signatures: leak.signatures, sources: leak.sources },
      })
      continue
    }
    const target = join(outDir, candidate.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, candidate.bytes)
    carriedPaths.push(candidate.path)
    carries.set(candidate.path, candidate.carries)
  }

  const leakCheck: SessionBundleLeakCheck = {
    signatureWords: SIGNATURE_WORDS,
    comparedSources: report.comparedSources,
    sourceSignatures: report.sourceSignatures,
    carried: report.carried
      .filter((entry) => carries.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        carries: carries.get(entry.path)!,
        signatures: entry.signatures,
      })),
    matches: 0,
  }
  const sourceManifestBytes = await readFile(join(sourceDir, 'manifest.json'))
  const manifest: SessionBundleManifest = {
    schemaVersion: 2,
    kind: 'traces.session_bundle',
    view: 'evidence-only',
    createdAt: generatedAt,
    provenance: source.provenance,
    files: await hashSessionBundleFiles(outDir),
    absent: source.absent,
    excluded,
    ledgerSlices: source.ledgerSlices.filter((slice) => carriedPaths.includes(slice.path)),
    knownLimits: [...source.knownLimits, ...EVIDENCE_ONLY_LIMITS],
    projection: {
      sourceDirectory: sourceDir,
      sourceManifestSha256: createHash('sha256').update(sourceManifestBytes).digest('hex'),
      leakCheck,
    },
  }
  const manifestPath = await writeSessionBundleManifest(outDir, manifest)
  return { directory: outDir, manifestPath, manifest, leakCheck }
}
