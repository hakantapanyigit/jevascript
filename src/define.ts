import { semanticContext } from "./factory.ts"
import { globalRuntime, type Runtime } from "./config.ts"
import type { IsOptions, QuestionSpec, ScoreOptions, SharedOptions, TruthValue } from "./questions.ts"
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
  defaults?: MetricOptions
}

/** Per-call options for a metric. Its shape — range, rubric, framing — belongs to the definition. */
export type MetricOptions = Omit<ScoreOptions, "range" | "levels" | "asProposition" | "detailed" | "metric">

export interface Metric {
  (state: State, options?: MetricOptions): Promise<number>
  readonly name: string
  readonly version: string | undefined
  readonly definition: MetricDefinition
  /** Use inside `batch()` to share a request with other questions. */
  question(options?: MetricOptions): QuestionSpec<number>
}

export function defineMetric(definition: MetricDefinition): Metric {
  return defineMetricWith(globalRuntime, definition)
}

export function defineMetricWith(runtime: Runtime, definition: MetricDefinition): Metric {
  const range: readonly [number, number] = [definition.output?.min ?? 0, definition.output?.max ?? 100]
  const levels = definition.output?.levels

  const identity = { name: definition.name, ...(definition.version ? { version: definition.version } : {}) }

  const baseOptions = (override: MetricOptions = {}): ScoreOptions => ({
    ...definition.defaults,
    ...override,
    // The call signature promises a number, whatever arrives at runtime.
    detailed: false,
    metric: identity,
    range,
    asProposition: true,
    ...(levels ? { levels } : {}),
    ...(definition.trueWhen !== undefined ? { trueWhen: definition.trueWhen } : {}),
    ...(definition.falseWhen !== undefined ? { falseWhen: definition.falseWhen } : {}),
  })

  const call = (state: State, options: MetricOptions = {}): Promise<number> =>
    semanticContext(state, runtime).score(definition.description, baseOptions(options)) as Promise<number>
  const metric = call as unknown as Metric

  Object.defineProperty(metric, "name", { value: definition.name, configurable: true })
  Object.defineProperty(metric, "version", { value: definition.version, configurable: true })
  Object.defineProperty(metric, "definition", { value: definition, configurable: true })
  Object.defineProperty(metric, "question", {
    value: (options: MetricOptions = {}): QuestionSpec<number> => ({
      build: (frame) => buildScore(definition.description, baseOptions(options), frame ?? DEFAULT_SCORE_FRAME),
    }),
    configurable: true,
  })
  return metric
}

/** Options a rule may set as defaults. `allowUnknown` here changes what the rule returns. */
export type RuleDefaults = Omit<SharedOptions, "detailed" | "metric"> & {
  threshold?: number
  allowUnknown?: boolean
  uncertaintyBand?: readonly [number, number]
  fallback?: boolean | (() => boolean | Promise<boolean>)
}

export interface RuleDefinition {
  name: string
  version?: string
  /** The condition, written as a complete proposition. */
  condition: string
  trueWhen?: string | JsonValue
  falseWhen?: string | JsonValue
  defaults?: RuleDefaults
}

/**
 * Per-call options for a rule. Whether it may answer "unknown" is part of the
 * definition, so it is not overridable per call — that keeps the return type honest.
 */
export type RuleOptions = Omit<IsOptions, "detailed" | "allowUnknown" | "metric" | "trueWhen" | "falseWhen">

/** What a rule resolves to: `boolean`, or `boolean | "unknown"` when its defaults allow it. */
export type RuleValue<D extends RuleDefinition> = "defaults" extends keyof D
  ? TruthValue<NonNullable<D["defaults"]>> | (undefined extends D["defaults"] ? boolean : never)
  : boolean

export interface Rule<V extends boolean | "unknown" = boolean> {
  (state: State, options?: RuleOptions): Promise<V>
  readonly name: string
  readonly version: string | undefined
  readonly definition: RuleDefinition
  question(options?: RuleOptions): QuestionSpec<V>
}

export function defineRule<const D extends RuleDefinition>(definition: D): Rule<RuleValue<D>> {
  return defineRuleWith(globalRuntime, definition)
}

export function defineRuleWith<const D extends RuleDefinition>(runtime: Runtime, definition: D): Rule<RuleValue<D>> {
  const identity = { name: definition.name, ...(definition.version ? { version: definition.version } : {}) }

  const baseOptions = (override: RuleOptions = {}): IsOptions => ({
    ...definition.defaults,
    ...override,
    detailed: false,
    allowUnknown: definition.defaults?.allowUnknown ?? false,
    metric: identity,
    ...(definition.trueWhen !== undefined ? { trueWhen: definition.trueWhen } : {}),
    ...(definition.falseWhen !== undefined ? { falseWhen: definition.falseWhen } : {}),
  })

  const call = (state: State, options: RuleOptions = {}): Promise<RuleValue<D>> =>
    semanticContext(state, runtime).is(definition.condition, baseOptions(options)) as Promise<RuleValue<D>>
  const rule = call as unknown as Rule<RuleValue<D>>

  Object.defineProperty(rule, "name", { value: definition.name, configurable: true })
  Object.defineProperty(rule, "version", { value: definition.version, configurable: true })
  Object.defineProperty(rule, "definition", { value: definition, configurable: true })
  Object.defineProperty(rule, "question", {
    value: (options: RuleOptions = {}): QuestionSpec<RuleValue<D>> => ({
      build: () => buildIs(definition.condition, baseOptions(options)),
    }),
    configurable: true,
  })
  return rule
}
