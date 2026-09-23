/**
 * Run with: npm run example examples/support-ticket.ts
 *
 * Shows the shape the library is built around: one request produces several
 * semantic values, and every consequence is decided by ordinary TypeScript.
 *
 * Every `score` criterion is a proposition — a claim about the ticket that can
 * be true — because that is what gets scored. "urgency" on its own is a label;
 * "A human needs to act on this urgently" is a claim. The short noun form is
 * still accepted (it is framed into "This has high urgency."), but a claim you
 * wrote yourself is always more precise than one the runtime guessed at.
 */
import { choose, is, score, semantic } from "jevascript"
import { section, usage } from "./_setup.ts"

const ticket = {
  customer: { plan: "enterprise", tenureMonths: 14 },
  subject: "Everything is down",
  message: `Production is completely unreachable since the 14:02 deploy.
    Twelve of our staff cannot work. We have customers waiting.
    If this is not fixed today we are going to look at alternatives.`,
}

section("Seven questions, one request")

const analysis = await semantic(ticket).batch({
  urgency: score("A human needs to act on this ticket urgently.", { asProposition: true }),
  frustration: score("The person writing this is frustrated or angry.", { asProposition: true }),
  churnRisk: score("The customer says they are considering leaving or looking at alternatives.", { asProposition: true }),
  securityRelated: is("This ticket describes a security or access-control problem."),
  wantsRefund: is("The customer is asking for money back.", {
    falseWhen: "Complaining about value or threatening to leave is not a refund request.",
  }),
  department: choose(
    {
      billing: "Payment, invoicing, subscription and refund problems",
      technical: "Outages, bugs and problems using the product",
      security: "Credentials, access, abuse and security problems",
      sales: "Purchasing, pricing and enterprise requests",
    },
    { instructions: "Which team should own this ticket" },
  ),
  severity: score("impact on the customer's ability to work", {
    levels: [
      "No impact; the customer can work normally.",
      "Annoying, but a workaround exists.",
      "A feature is unusable; the rest of the product works.",
      "The whole product is unusable for the customer.",
    ],
  }),
})

for (const [key, value] of Object.entries(analysis)) {
  console.log(`  ${key.padEnd(16)} ${typeof value === "number" ? value.toFixed(1) : value}`)
}

// ---------------------------------------------------------------------------
// From here on nothing is semantic. Thresholds, priorities and actions are
// plain code, so they are reviewable, testable and versioned like any logic.
// ---------------------------------------------------------------------------
section("Decisions, in plain TypeScript")

const priority =
  analysis.urgency >= 80 || analysis.frustration >= 90
    ? "critical"
    : analysis.urgency >= 60
      ? "high"
      : "normal"

console.log(`  priority        ${priority}`)
console.log(`  route to        ${analysis.department}`)
if (priority === "critical") console.log("  page on-call    yes")
if (analysis.churnRisk > 70) console.log("  retention flow  start")
if (analysis.securityRelated) console.log("  notify security yes")

console.log(`\n${usage()}`)
