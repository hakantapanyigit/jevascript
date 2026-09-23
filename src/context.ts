import { BUILTIN_DEFAULTS, globalRuntime, shouldWarnUnbatched, type Runtime, type SemanticConfig } from "./config.ts"
import { LowConfidenceError } from "./errors.ts"
import { emit, runPlan, type PlannedQuestion } from "./runner.ts"
import { bindCollections, type Ranked, type RankOptions } from "./collections.ts"
import { parseTtlOrUndefined } from "./internal.ts"
import {
  DEFAULT_SCORE_FRAME,
  buildChoose,
  buildIs,
  buildScore,
  type ChoiceInput,
  type ChooseOptions,
  type IsOptions,
  type QuestionSpec,
  type ScoreOptions,
  type SharedOptions,
} from "./questions.ts"
import type {
  ChoiceAnswer,
  ChoiceOptionSpec,
  LevelAnswer,
  SemanticAnswer,
  SemanticProvider,
  SemanticQuestion,
  State,
  TruthAnswer,
} from "./types.ts"

export interface DetailedTruth {
  value: boolean
  /** The calibrated signal. For truth-backed answers this *is* the uncertainty. */
  probability: number
  /** Measured across sample rounds. Undefined unless `samples`/`minConfidence` was set. */
  confidence?: number
}

export interface DetailedScore {
  value: number
  probability?: number
  /** Rubric position, 1-indexed. Present only for `levels`-backed scores. */
  level?: number
  confidence?: number
}

export interface DetailedChoice<T extends string> {
  value: T
  confidence: number
  probabilities: Record<string, number>
}

interface Pending {
  key: string
  provider: SemanticProvider
  planned: PlannedQuestion
  timeoutMs: number | undefined
  metric: { name: string; version?: string } | undefined
  settle: (answer: SemanticAnswer, measured: number | undefined, cached: boolean) => void
  fail: (error: unknown) => void
}

function scoreFrame(config: SemanticConfig): (criterion: string) => string {
  return config.defaults?.scoreFrame ?? DEFAULT_SCORE_FRAME
}

/** Rounds needed for this question. `minConfidence` implies measurement. */
function resolveSamples(kind: SemanticQuestion["kind"], options: SharedOptions, config: SemanticConfig): number {
  if (options.samples !== undefined) return Math.max(1, options.samples)
  const needsMeasurement = options.minConfidence !== undefined && kind === "truth"
  if (!needsMeasurement) return 1
  return config.defaults?.samples ?? BUILTIN_DEFAULTS.samples
}

async function applyFallback<T>(
  confidence: number | undefined,
  minConfidence: number | undefined,
  value: T,
  fallback: T | (() => T | Promise<T>) | undefined,
): Promise<T> {
  if (minConfidence === undefined) return value
  if (confidence !== undefined && confidence >= minConfidence) return value
  if (fallback === undefined) throw new LowConfidenceError(confidence ?? 0, minConfidence, value)
  return typeof fallback === "function" ? await (fallback as () => T | Promise<T>)() : fallback
}

export class SemanticContext {
  #state: State
  #pending: Pending[] = []
  #scheduled = false
  #flushes = 0
  #warned = false
  #counter = 0
  readonly #runtime: Runtime

  constructor(state: State, runtime: Runtime = globalRuntime) {
    this.#state = state
    this.#runtime = runtime
  }

  get #config(): SemanticConfig {
    return this.#runtime.config
  }

  /**
   * Queues a question and returns its answer.
   *
   * Nothing is sent until the current synchronous turn ends, so every question
   * created in the same turn — `Promise.all([...])` or `batch({...})` — travels
   * in one request. Sequentially awaited calls cannot be merged: the second
   * call does not exist until the first has resolved.
   */
  #enqueue(
    provider: SemanticProvider,
    question: SemanticQuestion,
    options: SharedOptions,
  ): Promise<{ answer: SemanticAnswer; measured: number | undefined; cached: boolean }> {
    const key = `q${this.#counter++}`
    const ttl = parseTtlOrUndefined(options.cache ?? this.#config.defaults?.cache)
    const planned: PlannedQuestion = {
      key,
      question,
      samples: resolveSamples(question.kind, options, this.#config),
      ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
    }
    return new Promise((resolve, reject) => {
      this.#pending.push({
        key,
        provider,
        planned,
        timeoutMs: options.timeoutMs ?? this.#config.defaults?.timeoutMs,
        metric: options.metric,
        settle: (answer, measured, cached) => resolve({ answer, measured, cached }),
        fail: reject,
      })
      this.#schedule()
    })
  }

  #schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      void this.#flush()
    })
  }

  async #flush(): Promise<void> {
    const batch = this.#pending
    this.#pending = []
    if (batch.length === 0) return

    this.#flushes++
    if (this.#flushes === 2 && !this.#warned && shouldWarnUnbatched(this.#config)) {
      this.#warned = true
      const info = { context: "semantic(state)", flushCount: this.#flushes }
      const hook = this.#config.observability?.onUnbatched
      if (hook) hook(info)
      else
        console.warn(
          "[semantic] This context issued a second provider request. Questions awaited one " +
            "at a time cannot share a request. Use `batch({...})` or `Promise.all([...])` to " +
            "send them together — batching is dramatically cheaper and no slower.",
        )
    }

    const byProvider = new Map<SemanticProvider, Pending[]>()
    for (const item of batch) {
      const list = byProvider.get(item.provider)
      if (list) list.push(item)
      else byProvider.set(item.provider, [item])
    }

    await Promise.all(
      [...byProvider].map(async ([provider, items]) => {
        const timeouts = items.map((i) => i.timeoutMs).filter((t): t is number => t !== undefined)
        try {
          const result = await runPlan(
            provider,
            this.#state,
            items.map((i) => i.planned),
            { store: this.#runtime.store, ...(timeouts.length > 0 ? { timeoutMs: Math.max(...timeouts) } : {}) },
          )
          // Only name the batch when every question came from the same
          // definition; a mixed batch has no single identity to report.
          const names = new Set(items.map((i) => (i.metric ? `${i.metric.name}@${i.metric.version ?? ""}` : "")))
          const metric = names.size === 1 ? items[0]!.metric : undefined

          emit({
            operation: items.length > 1 ? "batch" : "evaluate",
            keys: items.map((i) => i.key),
            provider: provider.name,
            model: provider.model,
            latencyMs: result.latencyMs,
            cached: result.cachedKeys.size === items.length,
            batched: items.length > 1,
            questionCount: items.length,
            requestCount: result.requestCount,
            samples: Math.max(...items.map((i) => i.planned.samples)),
            usage: result.usage,
            ...(metric ? { metric } : {}),
          }, this.#config)
          for (const item of items) {
            item.settle(result.answers[item.key]!, result.measured[item.key], result.cachedKeys.has(item.key))
          }
        } catch (error) {
          for (const item of items) item.fail(error)
        }
      }),
    )
  }

  // -------------------------------------------------------------------------
  // is()
  // -------------------------------------------------------------------------

  is(condition: string, options?: IsOptions & { detailed?: false; allowUnknown?: false }): Promise<boolean>
  is(condition: string, options: IsOptions & { detailed: true }): Promise<DetailedTruth>
  is(condition: string, options: IsOptions & { allowUnknown: true }): Promise<boolean | "unknown">
  async is(condition: string, options: IsOptions = {}): Promise<boolean | "unknown" | DetailedTruth> {
    const provider = this.#runtime.provider(options.provider)
    const built = buildIs(condition, options)
    const { answer, measured } = await this.#enqueue(provider, built.question, options)
    const probability = (answer as TruthAnswer).probability
    const defaults = this.#config.defaults

    if (options.allowUnknown) {
      const [low, high] = options.uncertaintyBand ?? defaults?.uncertaintyBand ?? BUILTIN_DEFAULTS.uncertaintyBand
      if (probability >= low && probability <= high) return "unknown"
    }

    const threshold = options.threshold ?? defaults?.threshold ?? BUILTIN_DEFAULTS.threshold
    const raw = probability > threshold
    const value = await applyFallback(measured, options.minConfidence ?? defaults?.minConfidence, raw, options.fallback)

    if (options.detailed) {
      return { value, probability, ...(measured !== undefined ? { confidence: measured } : {}) }
    }
    return value
  }

  // -------------------------------------------------------------------------
  // score()
  // -------------------------------------------------------------------------

  score(criterion: string, options?: ScoreOptions & { detailed?: false }): Promise<number>
  score(criterion: string, options: ScoreOptions & { detailed: true }): Promise<DetailedScore>
  async score(criterion: string, options: ScoreOptions = {}): Promise<number | DetailedScore> {
    const provider = this.#runtime.provider(options.provider)
    const built = buildScore(criterion, options, scoreFrame(this.#config))
    const { answer, measured } = await this.#enqueue(provider, built.question, options)
    const [min, max] = built.range
    const defaults = this.#config.defaults

    let raw: number
    let detail: DetailedScore
    if (answer.kind === "level") {
      const levels = (answer as LevelAnswer).probabilities.length
      const position = levels > 1 ? (answer as LevelAnswer).level / (levels - 1) : 0
      raw = min + position * (max - min)
      detail = { value: raw, level: (answer as LevelAnswer).level, confidence: (answer as LevelAnswer).confidence }
    } else {
      const probability = (answer as TruthAnswer).probability
      raw = min + probability * (max - min)
      detail = { value: raw, probability, ...(measured !== undefined ? { confidence: measured } : {}) }
    }

    const value = await applyFallback(
      detail.confidence,
      options.minConfidence ?? defaults?.minConfidence,
      raw,
      options.fallback,
    )
    return options.detailed ? { ...detail, value } : value
  }

  // -------------------------------------------------------------------------
  // choose()
  // -------------------------------------------------------------------------

  choose<const T extends readonly string[]>(
    options: T,
    extra?: ChooseOptions & { detailed?: false },
  ): Promise<T[number]>
  choose<const T extends readonly string[]>(
    options: T,
    extra: ChooseOptions & { detailed: true },
  ): Promise<DetailedChoice<T[number]>>
  choose<const T extends Readonly<Record<string, string | ChoiceOptionSpec>>>(
    options: T,
    extra?: ChooseOptions & { detailed?: false },
  ): Promise<keyof T & string>
  choose<const T extends Readonly<Record<string, string | ChoiceOptionSpec>>>(
    options: T,
    extra: ChooseOptions & { detailed: true },
  ): Promise<DetailedChoice<keyof T & string>>
  async choose(input: ChoiceInput, extra: ChooseOptions = {}): Promise<string | DetailedChoice<string>> {
    const provider = this.#runtime.provider(extra.provider)
    const built = buildChoose(input, extra)
    const { answer } = await this.#enqueue(provider, built.question, extra)
    const choice = answer as ChoiceAnswer
    const value = await applyFallback(
      choice.confidence,
      extra.minConfidence ?? this.#config.defaults?.minConfidence,
      choice.choice,
      extra.fallback,
    )
    return extra.detailed
      ? { value, confidence: choice.confidence, probabilities: { ...choice.probabilities } }
      : value
  }

  // -------------------------------------------------------------------------
  // rank()
  // -------------------------------------------------------------------------

  /**
   * Orders items by how well they fit this state.
   *
   * Each candidate is judged against the state in its own request, so this
   * costs one call per item. When you only need the winner, `semantic.find`
   * answers in a single call instead.
   */
  async rank<T>(items: readonly T[], options: Omit<RankOptions, "context">): Promise<Ranked<T>[]> {
    return bindCollections(this.#runtime).rank(items, { ...options, context: this.#state } as RankOptions)
  }

  // -------------------------------------------------------------------------
  // batch()
  // -------------------------------------------------------------------------

  /**
   * Evaluates every question against this state in a single request.
   *
   * Equivalent to creating the same questions in one turn and awaiting them
   * together; this form just makes the intent explicit and names the results.
   */
  async batch<S extends Record<string, QuestionSpec>>(
    spec: S,
  ): Promise<{ [K in keyof S]: S[K] extends QuestionSpec<infer V> ? V : never }> {
    const frame = scoreFrame(this.#config)
    const entries = Object.entries(spec)
    const results = await Promise.all(
      entries.map(async ([, questionSpec]) => {
        const built = questionSpec.build(frame)
        const provider = this.#runtime.provider(built.options.provider)
        const { answer, measured } = await this.#enqueue(
          provider,
          built.question as SemanticQuestion,
          built.options,
        )
        return this.#interpret(built, answer, measured)
      }),
    )
    const output: Record<string, unknown> = {}
    entries.forEach(([key], index) => {
      output[key] = results[index]
    })
    return output as never
  }

  #interpret(
    built: ReturnType<QuestionSpec["build"]>,
    answer: SemanticAnswer,
    measured: number | undefined,
  ): unknown {
    const defaults = this.#config.defaults
    if (built.operation === "choose") return (answer as ChoiceAnswer).choice
    if (built.operation === "is") {
      const options = built.options as IsOptions
      const probability = (answer as TruthAnswer).probability
      if (options.allowUnknown) {
        const [low, high] =
          options.uncertaintyBand ?? defaults?.uncertaintyBand ?? BUILTIN_DEFAULTS.uncertaintyBand
        if (probability >= low && probability <= high) return "unknown"
      }
      return probability > (options.threshold ?? defaults?.threshold ?? BUILTIN_DEFAULTS.threshold)
    }
    const [min, max] = built.range ?? [0, 100]
    if (answer.kind === "level") {
      const levels = (answer as LevelAnswer).probabilities.length
      const position = levels > 1 ? (answer as LevelAnswer).level / (levels - 1) : 0
      return min + position * (max - min)
    }
    void measured
    return min + (answer as TruthAnswer).probability * (max - min)
  }
}
