import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"

import {
  boolean,
  configureSemantic,
  defineMetric,
  defineRule,
  defineSchema,
  enumOf,
  object,
  resetSemantic,
  score,
  semantic,
} from "jevascript"
import { createMockSemanticProvider } from "jevascript/testing"

afterEach(() => resetSemantic())

function setup(rules: Record<string, number | boolean | string> = {}) {
  const provider = createMockSemanticProvider(rules)
  configureSemantic({ provider, warnUnbatched: false })
  return provider
}

const triage = defineSchema({
  name: "ticket-triage",
  version: "2",
  instructions: "Triage a support ticket for a payments API.",
  context: { plans: { free: "no SLA", enterprise: "30-minute response" } },
  output: object({
    urgency: score(0, 100, "A human needs to act on this ticket urgently."),
    blocking: boolean({ describe: "The customer cannot take payments right now." }),
    department: enumOf(["payments", "integration", "billing"], "Which team should own this"),
  }),
})

describe("defineSchema", () => {
  it("resolves every field in a single request", async () => {
    const provider = setup({ urgently: 0.93, "cannot take payments": true, own: "payments" })
    const result = await triage({ subject: "all charges failing" })

    assert.equal(provider.requestCount, 1, "a schema is one request, whatever its size")
    assert.equal(Object.keys(provider.calls[0]!.questions).length, 3)
    assert.equal(Math.round(result.urgency), 93)
    assert.equal(result.blocking, true)
    assert.equal(result.department, "payments")
  })

  it("carries the task and context in the state, not in every question", async () => {
    const provider = setup({ urgently: 0.5 })
    await triage({ subject: "all charges failing" })

    const state = provider.calls[0]!.state as Record<string, unknown>
    assert.equal(state["task"], "Triage a support ticket for a payments API.")
    assert.deepEqual(state["context"], { plans: { free: "no SLA", enterprise: "30-minute response" } })
    assert.deepEqual(state["input"], { subject: "all charges failing" })
  })

  it("asks each field as a bare proposition", async () => {
    // Folding task, field name and description into one blob reads as a label
    // rather than a claim, and the model hovers near 0.5. Each question must
    // stand on its own.
    const provider = setup({ urgently: 0.5 })
    await triage({ subject: "x" })

    const instructions = Object.values(provider.calls[0]!.questions).map((q) => q.instructions)
    assert.ok(instructions.includes("A human needs to act on this ticket urgently."))
    assert.ok(instructions.includes("The customer cannot take payments right now."))
    assert.ok(
      instructions.every((i) => typeof i === "string"),
      "instructions must be plain propositions, never a task/field blob",
    )
  })

  it("frames an undescribed numeric field rather than sending a bare name", async () => {
    const provider = setup({ risk: 0.5 })
    const bare = defineSchema({
      name: "bare",
      instructions: "Assess an order.",
      output: object({ risk: score(0, 100) }),
    })
    await bare({ id: 1 })
    assert.equal(Object.values(provider.calls[0]!.questions)[0]!.instructions, "This has high risk.")
  })

  it("exposes its identity for logging", async () => {
    const provider = createMockSemanticProvider({ urgently: 0.5 })
    const events: { metric?: { name: string; version?: string } }[] = []
    configureSemantic({ provider, warnUnbatched: false, observability: { onEvaluation: (e) => events.push(e) } })

    await triage({ subject: "x" })

    assert.equal(triage.name, "ticket-triage")
    assert.equal(triage.version, "2")
    assert.deepEqual(events[0]!.metric, { name: "ticket-triage", version: "2" })
  })

  it("omits the wrapper entirely when there is no task or context", async () => {
    const provider = setup({ risk: 0.5 })
    const plain = defineSchema({
      name: "plain",
      instructions: "",
      output: object({ risk: score(0, 100, "This is risky.") }),
    })
    await plain({ id: 7 })
    assert.deepEqual(provider.calls[0]!.state, { id: 7 })
  })
})

describe("observability identity", () => {
  it("names the definition a rule or metric came from", async () => {
    const provider = createMockSemanticProvider({ adequate: 0.9, churn: 0.4 })
    const events: { metric?: { name: string; version?: string } }[] = []
    configureSemantic({ provider, warnUnbatched: false, observability: { onEvaluation: (e) => events.push(e) } })

    const rule = defineRule({ name: "safeToAutoReply", version: "2", condition: "A templated answer is adequate." })
    await rule({ body: "x" })
    assert.deepEqual(events[0]!.metric, { name: "safeToAutoReply", version: "2" })

    const metric = defineMetric({ name: "churnRisk", version: "5", description: "churn is likely" })
    await metric({ body: "x" })
    assert.deepEqual(events[1]!.metric, { name: "churnRisk", version: "5" })
  })

  it("leaves a mixed batch unnamed rather than mislabelling it", async () => {
    const provider = createMockSemanticProvider({ churn: 0.4, urgency: 0.6 })
    const events: { metric?: unknown }[] = []
    configureSemantic({ provider, warnUnbatched: false, observability: { onEvaluation: (e) => events.push(e) } })

    const churn = defineMetric({ name: "churnRisk", version: "5", description: "churn is likely" })
    await semantic({ id: 1 }).batch({ churn: churn.question(), urgency: score("urgency") })

    assert.equal(events[0]!.metric, undefined)
  })
})
