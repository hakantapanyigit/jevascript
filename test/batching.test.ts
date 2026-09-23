import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"

import { configureSemantic, resetSemantic, semantic, choose, is, score } from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

function setup(rules: Record<string, number | boolean | string> = {}) {
  const provider = createMockSemanticProvider(rules)
  configureSemantic({ provider, warnUnbatched: false })
  return provider
}

afterEach(() => resetSemantic())

describe("request batching", () => {
  it("collapses questions created in one turn into a single request", async () => {
    const provider = setup({ urgency: 0.82, security: true, department: "technical" })
    const context = semantic({ message: "production is down" })

    const [urgency, securityRelated, department] = await Promise.all([
      context.score("urgency"),
      context.is("This is security related"),
      context.choose(["billing", "technical", "sales"], { instructions: "department" }),
    ])

    assert.equal(provider.requestCount, 1, "three questions must travel in one request")
    assert.equal(Math.round(urgency), 82)
    assert.equal(securityRelated, true)
    assert.equal(department, "technical")
    assert.equal(Object.keys(provider.calls[0]!.questions).length, 3)
  })

  it("batch() sends one request and names the results", async () => {
    const provider = setup({ urgency: 0.9, frustration: 0.4, security: false, department: "billing" })

    const analysis = await semantic({ message: "double charge" }).batch({
      urgency: score("urgency"),
      frustration: score("customer frustration"),
      securityRelated: is("This is security related"),
      department: choose(["billing", "technical", "sales"], { instructions: "department" }),
    })

    assert.equal(provider.requestCount, 1)
    assert.equal(Math.round(analysis.urgency), 90)
    assert.equal(Math.round(analysis.frustration), 40)
    assert.equal(analysis.securityRelated, false)
    assert.equal(analysis.department, "billing")
  })

  it("cannot batch sequentially awaited calls, and says so", async () => {
    const provider = createMockSemanticProvider({ urgency: 0.5 })
    const warnings: unknown[] = []
    configureSemantic({
      provider,
      warnUnbatched: true,
      observability: { onUnbatched: (info) => warnings.push(info) },
    })

    const context = semantic("a ticket")
    await context.score("urgency")
    await context.is("This is urgent")

    assert.equal(provider.requestCount, 2, "a second await cannot join the first request")
    assert.equal(warnings.length, 1, "the runtime should point this out once")
  })

  it("keeps separate contexts in separate requests", async () => {
    const provider = setup({ urgency: 0.5 })
    await Promise.all([semantic("ticket a").score("urgency"), semantic("ticket b").score("urgency")])
    assert.equal(provider.requestCount, 2, "different states cannot share a request")
  })
})
