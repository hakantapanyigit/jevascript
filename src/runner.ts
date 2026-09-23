import { getCacheStore, getConfig, parseTtlOrUndefined } from "./internal.ts"
import type { SemanticCache } from "./cache.ts"
import type { SemanticConfig } from "./config.ts"
import { hashKey } from "./cache.ts"
import { UnsupportedByProviderError } from "./errors.ts"
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  EvaluationEvent,
  LevelAnswer,
  LevelQuestion,
  SemanticAnswer,
  SemanticProvider,
  SemanticQuestion,
  State,
  TruthAnswer,
  Usage,
} from "./types.ts"

export interface PlannedQuestion {
  key: string
  question: SemanticQuestion
  /** Rounds to run. 1 means a single pass with no measured confidence. */
  samples: number
  cacheTtlMs?: number
}

export interface RunResult {
  answers: Record<string, SemanticAnswer>
  /** Per-key confidence measured across sample rounds, when samples > 1. */
  measured: Record<string, number | undefined>
  cachedKeys: Set<string>
  usage: Usage
  latencyMs: number
  requestCount: number
}

/** Stable stringify so cache keys survive key reordering. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
}

export function cacheKeyFor(
  provider: SemanticProvider,
  state: State,
  question: SemanticQuestion,
  samples: number,
): string {
  return hashKey(
    stable({ p: provider.name, m: provider.model, s: state, q: question, n: samples }),
  )
}

/**
 * Validates a question against what the provider can actually express, so an
 * impossible request fails here rather than as a confusing 4xx.
 */
export function assertSupported(provider: SemanticProvider, question: SemanticQuestion): void {
  const caps = provider.capabilities
  if (question.kind === "choice") {
    const count = Object.keys((question as ChoiceQuestion).options).length
    if (count > caps.maxChoiceOptions) {
      throw new UnsupportedByProviderError(
        provider.name,
        `a choice over ${count} options`,
        `The limit is ${caps.maxChoiceOptions}. Narrow the set first, or classify hierarchically.`,
      )
    }
    if (count < 2) {
      throw new UnsupportedByProviderError(provider.name, "a choice over fewer than 2 options", "Add options.")
    }
  }
  if (question.kind === "level") {
    const count = (question as LevelQuestion).levels.length
    const [min, max] = caps.levelRange
    if (count < min || count > max) {
      throw new UnsupportedByProviderError(
        provider.name,
        `a rubric with ${count} levels`,
        `Supported range is ${min}–${max}. Use fewer, well-separated levels, or drop \`levels\` to get a ` +
          "probability-backed score instead.",
      )
    }
  }
}

function argmax(probabilities: Record<string, number>): string {
  let best = ""
  let bestValue = -Infinity
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      bestValue = value
      best = key
    }
  }
  return best
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1)
  // Identical samples can leave a sub-epsilon residue behind, which would
  // otherwise report a perfectly stable answer as slightly less than certain.
  return variance < 1e-12 ? 0 : Math.sqrt(variance)
}

/**
 * Turns observed spread across sample rounds into a 0–1 confidence.
 *
 * A truth answer has no provider-reported confidence: the probability itself
 * carries the uncertainty. Deriving confidence from the probability (e.g.
 * |p-0.5|*2) is wrong for scores, where a mid-range value means "middling",
 * not "unsure". So we measure instead: re-ask and see how much the answer moves.
 *
 * sigma of 0 maps to 1.0, and 0.5 (the widest meaningful spread on [0,1]) to 0.
 */
export function confidenceFromSpread(samples: readonly number[]): number {
  return Math.min(1, Math.max(0, 1 - 2 * stdev(samples)))
}

function aggregate(kind: SemanticQuestion["kind"], rounds: readonly SemanticAnswer[]): SemanticAnswer {
  if (rounds.length === 1) return rounds[0]!
  if (kind === "truth") {
    const ps = (rounds as TruthAnswer[]).map((r) => r.probability)
    return { kind: "truth", probability: mean(ps) }
  }
  if (kind === "choice") {
    const all = rounds as ChoiceAnswer[]
    const keys = Object.keys(all[0]!.probabilities)
    const averaged: Record<string, number> = {}
    for (const key of keys) averaged[key] = mean(all.map((r) => r.probabilities[key] ?? 0))
    return {
      kind: "choice",
      choice: argmax(averaged),
      probabilities: averaged,
      confidence: mean(all.map((r) => r.confidence)),
    }
  }
  const all = rounds as LevelAnswer[]
  const width = all[0]!.probabilities.length
  const averaged: number[] = []
  for (let i = 0; i < width; i++) averaged.push(mean(all.map((r) => r.probabilities[i] ?? 0)))
  return {
    kind: "level",
    level: mean(all.map((r) => r.level)),
    probabilities: averaged,
    confidence: mean(all.map((r) => r.confidence)),
  }
}

/** Numeric series a measured confidence can be computed from, per kind. */
function series(kind: SemanticQuestion["kind"], rounds: readonly SemanticAnswer[]): number[] {
  if (kind === "truth") return (rounds as TruthAnswer[]).map((r) => r.probability)
  if (kind === "level") {
    // Normalise rubric position onto 0–1 so the spread formula stays comparable.
    const all = rounds as LevelAnswer[]
    const width = Math.max(1, all[0]!.probabilities.length - 1)
    return all.map((r) => r.level / width)
  }
  const all = rounds as ChoiceAnswer[]
  const winner = argmax(all[0]!.probabilities)
  return all.map((r) => r.probabilities[winner] ?? 0)
}

/**
 * Executes a plan as few provider requests as possible.
 *
 * Round 0 carries every question. Later rounds carry only the questions that
 * asked for more samples, so raising `samples` on one question does not
 * multiply the cost of its neighbours.
 */
export async function runPlan(
  provider: SemanticProvider,
  state: State,
  planned: readonly PlannedQuestion[],
  options: { timeoutMs?: number; signal?: AbortSignal; store?: SemanticCache } = {},
): Promise<RunResult> {
  const started = Date.now()
  const store = options.store ?? getCacheStore()
  const answers: Record<string, SemanticAnswer> = {}
  const measured: Record<string, number | undefined> = {}
  const cachedKeys = new Set<string>()
  const usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 }

  const live: PlannedQuestion[] = []
  for (const item of planned) {
    assertSupported(provider, item.question)
    if (item.cacheTtlMs && item.cacheTtlMs > 0) {
      const hit = await store.get(cacheKeyFor(provider, state, item.question, item.samples))
      if (hit) {
        answers[item.key] = hit
        cachedKeys.add(item.key)
        continue
      }
    }
    live.push(item)
  }

  let requestCount = 0
  if (live.length > 0) {
    const maxRounds = Math.max(...live.map((q) => q.samples))
    const rounds: Record<string, SemanticAnswer[]> = {}
    for (const item of live) rounds[item.key] = []

    for (let round = 0; round < maxRounds; round++) {
      const inRound = live.filter((q) => q.samples > round)
      if (inRound.length === 0) break
      const questions: Record<string, SemanticQuestion> = {}
      for (const item of inRound) questions[item.key] = item.question

      const response = await provider.evaluate({
        state,
        questions,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      requestCount++
      usage.inputTokens += response.usage?.inputTokens ?? 0
      usage.outputTokens += response.usage?.outputTokens ?? 0

      for (const item of inRound) {
        const answer = response.answers[item.key]
        if (!answer) throw new Error(`Provider "${provider.name}" returned no answer for key "${item.key}".`)
        rounds[item.key]!.push(answer)
      }
    }

    for (const item of live) {
      const collected = rounds[item.key]!
      answers[item.key] = aggregate(item.question.kind, collected)
      measured[item.key] = collected.length > 1 ? confidenceFromSpread(series(item.question.kind, collected)) : undefined
      if (item.cacheTtlMs && item.cacheTtlMs > 0) {
        await store.set(cacheKeyFor(provider, state, item.question, item.samples), answers[item.key]!, item.cacheTtlMs)
      }
    }
  }

  return {
    answers,
    measured,
    cachedKeys,
    usage,
    latencyMs: Date.now() - started,
    requestCount,
  }
}

export function emit(event: EvaluationEvent, config: SemanticConfig = getConfig()): void {
  const hook = config.observability?.onEvaluation
  if (!hook) return
  try {
    hook(event)
  } catch {
    // Observability must never break the call path it observes.
  }
}

export { parseTtlOrUndefined }
