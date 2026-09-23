/**
 * Inbound lead qualification.
 *
 * Your ICP lives in one place, as prose, where the revenue team can edit it
 * without touching code. Every lead is judged against it in one request.
 */
import { boolean, defineSchema, enumOf, object, score } from "jevascript"
import { section, row, bar, usage } from "../_setup.ts"

const qualify = defineSchema({
  name: "lead-qualification",
  version: "3",

  instructions: `
    Qualify an inbound lead for Northwind, a B2B payments API sold to engineering
    teams. Judge the lead only on what the form and enrichment actually say.
    Absence of evidence is not evidence of a poor fit — score it low, not negative.
  `,

  // Owned by the revenue team. Changing it is a config edit, not a deploy.
  context: {
    idealCustomer: `
      Series A to Series C software companies, 50-500 employees, processing
      payments as a core part of their product rather than to collect their own
      subscription fees. Marketplaces and vertical SaaS are the strongest fits.
    `,
    disqualifiers: `
      Agencies and consultancies reselling to clients. Companies in regulated
      lending. Students and personal projects.
    `,
    competitors: ["Stripe Connect", "Adyen for Platforms", "Moov"],
  },

  output: object({
    icpFit: score(0, 100, "This company matches the ideal customer profile."),
    buyingIntent: score(0, 100, "This person is actively evaluating a solution right now."),
    technicalDepth: score(0, 100, "The writer understands the technical problem they describe."),
    switching: boolean({
      describe: "The lead is moving away from a named competitor.",
      falseWhen: "Merely mentioning a competitor as a reference point.",
    }),
    disqualified: boolean({
      describe: "This lead matches one of the disqualifiers.",
      trueWhen: "An agency, a reseller, regulated lending, a student, or a personal project.",
    }),
    segment: enumOf(
      {
        marketplace: "Connects buyers and sellers and needs to split or route funds",
        vertical_saas: "Software for one industry that embeds payments for its customers",
        platform: "Lets other businesses build on top of them and pay out to them",
        internal: "Only wants to collect payment for their own product",
        unclear: "Not enough information to tell",
      },
      "What kind of business is this",
    ),
  }),
})

const leads = [
  {
    company: "Palette",
    employees: 120,
    funding: "Series B",
    role: "VP Engineering",
    message: `We run a marketplace for commercial kitchen rentals. We're on Stripe Connect
      but the payout scheduling doesn't fit our model — hosts need same-day payouts and
      we're building workarounds with manual transfers. Evaluating alternatives this quarter.`,
  },
  {
    company: "Bright Digital",
    employees: 18,
    funding: "Bootstrapped",
    role: "Founder",
    message: `We build ecommerce sites for our clients and would like to offer payments
      as part of our package. Do you have a reseller or agency programme?`,
  },
  {
    company: "Clinicly",
    employees: 240,
    funding: "Series C",
    role: "Staff Engineer",
    message: `We're clinic management software. Practices bill patients through us and we
      currently just pass card details to a gateway. We want to hold funds, take a platform
      fee, and pay out to each practice weekly. Mostly researching for now — no timeline yet.`,
  },
]

for (const lead of leads) {
  const { company, ...rest } = lead
  section(`${company} — ${lead.employees} employees, ${lead.funding}`)

  const q = await qualify({ company, ...rest })

  console.log(`  ${bar(q.icpFit)} ICP fit ${q.icpFit.toFixed(0)}`)
  console.log(`  ${bar(q.buyingIntent)} intent  ${q.buyingIntent.toFixed(0)}`)
  console.log(`  ${bar(q.technicalDepth)} depth   ${q.technicalDepth.toFixed(0)}`)
  row("segment", q.segment)
  row("switching", q.switching)
  row("disqualified", q.disqualified)

  // Routing is arithmetic on values you can explain to a sales leader.
  const priority = q.icpFit * 0.5 + q.buyingIntent * 0.35 + q.technicalDepth * 0.15
  const route = q.disqualified
    ? "nurture — disqualified"
    : priority > 70
      ? "book AE call today"
      : priority > 45
        ? "solutions engineer follow-up"
        : "self-serve onboarding email"

  console.log(`\n  priority ${priority.toFixed(0)} → ${route}${q.switching ? "  (competitive displacement)" : ""}`)
}

console.log(`\n${usage()}`)
