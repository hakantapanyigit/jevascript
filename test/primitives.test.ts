import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"

import { configureSemantic, resetSemantic, semantic, UnsupportedByProviderError } from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

afterEach(() => resetSemantic())

function setup(rules: Record<string, number | boolean | string> = {}, capabilities = {}) {
  const provider = createMockSemanticProvider(rules, { capabilities })
  configureSemantic({ provider, warnUnbatched: false })
  return provider
}

describe("score()", () => {
  it("maps a probability onto the requested range", async () => {
    setup({ "fraud risk": 0.73 })
    assert.equal(Math.round(await semantic({ id: 1 }).score("fraud risk")), 73)
    assert.equal(Math.round(await semantic({ id: 1 }).score("fraud risk", { range: [0, 10] })), 7)
  })

  it("frames a bare criterion as a proposition", async () => {
    const provider = setup({ "fraud risk": 0.5 })
    await semantic({ id: 1 }).score("fraud risk")
    const question = Object.values(provider.calls[0]!.questions)[0]!
    assert.equal(question.kind, "truth")
    assert.equal(question.instructions, "This has high fraud risk.")
  })

  it("passes a full proposition through untouched", async () => {
    const provider = setup({ dolandırıcılık: 0.5 })
    await semantic({ id: 1 }).score("Bu sipariş dolandırıcılık.", { asProposition: true })
    assert.equal(Object.values(provider.calls[0]!.questions)[0]!.instructions, "Bu sipariş dolandırıcılık.")
  })

  it("reads rubric levels as 0-indexed, matching the live API", async () => {
    // Four levels: index 0 is the floor of the range, index 3 the ceiling.
    setup({ severity: 3 })
    const value = await semantic({ id: 1 }).score("severity", {
      levels: ["No impact", "Workaround exists", "Feature unusable", "Product unusable"],
    })
    assert.equal(value, 100)

    setup({ severity: 1 })
    const middling = await semantic({ id: 1 }).score("severity", {
      levels: ["No impact", "Workaround exists", "Feature unusable", "Product unusable"],
    })
    assert.equal(Math.round(middling), 33)
  })

  it("rejects a rubric the provider cannot express", async () => {
    setup({}, { levelRange: [2, 10] as const })
    await assert.rejects(
      () => semantic({ id: 1 }).score("severity", { levels: Array.from({ length: 12 }, (_, i) => `level ${i}`) }),
      UnsupportedByProviderError,
    )
  })
})

describe("is()", () => {
  it("thresholds the probability and exposes it when asked", async () => {
    setup({ urgent: 0.62 })
    assert.equal(await semantic("t").is("This is urgent"), true)
    const detail = await semantic("t").is("This is urgent", { detailed: true })
    assert.equal(detail.value, true)
    assert.equal(Math.round(detail.probability * 100), 62)
    assert.equal(detail.confidence, undefined, "no confidence unless it was measured")
  })

  it("honours a custom threshold", async () => {
    setup({ urgent: 0.62 })
    assert.equal(await semantic("t").is("This is urgent", { threshold: 0.8 }), false)
  })

  it("reports the uncertainty band as unknown", async () => {
    setup({ fraud: 0.45 })
    assert.equal(await semantic("t").is("This is fraud", { allowUnknown: true }), "unknown")
    setup({ fraud: 0.92 })
    assert.equal(await semantic("t").is("This is fraud", { allowUnknown: true }), true)
    setup({ fraud: 0.05 })
    assert.equal(await semantic("t").is("This is fraud", { allowUnknown: true }), false)
  })

  it("sends trueWhen and falseWhen as criteria", async () => {
    const provider = setup({ refund: 0.5 })
    await semantic("t").is("The customer asked for a refund", {
      trueWhen: "An explicit request for money back.",
      falseWhen: "Merely complaining about price.",
    })
    const question = Object.values(provider.calls[0]!.questions)[0]!
    assert.equal(question.kind, "truth")
    assert.equal((question as { trueWhen?: string }).trueWhen, "An explicit request for money back.")
    assert.equal((question as { falseWhen?: string }).falseWhen, "Merely complaining about price.")
  })
})

describe("choose()", () => {
  it("infers the literal union without `as const` at the call site", async () => {
    setup({ department: "security" })
    const team = await semantic("t").choose(["billing", "technical", "security"], { instructions: "department" })
    // Compile-time: `team` is "billing" | "technical" | "security", not string.
    const accepted: "billing" | "technical" | "security" = team
    assert.equal(accepted, "security")
  })

  it("accepts described options and returns provider confidence", async () => {
    setup({ department: "billing" })
    const detail = await semantic("t").choose(
      { billing: "Payment problems", technical: "Bugs", security: "Access problems" },
      { instructions: "department", detailed: true },
    )
    assert.equal(detail.value, "billing")
    assert.equal(detail.confidence, 1)
    assert.deepEqual(Object.keys(detail.probabilities).sort(), ["billing", "security", "technical"])
  })

  it("rejects more options than the provider supports", async () => {
    setup({}, { maxChoiceOptions: 4 })
    await assert.rejects(
      () => semantic("t").choose(["a", "b", "c", "d", "e"]),
      UnsupportedByProviderError,
    )
  })
})
