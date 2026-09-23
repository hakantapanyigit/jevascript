import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"
import { getConfig, jev, NotConfiguredError, resetSemantic, semantic } from "jevascript"

describe("zero configuration", () => {
  const saved = process.env["JEV_API_KEY"]
  afterEach(() => {
    resetSemantic()
    if (saved === undefined) delete process.env["JEV_API_KEY"]
    else process.env["JEV_API_KEY"] = saved
  })

  it("throws a clear error when nothing is configured and no key is present", async () => {
    delete process.env["JEV_API_KEY"]
    await assert.rejects(() => semantic({ a: 1 }).is("anything"), NotConfiguredError)
  })

  it("builds the default provider from the environment on first use", async () => {
    process.env["JEV_API_KEY"] = "apikey_test"
    process.env["JEV_MODEL"] = "jev-test-model"
    // The provider is built lazily and picks up the global fetch then, so a
    // stub here keeps the test off the network entirely.
    const realFetch = globalThis.fetch
    const seen: { url: string; authorization: string | undefined; model: unknown }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      seen.push({ url, authorization: headers["authorization"], model: JSON.parse(String(init.body)).model })
      return new Response(JSON.stringify({ answers: { q0: { noul: 0.9 } } }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      assert.equal(await semantic({ a: 1 }).is("anything"), true)
      assert.equal(getConfig().provider?.name, "jev")
      assert.equal(getConfig().provider?.model, "jev-test-model")
      assert.deepEqual(seen, [
        { url: "https://api.typesafe.ai/v1/systemone", authorization: "Bearer apikey_test", model: "jev-test-model" },
      ])
    } finally {
      globalThis.fetch = realFetch
      delete process.env["JEV_MODEL"]
    }
  })

  it("lets explicit options win over the environment", () => {
    process.env["JEV_API_KEY"] = "apikey_test"
    process.env["JEV_MODEL"] = "jev-from-env"
    try {
      assert.equal(jev({ model: "jev-explicit" }).model, "jev-explicit")
      assert.equal(jev().model, "jev-from-env")
    } finally {
      delete process.env["JEV_MODEL"]
    }
  })
})
