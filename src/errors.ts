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
  constructor(
    readonly provider: string,
    readonly feature: string,
    hint: string,
  ) {
    super(`Provider "${provider}" cannot do ${feature}. ${hint}`)
    this.name = "UnsupportedByProviderError"
  }
}

export class LowConfidenceError extends SemanticError {
  constructor(
    readonly confidence: number,
    readonly minConfidence: number,
    readonly value: unknown,
  ) {
    super(
      `Confidence ${confidence.toFixed(3)} is below minConfidence ${minConfidence}. ` +
        "Supply `fallback` to degrade gracefully, or lower the threshold.",
    )
    this.name = "LowConfidenceError"
  }
}

export class SemanticValidationError extends SemanticError {
  constructor(
    readonly condition: string,
    readonly probability: number,
  ) {
    super(`Value failed semantic condition ${JSON.stringify(condition)} (p=${probability.toFixed(3)}).`)
    this.name = "SemanticValidationError"
  }
}

export class ProviderError extends SemanticError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ProviderError"
  }
}
