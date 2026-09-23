/**
 * Nine things ordinary TypeScript cannot do.
 *
 * Not "annoying to write" — actually not expressible. No regex, no library, no
 * amount of `if`. Each one is a few lines.
 */
import { semantic } from "jevascript"
import "./_setup.ts"

const show = async (label: string, p: Promise<{ value: unknown; probability: number }>) => {
  const r = await p
  const mark = r.value === true ? "\x1b[32myes\x1b[0m" : r.value === false ? "\x1b[31mno \x1b[0m" : String(r.value)
  console.log(`  ${mark}  p=${r.probability.toFixed(2)}  ${label}`)
}
const head = (n: number, t: string) => console.log(`\n\x1b[1m${n}. ${t}\x1b[0m`)

// ---------------------------------------------------------------------------
head(1, "An `if` on tone")

const comments = [
  "Nice work! Could you add a test for the empty case?",
  "Interesting choice. I'm sure you had your reasons for not testing this.",
]
for (const body of comments) {
  await show(
    `"${body.slice(0, 52)}…"`,
    semantic({ body }).is("This review comment is passive-aggressive.", { detailed: true }),
  )
}

// ---------------------------------------------------------------------------
head(2, "Two fields that contradict each other")

const reviews = [
  { stars: 5, text: "Works exactly as advertised. Shipped fast." },
  { stars: 5, text: "Arrived broken, support never replied, had to buy another one." },
]
for (const review of reviews) {
  await show(
    `${review.stars}★ "${review.text.slice(0, 44)}…"`,
    semantic(review).is("The star rating contradicts what the text says.", { detailed: true }),
  )
}

// ---------------------------------------------------------------------------
head(3, "Two strings that are the same bug in different words")

const pairs = [
  {
    a: "Login button does nothing on Safari",
    b: "Can't sign in from my Mac, clicking submit has no effect",
  },
  {
    a: "Login button does nothing on Safari",
    b: "Password reset email never arrives",
  },
]
for (const pair of pairs) {
  await show(
    `"${pair.a}" ≟ "${pair.b.slice(0, 38)}…"`,
    semantic(pair).is("These two reports describe the same underlying bug.", { detailed: true }),
  )
}

// ---------------------------------------------------------------------------
head(4, "An error you have never seen before")

// Ask about the text, not about the future. "Will retrying work?" is a
// prediction and comes back mushy (0.30 on a plainly transient error). "What
// caused this?" is a fact the message states, and separates cleanly — then the
// decision is a `!` in your own code.
const errors = [
  "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
  "ValidationError: field `currency` must be a 3-letter ISO 4217 code, got 'EURO'",
  "Error: ENOSPC: no space left on device, write",
]
for (const error of errors) {
  const ourFault = await semantic({ error }).is(
    "This error was caused by something the caller sent, or by a resource that is full.",
    { detailed: true },
  )
  const retryable = !ourFault.value
  const mark = retryable ? "\x1b[32mretry\x1b[0m" : "\x1b[31mdrop \x1b[0m"
  console.log(`  ${mark}  p=${ourFault.probability.toFixed(2)}  ${error.slice(0, 56)}…`)
}

// ---------------------------------------------------------------------------
head(5, "Absence — is the thing that should be there, there?")

const reports = [
  "It crashes. Please fix.",
  "Open /settings, toggle 'beta features' twice quickly, page goes white. Chrome 141, every time.",
]
for (const body of reports) {
  await show(
    `"${body.slice(0, 52)}…"`,
    // "Is there enough to reproduce?" asks for a verdict and hedges at 0.50.
    // "Does it list the steps?" asks what is on the page, and lands at 0.95.
    semantic({ body }).is("This report lists the steps someone would follow to make the problem happen.", {
      trueWhen: "Names a place to start and actions to take.",
      falseWhen: "Only describes the outcome.",
      detailed: true,
    }),
  )
}

// ---------------------------------------------------------------------------
head(6, "Ranking by fit, not by keyword")

const symptom = "Requests succeed locally but time out in production after exactly 30 seconds."
const hypotheses = [
  "The database connection pool is exhausted",
  "A load balancer idle timeout is cutting the connection",
  "The code has an off-by-one error in pagination",
  "DNS resolution is slow in the production VPC",
]
const ranked = await semantic({ symptom }).rank(hypotheses, {
  by: "This hypothesis explains the symptom, including the exact 30-second figure.",
})
ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.score.toFixed(2)}  ${r.item}`))

// ---------------------------------------------------------------------------
head(7, "Does the comment still describe the code?")

const snippets = [
  {
    comment: "// Retries up to 3 times with exponential backoff",
    code: "for (let i = 0; i < 3; i++) { try { return await call() } catch { await sleep(2 ** i * 100) } }",
  },
  {
    comment: "// Retries up to 3 times with exponential backoff",
    code: "return await call()",
  },
]
for (const snippet of snippets) {
  await show(
    `"${snippet.code.slice(0, 44)}…"`,
    semantic(snippet).is("The comment accurately describes what the code does.", { detailed: true }),
  )
}

// ---------------------------------------------------------------------------
head(8, "Across two languages at once")

const translations = [
  {
    source: "We may be able to ship this by Friday, but I wouldn't count on it.",
    tr: "Cuma'ya yetiştirebiliriz belki, ama ben pek güvenmezdim.",
  },
  {
    source: "We may be able to ship this by Friday, but I wouldn't count on it.",
    tr: "Bunu Cuma günü teslim edeceğiz.",
  },
]
for (const t of translations) {
  await show(
    `"${t.tr.slice(0, 46)}…"`,
    semantic(t).is("The translation preserves the meaning, including how tentative it is.", {
      detailed: true,
    }),
  )
}

// ---------------------------------------------------------------------------
head(9, "A number that exists nowhere in the data")

const messages = [
  "hey, quick one — is there a dark mode?",
  "We've been down for 40 minutes and I have the CEO on the phone.",
]
for (const body of messages) {
  const urgency = await semantic({ body }).score("Someone needs to act on this right now.")
  console.log(`  ${urgency.toFixed(0).padStart(3)}  "${body.slice(0, 52)}…"`)
}
