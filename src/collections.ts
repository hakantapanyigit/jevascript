import { BUILTIN_DEFAULTS, globalRuntime, resolveTimeout, type Runtime } from "./config.ts"
import { emit as emitEvent, runPlan as runPlanRaw } from "./runner.ts"
import { parseTtlOrUndefined } from "./internal.ts"
import type { ChoiceAnswer, SemanticProvider, State, TruthAnswer } from "./types.ts"

export interface CollectionOptions {
  provider?: SemanticProvider
  timeoutMs?: number
  cache?: string | number
  samples?: number
  threshold?: number
  /** How to render an item as state. Defaults to JSON for objects. */
  label?: (item: never, index: number) => string
  /** Bound on how many items are evaluated concurrently. */
  concurrency?: number
}

export interface RankOptions extends CollectionOptions {
  by: string
  trueWhen?: string
  falseWhen?: string
  /**
   * Shared state every candidate is judged against — the query in a re-ranking
   * setup. Sent alongside each candidate so the judgement is relative to it.
   */
  context?: State
}

export interface Ranked<T> {
  item: T
  score: number
}

function render<T>(item: T, index: number, label?: (item: never, index: number) => string): string {
  if (label) return label(item as never, index)
  if (typeof item === "string") return item
  return JSON.stringify(item)
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * Stops handing out new items as soon as one fails or `stop()` returns true,
 * so a failing provider or an already-decided `some()` does not keep spending
 * requests. Items never started are left `undefined`.
 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stop: (result: R) => boolean = () => false,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length)
  let cursor = 0
  let halted = false
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!halted && cursor < items.length) {
      const index = cursor++
      try {
        const result = await fn(items[index]!, index)
        results[index] = result
        if (stop(result)) halted = true
      } catch (error) {
        halted = true
        throw error
      }
    }
  })
  await Promise.all(workers)
  return results
}

export interface Collections {
  filter: <T>(items: readonly T[], condition: string, options?: CollectionOptions & { trueWhen?: string; falseWhen?: string }) => Promise<T[]>
  some: <T>(items: readonly T[], condition: string, options?: CollectionOptions) => Promise<boolean>
  every: <T>(items: readonly T[], condition: string, options?: CollectionOptions) => Promise<boolean>
  rank: <T>(items: readonly T[], options: RankOptions) => Promise<Ranked<T>[]>
  find: <T>(items: readonly T[], condition: string, options?: CollectionOptions) => Promise<T | undefined>
  compare: <T>(left: T, right: T, options: { by: string } & Omit<CollectionOptions, "label"> & { label?: (item: T) => string }) => Promise<Comparison>
}

export type Comparison = "left" | "right" | "equal"

/** Collection operations bound to one runtime: its provider, cache and defaults. */
export function bindCollections(runtime: Runtime): Collections {
  const getConfig = () => runtime.config
  const resolveProvider = (override?: SemanticProvider) => runtime.provider(override)
  const emit = (event: Parameters<typeof emitEvent>[0]) => emitEvent(event, runtime.config)
  const runPlan: typeof runPlanRaw = (provider, state, planned, options = {}) =>
    runPlanRaw(provider, state, planned, { ...options, store: runtime.store })
  const thresholdOf = (options: { threshold?: number }) =>
    options.threshold ?? getConfig().defaults?.threshold ?? BUILTIN_DEFAULTS.threshold
  const timeoutOf = (options: { timeoutMs?: number }) => {
    const timeoutMs = resolveTimeout(options.timeoutMs, getConfig())
    return timeoutMs !== undefined ? { timeoutMs } : {}
  }

/**
 * Scores items independently against one proposition.
 *
 * This is N requests, not one: each item is a different state, and a request
 * carries a single state. Prefer `find` when you only need the best item.
 * `stopWhen` ends the walk early once the answer is decided.
 */
async function scoreEach<T>(
  items: readonly T[],
  condition: string,
  options: RankOptions | (CollectionOptions & { by: string; trueWhen?: string; falseWhen?: string }),
  operation: "filter" | "rank" | "find" | "compare",
  stopWhen?: (probability: number) => boolean,
): Promise<(number | undefined)[]> {
  const provider = resolveProvider(options.provider)
  const ttl = parseTtlOrUndefined(options.cache ?? getConfig().defaults?.cache)
  const samples = options.samples ?? 1
  const started = Date.now()
  const totals = { requests: 0, cached: 0, inputTokens: 0, outputTokens: 0 }
  const scores = await mapLimited(
    items,
    options.concurrency ?? 8,
    async (item, index) => {
      const rendered = render(item, index, options.label)
      const shared = (options as { context?: State }).context
      const state: State = shared === undefined ? rendered : { context: shared, candidate: rendered }
      const result = await runPlan(
        provider,
        state,
        [
          {
            key: "match",
            question: {
              kind: "truth",
              instructions: condition,
              ...(options.trueWhen !== undefined ? { trueWhen: options.trueWhen } : {}),
              ...(options.falseWhen !== undefined ? { falseWhen: options.falseWhen } : {}),
            },
            samples,
            ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
          },
        ],
        timeoutOf(options),
      )
      totals.requests += result.requestCount
      totals.cached += result.cachedKeys.size
      totals.inputTokens += result.usage.inputTokens ?? 0
      totals.outputTokens += result.usage.outputTokens ?? 0
      return (result.answers["match"] as TruthAnswer).probability
    },
    stopWhen,
  )
  const evaluated = scores.filter((s) => s !== undefined).length
  emit({
    operation,
    keys: ["match"],
    provider: provider.name,
    model: provider.model,
    latencyMs: Date.now() - started,
    cached: evaluated > 0 && totals.cached === evaluated,
    batched: false,
    questionCount: evaluated,
    requestCount: totals.requests,
    samples,
    usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens },
  })
  return scores
}

async function filter<T>(
  items: readonly T[],
  condition: string,
  options: CollectionOptions & { trueWhen?: string; falseWhen?: string } = {},
): Promise<T[]> {
  if (items.length === 0) return []
  const scores = await scoreEach(items, condition, { ...options, by: condition }, "filter")
  const threshold = thresholdOf(options)
  return items.filter((_, index) => scores[index]! > threshold)
}

/** Stops at the first match: at best one request, at worst N. */
async function some<T>(items: readonly T[], condition: string, options: CollectionOptions = {}): Promise<boolean> {
  if (items.length === 0) return false
  const threshold = thresholdOf(options)
  const scores = await scoreEach(items, condition, { ...options, by: condition }, "filter", (p) => p > threshold)
  return scores.some((p) => p !== undefined && p > threshold)
}

/** Stops at the first item that fails. */
async function every<T>(items: readonly T[], condition: string, options: CollectionOptions = {}): Promise<boolean> {
  if (items.length === 0) return true
  const threshold = thresholdOf(options)
  const scores = await scoreEach(items, condition, { ...options, by: condition }, "filter", (p) => p <= threshold)
  return scores.every((p) => p !== undefined && p > threshold)
}

async function rank<T>(items: readonly T[], options: RankOptions): Promise<Ranked<T>[]> {
  if (items.length === 0) return []
  const scores = await scoreEach(items, options.by, options, "rank")
  return items
    .map((item, index) => ({ item, score: scores[index]! }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Picks the single best item in **one** request.
 *
 * Items become options of a Choice, and a companion truth question asks whether
 * any of them actually fits. That second question is not optional: choice
 * probabilities always sum to 1, so something always wins — including when
 * nothing is suitable.
 */
async function find<T>(
  items: readonly T[],
  condition: string,
  options: CollectionOptions = {},
): Promise<T | undefined> {
  if (items.length === 0) return undefined
  const provider = resolveProvider(options.provider)
  const capacity = provider.capabilities.maxChoiceOptions
  const threshold = thresholdOf(options)

  if (items.length > capacity) {
    const ranked = await rank(items, { ...options, by: condition })
    const best = ranked[0]
    return best && best.score > threshold ? best.item : undefined
  }

  // Measured against the live API: the candidates belong both in the state
  // (the existence check reads them there) and as the option descriptions
  // (bare ids lose accuracy). Moving the text out of either costs correctness
  // and saves almost no tokens.
  const ids = items.map((_, index) => `i${index}`)
  const candidates: Record<string, string> = {}
  items.forEach((item, index) => {
    candidates[ids[index]!] = render(item, index, options.label)
  })

  const ttl = parseTtlOrUndefined(options.cache ?? getConfig().defaults?.cache)
  const started = Date.now()
  const result = await runPlan(
    provider,
    { candidates },
    [
      {
        key: "pick",
        question: { kind: "choice", instructions: condition, options: candidates },
        samples: options.samples ?? 1,
        ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
      },
      {
        key: "exists",
        question: {
          kind: "truth",
          instructions: `At least one of the candidates satisfies: ${condition}`,
          falseWhen: "Every candidate is unrelated or only superficially similar.",
        },
        samples: options.samples ?? 1,
        ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
      },
    ],
    timeoutOf(options),
  )

  emit({
    operation: "find",
    keys: ["pick", "exists"],
    provider: provider.name,
    model: provider.model,
    latencyMs: Date.now() - started,
    cached: result.cachedKeys.size === 2,
    batched: true,
    questionCount: 2,
    requestCount: result.requestCount,
    samples: options.samples ?? 1,
    usage: result.usage,
  })

  if ((result.answers["exists"] as TruthAnswer).probability <= threshold) return undefined
  const picked = (result.answers["pick"] as ChoiceAnswer).choice
  const index = ids.indexOf(picked)
  return index >= 0 ? items[index] : undefined
}

/** Compares two values on one criterion in a single request. */
async function compare<T>(
  left: T,
  right: T,
  options: { by: string } & Omit<CollectionOptions, "label"> & { label?: (item: T) => string },
): Promise<Comparison> {
  const provider = resolveProvider(options.provider)
  const toText = (item: T) => (options.label ? options.label(item) : typeof item === "string" ? item : JSON.stringify(item))
  const ttl = parseTtlOrUndefined(options.cache ?? getConfig().defaults?.cache)
  const started = Date.now()
  const result = await runPlan(
    provider,
    { left: toText(left), right: toText(right) },
    [
      {
        key: "winner",
        question: {
          kind: "choice",
          instructions: `Which of "left" and "right" is better on this criterion: ${options.by}`,
          options: {
            left: "The value under `left` is better on the criterion.",
            right: "The value under `right` is better on the criterion.",
            equal: "Neither is meaningfully better on the criterion.",
          },
        },
        samples: options.samples ?? 1,
        ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
      },
    ],
    timeoutOf(options),
  )
  emit({
    operation: "compare",
    keys: ["winner"],
    provider: provider.name,
    model: provider.model,
    latencyMs: Date.now() - started,
    cached: result.cachedKeys.size === 1,
    batched: false,
    questionCount: 1,
    requestCount: result.requestCount,
    samples: options.samples ?? 1,
    usage: result.usage,
  })
  return (result.answers["winner"] as ChoiceAnswer).choice as Comparison
}

  return { filter, some, every, rank, find, compare }
}

const global = bindCollections(globalRuntime)
export const filter: Collections["filter"] = (items, condition, options) => global.filter(items, condition, options)
export const some: Collections["some"] = (items, condition, options) => global.some(items, condition, options)
export const every: Collections["every"] = (items, condition, options) => global.every(items, condition, options)
export const rank: Collections["rank"] = (items, options) => global.rank(items, options)
export const find: Collections["find"] = (items, condition, options) => global.find(items, condition, options)
export const compare: Collections["compare"] = (left, right, options) => global.compare(left, right, options)
