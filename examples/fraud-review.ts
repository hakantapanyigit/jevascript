/**
 * Scenario: decide whether an order needs manual review.
 *
 * The point here is *composite scoring*. Each dimension is a proposition —
 * a claim that can be true of the order — never a "how much" question, which
 * the model would have to answer with a label rather than a probability. Instead of asking one fuzzy question
 * ("how risky is this order?") and getting an opaque number, ask several
 * independent ones and combine them with weights you own. The weighting is a
 * line of code: reviewable, testable, and adjustable without touching a model.
 */
import { is, score, semantic } from "jevascript"
import { section, usage } from "./_setup.ts"

interface Order {
  id: string
  total: number
  currency: string
  itemCount: number
  customer: { accountAgeDays: number; priorOrders: number; priorChargebacks: number }
  shipping: { country: string; matchesBilling: boolean; type: string }
  payment: { method: string; issuerCountry: string; attempts: number }
  notes?: string
}

const WEIGHTS = { identity: 0.35, behaviour: 0.4, shipping: 0.25 } as const

async function assess(order: Order) {
  const signals = await semantic(order).batch({
    identityMismatch: score("The way this customer is paying is inconsistent with who they claim to be.", {
      asProposition: true,
    }),
    behaviourAnomaly: score("This order is unusual for this customer's history.", { asProposition: true }),
    shippingRisk: score("This shipping arrangement is designed to avoid traceability.", { asProposition: true }),
    resale: is("The order pattern looks like buying for resale rather than personal use.", {
      falseWhen: "A large but coherent purchase, such as one team buying equipment.",
    }),
    rushed: is("The customer appears to be in an unusual hurry to receive the goods."),
  })

  // Nothing above knows how it will be used. The combination is ours.
  const composite =
    signals.identityMismatch * WEIGHTS.identity +
    signals.behaviourAnomaly * WEIGHTS.behaviour +
    signals.shippingRisk * WEIGHTS.shipping

  // Deterministic facts stay deterministic. Do not ask a model to do arithmetic
  // or compare dates — it reads them as text.
  const hardFlags =
    (order.customer.priorChargebacks > 0 ? 1 : 0) +
    (order.payment.attempts > 2 ? 1 : 0) +
    (order.customer.accountAgeDays < 1 && order.total > 1000 ? 1 : 0)

  return { signals, composite, hardFlags }
}

const orders: Order[] = [
  {
    id: "A-1041",
    total: 89.5,
    currency: "EUR",
    itemCount: 2,
    customer: { accountAgeDays: 890, priorOrders: 14, priorChargebacks: 0 },
    shipping: { country: "DE", matchesBilling: true, type: "standard" },
    payment: { method: "card", issuerCountry: "DE", attempts: 1 },
  },
  {
    id: "A-1042",
    total: 4280,
    currency: "EUR",
    itemCount: 12,
    customer: { accountAgeDays: 0, priorOrders: 0, priorChargebacks: 0 },
    shipping: { country: "RO", matchesBilling: false, type: "overnight" },
    payment: { method: "card", issuerCountry: "GB", attempts: 4 },
    notes: "Customer asked in chat whether the order can ship before the card clears.",
  },
  {
    id: "A-1043",
    total: 3150,
    currency: "EUR",
    itemCount: 9,
    customer: { accountAgeDays: 410, priorOrders: 22, priorChargebacks: 0 },
    shipping: { country: "DE", matchesBilling: true, type: "overnight" },
    payment: { method: "invoice", issuerCountry: "DE", attempts: 1 },
    notes: "Purchase order attached, company billing address, asked for it before a Friday launch.",
  },
]

for (const order of orders) {
  section(`${order.id} — ${order.total} ${order.currency}, ${order.itemCount} items`)
  const { signals, composite, hardFlags } = await assess(order)

  console.log(
    `  identity ${signals.identityMismatch.toFixed(0).padStart(3)}  ` +
      `behaviour ${signals.behaviourAnomaly.toFixed(0).padStart(3)}  ` +
      `shipping ${signals.shippingRisk.toFixed(0).padStart(3)}  ` +
      `resale ${String(signals.resale).padEnd(5)} rushed ${signals.rushed}`,
  )
  console.log(`  composite ${composite.toFixed(1)}   hard flags ${hardFlags}`)

  const action =
    hardFlags >= 2 || composite >= 70 ? "manual review" : composite >= 45 ? "hold for 3-D Secure" : "approve"
  console.log(`  → ${action}`)
}

// ---------------------------------------------------------------------------
// When being wrong is expensive, gate on confidence and pay for certainty.
// `minConfidence` re-asks the question and measures how much the answer moves.
// ---------------------------------------------------------------------------
section("High-stakes path: gate on measured confidence")

let escalations = 0
const gated = await semantic(orders[1]!).score("This order is fraudulent.", {
  asProposition: true,
  minConfidence: 0.9,
  fallback: async () => {
    escalations++
    return 100 // a real system would call a slower, costlier reviewer here
  },
})

console.log(`  gated score ${gated.toFixed(1)}  ${escalations > 0 ? "(escalated — answer was unstable)" : "(confident)"}`)
console.log(`\n${usage()}`)
