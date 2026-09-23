export class SemanticError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SemanticError"
  }
}

export class NotConfiguredError extends SemanticError {
  constructor() {
    super(
      "No provider configured. Set JEV_API_KEY in the environment, or call " +
        "configureSemantic({ provider: jev({ apiKey }) }) before evaluating.",
    )
    this.name = "NotConfiguredError"
  }
}

/** The request cannot be expressed by this provider. Thrown before any network call. */
export class UnsupportedByProviderError extends SemanticError {
  readonly provider: string
  readonly feature: string

  constructor(provider: string, feature: string, hint: string) {
    super(`Provider "${provider}" cannot do ${feature}. ${hint}`)
    this.name = "UnsupportedByProviderError"
    this.provider = provider
    this.feature = feature
  }
}

export class LowConfidenceError extends SemanticError {
  readonly confidence: number
  readonly minConfidence: number
  readonly value: unknown

  constructor(confidence: number, minConfidence: number, value: unknown) {
    super(
      `Confidence ${confidence.toFixed(3)} is below minConfidence ${minConfidence}. ` +
        "Supply `fallback` to degrade gracefully, or lower the threshold.",
    )
    this.name = "LowConfidenceError"
    this.confidence = confidence
    this.minConfidence = minConfidence
    this.value = value
  }
}

export class SemanticValidationError extends SemanticError {
  readonly condition: string
  readonly probability: number

  constructor(condition: string, probability: number) {
    super(`Value failed semantic condition ${JSON.stringify(condition)} (p=${probability.toFixed(3)}).`)
    this.name = "SemanticValidationError"
    this.condition = condition
    this.probability = probability
  }
}

export class ProviderError extends SemanticError {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = "ProviderError"
    this.status = status
  }
}

/** The evaluation did not finish inside its deadline. Retries count against the same deadline. */
export class SemanticTimeoutError extends ProviderError {
  readonly timeoutMs: number

  constructor(provider: string, timeoutMs: number) {
    super(`Provider "${provider}" did not answer within ${timeoutMs}ms.`)
    this.name = "SemanticTimeoutError"
    this.timeoutMs = timeoutMs
  }
}
