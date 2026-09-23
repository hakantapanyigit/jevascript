import { globalRuntime, resolveTimeout, shouldWarnUnbatched, type Runtime, type SemanticConfig } from "./config.ts"
import { emit, runPlan, type PlannedQuestion } from "./runner.ts"
import { bindCollections, type Ranked, type RankOptions } from "./collections.ts"
import { parseTtlOrUndefined } from "./internal.ts"
import { interpret, resolveSamples } from "./interpret.ts"
import {
  DEFAULT_SCORE_FRAME,
  buildChoose,
  buildIs,
  buildScore,
  type BuiltQuestion,
  type ChoiceInput,
  type ChoiceKey,
  type ChooseOptions,
  type ChooseResult,
  type IsOptions,
  type IsResult,
  type QuestionSpec,
  type ScoreOptions,
  type ScoreResult,
  type SharedOptions,
} from "./questions.ts"
import type { SemanticAnswer, SemanticProvider, SemanticQuestion, State } from "./types.ts"

export type { DetailedChoice, DetailedScore, DetailedTruth } from "./questions.ts"

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
      samples: resolveSamples(question.kind, options, this.#config.defaults),
      ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
    }
    return new Promise((resolve, reject) => {
      this.#pending.push({
        key,
        provider,
        planned,
        timeoutMs: resolveTimeout(options.timeoutMs, this.#config),
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
        // One request carries every question, so it runs under the most
        // generous deadline among them — or none, if any asked for none.
        const timeouts = items.map((i) => i.timeoutMs)
        const timeoutMs = timeouts.includes(undefined) ? undefined : Math.max(...(timeouts as number[]))
        try {
          const result = await runPlan(
            provider,
            this.#state,
            items.map((i) => i.planned),
            { store: this.#runtime.store, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
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

  /** Sends one built question and interprets its answer. Every primitive goes through here. */
  async #ask(built: BuiltQuestion): Promise<unknown> {
    const provider = this.#runtime.provider(built.options.provider)
    const { answer, measured } = await this.#enqueue(provider, built.question, built.options)
    return interpret(built, answer, measured, this.#config.defaults)
  }

  /**
   * P(condition) thresholded into a boolean.
   *
   * `allowUnknown: true` widens the result to `boolean | "unknown"`, and
   * `detailed: true` returns the probability alongside — the types follow.
   */
  is<O extends IsOptions = {}>(condition: string, options?: O): Promise<IsResult<O>> {
    return this.#ask(buildIs(condition, options ?? {})) as Promise<IsResult<O>>
  }

  /** A probability- or rubric-backed number on `range` (0–100 by default). */
  score<O extends ScoreOptions = {}>(criterion: string, options?: O): Promise<ScoreResult<O>> {
    return this.#ask(buildScore(criterion, options ?? {}, scoreFrame(this.#config))) as Promise<ScoreResult<O>>
  }

  /** Exactly one of the options. The literal union is inferred without `as const`. */
  choose<const T extends ChoiceInput, O extends ChooseOptions = {}>(
    options: T,
    extra?: O,
  ): Promise<ChooseResult<ChoiceKey<T>, O>> {
    return this.#ask(buildChoose(options, extra ?? {})) as Promise<ChooseResult<ChoiceKey<T>, O>>
  }

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

  /**
   * Evaluates every question against this state in a single request.
   *
   * Equivalent to creating the same questions in one turn and awaiting them
   * together — including every option: thresholds, `allowUnknown`,
   * `minConfidence` and `fallback`, `detailed`. This form just makes the
   * intent explicit and names the results.
   */
  async batch<S extends Record<string, QuestionSpec>>(
    spec: S,
  ): Promise<{ [K in keyof S]: S[K] extends QuestionSpec<infer V> ? V : never }> {
    const frame = scoreFrame(this.#config)
    const entries = Object.entries(spec)
    const results = await Promise.all(entries.map(([, questionSpec]) => this.#ask(questionSpec.build(frame))))
    const output: Record<string, unknown> = {}
    entries.forEach(([key], index) => {
      output[key] = results[index]
    })
    return output as never
  }
}
