import { ProviderError } from "../errors.ts"
import type {
  ChoiceQuestion,
  LevelQuestion,
  ProviderCapabilities,
  SemanticAnswer,
  SemanticProvider,
  SemanticProviderResponse,
  SemanticQuestion,
  SemanticRequest,
  TruthQuestion,
} from "../types.ts"

/**
 * Pinned on purpose.
 *
 * `jev-latest` is an alias that moves. A silent move would invalidate cached
 * answers, shift production behaviour, and quietly detach dataset evaluations
 * from the model they were measured against.
 */
export const DEFAULT_MODEL = "jev-1.13.0"
export const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1"

export const JEV_CAPABILITIES: ProviderCapabilities = {
  maxChoiceOptions: 255,
  levelRange: [2, 10],
  maxStateTokens: 32_000,
  maxTotalTokens: 64_000,
  /** Decision-only: there is no generated text, so no generated rationale. */
  generatesText: false,
  batching: true,
}

export interface JevOptions {
  apiKey?: string
  model?: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  /** Attempts on 429 and 5xx, including the first. Defaults to 3. */
  maxRetries?: number
}

interface JevQuestionPayload {
  type: "noul" | "choice" | "score"
  instructions: unknown
  criteria?: unknown
}

function toPayload(question: SemanticQuestion): JevQuestionPayload {
  if (question.kind === "truth") {
    const truth = question as TruthQuestion
    const criteria: Record<string, unknown> = {}
    if (truth.trueWhen !== undefined) criteria["true"] = truth.trueWhen
    if (truth.falseWhen !== undefined) criteria["false"] = truth.falseWhen
    return {
      type: "noul",
      instructions: truth.instructions,
      ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
    }
  }
  if (question.kind === "choice") {
    const choice = question as ChoiceQuestion
    return { type: "choice", instructions: choice.instructions, criteria: choice.options }
  }
  const level = question as LevelQuestion
  return {
    type: "score",
    instructions: level.instructions,
    criteria: level.levels.map((entry) => (typeof entry === "string" ? entry : entry)),
  }
}

function parseAnswer(key: string, raw: unknown, question: SemanticQuestion): SemanticAnswer {
  if (raw === null || typeof raw !== "object") {
    throw new ProviderError(`Malformed answer for "${key}": expected an object, got ${typeof raw}.`)
  }
  const value = raw as Record<string, unknown>

  if (question.kind === "truth") {
    const noul = value["noul"]
    if (typeof noul !== "number") throw new ProviderError(`Answer "${key}" is missing a numeric \`noul\`.`)
    return { kind: "truth", probability: noul }
  }

  if (question.kind === "choice") {
    const choice = value["choice"]
    if (typeof choice !== "string") throw new ProviderError(`Answer "${key}" is missing a \`choice\`.`)
    const probabilities = (value["probabilities"] as Record<string, number> | undefined) ?? { [choice]: 1 }
    const confidence = typeof value["confidence"] === "number" ? value["confidence"] : deriveConfidence(Object.values(probabilities))
    return { kind: "choice", choice, probabilities, confidence }
  }

  const level = value["score"]
  if (typeof level !== "number") throw new ProviderError(`Answer "${key}" is missing a numeric \`score\`.`)
  const raws = value["probabilities"]
  const probabilities = Array.isArray(raws)
    ? (raws as number[])
    : Object.entries((raws as Record<string, number> | undefined) ?? {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, probability]) => probability)
  const confidence = typeof value["confidence"] === "number" ? value["confidence"] : deriveConfidence(probabilities)
  return { kind: "level", level, probabilities, confidence }
}

/** Fallback only: used when the API omits an explicit confidence. */
function deriveConfidence(probabilities: readonly number[]): number {
  if (probabilities.length === 0) return 0
  return Math.max(...probabilities)
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529])

export function jev(options: JevOptions = {}): SemanticProvider {
  // Resolved per request, not at construction: a module that creates the
  // provider must be importable in tests and builds that have no key.
  const resolveKey = (): string => {
    const apiKey = options.apiKey ?? process.env["JEV_API_KEY"]
    if (!apiKey) {
      throw new ProviderError(
        "No API key. Pass jev({ apiKey }) or set JEV_API_KEY. Keys: https://console.typesafe.ai/keys",
      )
    }
    return apiKey
  }
  const model = options.model ?? process.env["JEV_MODEL"] ?? DEFAULT_MODEL
  const baseUrl = (options.baseUrl ?? process.env["JEV_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const doFetch = options.fetch ?? globalThis.fetch
  const maxRetries = options.maxRetries ?? 3

  return {
    name: "jev",
    model,
    capabilities: JEV_CAPABILITIES,

    async evaluate(request: SemanticRequest): Promise<SemanticProviderResponse> {
      const apiKey = resolveKey()
      const questions: Record<string, JevQuestionPayload> = {}
      for (const [key, question] of Object.entries(request.questions)) questions[key] = toPayload(question)

      const body = JSON.stringify({ state: request.state, model, questions })
      let lastError: unknown

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const signals: AbortSignal[] = []
        if (request.signal) signals.push(request.signal)
        if (request.timeoutMs) signals.push(AbortSignal.timeout(request.timeoutMs))

        let response: Response
        try {
          response = await doFetch(`${baseUrl}/systemone`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body,
            ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
          })
        } catch (error) {
          lastError = error
          if (attempt === maxRetries - 1) throw new ProviderError(`Request to Jev failed: ${String(error)}`)
          await backoff(attempt)
          continue
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => "")
          if (RETRYABLE.has(response.status) && attempt < maxRetries - 1) {
            lastError = detail
            await backoff(attempt, response.headers.get("retry-after"))
            continue
          }
          throw new ProviderError(`Jev returned ${response.status}: ${detail.slice(0, 500)}`, response.status)
        }

        const payload = (await response.json()) as Record<string, unknown>
        // The envelope has varied between SDK surfaces; accept either shape.
        const container = (payload["answers"] as Record<string, unknown> | undefined) ?? payload
        const answers: Record<string, SemanticAnswer> = {}
        for (const [key, question] of Object.entries(request.questions)) {
          const raw = container[key]
          if (raw === undefined) throw new ProviderError(`Jev returned no answer for "${key}".`)
          answers[key] = parseAnswer(key, raw, question)
        }

        const usage = payload["usage"] as { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number } | undefined
        return {
          answers,
          model: (payload["model"] as string | undefined) ?? model,
          ...(usage
            ? {
                usage: {
                  inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
                  outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
                },
              }
            : {}),
        }
      }

      throw new ProviderError(`Jev request exhausted ${maxRetries} attempts: ${String(lastError)}`)
    },
  }
}

async function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const hinted = retryAfter ? Number(retryAfter) * 1000 : NaN
  const delay = Number.isFinite(hinted) ? hinted : 2 ** attempt * 250 + Math.random() * 100
  await new Promise((resolve) => setTimeout(resolve, delay))
}
