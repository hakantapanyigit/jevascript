/**
 * Scenario: the control flow of an agent.
 *
 * An agent loop is mostly small decisions: am I done, what next, which tool.
 * Those do not need a frontier model — they need a fast, calibrated answer the
 * loop can branch on.
 *
 * The lesson embedded here is about *how to ask*. "Is the task complete?"
 * requires the model to parse a task into sub-goals and match each against a
 * history — a multi-hop join it does poorly. Measured on the last step below,
 * that phrasing lands at p=0.24 (wrong), and rewording it only moves it to
 * p=0.51, which is a coin flip dressed up as an answer.
 *
 * Asking one direct question per sub-goal and doing the join in code gives
 * p=0.95 and p=0.98 on the same state. Keep each question single-hop; compose
 * the result yourself.
 */
import { semantic } from "jevascript"
import { section, usage } from "./_setup.ts"

const TOOLS = [
  "search_docs — full-text search over the product documentation",
  "read_file — read a file from the user's repository",
  "run_tests — execute the project's test suite and return failures",
  "query_db — run a read-only SQL query against the analytics warehouse",
  "send_email — send an email on the user's behalf",
  "create_ticket — open a ticket in the issue tracker",
]

interface Task {
  goal: string
  /** Sub-goals, each phrased as a single-hop proposition about the state. */
  subGoals: Record<string, string>
}

interface Step {
  task: string
  history: string[]
  lastToolResult: string
}

async function decide(task: Task, step: Step) {
  const context = semantic(step)

  // Every question below travels in one request: the sub-goals, plus the two
  // loop-control questions. Adding a sub-goal costs almost nothing.
  const names = Object.keys(task.subGoals)
  const [blocked, ...goalResults] = await Promise.all([
    context.is("Progress is blocked on information only the user can supply.", {
      trueWhen: "A credential, a decision, or a missing fact the agent cannot obtain itself.",
      falseWhen: "A transient error, or something the agent could retry or work around.",
    }),
    ...names.map((name) => context.is(task.subGoals[name]!, { allowUnknown: true })),
  ])

  const goals = Object.fromEntries(names.map((name, i) => [name, goalResults[i]!]))
  const done = names.every((name) => goals[name] === true)
  const unclear = names.some((name) => goals[name] === "unknown")

  if (done) return { next: "finish" as const, goals, blocked }
  if (blocked) return { next: "ask_user" as const, goals, blocked }
  if (unclear) return { next: "verify" as const, goals, blocked }

  const next = await semantic(step).choose(
    {
      retry: "The last attempt failed for a transient reason; try it again unchanged.",
      use_another_tool: "The approach was wrong; a different tool is needed.",
      continue: "The last step succeeded; proceed to the next step of the plan.",
    },
    { instructions: "What should the agent do next" },
  )
  return { next, goals, blocked }
}

const perfTask: Task = {
  goal: "Find out why the checkout page is slow and open a ticket.",
  subGoals: {
    causeFound: "The cause of the slow checkout page has been identified.",
    ticketOpened: "A ticket has been created in the issue tracker.",
  },
}

const emailTask: Task = {
  goal: "Email the quarterly report to the finance team.",
  subGoals: {
    reportFound: "The quarterly report file has been located.",
    emailSent: "The email has been sent successfully.",
  },
}

const runs: [Task, Step][] = [
  [
    perfTask,
    {
      task: perfTask.goal,
      history: ["ran run_tests — all passed"],
      lastToolResult: "All 214 tests passed in 12.4s. No failures.",
    },
  ],
  [
    perfTask,
    {
      task: perfTask.goal,
      history: ["ran run_tests — passed", "ran query_db — timed out"],
      lastToolResult: "Error: connection reset by peer after 30000ms. No rows returned.",
    },
  ],
  [
    emailTask,
    {
      task: emailTask.goal,
      history: ["ran read_file — found report.pdf", "ran send_email — failed"],
      lastToolResult: "Error: no recipient address configured for group 'finance'.",
    },
  ],
  [
    perfTask,
    {
      task: perfTask.goal,
      history: [
        "ran query_db — p95 4.2s on /checkout, traced to an unindexed scan on orders.customer_id",
        "ran create_ticket — PERF-441 created",
      ],
      lastToolResult: "Created ticket PERF-441 with the query plan attached.",
    },
  ],
]

for (const [task, step] of runs) {
  section(`last result: ${step.lastToolResult.slice(0, 52)}…`)
  const { next, goals, blocked } = await decide(task, step)
  const summary = Object.entries(goals)
    .map(([name, value]) => `${name}=${value}`)
    .join("  ")
  console.log(`  ${summary}  blocked=${blocked}`)
  console.log(`  → ${next}`)
}

// ---------------------------------------------------------------------------
// Tool selection. `find` puts the tools themselves into one choice and pairs it
// with an existence check, so "none of these fit" is a real answer rather than
// whichever option happened to score highest.
// ---------------------------------------------------------------------------
section("Tool selection — one request each")

for (const request of [
  "Why did the nightly job fail last Tuesday?",
  "What's our refund policy for annual plans?",
  "Please book me a flight to Berlin.",
]) {
  const tool = await semantic.find(TOOLS, `Best tool for handling this request: ${request}`)
  console.log(`  ${request.padEnd(48)} → ${tool ? tool.split(" — ")[0] : "no suitable tool"}`)
}

console.log(`\n${usage()}`)
