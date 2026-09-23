/**
 * The Jev adapter against a scripted `fetch`: retries, deadlines, error
 * bodies and answer validation. No network.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { jev, ProviderError, SemanticTimeoutError, type SemanticRequest } from "jevascript"

type Reply = Response | ((init: RequestInit) => Promise<Response>)

function scripted(replies: Reply[]) {
  const calls: RequestInit[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init)
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!
    return typeof reply === "function" ? reply(init) : reply.clone()
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/**
 * Never answers; rejects only when the request is aborted, like a real fetch.
 * The timer stands in for the open socket that keeps a real request's event
 * loop alive — `AbortSignal.timeout` alone does not, on Node 22.
 */
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const socket = setTimeout(() => {}, 60_000)
    init.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(socket)
        reject(init.signal!.reason)
      },
      { once: true },
    )
  })

const truth: SemanticRequest = { state: "s", questions: { t: { kind: "truth", instructions: "x" } } }
const ok = json({ model: "jev-1.13.0", answers: { t: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 2 } })

describe("jev provider", () => {
  it("parses the live response envelope for all three kinds", async () => {
    // Shape copied from a live response.
    const { fetch } = scripted([
      json({
        model: "jev-1.13.0",
        answers: {
          t: { type: "noul", noul: 0.95 },
          c: { type: "choice", choice: "payments", confidence: 1.0, probabilities: { docs: 0.0, payments: 1.0, billing: 0.0 } },
          l: { type: "score", score: 2.56, confidence: 0.56, probabilities: { "0": 0.0, "1": 0.0, "2": 0.43, "3": 0.57 } },
        },
        usage: { input_tokens: 421, output_tokens: 68 },
      }),
    ])
    const response = await jev({ apiKey: "k", fetch }).evaluate({
      state: "s",
      questions: {
        t: { kind: "truth", instructions: "x" },
        c: { kind: "choice", instructions: "x", options: { billing: "b", payments: "p", docs: "d" } },
        l: { kind: "level", instructions: "x", levels: ["a", "b", "c", "d"] },
      },
    })
    assert.deepEqual(response.answers["t"], { kind: "truth", probability: 0.95 })
    assert.equal((response.answers["c"] as { choice: string }).choice, "payments")
    assert.deepEqual((response.answers["l"] as { probabilities: readonly number[] }).probabilities, [0, 0, 0.43, 0.57])
    assert.deepEqual(response.usage, { inputTokens: 421, outputTokens: 68 })
  })

  it("retries a 503 and then succeeds", async () => {
    const { fetch, calls } = scripted([json({ detail: "busy" }, 503, { "retry-after": "0" }), ok])
    const response = await jev({ apiKey: "k", fetch }).evaluate(truth)
    assert.equal(calls.length, 2)
    assert.equal((response.answers["t"] as { probability: number }).probability, 0.8)
  })

  it("does not retry a 400, and surfaces the API's own message", async () => {
    const { fetch, calls } = scripted([
      json({ detail: { error_type: "api_usage_error", message: "Unknown model: jev-nope" } }, 400),
    ])
    await assert.rejects(
      () => jev({ apiKey: "k", fetch }).evaluate(truth),
      (error: ProviderError) => error.status === 400 && error.message.endsWith("Unknown model: jev-nope"),
    )
    assert.equal(calls.length, 1)
  })

  it("joins validation messages from a 422", async () => {
    const { fetch } = scripted([json({ detail: [{ msg: "Dictionary should have at least 1 item" }] }, 422)])
    await assert.rejects(() => jev({ apiKey: "k", fetch }).evaluate(truth), /at least 1 item/)
  })

  it("holds one deadline across the whole call, and never retries a timeout", async () => {
    const { fetch, calls } = scripted([hang])
    const started = Date.now()
    await assert.rejects(
      () => jev({ apiKey: "k", fetch, maxRetries: 5 }).evaluate({ ...truth, timeoutMs: 60 }),
      SemanticTimeoutError,
    )
    assert.equal(calls.length, 1, "a timed-out request is not retried")
    assert.ok(Date.now() - started < 1_000, "the deadline covers the call, not each attempt")
  })

  it("gives up rather than sleep past the deadline on Retry-After", async () => {
    const { fetch, calls } = scripted([json({ detail: "slow down" }, 429, { "retry-after": "30" }), ok])
    const started = Date.now()
    await assert.rejects(
      () => jev({ apiKey: "k", fetch }).evaluate({ ...truth, timeoutMs: 2_000 }),
      (error: ProviderError) => error.status === 429,
    )
    assert.equal(calls.length, 1)
    assert.ok(Date.now() - started < 1_000)
  })

  it("rethrows the caller's abort as-is, without retrying", async () => {
    const { fetch, calls } = scripted([hang])
    const controller = new AbortController()
    const pending = jev({ apiKey: "k", fetch }).evaluate({ ...truth, signal: controller.signal })
    controller.abort(new Error("user cancelled"))
    await assert.rejects(pending, /user cancelled/)
    assert.equal(calls.length, 1)
  })

  it("reports a non-JSON body as a ProviderError", async () => {
    const { fetch } = scripted([new Response("<html>gateway</html>", { status: 200 })])
    await assert.rejects(() => jev({ apiKey: "k", fetch }).evaluate(truth), ProviderError)
  })

  it("rejects a choice that is not one of the options", async () => {
    const { fetch } = scripted([json({ answers: { c: { choice: "sales", confidence: 1 } } })])
    await assert.rejects(
      () =>
        jev({ apiKey: "k", fetch }).evaluate({
          state: "s",
          questions: { c: { kind: "choice", instructions: "x", options: { billing: "b", payments: "p" } } },
        }),
      /not one of the options/,
    )
  })

  it("rejects a probability outside [0, 1]", async () => {
    const { fetch } = scripted([json({ answers: { t: { noul: 7 } } })])
    await assert.rejects(() => jev({ apiKey: "k", fetch }).evaluate(truth), ProviderError)
  })

  it("rejects a rubric position outside the rubric", async () => {
    const { fetch } = scripted([json({ answers: { l: { score: 5, probabilities: [0, 1] } } })])
    await assert.rejects(
      () =>
        jev({ apiKey: "k", fetch }).evaluate({
          state: "s",
          questions: { l: { kind: "level", instructions: "x", levels: ["a", "b"] } },
        }),
      ProviderError,
    )
  })

  it("stops after maxRetries network failures", async () => {
    const { fetch, calls } = scripted([
      async () => {
        throw new TypeError("fetch failed")
      },
    ])
    await assert.rejects(() => jev({ apiKey: "k", fetch, maxRetries: 2 }).evaluate(truth), /after 2 attempt/)
    assert.equal(calls.length, 2)
  })
})
