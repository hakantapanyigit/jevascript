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
// Standalone builders, for composing inside `batch()`.
// ---------------------------------------------------------------------------

export function is(condition: string, options: IsOptions = {}): QuestionSpec<boolean> {
  return { build: () => buildIs(condition, options) }
}

export function score(criterion: string, options: ScoreOptions = {}): QuestionSpec<number> {
  return { build: (frame) => buildScore(criterion, options, frame) }
}

export function choose<const T extends readonly string[]>(
  options: T,
  extra?: ChooseOptions,
): QuestionSpec<T[number]>
export function choose<const T extends Readonly<Record<string, string | ChoiceOptionSpec>>>(
  options: T,
  extra?: ChooseOptions,
): QuestionSpec<keyof T & string>
export function choose(options: ChoiceInput, extra: ChooseOptions = {}): QuestionSpec<string> {
  return { build: () => buildChoose(options, extra) }
}
