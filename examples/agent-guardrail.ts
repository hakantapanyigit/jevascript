/**
 * Scenario: an agent is about to execute a tool call. Screen it first.
 *
 * Guardrails are the clearest case for a decision model: they run on *every*
 * call, so cost and latency are the binding constraint, not peak intelligence.
 * All four checks share one request.
 */
import { choose, is, score, semantic } from "jevascript"
import { section, usage } from "./_setup.ts"

interface ToolCall {
  tool: string
  args: Record<string, unknown>
  userAsked: string
}

const RISK_LEVELS = [
  "Affects nothing outside the current request.",
  "Affects a single record belonging to one user.",
  "Affects many records, or an entire customer account.",
  "Affects every tenant, or the production system as a whole.",
]

async function screen(call: ToolCall) {
  // One request, five questions. Adding checks is nearly free; making five
  // separate calls would not be.
  return semantic(call).batch({
    irreversible: is("Running this permanently destroys data or cannot be undone.", {
      trueWhen: "Deletes, drops, truncates, overwrites, or sends something to a third party.",
      falseWhen: "Reads, lists, searches, or writes to a scratch area.",
    }),
    beyondRequest: is("This goes further than what the user actually asked for.", {
      falseWhen: "A reasonable, direct step toward the stated request.",
    }),
    touchesProduction: is("This operates on production data or live infrastructure."),
    blastRadius: score("how much this affects", { levels: RISK_LEVELS }),
    category: choose(
      {
        read: "Only reads or searches data",
        write: "Creates or updates data",
        destroy: "Deletes or irreversibly overwrites data",
        external: "Sends data outside the system, or spends money",
      },
      { instructions: "What kind of action is this" },
    ),
  })
}

const calls: ToolCall[] = [
  {
    tool: "search_docs",
    args: { query: "how do I rotate an API key" },
    userAsked: "How do I rotate my API key?",
  },
  {
    tool: "run_sql",
    args: { database: "prod", query: "DELETE FROM sessions WHERE last_seen < now() - interval '90 days'" },
    userAsked: "Can you clean up old sessions?",
  },
  {
    tool: "send_email",
    args: { to: "all-customers@acme.com", subject: "Scheduled maintenance", body: "…" },
    userAsked: "Draft an email about the maintenance window.",
  },
]

for (const call of calls) {
  section(`${call.tool}  ←  "${call.userAsked}"`)
  const risk = await screen(call)

  console.log(
    `  category ${risk.category.padEnd(9)} blast ${risk.blastRadius.toFixed(0).padStart(3)}  ` +
      `irreversible ${String(risk.irreversible).padEnd(5)}  beyondRequest ${String(risk.beyondRequest).padEnd(5)}  ` +
      `production ${risk.touchesProduction}`,
  )

  // Every consequence below is ordinary code. The thresholds are reviewable,
  // testable, and differ by how much being wrong would cost.
  const verdict =
    risk.irreversible && risk.touchesProduction && risk.blastRadius > 60
      ? "block"
      : risk.beyondRequest || risk.irreversible || risk.category === "external"
        ? "confirm"
        : "allow"

  console.log(`  → ${verdict}`)
}

console.log(`\n${usage()}`)
