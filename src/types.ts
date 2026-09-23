/**
 * Provider-neutral vocabulary.
 *
 * Deliberately NOT named after any one provider (see design rule: no `jevNoul()`
 * in the public API). Jev's `noul` is our `truth`, Jev's `score` is our `level`.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/**
 * What gets evaluated. Providers accept text only, so objects are serialised
 * as JSON before they are sent.
 *
 * Typed as `object` rather than `Record<string, unknown>` on purpose: an
 * `interface` has no implicit index signature, so the narrower type would
 * reject exactly the case this library exists for — handing it the domain
 * object you already have.
 */
export type State = string | readonly string[] | object

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * A yes/no proposition. The provider returns P(true), which carries both the
 * answer and its uncertainty — there is no separate confidence for this kind.
 */
export interface TruthQuestion {
  readonly kind: "truth"
  /** Written as a proposition, not a noun phrase. */
  readonly instructions: string | JsonValue
  /** What clearly counts as true. Materially improves accuracy on edge cases. */
  readonly trueWhen?: string | JsonValue
  /** What clearly does *not* count, even if it looks close. */
  readonly falseWhen?: string | JsonValue
}

export interface ChoiceOptionSpec {
  readonly what: string
  readonly not_for?: string
  readonly examples?: readonly string[]
}

/** Pick exactly one of a fixed set. */
export interface ChoiceQuestion {
  readonly kind: "choice"
  readonly instructions: string | JsonValue
  readonly options: Readonly<Record<string, string | ChoiceOptionSpec>>
}

export interface LevelSpec {
  readonly summary: string
  readonly signals?: readonly string[]
}

/**
 * Position on an ordered rubric. Levels describe *situations*, not degrees —
 * "feature broken, workaround exists" rather than "moderately severe".
 */
export interface LevelQuestion {
  readonly kind: "level"
  readonly instructions: string | JsonValue
  readonly levels: readonly (string | LevelSpec)[]
}

export type SemanticQuestion = TruthQuestion | ChoiceQuestion | LevelQuestion

// ---------------------------------------------------------------------------
// Raw provider answers
// ---------------------------------------------------------------------------

export interface TruthAnswer {
  readonly kind: "truth"
  /** P(the proposition is true), 0–1. */
  readonly probability: number
}

export interface ChoiceAnswer {
  readonly kind: "choice"
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  /** How concentrated the distribution is, 0–1. */
  readonly confidence: number
}

export interface LevelAnswer {
  readonly kind: "level"
  /**
   * Probability-weighted mean over levels, **0-indexed**: 0 is the first level
   * and probabilities.length - 1 the last. Verified against the live API, which
   * indexes from 0 even though the published example reads as 1-indexed.
   * May land between levels.
   */
  readonly level: number
  readonly probabilities: readonly number[]
  readonly confidence: number
}

export type SemanticAnswer = TruthAnswer | ChoiceAnswer | LevelAnswer

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface Usage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/**
 * Multi-question by construction. A single-question shape would make batching
 * impossible to express through the adapter, and batching is where nearly all
 * of the cost and latency savings live.
 */
export interface SemanticRequest {
  readonly state: State
  readonly questions: Readonly<Record<string, SemanticQuestion>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface SemanticProviderResponse {
  readonly answers: Readonly<Record<string, SemanticAnswer>>
  readonly usage?: Usage
  readonly model?: string
}

/**
 * Providers differ sharply in what they can express. Stating capabilities up
 * front lets the runtime reject impossible requests at configuration time
 * rather than failing deep inside a production call path.
 */
export interface ProviderCapabilities {
  readonly maxChoiceOptions: number
  /** Inclusive [min, max] number of rubric levels. */
  readonly levelRange: readonly [number, number]
  readonly maxStateTokens?: number
  readonly maxTotalTokens?: number
  /** False for decision-only models: no generated rationale is possible. */
  readonly generatesText: boolean
  /** Whether many questions in one request cost less than many requests. */
  readonly batching: boolean
}

export interface SemanticProvider {
  readonly name: string
  /** Pinned model identity. Must be a concrete version, never a moving alias. */
  readonly model: string
  readonly capabilities: ProviderCapabilities
  evaluate(request: SemanticRequest): Promise<SemanticProviderResponse>
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface EvaluationEvent {
  readonly operation: "is" | "score" | "choose" | "batch" | "evaluate" | "rank" | "filter" | "find" | "compare"
  readonly keys: readonly string[]
  readonly provider: string
  readonly model: string
  readonly latencyMs: number
  readonly cached: boolean
  readonly batched: boolean
  readonly questionCount: number
  /** Requests actually issued. Greater than one when `samples` was in play. */
  readonly requestCount: number
  readonly samples: number
  readonly usage?: Usage
  readonly metric?: { name: string; version?: string }
}

export interface Observability {
  onEvaluation?(event: EvaluationEvent): void
  /** Fired when calls that could have shared a request did not. */
  onUnbatched?(info: { context: string; flushCount: number }): void
}
