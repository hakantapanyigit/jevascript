import { semanticContext } from "./factory.ts"
import { globalRuntime, type Runtime } from "./config.ts"
import type { IsOptions, QuestionSpec, ScoreOptions, SharedOptions } from "./questions.ts"
import { buildIs, buildScore, DEFAULT_SCORE_FRAME } from "./questions.ts"
import type { JsonValue, State } from "./types.ts"
import type { NumberOutput } from "./outputs.ts"

export interface MetricDefinition {
  name: string
  /** Bump whenever the wording changes. Logged alongside results so old evaluations stay interpretable. */
  version?: string
  /**
   * The proposition, written out in full. This is the explicit path: unlike the
   * shorthand `score("urgency")`, nothing is inferred or reframed on your behalf.
   */
  description: string
  /** What clearly counts as true. */
  trueWhen?: string | JsonValue
  /** What clearly does not count, even when it looks close — the near-misses. */
  falseWhen?: string | JsonValue
  output?: NumberOutput
  defaults?: Omit<ScoreOptions, "range" | "levels">
}

export interface Metric {
  (state: State, options?: ScoreOptions): Promise<number>
  readonly name: string
  readonly version: string | undefined
  readonly definition: MetricDefinition
  /** Use inside `batch()` to share a request with other questions. */
  question(options?: ScoreOptions): QuestionSpec<number>
}

export function defineMetric(definition: MetricDefinition): Metric {
  return defineMetricWith(globalRuntime, definition)
}

export function defineMetricWith(runtime: Runtime, definition: MetricDefinition): Metric {
  const range: readonly [number, number] = [definition.output?.min ?? 0, definition.output?.max ?? 100]
  const levels = definition.output?.levels

  const identity = { name: definition.name, ...(definition.version ? { version: definition.version } : {}) }

  const baseOptions = (override: ScoreOptions = {}): ScoreOptions => ({
    ...definition.defaults,
    ...override,
    metric: identity,
    range,
    asProposition: true,
    ...(levels ? { levels } : {}),
    ...(definition.trueWhen !== undefined ? { trueWhen: definition.trueWhen } : {}),
    ...(definition.falseWhen !== undefined ? { falseWhen: definition.falseWhen } : {}),
  })

  const call = (state: State, options: ScoreOptions = {}): Promise<number> =>
    semanticContext(state, runtime).score(
      definition.description,
      baseOptions(options) as ScoreOptions & { detailed?: false },
    )
  const metric = call as unknown as Metric

  Object.defineProperty(metric, "name", { value: definition.name, configurable: true })
  Object.defineProperty(metric, "version", { value: definition.version, configurable: true })
  Object.defineProperty(metric, "definition", { value: definition, configurable: true })
  Object.defineProperty(metric, "question", {
    value: (options: ScoreOptions = {}): QuestionSpec<number> => ({
      build: (frame) => buildScore(definition.description, baseOptions(options), frame ?? DEFAULT_SCORE_FRAME),
    }),
    configurable: true,
  })
  return metric
}

export interface RuleDefinition {
  name: string
  version?: string
  /** The condition, written as a complete proposition. */
  condition: string
  trueWhen?: string | JsonValue
  falseWhen?: string | JsonValue
  defaults?: SharedOptions & { threshold?: number; allowUnknown?: boolean }
}

export interface Rule {
  (state: State, options?: IsOptions): Promise<boolean>
  readonly name: string
  readonly version: string | undefined
  readonly definition: RuleDefinition
  question(options?: IsOptions): QuestionSpec<boolean>
}

export function defineRule(definition: RuleDefinition): Rule {
  return defineRuleWith(globalRuntime, definition)
}

export function defineRuleWith(runtime: Runtime, definition: RuleDefinition): Rule {
  const identity = { name: definition.name, ...(definition.version ? { version: definition.version } : {}) }

  const baseOptions = (override: IsOptions = {}): IsOptions => ({
    ...definition.defaults,
    ...override,
    metric: identity,
    ...(definition.trueWhen !== undefined ? { trueWhen: definition.trueWhen } : {}),
    ...(definition.falseWhen !== undefined ? { falseWhen: definition.falseWhen } : {}),
  })

  const call = (state: State, options: IsOptions = {}): Promise<boolean> =>
    semanticContext(state, runtime).is(
      definition.condition,
      baseOptions(options) as IsOptions & { detailed?: false; allowUnknown?: false },
    )
  const rule = call as unknown as Rule

  Object.defineProperty(rule, "name", { value: definition.name, configurable: true })
  Object.defineProperty(rule, "version", { value: definition.version, configurable: true })
  Object.defineProperty(rule, "definition", { value: definition, configurable: true })
  Object.defineProperty(rule, "question", {
    value: (options: IsOptions = {}): QuestionSpec<boolean> => ({
      build: () => buildIs(definition.condition, baseOptions(options)),
    }),
    configurable: true,
  })
  return rule
}
