/**
 * Against the live API. Run with `npm run test:live` (reads JEV_API_KEY from
 * .env); skipped entirely without a key. Every case is chosen to be clear-cut,
 * so a failure means the contract moved — not that the model had an off day.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  boolean,
  createSemantic,
  defineSchema,
  enumOf,
  is,
  jev,
  choose,
  object,
  ProviderError,
  score,
  SemanticTimeoutError,
  type EvaluationEvent,
} from "jevascript"

const live = Boolean(process.env["JEV_API_KEY"])

function instance() {
  const events: EvaluationEvent[] = []
  let requests = 0
  const counting: typeof fetch = (input, init) => {
    requests++
    return fetch(input, init)
  }
  const ai = createSemantic({
    provider: jev({ fetch: counting }),
    warnUnbatched: false,
    observability: { onEvaluation: (e) => events.push(e) },
  })
  return { ai, events, requests: () => requests }
}

const outage = {
  subject: "Checkout is down",
  body: "Since 09:00 every card payment on our production checkout returns HTTP 500. We are losing sales every minute.",
}
const praise = {
  subject: "Thanks!",
  body: "Just wanted to say the new dashboard looks great. No action needed.",
}

describe("live API", { skip: !live && "JEV_API_KEY not set" }, () => {
  it("answers all three kinds in one request", async () => {
    const { ai, events, requests } = instance()
    const result = await ai(outage).batch({
      urgent: is("A human needs to act on this ticket right now."),
      urgency: score("urgency"),
      team: choose({ payments: "Card processing and checkout failures", docs: "Documentation questions", billing: "Our own invoices" }),
      impact: score("impact on the customer", {
        levels: ["No impact.", "Annoying, but a workaround exists.", "A feature is unusable.", "The business cannot operate."],
      }),
    })
    assert.equal(requests(), 1)
    assert.equal(result.urgent, true)
    assert.ok(result.urgency > 70, `urgency ${result.urgency}`)
    assert.equal(result.team, "payments")
    assert.ok(result.impact > 50, `impact ${result.impact}`)
    assert.ok((events[0]!.usage?.inputTokens ?? 0) > 0, "usage is reported")
  })

  it("says no to the opposite case", async () => {
    const { ai } = instance()
    assert.equal(await ai(praise).is("A human needs to act on this ticket right now."), false)
  })

  it("reads rubric levels 0-indexed: the top level maps to the top of the range", async () => {
    const { ai } = instance()
    const detail = await ai("The building is on fire and everyone has been evacuated.").score("severity", {
      levels: ["Nothing is happening.", "A minor inconvenience.", "A serious, life-threatening emergency."],
      detailed: true,
    })
    assert.ok(detail.level! > 1.5, `level ${detail.level}`)
    assert.ok(detail.value > 75, `value ${detail.value}`)
  })

  it("measures confidence with concurrent sample rounds", async () => {
    const { ai, requests } = instance()
    const detail = await ai(outage).is("This ticket reports a production outage.", { samples: 3, detailed: true })
    assert.equal(requests(), 3)
    assert.equal(detail.value, true)
    assert.ok(detail.confidence !== undefined && detail.confidence > 0.8, `confidence ${detail.confidence}`)
  })

  it("serves a repeat from cache, confidence included", async () => {
    const { ai, requests } = instance()
    const options = { minConfidence: 0.5, cache: "5m" } as const
    const first = await ai(outage).is("This ticket reports a production outage.", options)
    const second = await ai(outage).is("This ticket reports a production outage.", options)
    assert.equal(first, second)
    assert.equal(requests(), 3, "three sample rounds, then a cache hit")
  })

  it("finds the right item, and nothing when nothing fits", async () => {
    const { ai } = instance()
    const articles = ["Resetting your password", "Understanding your invoice", "Webhook retries and backoff", "Refund policy"]
    assert.equal(
      await ai.find(articles, "The article that helps a customer whose webhook deliveries keep failing."),
      "Webhook retries and backoff",
    )
    assert.equal(
      await ai.find(["Chocolate cake recipe", "Knitting for beginners"], "The document that explains Kubernetes pod autoscaling."),
      undefined,
    )
  })

  it("resolves a schema in one request", async () => {
    const { ai, requests } = instance()
    const triage = ai.defineSchema({
      name: "live-triage",
      instructions: "Triage an inbound support ticket for a payments API.",
      output: object({
        blocking: boolean({ describe: "The customer cannot take payments right now." }),
        team: enumOf({ payments: "Checkout and card failures", docs: "Documentation questions" }, "Which team should own this ticket"),
      }),
    })
    const result = await triage(outage)
    assert.equal(requests(), 1)
    assert.deepEqual(result, { blocking: true, team: "payments" })
    void defineSchema
  })

  it("times out as a SemanticTimeoutError, without retrying", async () => {
    const { ai, requests } = instance()
    await assert.rejects(() => ai(outage).is("x", { timeoutMs: 1 }), SemanticTimeoutError)
    assert.equal(requests(), 1)
  })

  it("fails fast on a bad key, with the status", async () => {
    let requests = 0
    const ai = createSemantic({
      provider: jev({ apiKey: "apikey_invalid", fetch: (i, n) => (requests++, fetch(i, n)) }),
      warnUnbatched: false,
    })
    await assert.rejects(
      () => ai(outage).is("x"),
      (error: ProviderError) => error instanceof ProviderError && (error.status === 401 || error.status === 403),
    )
    assert.equal(requests, 1, "an auth failure is not retried")
  })

  it("surfaces the API's message for an unknown model", async () => {
    const ai = createSemantic({ provider: jev({ model: "jev-does-not-exist" }), warnUnbatched: false })
    await assert.rejects(() => ai(outage).is("x"), /Unknown model: jev-does-not-exist/)
  })
})
