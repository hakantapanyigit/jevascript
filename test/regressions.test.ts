/**
 * One test per defect found in review, so none of them can come back quietly.
 */
import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"

import {
  cacheKeyFor,
  configureSemantic,
  createSemantic,
  defineRule,
  evaluate,
  is,
  LowConfidenceError,
  number,
  object,
  ProviderError,
  resetSemantic,
  score,
  semantic,
  boolean,
  type EvaluationEvent,
  type SemanticProvider,
  type SemanticRequest,
} from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

afterEach(() => resetSemantic())

function setup(rules: Record<string, number | boolean | string> = {}, jitter = 0) {
  const provider = createMockSemanticProvider(rules, { jitter })
  configureSemantic({ provider, warnUnbatched: false })
  return provider
}

describe("batch() means the same as the direct call", () => {
  it("reports the uncertainty band as \"unknown\", and types it so", async () => {
    setup({ fraud: 0.5 })
    const result = await semantic("x").batch({ fraud: is("This is fraud", { allowUnknown: true }) })
    // Compile-time: a plain `boolean` here would let "unknown" through as truthy.
    const value: boolean | "unknown" = result.fraud
    assert.equal(value, "unknown")
  })

  it("applies minConfidence and fallback", async () => {
    setup({ risk: 0.5 }, 0.45)
    const result = await semantic("x").batch({
      risk: score("risk", { minConfidence: 0.99, samples: 5, fallback: -1 }),
    })
    assert.equal(result.risk, -1)
  })

  it("throws LowConfidenceError without a fallback, like the direct call", async () => {
    setup({ risk: 0.5 }, 0.45)
    await assert.rejects(
      () => semantic("x").batch({ risk: score("risk", { minConfidence: 0.99, samples: 5 }) }),
      LowConfidenceError,
    )
  })

  it("returns detail when asked", async () => {
    setup({ urgent: 0.7 })
    const result = await semantic("x").batch({ urgent: is("This is urgent", { detailed: true }) })
    assert.equal(result.urgent.value, true)
    assert.equal(result.urgent.probability, 0.7)
  })
})

describe("confidence defaults", () => {
  it("a default minConfidence triggers sampling instead of failing every call", async () => {
    const provider = createMockSemanticProvider({ urgent: 0.99 })
    const ai = createSemantic({ provider, defaults: { minConfidence: 0.5 }, warnUnbatched: false })
    assert.equal(await ai("x").is("This is urgent"), true)
    assert.equal(provider.requestCount, 3, "measured over the default three rounds")
  })

  it("a cached answer keeps the confidence it was measured with", async () => {
    const provider = createMockSemanticProvider({ urgent: 0.99 })
    const ai = createSemantic({ provider, warnUnbatched: false })
    const options = { minConfidence: 0.5, cache: "1h" } as const
    assert.equal(await ai("x").is("This is urgent", options), true)
    assert.equal(await ai("x").is("This is urgent", options), true)
    assert.equal(provider.requestCount, 3, "the second call is served from cache")
  })
})

describe("defineRule", () => {
  it("returns \"unknown\" when its defaults allow it, and says so in its type", async () => {
    setup({ fraud: 0.5 })
    const rule = defineRule({ name: "fraud", condition: "This is fraud", defaults: { allowUnknown: true } })
    const value: boolean | "unknown" = await rule("x")
    assert.equal(value, "unknown")
  })

  it("stays a boolean even if detailed is forced in at runtime", async () => {
    setup({ fraud: 0.9 })
    const rule = defineRule({ name: "fraud", condition: "This is fraud" })
    const value = await rule("x", { detailed: true } as never)
    assert.equal(value, true)
  })
})

describe("cache keys", () => {
  const provider = createMockSemanticProvider()
  const question = { kind: "truth", instructions: "x" } as const

  it("distinguish states that differ only by a Date", () => {
    const a = cacheKeyFor(provider, { at: new Date("2020-01-01") }, question, 1)
    const b = cacheKeyFor(provider, { at: new Date("2026-01-01") }, question, 1)
    assert.notEqual(a, b)
  })

  it("ignore key order and undefined fields, exactly as JSON does", () => {
    const a = cacheKeyFor(provider, { x: 1, y: 2 }, question, 1)
    const b = cacheKeyFor(provider, { y: 2, x: 1, z: undefined }, question, 1)
    assert.equal(a, b)
  })

  it("are a full-width digest", () => {
    assert.match(cacheKeyFor(provider, "s", question, 1), /^[0-9a-f]{64}$/)
  })
})

describe("evaluate()", () => {
  it("keeps `a__b` and `a.b` apart", async () => {
    const provider = setup({ flat: true, nested: false })
    const result = await evaluate({
      data: "x",
      question: "",
      output: object({
        a__b: boolean({ describe: "flat" }),
        a: object({ b: boolean({ describe: "nested" }) }),
      }),
    })
    assert.equal(Object.keys(provider.calls[0]!.questions).length, 2)
    assert.equal(result.a__b, true)
    assert.equal(result.a.b, false)
  })
})

describe("outputs", () => {
  it("number() keeps its defaults when a bound is explicitly undefined", () => {
    const output = number({ min: undefined, max: undefined })
    assert.equal(output.min, 0)
    assert.equal(output.max, 100)
  })
})

describe("runner", () => {
  it("runs sample rounds concurrently", async () => {
    let inFlight = 0
    let peak = 0
    const inner = createMockSemanticProvider({ urgent: 0.8 })
    const slow: SemanticProvider = {
      ...inner,
      async evaluate(request) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlight--
        return inner.evaluate(request)
      },
    }
    configureSemantic({ provider: slow, warnUnbatched: false })
    await semantic("x").is("This is urgent", { samples: 3 })
    assert.equal(peak, 3)
  })

  it("scales a rubric by the question's width, not the answer's", async () => {
    const provider: SemanticProvider = {
      ...createMockSemanticProvider(),
      async evaluate(request) {
        const key = Object.keys(request.questions)[0]!
        // A provider that omits the distribution must not collapse the scale.
        return { answers: { [key]: { kind: "level" as const, level: 3, probabilities: [], confidence: 1 } } }
      },
    }
    configureSemantic({ provider, warnUnbatched: false })
    const value = await semantic("x").score("impact", { levels: ["a", "b", "c", "d"] })
    assert.equal(value, 100)
  })

  it("rejects an answer of the wrong kind", async () => {
    const provider: SemanticProvider = {
      ...createMockSemanticProvider(),
      async evaluate(request) {
        const key = Object.keys(request.questions)[0]!
        return { answers: { [key]: { kind: "truth" as const, probability: 0.9 } } }
      },
    }
    configureSemantic({ provider, warnUnbatched: false })
    await assert.rejects(() => semantic("x").choose(["a", "b"]), ProviderError)
  })
})

describe("timeouts", () => {
  function capture() {
    const seen: (number | undefined)[] = []
    const inner = createMockSemanticProvider({ x: 0.9 })
    const provider: SemanticProvider = {
      ...inner,
      evaluate(request: SemanticRequest) {
        seen.push(request.timeoutMs)
        return inner.evaluate(request)
      },
    }
    return { provider, seen }
  }

  it("apply the built-in 10s default when nothing is configured", async () => {
    const { provider, seen } = capture()
    configureSemantic({ provider, warnUnbatched: false })
    await semantic("s").is("x")
    await semantic.filter(["a"], "x")
    await evaluate({ data: "s", question: "", output: boolean({ describe: "x" }) })
    assert.deepEqual(seen, [10_000, 10_000, 10_000])
  })

  it("prefer the configured default, and treat 0 as no deadline", async () => {
    const { provider, seen } = capture()
    configureSemantic({ provider, warnUnbatched: false, defaults: { timeoutMs: 2_500 } })
    await semantic("s").is("x")
    await semantic("s").is("x", { timeoutMs: 0 })
    assert.deepEqual(seen, [2_500, undefined])
  })
})

describe("collections", () => {
  function scripted(scores: number[]) {
    const inner = createMockSemanticProvider()
    let calls = 0
    const provider: SemanticProvider = {
      ...inner,
      async evaluate(request) {
        const probability = scores[calls++] ?? 0
        const key = Object.keys(request.questions)[0]!
        return { answers: { [key]: { kind: "truth" as const, probability } }, usage: { inputTokens: 100 } }
      },
    }
    return { provider, calls: () => calls }
  }

  it("some() stops at the first match", async () => {
    const { provider, calls } = scripted([0.1, 0.9, 0.1, 0.1, 0.1])
    configureSemantic({ provider, warnUnbatched: false })
    assert.equal(await semantic.some(["a", "b", "c", "d", "e"], "x", { concurrency: 1 }), true)
    assert.equal(calls(), 2)
  })

  it("every() stops at the first failure", async () => {
    const { provider, calls } = scripted([0.9, 0.1, 0.9, 0.9])
    configureSemantic({ provider, warnUnbatched: false })
    assert.equal(await semantic.every(["a", "b", "c", "d"], "x", { concurrency: 1 }), false)
    assert.equal(calls(), 2)
  })

  it("stops sending once a request has failed", async () => {
    // The first request fails at once; the other worker is mid-flight on a
    // slow success. It must not go on to start the remaining items.
    let calls = 0
    const inner = createMockSemanticProvider({ x: 0.9 })
    const provider: SemanticProvider = {
      ...inner,
      async evaluate(request) {
        if (calls++ === 0) throw new ProviderError("down", 503)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return inner.evaluate(request)
      },
    }
    configureSemantic({ provider, warnUnbatched: false })
    await assert.rejects(() => semantic.filter(["a", "b", "c", "d", "e", "f"], "x", { concurrency: 2 }), ProviderError)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(calls, 2)
  })

  it("reports real usage and request counts", async () => {
    const { provider } = scripted([0.9, 0.9, 0.9])
    const events: EvaluationEvent[] = []
    configureSemantic({ provider, warnUnbatched: false, observability: { onEvaluation: (e) => events.push(e) } })
    await semantic.filter(["a", "b", "c"], "x")
    assert.equal(events[0]!.requestCount, 3)
    assert.equal(events[0]!.usage?.inputTokens, 300)
  })

  it("compare() honours the cache", async () => {
    const provider = createMockSemanticProvider({ better: "left" })
    configureSemantic({ provider, warnUnbatched: false })
    await semantic.compare("a", "b", { by: "clarity", cache: "1h" })
    await semantic.compare("a", "b", { by: "clarity", cache: "1h" })
    assert.equal(provider.requestCount, 1)
  })
})
