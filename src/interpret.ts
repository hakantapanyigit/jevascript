import { BUILTIN_DEFAULTS, type SemanticDefaults } from "./config.ts"
import { LowConfidenceError } from "./errors.ts"
import type { BuiltQuestion, ChooseOptions, DetailedScore, IsOptions, ScoreOptions } from "./questions.ts"
import type { ChoiceAnswer, LevelAnswer, SemanticAnswer, SemanticQuestion, TruthAnswer } from "./types.ts"

/**
 * Maps a truth or level answer onto a numeric range.
 *
 * The rubric width comes from the question, never from the answer: an answer
 * with a missing or short `probabilities` list must not move the scale.
 */
export function toRange(question: SemanticQuestion, answer: SemanticAnswer, [min, max]: readonly [number, number]): number {
  if (answer.kind === "level" && question.kind === "level") {
    const width = question.levels.length
    const position = width > 1 ? answer.level / (width - 1) : 0
    return min + position * (max - min)
  }
  return min + (answer as TruthAnswer).probability * (max - min)
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

/** Rounds needed for a question. `minConfidence`, set here or as a default, implies measurement. */
export function resolveSamples(
  kind: SemanticQuestion["kind"],
  options: { samples?: number; minConfidence?: number },
  defaults: SemanticDefaults | undefined,
): number {
  if (options.samples !== undefined) return Math.max(1, Math.floor(options.samples))
  // Only truth-backed answers need re-asking; choice and rubric answers carry
  // a provider-reported confidence already.
  const minConfidence = options.minConfidence ?? defaults?.minConfidence
  if (minConfidence === undefined || kind !== "truth") return 1
  return Math.max(2, defaults?.samples ?? BUILTIN_DEFAULTS.samples)
}

/**
 * Turns a raw answer into the value the caller asked for: thresholds, the
 * uncertainty band, confidence gating and `detailed`.
 *
 * This is the only place that happens. `semantic(x).is(...)` and
 * `batch({ x: is(...) })` go through it alike, so the same options can never
 * mean different things depending on how a question was sent.
 */
export async function interpret(
  built: BuiltQuestion,
  answer: SemanticAnswer,
  measured: number | undefined,
  defaults: SemanticDefaults | undefined,
): Promise<unknown> {
  const minConfidence = built.options.minConfidence ?? defaults?.minConfidence

  if (built.operation === "is") {
    const options = built.options as IsOptions
    const probability = (answer as TruthAnswer).probability
    const [low, high] = options.uncertaintyBand ?? defaults?.uncertaintyBand ?? BUILTIN_DEFAULTS.uncertaintyBand
    const threshold = options.threshold ?? defaults?.threshold ?? BUILTIN_DEFAULTS.threshold

    const value: boolean | "unknown" =
      options.allowUnknown && probability >= low && probability <= high
        ? "unknown"
        : await applyFallback(measured, minConfidence, probability > threshold, options.fallback)

    if (!options.detailed) return value
    return { value, probability, ...(measured !== undefined ? { confidence: measured } : {}) }
  }

  if (built.operation === "score") {
    const options = built.options as ScoreOptions
    const raw = toRange(built.question, answer, built.range ?? [0, 100])
    const detail: DetailedScore =
      answer.kind === "level"
        ? { value: raw, level: (answer as LevelAnswer).level, confidence: (answer as LevelAnswer).confidence }
        : {
            value: raw,
            probability: (answer as TruthAnswer).probability,
            ...(measured !== undefined ? { confidence: measured } : {}),
          }
    const value = await applyFallback(detail.confidence, minConfidence, raw, options.fallback)
    return options.detailed ? { ...detail, value } : value
  }

  const options = built.options as ChooseOptions
  const choice = answer as ChoiceAnswer
  const value = await applyFallback(choice.confidence, minConfidence, choice.choice, options.fallback)
  return options.detailed ? { value, confidence: choice.confidence, probabilities: { ...choice.probabilities } } : value
}
