import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"

import {
  boolean,
  configureSemantic,
  defineMetric,
  defineRule,
  enumOf,
  evaluate,
  object,
  resetSemantic,
  score,
  semantic,
} from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

afterEach(() => resetSemantic())

describe("caching", () => {
  it("serves a repeat question without a second request", async () => {
    const provider = createMockSemanticProvider({ quality: 0.7 })
    configureSemantic({ provider, warnUnbatched: false })

    const first = await semantic({ doc: "a" }).score("quality", { cache: "5m" })
    const second = await semantic({ doc: "a" }).score("quality", { cache: "5m" })

    assert.equal(provider.requestCount, 1, "the second call is answered from cache")
    assert.equal(first, second, "and therefore cannot drift across a threshold")
  })

  it("keys on the state, so a different state still asks", async () => {
    const provider = createMockSemanticProvider({ quality: 0.7 })
    configureSemantic({ provider, warnUnbatched: false })
    await semantic({ doc: "a" }).score("quality", { cache: "5m" })
    await semantic({ doc: "b" }).score("quality", { cache: "5m" })
    assert.equal(provider.requestCount, 2)
  })
})

describe("collections", () => {
  it("find() answers in one request and verifies something actually fits", async () => {
    const provider = createMockSemanticProvider({ "at least one": 0.95, "best tool": "i1" })
    configureSemantic({ provider, warnUnbatched: false })

    const tools = ["send_email", "search_docs", "restart_server"]
    const best = await semantic.find(tools, "best tool for reading documentation")

    assert.equal(provider.requestCount, 1, "choice and existence check share a request")
    assert.equal(Object.keys(provider.calls[0]!.questions).length, 2)
    assert.equal(best, "search_docs")
  })

  it("find() returns undefined when nothing fits", async () => {
    const provider = createMockSemanticProvider({ "at least one": 0.02, "best tool": "i0" })
    configureSemantic({ provider, warnUnbatched: false })
    const best = await semantic.find(["send_email", "search_docs"], "best tool for baking a cake")
    assert.equal(best, undefined, "a choice always has a winner; the existence check is what saves us")
  })

  it("filter() costs one request per item", async () => {
    const provider = createMockSemanticProvider({ critical: 0.9 })
    configureSemantic({ provider, warnUnbatched: false })
    const kept = await semantic.filter(["a", "b", "c"], "This is critical")
    assert.equal(kept.length, 3)
    assert.equal(provider.requestCount, 3)
  })

  it("rank() orders by probability, highest first", async () => {
    const provider = createMockSemanticProvider({})
    let round = 0
    const scores = [0.2, 0.9, 0.5]
    const scripted = {
      ...provider,
      async evaluate(request: Parameters<typeof provider.evaluate>[0]) {
        const probability = scores[round++] ?? 0
        const key = Object.keys(request.questions)[0]!
        return { answers: { [key]: { kind: "truth" as const, probability } } }
      },
    }
    configureSemantic({ provider: scripted, warnUnbatched: false })

    const ranked = await semantic("the query").rank(["low", "high", "mid"], {
      by: "relevance to the query",
      concurrency: 1,
    })
    assert.deepEqual(ranked.map((r) => r.item), ["high", "mid", "low"])
  })
})

describe("evaluate()", () => {
  it("resolves a whole object shape in one request", async () => {
    const provider = createMockSemanticProvider({ urgency: 0.88, category: "security", needsHuman: true })
    configureSemantic({ provider, warnUnbatched: false })

    const analysis = await evaluate({
      data: { ticket: "credentials leaked in logs" },
      question: "Assess this support ticket",
      output: object({
        urgency: score(0, 100, "urgency"),
        category: enumOf(["billing", "technical", "security"], "category"),
        needsHuman: boolean({ describe: "needsHuman" }),
      }),
    })

    assert.equal(provider.requestCount, 1)
    assert.equal(Math.round(analysis.urgency), 88)
    assert.equal(analysis.category, "security")
    assert.equal(analysis.needsHuman, true)
  })
})

describe("reusable definitions", () => {
  it("defineMetric forwards trueWhen and falseWhen verbatim", async () => {
    const provider = createMockSemanticProvider({ churn: 0.84 })
    configureSemantic({ provider, warnUnbatched: false })

    const churnRisk = defineMetric({
      name: "churnRisk",
      version: "2",
      description: "The customer is at risk of churn in the near term.",
      trueWhen: "Cancellation language, or repeated unresolved problems.",
      falseWhen: "Merely angry. Anger alone is not churn risk.",
      output: score(0, 100),
    })

    const risk = await churnRisk({ customer: "…" })
    const question = Object.values(provider.calls[0]!.questions)[0]!

    assert.equal(churnRisk.name, "churnRisk")
    assert.equal(churnRisk.version, "2")
    assert.equal(Math.round(risk), 84)
    assert.equal(question.instructions, "The customer is at risk of churn in the near term.")
    assert.equal((question as { falseWhen?: string }).falseWhen, "Merely angry. Anger alone is not churn risk.")
  })

  it("a defined metric shares a request with other questions", async () => {
    const provider = createMockSemanticProvider({ churn: 0.6, urgency: 0.3 })
    configureSemantic({ provider, warnUnbatched: false })

    const churnRisk = defineMetric({ name: "churnRisk", description: "churn is likely" })
    const result = await semantic({ customer: "…" }).batch({
      churn: churnRisk.question(),
      urgency: score("urgency"),
    })

    assert.equal(provider.requestCount, 1)
    assert.equal(Math.round(result.churn), 60)
    assert.equal(Math.round(result.urgency), 30)
  })

  it("defineRule returns a boolean and carries its criteria", async () => {
    const provider = createMockSemanticProvider({ "human review": 0.93 })
    configureSemantic({ provider, warnUnbatched: false })

    const needsHumanReview = defineRule({
      name: "needsHumanReview",
      condition: "This action needs human review before it runs.",
      falseWhen: "Routine, reversible, low-value actions.",
    })

    assert.equal(await needsHumanReview({ amount: 40_000 }), true)
    const question = Object.values(provider.calls[0]!.questions)[0]!
    assert.equal((question as { falseWhen?: string }).falseWhen, "Routine, reversible, low-value actions.")
  })
})
