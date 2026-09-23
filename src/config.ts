import { MemoryCache, type SemanticCache } from "./cache.ts"
import { NotConfiguredError } from "./errors.ts"
import { jev } from "./providers/jev.ts"
import type { Observability, SemanticProvider } from "./types.ts"

export interface SemanticDefaults {
  timeoutMs?: number
  minConfidence?: number
  cache?: string | number
  /**
   * Rounds used to measure confidence for truth-backed answers. Providers are
   * not deterministic, so this is a measured spread rather than a derived one.
   */
  samples?: number
  /** Threshold `is()` uses to turn a probability into a boolean. */
  threshold?: number
  /** Probabilities inside this band are reported as "unknown" when allowed. */
  uncertaintyBand?: readonly [number, number]
  /** Turns a noun-phrase criterion into a proposition. Replace for other languages. */
  scoreFrame?: (criterion: string) => string
}

export interface SemanticConfig {
  provider?: SemanticProvider
  defaults?: SemanticDefaults
  observability?: Observability
  cacheStore?: SemanticCache
  /** Warn when calls that could have shared a request did not. Defaults to NODE_ENV !== "production". */
  warnUnbatched?: boolean
}

export const BUILTIN_DEFAULTS = {
  timeoutMs: 10_000,
  samples: 3,
  threshold: 0.5,
  /** Matches the band the provider's own guidance recommends for escalation. */
  uncertaintyBand: [0.3, 0.7] as const,
} satisfies SemanticDefaults

/**
 * Everything a call needs that is not in its own options: the configuration,
 * the cache it reads and writes, and the provider it talks to.
 *
 * There is one global runtime behind `semantic` and `configureSemantic`, and
 * `createSemantic()` makes private ones. The two never share state.
 */
export interface Runtime {
  readonly config: SemanticConfig
  readonly store: SemanticCache
  provider(override?: SemanticProvider): SemanticProvider
  /** Merge more configuration in, the way `configureSemantic` does for the global runtime. */
  configure(config: SemanticConfig): void
}

function resolveProviderIn(config: SemanticConfig, override?: SemanticProvider): SemanticProvider {
  if (override) return override
  if (config.provider) return config.provider
  // Zero-config path: an API key in the environment is enough to start.
  if (process.env["JEV_API_KEY"]) {
    config.provider = jev()
    return config.provider
  }
  throw new NotConfiguredError()
}

export function createRuntime(config: SemanticConfig = {}): Runtime {
  let own: SemanticConfig = { ...config, defaults: { ...config.defaults } }
  let store = config.cacheStore ?? new MemoryCache()
  return {
    get config() {
      return own
    },
    get store() {
      return store
    },
    provider: (override) => resolveProviderIn(own, override),
    configure(next) {
      own = { ...own, ...next, defaults: { ...own.defaults, ...next.defaults } }
      if (next.cacheStore) store = next.cacheStore
    },
  }
}

let current: SemanticConfig = {}
let store: SemanticCache = new MemoryCache()

/** The runtime behind the module-level `semantic`. Reads the live config on every access. */
export const globalRuntime: Runtime = {
  get config() {
    return current
  },
  get store() {
    return store
  },
  provider: (override) => resolveProviderIn(current, override),
  configure: (config) => configureSemantic(config),
}

export function configureSemantic(config: SemanticConfig): void {
  current = { ...current, ...config, defaults: { ...current.defaults, ...config.defaults } }
  if (config.cacheStore) store = config.cacheStore
}

export function resetSemantic(): void {
  current = {}
  store = new MemoryCache()
}

export function getConfig(): SemanticConfig {
  return current
}

export function getCacheStore(): SemanticCache {
  return store
}

export function resolveProvider(override?: SemanticProvider): SemanticProvider {
  return globalRuntime.provider(override)
}

export function shouldWarnUnbatched(config: SemanticConfig = current): boolean {
  return config.warnUnbatched ?? process.env["NODE_ENV"] !== "production"
}
