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
    try {
      const context = semantic({ a: 1 })
      // The call fails at the network, which is after provider resolution.
      await context.is("anything", { timeoutMs: 1 }).catch(() => undefined)
      assert.equal(getConfig().provider?.name, "jev")
      assert.equal(getConfig().provider?.model, "jev-test-model")
    } finally {
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
