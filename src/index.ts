import { SemanticContext } from "./context.ts"
import { semanticContext } from "./factory.ts"
import { bindCollections, type Collections } from "./collections.ts"
import { createRuntime, globalRuntime, type Runtime, type SemanticConfig } from "./config.ts"
import { evaluateWith, type EvaluateRequest } from "./evaluate.ts"
import { defineMetricWith, defineRuleWith, type Metric, type MetricDefinition, type Rule, type RuleDefinition } from "./define.ts"
import { defineSchemaWith, type Evaluator, type SchemaDefinition } from "./schema.ts"
import type { AnyOutput, OutputValue } from "./outputs.ts"
import { score as questionScore, type QuestionSpec, type ScoreOptions } from "./questions.ts"
import { numberRange, type NumberOutput } from "./outputs.ts"
import type { State } from "./types.ts"

export interface Semantic extends Collections {
  /** Wraps a value so semantic questions can be asked about it. */
  (state: State): SemanticContext
  evaluate<O extends AnyOutput>(request: EvaluateRequest<O>): Promise<OutputValue<O>>
  defineMetric(definition: MetricDefinition): Metric
  defineRule(definition: RuleDefinition): Rule
  defineSchema<const O extends AnyOutput>(definition: SchemaDefinition<O>): Evaluator<O>
  /** The configuration this instance runs with. */
  readonly config: SemanticConfig
  /** Merge more configuration in — swap the provider in a test, add a hook at boot. */
  configure(config: SemanticConfig): void
}

/** @deprecated Use `Semantic`. */
export type SemanticFn = Semantic

function bind(runtime: Runtime): Semantic {
  const fn = (state: State) => semanticContext(state, runtime)
  return Object.assign(fn, bindCollections(runtime), {
    evaluate: <O extends AnyOutput>(request: EvaluateRequest<O>) => evaluateWith(runtime, request),
    defineMetric: (definition: MetricDefinition) => defineMetricWith(runtime, definition),
    defineRule: (definition: RuleDefinition) => defineRuleWith(runtime, definition),
    defineSchema: <const O extends AnyOutput>(definition: SchemaDefinition<O>) => defineSchemaWith(runtime, definition),
    configure: (config: SemanticConfig) => runtime.configure(config),
    get config() {
      return runtime.config
    },
  })
}

/**
 * A private, fully configured instance. Create it once in a shared module and
 * import it everywhere; naming it `semantic` keeps call sites identical:
 *
 *   export const semantic = createSemantic({ provider: jev(), defaults: { timeoutMs: 5_000 } })
 *
 * Nothing it does touches the global `semantic` or `configureSemantic`.
 */
export function createSemantic(config: SemanticConfig = {}): Semantic {
  return bind(createRuntime(config))
}

/** The module-level instance, configured with `configureSemantic()` or from the environment. */
export const semantic: Semantic = bind(globalRuntime)

/**
 * `score` is two things, disambiguated by its first argument.
 *
 * As a question — `score("urgency")` — it composes into `batch()`.
 * As an output shape — `score(0, 100)` — it describes a field for `evaluate()`.
 */
export function score(criterion: string, options?: ScoreOptions): QuestionSpec<number>
export function score(min?: number, max?: number, describe?: string): NumberOutput
export function score(
  a?: string | number,
  b?: ScoreOptions | number,
  c?: string,
): QuestionSpec<number> | NumberOutput {
  if (typeof a === "string") return questionScore(a, (b as ScoreOptions) ?? {})
  return numberRange(a ?? 0, (b as number) ?? 100, c)
}

export { SemanticContext } from "./context.ts"
export type { DetailedChoice, DetailedScore, DetailedTruth } from "./context.ts"

export { configureSemantic, resetSemantic, getConfig, createRuntime, BUILTIN_DEFAULTS } from "./config.ts"
export type { SemanticConfig, SemanticDefaults, Runtime } from "./config.ts"

export { choose, is, DEFAULT_SCORE_FRAME } from "./questions.ts"
export type {
  ChoiceInput,
  ChooseOptions,
  IsOptions,
  QuestionSpec,
  ScoreOptions,
  SharedOptions,
  TruthCriteria,
} from "./questions.ts"

export { evaluate, evaluateWith } from "./evaluate.ts"
export type { EvaluateRequest } from "./evaluate.ts"

export { boolean, enumOf, number, numberRange, object } from "./outputs.ts"
export type {
  AnyOutput,
  BooleanOutput,
  EnumOutput,
  NumberOutput,
  ObjectOutput,
  OutputValue,
} from "./outputs.ts"

export { defineMetric, defineRule, defineMetricWith, defineRuleWith } from "./define.ts"
export type { Metric, MetricDefinition, Rule, RuleDefinition } from "./define.ts"

export { compare, every, filter, find, some, rank, bindCollections } from "./collections.ts"
export type { Collections, CollectionOptions, Comparison, Ranked, RankOptions } from "./collections.ts"

export { MemoryCache, parseTtl, hashKey } from "./cache.ts"
export type { SemanticCache } from "./cache.ts"

export { confidenceFromSpread, assertSupported, cacheKeyFor, runPlan } from "./runner.ts"
export type { PlannedQuestion, RunResult } from "./runner.ts"

export {
  LowConfidenceError,
  NotConfiguredError,
  ProviderError,
  SemanticError,
  SemanticValidationError,
  UnsupportedByProviderError,
} from "./errors.ts"

export type {
  ChoiceAnswer,
  ChoiceOptionSpec,
  ChoiceQuestion,
  EvaluationEvent,
  JsonValue,
  LevelAnswer,
  LevelQuestion,
  LevelSpec,
  Observability,
  ProviderCapabilities,
  SemanticAnswer,
  SemanticProvider,
  SemanticProviderResponse,
  SemanticQuestion,
  SemanticRequest,
  State,
  TruthAnswer,
  TruthQuestion,
  Usage,
} from "./types.ts"

export { defineSchema, defineSchemaWith } from "./schema.ts"
export type { Evaluator, SchemaDefinition, SchemaOptions } from "./schema.ts"

export { jev, DEFAULT_MODEL, DEFAULT_BASE_URL, JEV_CAPABILITIES } from "./providers/jev.ts"
export type { JevOptions } from "./providers/jev.ts"
