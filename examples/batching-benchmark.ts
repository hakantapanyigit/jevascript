/**
 * Measures the thing the whole design rests on: what batching actually saves.
 *
 * Run with: npm run example examples/batching-benchmark.ts
 *
 * Each shape is run ROUNDS times and the median is reported, because a single
 * network round-trip is not a measurement.
 */
import { choose, is, score, semantic } from "jevascript"
import { reset, snapshot } from "./_setup.ts"

const ROUNDS = 3

const ticket = {
  customer: { plan: "enterprise" },
  message: `Production is unreachable since the 14:02 deploy. Twelve staff cannot work.
    We were double-charged last month too and nobody replied. If this is not fixed today
    we will look at alternatives.`,
}

// Fresh specs per run: a spec is bound to a context once.
const questions = () => ({
  urgency: score("A human needs to act on this ticket urgently.", { asProposition: true }),
  frustration: score("The person writing this is frustrated or angry.", { asProposition: true }),
  churn: score("The customer says they are considering leaving or looking at alternatives.", { asProposition: true }),
  security: is("This describes a security or access-control problem."),
  refund: is("The customer is asking for money back."),
  regression: is("The problem started after a deployment."),
  department: choose(["billing", "technical", "security", "sales"], {
    instructions: "Which team should own this",
  }),
})

interface Sample {
  ms: number
  requests: number
  tokens: number
}

async function measure(run: () => Promise<void>): Promise<Sample> {
  const samples: Sample[] = []
  for (let i = 0; i < ROUNDS; i++) {
    reset()
    const started = Date.now()
    await run()
    const s = snapshot()
    samples.push({ ms: Date.now() - started, requests: s.requests, tokens: s.tokens })
  }
  samples.sort((a, b) => a.ms - b.ms)
  return samples[Math.floor(ROUNDS / 2)]!
}

const batched = await measure(async () => {
  await semantic(ticket).batch(questions())
})

const sequential = await measure(async () => {
  // A fresh context each time is what naive sequential code does.
  for (const spec of Object.values(questions())) await semantic(ticket).batch({ only: spec })
})

const line = (label: string, s: Sample) =>
  `${label.padEnd(12)} ${String(s.requests).padStart(3)} requests  ${String(s.tokens).padStart(6)} tokens  ${String(s.ms).padStart(6)}ms`

console.log(`median of ${ROUNDS} rounds, ${Object.keys(questions()).length} questions\n`)
console.log(line("batched", batched))
console.log(line("sequential", sequential))
console.log(
  `\n${(sequential.tokens / batched.tokens).toFixed(1)}x cheaper, ` +
    `${(sequential.ms / batched.ms).toFixed(1)}x faster for the same questions.`,
)
