import { BUILTIN_DEFAULTS, globalRuntime, type Runtime } from "./config.ts"
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

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!, index)
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

/**
 * Scores every item independently against one proposition.
 *
 * This is N requests, not one: each item is a different state, and a request
 * carries a single state. Prefer `find` when you only need the best item.
 */
async function scoreEach<T>(
  items: readonly T[],
  condition: string,
  options: RankOptions | (CollectionOptions & { by: string; trueWhen?: string; falseWhen?: string }),
  operation: "filter" | "rank" | "find" | "compare",
): Promise<number[]> {
  const provider = resolveProvider(options.provider)
  const ttl = parseTtlOrUndefined(options.cache ?? getConfig().defaults?.cache)
  const started = Date.now()
  const scores = await mapLimited(items, options.concurrency ?? 8, async (item, index) => {
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
          samples: options.samples ?? 1,
          ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
        },
      ],
      options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    )
    return (result.answers["match"] as TruthAnswer).probability
  })
  emit({
    operation,
    keys: ["match"],
    provider: provider.name,
    model: provider.model,
    latencyMs: Date.now() - started,
    cached: false,
    batched: false,
    questionCount: items.length,
    requestCount: items.length * (options.samples ?? 1),
    samples: options.samples ?? 1,
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
  const threshold = options.threshold ?? getConfig().defaults?.threshold ?? BUILTIN_DEFAULTS.threshold
  return items.filter((_, index) => scores[index]! > threshold)
}

async function some<T>(items: readonly T[], condition: string, options: CollectionOptions = {}): Promise<boolean> {
  return (await filter(items, condition, options)).length > 0
}

async function every<T>(items: readonly T[], condition: string, options: CollectionOptions = {}): Promise<boolean> {
  if (items.length === 0) return true
  return (await filter(items, condition, options)).length === items.length
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

  if (items.length > capacity) {
    const ranked = await rank(items, { ...options, by: condition })
    const best = ranked[0]
    const threshold = options.threshold ?? getConfig().defaults?.threshold ?? BUILTIN_DEFAULTS.threshold
    return best && best.score > threshold ? best.item : undefined
  }

  const ids = items.map((_, index) => `i${index}`)
  const optionMap: Record<string, string> = {}
  const candidates: Record<string, string> = {}
  items.forEach((item, index) => {
    const text = render(item, index, options.label)
    optionMap[ids[index]!] = text
    candidates[ids[index]!] = text
  })

  const ttl = parseTtlOrUndefined(options.cache ?? getConfig().defaults?.cache)
  const started = Date.now()
  const result = await runPlan(
    provider,
    { candidates },
    [
      {
        key: "pick",
        question: { kind: "choice", instructions: condition, options: optionMap },
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
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
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

  const threshold = options.threshold ?? getConfig().defaults?.threshold ?? BUILTIN_DEFAULTS.threshold
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
      },
    ],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
  )
  emit({
    operation: "compare",
    keys: ["winner"],
    provider: provider.name,
    model: provider.model,
    latencyMs: Date.now() - started,
    cached: false,
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
