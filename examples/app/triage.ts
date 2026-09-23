/**
 * Declared once at module scope, like a validation schema, on the shared `semantic`
 * instance. Nothing here runs until it is applied to a ticket.
 */
import { boolean, enumOf, object, score } from "jevascript"
import { semantic } from "./semantic.ts"

export const triage = semantic.defineSchema({
  name: "ticket-triage",
  version: "4",

  instructions: `
    Triage an inbound support ticket for Northwind, a B2B payments API sold to
    engineering teams. "Blocked" means the customer cannot process live
    transactions right now. Sandbox and documentation problems are never blocking.
  `,

  context: {
    escalationPolicy:
      "Page on-call only for live payment failures affecting a paying customer in production.",
  },

  output: object({
    urgency: score(0, 100, "A human needs to act on this ticket urgently."),
    frustration: score(0, 100, "The person writing this sounds frustrated or angry."),
    blocksRevenue: boolean({
      describe: "The customer is currently unable to take money from their own customers.",
      falseWhen: "Sandbox failures, slow dashboards, or questions about future work.",
    }),
    churnSignal: boolean({
      describe: "The customer hints they may leave, or is evaluating competitors.",
      falseWhen: "Frustration alone. Anger is not the same as leaving.",
    }),
    department: enumOf(
      {
        integration: "SDK usage, API errors, webhooks, authentication during integration",
        payments: "Declines, settlement, payouts, chargebacks, currency",
        billing: "Our own invoices, pricing, plan changes and refunds",
        security: "Credential exposure, suspicious access, vulnerability reports",
      },
      "Which team should own this ticket",
    ),
  }),
})

export type Triage = Awaited<ReturnType<typeof triage>>

/** A single reusable condition, applied wherever a reply is about to be sent. */
export const safeToAutoReply = semantic.defineRule({
  name: "safeToAutoReply",
  version: "2",
  condition: "A templated answer would be adequate and would not annoy this customer.",
  falseWhen: "The customer is angry, is blocked, or is asking something specific to their account.",
})
