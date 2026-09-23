/**
 * Shared wiring for every example: one provider, one usage counter, a few
 * print helpers. Import it for its side effect and use what you need.
 *
 *   import { section, usage } from "./_setup.ts"
 */
import { configureSemantic, jev } from "jevascript"

/** Jev pricing at the time of writing. Output tokens are free. */
const USD_PER_MILLION_INPUT_TOKENS = 0.042

const stats = { requests: 0, questions: 0, tokens: 0, ms: 0 }

configureSemantic({
  provider: jev(),
  defaults: { timeoutMs: 8_000 },
  observability: {
    onEvaluation(event) {
      stats.requests += event.requestCount
      stats.questions += event.questionCount
      stats.tokens += event.usage?.inputTokens ?? 0
      stats.ms += event.latencyMs
    },
  },
})

/** Totals since the last reset. */
export function snapshot(): typeof stats {
  return { ...stats }
}

export function reset(): void {
  stats.requests = stats.questions = stats.tokens = stats.ms = 0
}

/** One line: requests, questions, tokens, latency and what it cost. */
export function usage(): string {
  const usd = (stats.tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS
  return (
    `${stats.requests} request(s) · ${stats.questions} question(s) · ` +
    `${stats.tokens} tokens · ${stats.ms}ms · $${usd.toFixed(6)}`
  )
}

export function section(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n${"═".repeat(Math.min(text.length, 72))}`)
}

export function row(label: string, value: unknown, width = 18): void {
  const shown = typeof value === "number" ? value.toFixed(1) : String(value)
  console.log(`  ${label.padEnd(width)} ${shown}`)
}

export function bar(value: number, width = 24): string {
  const filled = Math.round((value / 100) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}
