/**
 * The service under test, offline. No network, no key, no flakiness — the
 * provider is swapped, and everything around it is exercised normally.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { ProviderError } from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

import { semantic } from "../examples/app/semantic.ts"
import { createMemoryDb } from "../examples/app/db.ts"
import { TicketService } from "../examples/app/tickets.ts"

const silent = { info() {}, warn() {} }

function app(rules: Record<string, number | boolean | string>) {
  const provider = createMockSemanticProvider(rules)
  // The app's shared `semantic` instance, with its provider swapped for a mock.
  semantic.configure({ provider, warnUnbatched: false, observability: {} })
  const jobs: { name: string; payload: Record<string, unknown> }[] = []
  const db = createMemoryDb({ c_1: { id: "c_1", plan: "enterprise" }, c_2: { id: "c_2", plan: "free" } }, jobs)
  return { service: new TicketService(db, silent), provider, jobs, db }
}

describe("TicketService.intake", () => {
  it("grades a blocking enterprise ticket as critical and pages on-call", async () => {
    const { service, provider, jobs } = app({
      "unable to take money": true,
      urgently: 0.95,
      frustrated: 0.8,
      "may leave": false,
      "own this ticket": "payments",
    })

    const record = await service.intake({ customerId: "c_1", subject: "Charges failing", body: "All declines." })

    assert.equal(record.priority, "critical")
    assert.equal(record.queue, "payments")
    assert.equal(record.slaMinutes, 30)
    assert.equal(record.gradedBy, "ticket-triage@4")
    assert.deepEqual(jobs.map((j) => j.name), ["page-oncall"])
    assert.equal(provider.requestCount, 1, "the whole schema is one call")
  })

  it("does not page on-call for a free plan, however bad it looks", async () => {
    const { service, jobs } = app({
      "unable to take money": true,
      urgently: 0.95,
      frustrated: 0.5,
      "may leave": false,
      "own this ticket": "payments",
    })
    const record = await service.intake({ customerId: "c_2", subject: "down", body: "everything broken" })

    assert.equal(record.priority, "high", "plan is a deterministic fact, not a judgement")
    assert.equal(record.slaMinutes, null)
    assert.deepEqual(jobs, [])
  })

  it("notifies the CSM on a churn signal even when the ticket is calm", async () => {
    const { service, jobs } = app({
      "unable to take money": false,
      urgently: 0.2,
      frustrated: 0.3,
      "may leave": true,
      "own this ticket": "billing",
    })
    const record = await service.intake({ customerId: "c_1", subject: "renewal", body: "comparing options" })

    assert.equal(record.priority, "low")
    assert.deepEqual(jobs.map((j) => j.name), ["notify-csm"])
  })

  it("keeps working when the provider is down", async () => {
    const provider = createMockSemanticProvider({})
    semantic.configure({
      provider: { ...provider, async evaluate() { throw new ProviderError("upstream 503", 503) } },
      warnUnbatched: false,
      observability: {},
    })
    const db = createMemoryDb({ c_1: { id: "c_1", plan: "enterprise" } })
    const service = new TicketService(db, silent)

    const record = await service.intake({ customerId: "c_1", subject: "API is down", body: "outage" })

    assert.equal(record.gradedBy, "fallback", "the record says it was not graded")
    assert.equal(record.priority, "high", "keyword rules still ran")
  })

  it("still refuses to auto-reply to a critical ticket, whatever the model says", async () => {
    const { service, db } = app({
      "unable to take money": true,
      urgently: 0.95,
      frustrated: 0.9,
      "may leave": false,
      "own this ticket": "payments",
      adequate: true, // the rule would say yes
    })
    const record = await service.intake({ customerId: "c_1", subject: "down", body: "all failing" })
    void db

    assert.equal(await service.canAutoReply(record.id), false)
  })
})
