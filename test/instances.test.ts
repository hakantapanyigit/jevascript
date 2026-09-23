import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"
import { configureSemantic, createSemantic, resetSemantic, semantic } from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

describe("createSemantic", () => {
  afterEach(() => resetSemantic())

  it("gives each instance its own provider, cache and observability", async () => {
    const events: string[] = []
    const a = createSemantic({
      provider: createMockSemanticProvider({ urgent: 0.9 }),
      observability: { onEvaluation: () => events.push("a") },
    })
    const b = createSemantic({ provider: createMockSemanticProvider({ urgent: 0.1 }) })

    assert.equal(await a({ t: 1 }).is("urgent"), true)
    assert.equal(await b({ t: 1 }).is("urgent"), false)
    assert.deepEqual(events, ["a"])
  })

  it("does not touch the global instance", async () => {
    const global = createMockSemanticProvider({ urgent: 0.9 })
    configureSemantic({ provider: global })
    const own = createSemantic({ provider: createMockSemanticProvider({ urgent: 0.1 }) })

    assert.equal(await own({ t: 1 }).is("urgent"), false)
    assert.equal(await semantic({ t: 1 }).is("urgent"), true)
    assert.equal(global.requestCount, 1)
  })

  it("binds definitions and collections to the instance", async () => {
    const provider = createMockSemanticProvider({ churn: 0.8, fits: 0.9 })
    const ai = createSemantic({ provider, defaults: { threshold: 0.7 } })
    const churn = ai.defineRule({ name: "churn", condition: "churn" })

    assert.equal(await churn({ t: 1 }), true)
    assert.deepEqual(await ai.filter(["x"], "fits"), ["x"])
    assert.equal(provider.requestCount, 2)
    assert.equal(ai.config.defaults?.threshold, 0.7)
  })

  it("caches per instance", async () => {
    const provider = createMockSemanticProvider({ urgent: 0.9 })
    const ai = createSemantic({ provider })
    await ai({ t: 1 }).is("urgent", { cache: "1h" })
    await ai({ t: 1 }).is("urgent", { cache: "1h" })
    assert.equal(provider.requestCount, 1)

    const other = createSemantic({ provider })
    await other({ t: 1 }).is("urgent", { cache: "1h" })
    assert.equal(provider.requestCount, 2) // a different instance does not see the first cache
  })
})
