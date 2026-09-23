import { choose, is, score, semantic } from "jevascript"
import "../_setup.ts"

const ticket = { plan: "enterprise", message: "Production is down since your 14:02 deploy. Twelve people can't work." }

const t = await semantic(ticket).batch({
  urgency: score("A human needs to act on this right now.", { asProposition: true }),
  refund: is("The customer is asking for money back."),
  team: choose(["billing", "technical", "security"]),
})

console.log(t)
if (t.urgency > 80 && ticket.plan === "enterprise") console.log("→ page on-call")
if (t.refund) console.log("→ open a billing case")
console.log(`→ route to ${t.team}`)
