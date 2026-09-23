/**
 * Support ticket triage.
 *
 * Declare the domain once — what the data is, what your words mean, what your
 * tiers are — then apply it to every ticket. One request per ticket, whatever
 * the schema contains.
 */
import { boolean, defineSchema, enumOf, object, score } from "jevascript"
import { section, row, bar, usage } from "../_setup.ts"

const triage = defineSchema({
  name: "ticket-triage",
  version: "1",

  // The frame every question is asked in. Not an instruction the model obeys —
  // it does not take orders — but the context that makes your words mean what
  // you mean by them.
  instructions: `
    Triage an inbound support ticket for Northwind, a B2B payments API.
    Customers are engineering teams integrating our SDK.
    "Blocked" means they cannot process live transactions right now.
    Sandbox and documentation problems are never blocking.
  `,

  // Background merged into every call: policy the ticket is judged against.
  context: {
    plans: {
      free: "Community support only. No SLA.",
      growth: "Business-hours support. 8-hour first response.",
      enterprise: "24/7 support. 30-minute first response. Named CSM.",
    },
    escalationPolicy:
      "Page on-call only for live payment failures affecting a paying customer in production.",
  },

  // Each `describe` is a proposition, because that is what gets scored.
  // "How urgent is this?" is a label; "A human needs to act urgently" is a claim.
  output: object({
    urgency: score(0, 100, "A human needs to act on this ticket urgently."),
    blocksRevenue: boolean({
      describe: "The customer is currently unable to take money from their own customers.",
      trueWhen: "Live transactions are failing, being declined, or not settling.",
      falseWhen: "Sandbox failures, slow dashboards, or questions about future work.",
    }),
    department: enumOf(
      {
        integration: "SDK usage, API errors, webhooks, authentication during integration",
        payments: "Declines, settlement, payouts, chargebacks, currency",
        billing: "Our own invoices, pricing, plan changes and refunds to the customer",
        security: "Credential exposure, suspicious access, vulnerability reports",
      },
      "Which team should own this ticket",
    ),
    sentiment: score(0, 100, "The person writing this sounds frustrated or angry."),
    churnSignal: boolean({
      describe: "The customer hints they may leave, or is evaluating competitors.",
      falseWhen: "Frustration alone. Anger is not the same as leaving.",
    }),
    needsHuman: boolean({
      describe: "A canned or templated answer would be inadequate here.",
    }),
  }),
})

const tickets = [
  {
    id: "NW-8801",
    plan: "enterprise",
    subject: "All card payments failing since 14:02",
    body: `Every charge is coming back with gateway_timeout since your 14:02 deploy.
      We've processed zero payments in 40 minutes. This is our Friday peak.
      Our CEO is asking me what our contingency is.`,
  },
  {
    id: "NW-8802",
    plan: "free",
    subject: "Webhook signature docs unclear",
    body: `The docs show HMAC-SHA256 but don't say whether the timestamp is included
      in the signed payload. Could you clarify? Not urgent, I'm still in sandbox.`,
  },
  {
    id: "NW-8803",
    plan: "growth",
    subject: "Third outage this quarter",
    body: `This is the third time this quarter. Payments are working now, but my team
      has spent two weeks on reliability workarounds. I've been asked to prepare a
      comparison against Stripe and Adyen before our renewal in March.`,
  },
]

for (const ticket of tickets) {
  const { id, plan, ...content } = ticket
  section(`${id} — ${plan}`)

  const t = await triage({ plan, ...content })

  console.log(`  ${bar(t.urgency)} urgency ${t.urgency.toFixed(0)}`)
  console.log(`  ${bar(t.sentiment)} frustration ${t.sentiment.toFixed(0)}`)
  row("department", t.department)
  row("blocksRevenue", t.blocksRevenue)
  row("churnSignal", t.churnSignal)
  row("needsHuman", t.needsHuman)

  // Every consequence is plain TypeScript. Thresholds differ by what being
  // wrong would cost, and they live in code you can review and test.
  const sla = plan === "enterprise" ? 30 : plan === "growth" ? 480 : null
  const actions: string[] = []
  if (t.blocksRevenue && plan !== "free") actions.push("page on-call")
  if (t.urgency > 80) actions.push("pin to top of queue")
  if (t.churnSignal) actions.push("notify CSM")
  if (!t.needsHuman) actions.push("try autoresponder first")

  console.log(`\n  → ${actions.join(", ") || "normal queue"}${sla ? `  (SLA ${sla}m)` : ""}`)
}

console.log(`\n${usage()}`)
