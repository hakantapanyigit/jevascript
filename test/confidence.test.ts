import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"

import {
  confidenceFromSpread,
  configureSemantic,
  LowConfidenceError,
  resetSemantic,
  semantic,
} from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

afterEach(() => resetSemantic())

describe("measured confidence", () => {
  it("maps observed spread onto 0–1", () => {
    assert.equal(confidenceFromSpread([0.8, 0.8, 0.8]), 1, "no movement is full confidence")
    // The provider's published per-question sigma is ~0.0102.
    assert.ok(confidenceFromSpread([0.80, 0.81, 0.79]) > 0.97)
    assert.ok(confidenceFromSpread([0.1, 0.9, 0.5]) < 0.3, "wild disagreement is low confidence")
  })

  it("does not invent a confidence when none was measured", async () => {
    const provider = createMockSemanticProvider({ urgent: 0.62 })
    configureSemantic({ provider, warnUnbatched: false })
    const detail = await semantic("t").is("This is urgent", { detailed: true })
    assert.equal(detail.confidence, undefined)
    assert.equal(provider.requestCount, 1)
  })

  it("minConfidence implies sampling on truth-backed answers", async () => {
    const provider = createMockSemanticProvider({ "fraud risk": 0.9 }, { jitter: 0 })
    configureSemantic({ provider, warnUnbatched: false })

    const detail = await semantic({ id: 1 }).score("fraud risk", {
      minConfidence: 0.8,
      detailed: true,
    })

    assert.equal(provider.requestCount, 3, "three rounds are needed to measure spread")
    assert.equal(detail.confidence, 1)
    assert.equal(Math.round(detail.value), 90)
  })

  it("falls back when the measured confidence is too low", async () => {
    // Heavy jitter makes the answer unstable, which is exactly what should trip the gate.
    const provider = createMockSemanticProvider({ "fraud risk": 0.5 }, { jitter: 0.45 })
    configureSemantic({ provider, warnUnbatched: false })

    const value = await semantic({ id: 1 }).score("fraud risk", {
      minConfidence: 0.99,
      samples: 5,
      fallback: 50,
    })
    assert.equal(value, 50)
    assert.equal(provider.requestCount, 5)
  })

  it("supports an async fallback for escalating to a costlier model", async () => {
    const provider = createMockSemanticProvider({ "fraud risk": 0.5 }, { jitter: 0.45 })
    configureSemantic({ provider, warnUnbatched: false })
    let escalated = false

    const value = await semantic({ id: 1 }).score("fraud risk", {
      minConfidence: 0.99,
      samples: 4,
      fallback: async () => {
        escalated = true
        return 77
      },
    })
    assert.equal(escalated, true)
    assert.equal(value, 77)
  })

  it("throws rather than guessing when no fallback is given", async () => {
    const provider = createMockSemanticProvider({ "fraud risk": 0.5 }, { jitter: 0.45 })
    configureSemantic({ provider, warnUnbatched: false })
    await assert.rejects(
      () => semantic({ id: 1 }).score("fraud risk", { minConfidence: 0.99, samples: 4 }),
      LowConfidenceError,
    )
  })

  it("does not multiply the cost of unsampled neighbours", async () => {
    const provider = createMockSemanticProvider({ urgency: 0.8, frustration: 0.4 })
    configureSemantic({ provider, warnUnbatched: false })
    const context = semantic({ id: 1 })

    await Promise.all([
      context.score("urgency", { minConfidence: 0.5, samples: 3 }),
      context.score("customer frustration"),
    ])

    assert.equal(provider.requestCount, 3)
    // Round one carries both questions; later rounds carry only the sampled one.
    assert.equal(Object.keys(provider.calls[0]!.questions).length, 2)
    assert.equal(Object.keys(provider.calls[1]!.questions).length, 1)
    assert.equal(Object.keys(provider.calls[2]!.questions).length, 1)
  })
})
