import type {
  ProviderCapabilities,
  SemanticAnswer,
  SemanticProvider,
  SemanticProviderResponse,
  SemanticQuestion,
  SemanticRequest,
} from "./types.ts"

export interface MockCall {
  state: SemanticRequest["state"]
  questions: Record<string, SemanticQuestion>
}

/**
 * What a stubbed answer may look like.
 *
 * A bare number stands in for a probability (truth) or a rubric position
 * (level); a boolean becomes 0.95/0.05; a string selects a choice option.
 */
export type MockValue = number | boolean | string | SemanticAnswer

export interface MockProviderOptions {
  capabilities?: Partial<ProviderCapabilities>
  model?: string
  /** Answer used when no rule matches. Defaults to 0.5 / the first option. */
  fallback?: MockValue
  /** Adds jitter to probabilities so sampling-based confidence can be exercised. */
  jitter?: number
}

export interface MockProvider extends SemanticProvider {
  readonly calls: MockCall[]
  /** Number of requests actually issued — the assertion that proves batching. */
  readonly requestCount: number
  reset(): void
}

function instructionsText(question: SemanticQuestion): string {
  const raw = question.instructions
  return typeof raw === "string" ? raw : JSON.stringify(raw)
}

function toAnswer(question: SemanticQuestion, value: MockValue, jitter: number): SemanticAnswer {
  if (typeof value === "object") return value

  if (question.kind === "truth") {
    const base = typeof value === "boolean" ? (value ? 0.95 : 0.05) : Number(value)
    const noise = jitter > 0 ? (Math.random() - 0.5) * 2 * jitter : 0
    return { kind: "truth", probability: Math.min(1, Math.max(0, base + noise)) }
  }

  if (question.kind === "choice") {
    const keys = Object.keys(question.options)
    const picked = typeof value === "string" && keys.includes(value) ? value : keys[0]!
    const probabilities: Record<string, number> = {}
    for (const key of keys) probabilities[key] = key === picked ? 1 : 0
    return { kind: "choice", choice: picked, probabilities, confidence: 1 }
  }

  const width = question.levels.length
  const level = Math.min(width - 1, Math.max(0, typeof value === "number" ? value : 0))
  const probabilities = Array.from({ length: width }, (_, index) => (index === Math.round(level) ? 1 : 0))
  return { kind: "level", level, probabilities, confidence: 1 }
}

/**
 * A provider that answers from a lookup table instead of a network call.
 *
 * Keys are matched as substrings of a question's instructions, so a rule like
 * `"urgency"` answers `score("urgency")` regardless of how it was framed.
 */
export function createMockSemanticProvider(
  rules: Record<string, MockValue> = {},
  options: MockProviderOptions = {},
): MockProvider {
  const calls: MockCall[] = []
  const jitter = options.jitter ?? 0

  const provider: MockProvider = {
    name: "mock",
    model: options.model ?? "mock-1",
    capabilities: {
      maxChoiceOptions: 255,
      levelRange: [2, 10],
      generatesText: false,
      batching: true,
      ...options.capabilities,
    },
    get calls() {
      return calls
    },
    get requestCount() {
      return calls.length
    },
    reset() {
      calls.length = 0
    },
    async evaluate(request: SemanticRequest): Promise<SemanticProviderResponse> {
      calls.push({ state: request.state, questions: { ...request.questions } })
      const answers: Record<string, SemanticAnswer> = {}
      for (const [key, question] of Object.entries(request.questions)) {
        const text = instructionsText(question).toLowerCase()
        const match = Object.entries(rules).find(([needle]) => text.includes(needle.toLowerCase()))
        const value = match ? match[1] : (options.fallback ?? 0.5)
        answers[key] = toAnswer(question, value, jitter)
      }
      return { answers, model: provider.model, usage: { inputTokens: 0, outputTokens: 0 } }
    },
  }
  return provider
}
