import { parseTtl } from "./cache.ts"

export { getCacheStore, getConfig } from "./config.ts"

export function parseTtlOrUndefined(ttl: string | number | undefined): number | undefined {
  return ttl === undefined ? undefined : parseTtl(ttl)
}
