/**
 * Reads an environment variable where one exists. Runtimes without `process`
 * (edge workers) simply have no environment to read, rather than crashing.
 */
export function env(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.[name]
}
