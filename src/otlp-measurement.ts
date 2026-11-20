import { readOtlpInput, type OtlpInput } from './otlp-input.js'

/** Measurements require one body per source identity. The diagnostic reader keeps every conflicting row's location. */
export async function readConsistentOtlpInput(path: string, options?: { readonly allowEmptyDirectory?: boolean }): Promise<OtlpInput> {
  const input = await readOtlpInput(path, options)
  const conflict = input.issues.find((issue) => issue.kind === 'conflicting-span-id')
  if (conflict) throw new Error(`conflicting span bodies at ${conflict.file}:${conflict.line}. ${conflict.detail}`)
  return input
}
