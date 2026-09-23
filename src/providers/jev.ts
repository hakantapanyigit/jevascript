import { env } from "../env.ts"
import { ProviderError, SemanticTimeoutError } from "../errors.ts"
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
  return { type: "score", instructions: level.instructions, criteria: level.levels }
}

/** Probabilities come back rounded, so allow a hair outside [0, 1] before calling it malformed. */
const EPSILON = 1e-6

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -EPSILON && value <= 1 + EPSILON
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function parseAnswer(key: string, raw: unknown, question: SemanticQuestion): SemanticAnswer {
  if (raw === null || typeof raw !== "object") {
    throw new ProviderError(`Malformed answer for "${key}": expected an object, got ${typeof raw}.`)
  }
  const value = raw as Record<string, unknown>

  if (question.kind === "truth") {
    const noul = value["noul"]
    if (!isProbability(noul)) throw new ProviderError(`Answer "${key}" is missing a \`noul\` probability in [0, 1].`)
    return { kind: "truth", probability: clamp01(noul) }
  }

  if (question.kind === "choice") {
    const choice = value["choice"]
    const allowed = Object.keys((question as ChoiceQuestion).options)
    if (typeof choice !== "string" || !allowed.includes(choice)) {
      throw new ProviderError(`Answer "${key}" chose ${JSON.stringify(choice)}, which is not one of the options.`)
    }
    const probabilities = parseProbabilityRecord(key, value["probabilities"]) ?? { [choice]: 1 }
    const confidence = isProbability(value["confidence"])
      ? clamp01(value["confidence"])
      : deriveConfidence(Object.values(probabilities))
    return { kind: "choice", choice, probabilities, confidence }
  }

  const width = (question as LevelQuestion).levels.length
  const level = value["score"]
  if (typeof level !== "number" || !Number.isFinite(level) || level < -EPSILON || level > width - 1 + EPSILON) {
    throw new ProviderError(`Answer "${key}" is missing a \`score\` between 0 and ${width - 1}.`)
  }
  const raws = value["probabilities"]
  const probabilities = Array.isArray(raws)
    ? raws.map((p) => (isProbability(p) ? clamp01(p) : 0))
    : Object.entries(parseProbabilityRecord(key, raws) ?? {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, probability]) => probability)
  const confidence = isProbability(value["confidence"]) ? clamp01(value["confidence"]) : deriveConfidence(probabilities)
  return { kind: "level", level: Math.min(width - 1, Math.max(0, level)), probabilities, confidence }
}

function parseProbabilityRecord(key: string, raw: unknown): Record<string, number> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderError(`Answer "${key}" has malformed \`probabilities\`.`)
  }
  const out: Record<string, number> = {}
  for (const [name, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProbability(p)) throw new ProviderError(`Answer "${key}" has a non-probability for "${name}".`)
    out[name] = clamp01(p)
  }
  return out
}

/** Fallback only: used when the API omits an explicit confidence. */
function deriveConfidence(probabilities: readonly number[]): number {
  if (probabilities.length === 0) return 0
  return Math.max(...probabilities)
}

/** Pulls the human-readable part out of an error body: `{ detail: { message } }` or a validation list. */
function describeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    const detail = parsed.detail
    if (typeof detail === "string") return detail
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const message = (detail as { message?: unknown }).message
      if (typeof message === "string") return message
    }
    if (Array.isArray(detail)) {
      const messages = detail
        .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : undefined))
        .filter((m): m is string => typeof m === "string")
      if (messages.length > 0) return messages.join("; ")
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.slice(0, 500)
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529])

/** A `Retry-After` longer than this is a signal to give up, not to wait. */
const MAX_RETRY_DELAY_MS = 30_000

export function jev(options: JevOptions = {}): SemanticProvider {
  // Resolved per request, not at construction: a module that creates the
  // provider must be importable in tests and builds that have no key.
  const resolveKey = (): string => {
    const apiKey = options.apiKey ?? env("JEV_API_KEY")
    if (!apiKey) {
      throw new ProviderError(
        "No API key. Pass jev({ apiKey }) or set JEV_API_KEY. Keys: https://console.typesafe.ai/keys",
      )
    }
    return apiKey
  }
  const model = options.model ?? env("JEV_MODEL") ?? DEFAULT_MODEL
  const baseUrl = (options.baseUrl ?? env("JEV_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const doFetch = options.fetch ?? globalThis.fetch
  const maxRetries = Math.max(1, options.maxRetries ?? 3)

  return {
    name: "jev",
    model,
    capabilities: JEV_CAPABILITIES,

    async evaluate(request: SemanticRequest): Promise<SemanticProviderResponse> {
      const apiKey = resolveKey()
      const questions: Record<string, JevQuestionPayload> = {}
      for (const [key, question] of Object.entries(request.questions)) questions[key] = toPayload(question)
      const body = JSON.stringify({ state: request.state, model, questions })

      // One deadline for the whole call. Retries spend from it; they do not
      // each get a fresh one, or a 5s timeout could take 15s and more.
      const timeoutMs = request.timeoutMs && request.timeoutMs > 0 && Number.isFinite(request.timeoutMs)
        ? request.timeoutMs
        : undefined
      const deadlineAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined
      const deadline = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined
      const parts = [request.signal, deadline].filter((s): s is AbortSignal => s !== undefined)
      const signal = parts.length > 1 ? AbortSignal.any(parts) : parts[0]

      /** An abort is final: the caller cancelled, or the deadline passed. Never retried. */
      const aborted = (): unknown => {
        if (request.signal?.aborted) return request.signal.reason
        return new SemanticTimeoutError("jev", timeoutMs!)
      }

      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw aborted()
        const last = attempt >= maxRetries - 1

        let response: Response
        try {
          response = await doFetch(`${baseUrl}/systemone`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body,
            ...(signal ? { signal } : {}),
          })
        } catch (error) {
          if (signal?.aborted) throw aborted()
          if (last) throw new ProviderError(`Request to Jev failed after ${attempt + 1} attempt(s): ${String(error)}`)
          await sleep(backoffDelay(attempt), signal).catch(() => {
            throw aborted()
          })
          continue
        }

        if (!response.ok) {
          const detail = describeError(await response.text().catch(() => ""))
          const error = new ProviderError(`Jev returned ${response.status}: ${detail}`, response.status)
          if (!RETRYABLE.has(response.status) || last) throw error
          const delay = backoffDelay(attempt, response.headers.get("retry-after"))
          const remaining = deadlineAt !== undefined ? deadlineAt - Date.now() : Infinity
          // Waiting past the deadline, or for longer than any caller would, only delays the same failure.
          if (delay > MAX_RETRY_DELAY_MS || delay >= remaining) throw error
          await sleep(delay, signal).catch(() => {
            throw aborted()
          })
          continue
        }

        let payload: Record<string, unknown>
        try {
          payload = (await response.json()) as Record<string, unknown>
        } catch (error) {
          if (signal?.aborted) throw aborted()
          throw new ProviderError(`Jev returned a body that is not JSON: ${String(error)}`, response.status)
        }
        if (payload === null || typeof payload !== "object") {
          throw new ProviderError("Jev returned a body that is not an object.", response.status)
        }
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
    },
  }
}

/** Exponential with jitter, unless the server said how long to wait. */
function backoffDelay(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return 2 ** attempt * 250 + Math.random() * 100
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
