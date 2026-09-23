import type {
  ChoiceOptionSpec,
  ChoiceQuestion,
  JsonValue,
  LevelSpec,
  SemanticProvider,
  SemanticQuestion,
  TruthQuestion,
} from "./types.ts"

export interface SharedOptions {
  provider?: SemanticProvider
  timeoutMs?: number
  cache?: string | number
  /** Rounds used to measure confidence. Implied by `minConfidence`. */
  samples?: number
  minConfidence?: number
  detailed?: boolean
  /** Identity of the definition this came from, surfaced in observability. */
  metric?: { name: string; version?: string }
}

export interface TruthCriteria {
  /** What clearly counts as true. */
  trueWhen?: string | JsonValue
  /** What clearly does not count, even when it looks close. */
  falseWhen?: string | JsonValue
}

export interface IsOptions extends SharedOptions, TruthCriteria {
  /** Probability above which the answer reads as true. Defaults to 0.5. */
  threshold?: number
  /** Report probabilities inside the uncertainty band as "unknown". */
  allowUnknown?: boolean
  uncertaintyBand?: readonly [number, number]
  fallback?: boolean | (() => boolean | Promise<boolean>)
}

export interface ScoreOptions extends SharedOptions, TruthCriteria {
  range?: readonly [number, number]
  /**
   * Ordered rubric levels, 2–10 of them, each describing a *situation* rather
   * than a degree. Supplying these switches from a probability-backed score to
   * a rubric-backed one.
   */
  levels?: readonly (string | LevelSpec)[]
  /** Treat the criterion as a complete proposition instead of framing it. */
  asProposition?: boolean
  fallback?: number | (() => number | Promise<number>)
}

export interface ChooseOptions extends SharedOptions {
  instructions?: string
  fallback?: string | (() => string | Promise<string>)
}

// ---------------------------------------------------------------------------
// Result types. The options decide the shape, so the type has to follow them:
// `allowUnknown` adds "unknown", `detailed` returns the evidence alongside.
// When a flag is not known at compile time, the type is the union of both.
// ---------------------------------------------------------------------------

export interface DetailedTruth<V extends boolean | "unknown" = boolean> {
  value: V
  /** The calibrated signal. For truth-backed answers this *is* the uncertainty. */
  probability: number
  /** Measured across sample rounds. Undefined unless `samples`/`minConfidence` was set. */
  confidence?: number
}

export interface DetailedScore {
  value: number
  probability?: number
  /** Rubric position, **0-indexed** and possibly between levels. Present only for `levels`-backed scores. */
  level?: number
  confidence?: number
}

export interface DetailedChoice<T extends string> {
  value: T
  confidence: number
  probabilities: Record<string, number>
}

/**
 * The type of flag `F` in options `O`: "off" when absent or false, "on" when
 * literally true, "either" when only known to be a boolean. Read through
 * `keyof` rather than `O extends { flag?: false }`, because an all-optional
 * target is a weak type and would reject `{ instructions: "…" }` outright.
 */
type Flag<O, F extends string> = F extends keyof O
  ? [O[F]] extends [false | undefined]
    ? "off"
    : [O[F]] extends [true]
      ? "on"
      : "either"
  : "off"

type WithDetail<O, Plain, Rich> = {
  off: Plain
  on: Rich
  either: Plain | Rich
}[Flag<O, "detailed">]

/** `boolean`, or `boolean | "unknown"` when the band may be reported. */
export type TruthValue<O> = Flag<O, "allowUnknown"> extends "off" ? boolean : boolean | "unknown"
export type IsResult<O> = WithDetail<O, TruthValue<O>, DetailedTruth<TruthValue<O>>>
export type ScoreResult<O> = WithDetail<O, number, DetailedScore>
export type ChooseResult<K extends string, O> = WithDetail<O, K, DetailedChoice<K>>
export type ChoiceKey<T> = T extends readonly string[] ? T[number] : keyof T & string

/**
 * Default framing that turns a noun-phrase criterion into a proposition.
 *
 * `score("fraud risk")` on its own is a noun phrase, and the model answers what
 * it is literally asked. Framing it as "This has high fraud risk." gives the
 * probability a well-defined referent. Override for other languages via
 * `configureSemantic({ defaults: { scoreFrame } })`.
 */
export const DEFAULT_SCORE_FRAME = (criterion: string): string => `This has high ${criterion}.`

export interface BuiltQuestion {
  question: SemanticQuestion
  options: SharedOptions
  operation: "is" | "score" | "choose"
  range?: readonly [number, number]
  optionKeys?: readonly string[]
}

/** A question that has not been bound to a state yet. Used by `batch()`. */
export interface QuestionSpec<TValue = unknown> {
  readonly __value?: TValue
  readonly build: (frame: (criterion: string) => string) => BuiltQuestion
}

function truthQuestion(instructions: string | JsonValue, criteria: TruthCriteria): TruthQuestion {
  return {
    kind: "truth",
    instructions,
    ...(criteria.trueWhen !== undefined ? { trueWhen: criteria.trueWhen } : {}),
    ...(criteria.falseWhen !== undefined ? { falseWhen: criteria.falseWhen } : {}),
  }
}

export function buildIs(condition: string | JsonValue, options: IsOptions = {}) {
  return { question: truthQuestion(condition, options), options, operation: "is" as const }
}

export function buildScore(criterion: string, options: ScoreOptions = {}, frame = DEFAULT_SCORE_FRAME) {
  const range = options.range ?? ([0, 100] as const)
  if (options.levels) {
    return {
      question: { kind: "level" as const, instructions: criterion, levels: options.levels },
      options,
      operation: "score" as const,
      range,
    }
  }
  const instructions = options.asProposition ? criterion : frame(criterion)
  return { question: truthQuestion(instructions, options), options, operation: "score" as const, range }
}

export type ChoiceInput =
  | readonly string[]
  | Readonly<Record<string, string | ChoiceOptionSpec>>

export function buildChoose(input: ChoiceInput, options: ChooseOptions = {}) {
  const optionMap: Record<string, string | ChoiceOptionSpec> = Array.isArray(input)
    ? Object.fromEntries((input as readonly string[]).map((key) => [key, key]))
    : { ...(input as Record<string, string | ChoiceOptionSpec>) }
  const question: ChoiceQuestion = {
    kind: "choice",
    instructions: options.instructions ?? "Select the option that best fits the state.",
    options: optionMap,
  }
  return { question, options, operation: "choose" as const, optionKeys: Object.keys(optionMap) }
}

// ---------------------------------------------------------------------------
// Standalone builders, for composing inside `batch()`. They take the same
// options as the context methods and resolve to exactly the same values.
// ---------------------------------------------------------------------------

export function is<O extends IsOptions = {}>(condition: string, options?: O): QuestionSpec<IsResult<O>> {
  return { build: () => buildIs(condition, options ?? {}) }
}

export function score<O extends ScoreOptions = {}>(criterion: string, options?: O): QuestionSpec<ScoreResult<O>> {
  return { build: (frame) => buildScore(criterion, options ?? {}, frame) }
}

export function choose<const T extends ChoiceInput, O extends ChooseOptions = {}>(
  options: T,
  extra?: O,
): QuestionSpec<ChooseResult<ChoiceKey<T>, O>> {
  return { build: () => buildChoose(options, extra ?? {}) }
}
