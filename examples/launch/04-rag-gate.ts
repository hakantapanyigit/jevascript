/**
 * Retrieval gate: decide what is worth putting in front of an expensive model.
 *
 * Vector search returns things that are *similar*. Similar is not the same as
 * useful. This judges every candidate against the actual question — all of them
 * in one request — and answers the question retrieval cannot: whether the
 * corpus contains an answer at all.
 */
import { is, semantic, type QuestionSpec } from "jevascript"
import { section, usage } from "../_setup.ts"

// What a vector search handed back for the question below. Ranked by cosine
// similarity, which is why the genuinely useful passage is not first.
const question = "Can I issue a partial refund after a payout has already been sent to the seller?"

const passages = [
  "Refunds can be issued in full or in part from the dashboard or via the API.",
  "Payouts are scheduled daily at 03:00 UTC and settle within two business days.",
  "A refund reduces the merchant's available balance immediately, even if the original charge has settled.",
  "Once a payout has been sent, reversing it is not possible. A partial refund after payout is taken from the merchant's next payout, and if the next payout is insufficient, the balance becomes negative and is recovered from subsequent volume.",
  "Chargebacks are handled separately from refunds and follow the card network's timeline.",
  "The refunds API accepts an `amount` parameter in the smallest currency unit.",
  "Sellers can view their payout history under Settings → Payouts.",
  "Refund requests older than 180 days must be processed as a bank transfer.",
  "Our SDK exposes `refunds.create()` in all supported languages.",
  "Payout schedules can be changed to weekly or monthly on Growth plans and above.",
  "Disputes must be responded to within 7 days of notification.",
  "Partial refunds are not supported for subscriptions billed in advance.",
]

section(`Question: ${question}`)

const ids = passages.map((_, i) => `p${i}`)
const context = semantic({
  question,
  passages: Object.fromEntries(passages.map((text, i) => [ids[i]!, text])),
})

// Fanning out over a list means dynamic keys, which TypeScript cannot infer
// through `Object.fromEntries`. Declaring the record type once keeps the rest
// of the file typed as `Record<string, boolean>`.
const questions: Record<string, QuestionSpec<boolean>> = {
  ...Object.fromEntries(
    ids.map((id) => [
      id,
      is(`Passage ${id} contains information that helps answer the question.`, {
        trueWhen: "It states a rule, limit or behaviour that bears directly on the question.",
        falseWhen: "It is about a neighbouring topic, or merely uses the same words.",
      }),
    ]),
  ),
  // Retrieval always returns something. This is the question it cannot answer.
  answerable: is("The passages together contain enough to answer the question.", {
    falseWhen: "They discuss the topic but never state the specific rule being asked about.",
  }),
}

// Every passage judged in the same request, against the same state. Thirteen
// questions cost barely more than one, because the corpus is sent once.
const verdicts = await context.batch(questions)

const kept = ids.filter((id) => verdicts[id] === true)

passages.forEach((text, i) => {
  const mark = verdicts[ids[i]!] === true ? "\x1b[32m keep \x1b[0m" : "\x1b[2m drop \x1b[0m"
  console.log(`  ${mark} ${text.slice(0, 84)}${text.length > 84 ? "…" : ""}`)
})

console.log(`\n  answerable from this corpus: ${verdicts["answerable"]}`)
console.log(`  ${kept.length} of ${passages.length} passages worth sending on`)

// ---------------------------------------------------------------------------
const corpusChars = passages.join(" ").length
const keptChars = kept.map((id) => passages[Number(id.slice(1))]!).join(" ").length
const saved = 1 - keptChars / corpusChars

section("Why this is worth doing")
console.log(`  context reduced by      ${(saved * 100).toFixed(0)}%  (${corpusChars} → ${keptChars} chars)`)
console.log(`  gate cost               ${usage()}`)
console.log(`
  The gate runs before the expensive call, on every query, and costs a fraction
  of a cent. It also gives you something retrieval cannot: a direct answer to
  "do we even know this?", so an empty corpus produces "I don't know" instead of
  a confident paragraph built from adjacent passages.`)
