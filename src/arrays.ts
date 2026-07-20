export function appendAll<T>(target: T[], values: readonly T[]): void {
  for (const value of values) target.push(value)
}
