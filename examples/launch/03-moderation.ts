/**
 * Marketplace listing moderation.
 *
 * The policy is prose your trust-and-safety team owns. The thresholds are a
 * diffable object. Neither is buried in a prompt, and changing either is a
 * config change rather than a retraining cycle.
 */
import { boolean, defineSchema, enumOf, object, score } from "jevascript"
import { section, row, usage } from "../_setup.ts"

const moderate = defineSchema({
  name: "listing-moderation",
  version: "7",

  instructions: `
    Review a listing submitted to Northwind Market, a marketplace for used
    professional equipment. Judge only the listing text and declared fields.
    A listing is not prohibited merely because the item is expensive or unusual.
  `,

  context: {
    prohibited: `
      Weapons and weapon parts. Prescription drugs and medical devices requiring a
      licence. Counterfeit or replica branded goods. Recalled equipment. Anything
      whose sale requires a licence the seller does not claim to hold.
    `,
    restricted: `
      Items over EUR 10,000 require identity verification before listing.
      Industrial machinery requires a declared safety certificate.
    `,
  },

  output: object({
    prohibited: boolean({
      describe: "This listing is for a prohibited item.",
      falseWhen: "An item that is merely expensive, niche, or requires care to ship.",
    }),
    counterfeitRisk: score(0, 100, "This listing is likely to be a counterfeit or replica."),
    offPlatform: boolean({
      describe: "The seller is steering the buyer to pay or communicate outside the platform.",
      trueWhen: "Shares a phone number, personal email, or asks for a bank transfer or crypto.",
    }),
    misleading: score(0, 100, "The description overstates the condition or provenance of the item."),
    missingInfo: boolean({
      describe: "A buyer could not reasonably decide from this description alone.",
    }),
    action: enumOf(
      {
        publish: "Nothing here needs a human",
        verify: "Publish only once the seller completes identity or certificate checks",
        review: "A moderator should look at this before it goes live",
        reject: "This cannot be listed",
      },
      "What should happen to this listing",
    ),
  }),
})

const listings = [
  {
    id: "L-4410",
    price: 2400,
    category: "Photography",
    text: `Canon EOS R5, 14k shutter count, boxed with two batteries and the original
      receipt from Calumet Hamburg. Minor scuff on the baseplate, shown in photo 4.
      Collection from Hamburg or insured courier at buyer's cost.`,
  },
  {
    id: "L-4411",
    price: 180,
    category: "Watches",
    text: `Rolex Submariner, superb quality, indistinguishable from the real thing.
      Comes in a box. WhatsApp me on +49 170 000 0000 for a faster deal, I can do
      better price outside the site.`,
  },
  {
    id: "L-4412",
    price: 14500,
    category: "Industrial",
    text: `Haas VF-2 CNC mill, 2019, approximately 3000 spindle hours. Runs perfectly.
      Selling because we upgraded. Buyer arranges rigging and transport.`,
  },
]

for (const listing of listings) {
  const { id, ...content } = listing
  section(`${id} — €${listing.price}, ${listing.category}`)

  const m = await moderate(content)

  row("prohibited", m.prohibited)
  row("counterfeitRisk", m.counterfeitRisk.toFixed(0))
  row("offPlatform", m.offPlatform)
  row("misleading", m.misleading.toFixed(0))
  row("missingInfo", m.missingInfo)
  row("model says", m.action)

  // The model's own suggestion is one input, not the decision. Hard policy
  // wins, and the deterministic price rule is not the model's job to remember.
  const decision = m.prohibited || m.offPlatform
    ? "reject"
    : m.counterfeitRisk > 60
      ? "review"
      : listing.price > 10_000
        ? "verify"
        : m.misleading > 60 || m.missingInfo
          ? "review"
          : "publish"

  console.log(`\n  → ${decision}`)
}

console.log(`\n${usage()}`)
