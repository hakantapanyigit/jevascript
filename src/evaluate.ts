import { BUILTIN_DEFAULTS, globalRuntime, type Runtime } from "./config.ts"
import { emit, runPlan, type PlannedQuestion } from "./runner.ts"
import { parseTtlOrUndefined } from "./internal.ts"
import { DEFAULT_SCORE_FRAME } from "./questions.ts"
import type { AnyOutput, ObjectOutput, OutputValue } from "./outputs.ts"
import type { ChoiceAnswer, LevelAnswer, SemanticProvider, SemanticQuestion, State, TruthAnswer } from "./types.ts"

export interface EvaluateRequest<O extends AnyOutput> {
  data: State
  /**
   * The frame every field is judged in — what the data is, what your words
   * mean. Carried once in the state rather than repeated in every question.
   */
  question: string
  /** Background merged into the state: a policy, a tier list, a price table. */
  context?: Record<string, unknown>
  output: O
  provider?: SemanticProvider
  timeoutMs?: number
  cache?: string | number
  samples?: number
  /** Identity of the definition this came from, for logs. */
  metric?: { name: string; version?: string }
}

interface Leaf {
  key: string
  path: string[]
  output: Exclude<AnyOutput, ObjectOutput>
  question: SemanticQuestion
}

/**
 * Each question's instructions must be a proposition, on its own.
 *
 * Folding the task, the field name and a description into one JSON blob reads
 * as a label rather than a claim, and the model scores it near 0.5 because
 * there is nothing definite to affirm or deny. Measured on a ticket that is
 * plainly not urgent: the blob form returns 0.54, a bare proposition 0.06.
 *
 * So the task moves into the state, where it is sent once and frames every
 * question, and each field asks something answerable.
 */
function instructionsFor(path: string[], describe: string | undefined, kind: AnyOutput["kind"]): string {
  if (describe !== undefined) return describe
  const name = path.length > 0 ? path.join(" ") : "this"
  // No description given: build the least-bad proposition from the field name.
  return kind === "number" ? DEFAULT_SCORE_FRAME(name) : name
}

function collect(output: AnyOutput, path: string[], into: Leaf[]): void {
  if (output.kind === "object") {
    for (const [name, field] of Object.entries(output.fields)) collect(field, [...path, name], into)
    return
  }
  const key = path.length === 0 ? "value" : path.join("__")
  const instructions = instructionsFor(path, output.describe, output.kind)
  if (output.kind === "boolean") {
    into.push({
      key,
      path,
      output,
      question: {
        kind: "truth",
        instructions,
        ...(output.trueWhen !== undefined ? { trueWhen: output.trueWhen } : {}),
        ...(output.falseWhen !== undefined ? { falseWhen: output.falseWhen } : {}),
      },
    })
    return
  }
  if (output.kind === "enum") {
    into.push({ key, path, output, question: { kind: "choice", instructions, options: output.options } })
    return
  }
  into.push({
    key,
    path,
    output,
    question: output.levels
      ? { kind: "level", instructions, levels: output.levels }
      : { kind: "truth", instructions },
  })
}

function assign(target: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    cursor[segment] ??= {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[path[path.length - 1]!] = value
}

/**
 * The low-level entry point. One request regardless of how many fields the
 * output describes.
 */
export async function evaluate<O extends AnyOutput>(request: EvaluateRequest<O>): Promise<OutputValue<O>> {
  return evaluateWith(globalRuntime, request)
}

/** `evaluate` against a specific runtime. `createSemantic()` binds this. */
export async function evaluateWith<O extends AnyOutput>(runtime: Runtime, request: EvaluateRequest<O>): Promise<OutputValue<O>> {
  const provider = runtime.provider(request.provider)
  const leaves: Leaf[] = []
  collect(request.output, [], leaves)
  if (leaves.length === 0) throw new Error("`output` describes no fields to evaluate.")

  // The task and any background travel in the state: sent once, not per question.
  const state: State =
    request.question || request.context
      ? {
          ...(request.question ? { task: request.question } : {}),
          ...(request.context ? { context: request.context } : {}),
          input: request.data,
        }
      : request.data

  const ttl = parseTtlOrUndefined(request.cache ?? runtime.config.defaults?.cache)
  const planned: PlannedQuestion[] = leaves.map((leaf) => ({
    key: leaf.key,
    question: leaf.question,
    samples: request.samples ?? 1,
    ...(ttl !== undefined ? { cacheTtlMs: ttl } : {}),
  }))

  const result = await runPlan(
    provider,
    state,
    planned,
    { store: runtime.store, ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}) },
  )

  emit({
    operation: "evaluate",
    keys: leaves.map((l) => l.key),
    provider: provider.name,
    model: provider.model,
    latencyMs: result.latencyMs,
    cached: result.cachedKeys.size === leaves.length,
    batched: leaves.length > 1,
    questionCount: leaves.length,
    requestCount: result.requestCount,
    samples: request.samples ?? 1,
    usage: result.usage,
    ...(request.metric ? { metric: request.metric } : {}),
  }, runtime.config)

  const threshold = runtime.config.defaults?.threshold ?? BUILTIN_DEFAULTS.threshold
  const root: Record<string, unknown> = {}
  let scalar: unknown

  for (const leaf of leaves) {
    const answer = result.answers[leaf.key]!
    let value: unknown
    if (leaf.output.kind === "boolean") {
      value = (answer as TruthAnswer).probability > threshold
    } else if (leaf.output.kind === "enum") {
      value = (answer as ChoiceAnswer).choice
    } else {
      const { min, max } = leaf.output
      if (answer.kind === "level") {
        const width = (answer as LevelAnswer).probabilities.length
        const position = width > 1 ? (answer as LevelAnswer).level / (width - 1) : 0
        value = min + position * (max - min)
      } else {
        value = min + (answer as TruthAnswer).probability * (max - min)
      }
    }
    if (leaf.path.length === 0) scalar = value
    else assign(root, leaf.path, value)
  }

  return (request.output.kind === "object" ? root : scalar) as OutputValue<O>
}
