import { LowConfidenceError, SemanticError } from "jevascript"
import { safeToAutoReply, triage, type Triage } from "./triage.ts"
import type { Db, Ticket, TicketRecord } from "./db.ts"

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export type Priority = "critical" | "high" | "normal" | "low"

export interface TriageResult {
  priority: Priority
  queue: string
  actions: string[]
  /** False when the semantic layer was unavailable and we fell back. */
  graded: boolean
}

const SLA_MINUTES: Record<string, number | null> = {
  enterprise: 30,
  growth: 480,
  free: null,
}

export class TicketService {
  readonly #db: Db
  readonly #log: Logger

  constructor(db: Db, log: Logger) {
    this.#db = db
    this.#log = log
  }

  async intake(input: Ticket): Promise<TicketRecord> {
    const customer = await this.#db.customers.find(input.customerId)
    if (!customer) throw new Error(`Unknown customer ${input.customerId}`)

    const { priority, queue, actions, graded } = await this.grade(input, customer.plan)

    const record = await this.#db.tickets.insert({
      ...input,
      priority,
      queue,
      slaMinutes: SLA_MINUTES[customer.plan] ?? null,
      gradedBy: graded ? `${triage.name}@${triage.version}` : "fallback",
      createdAt: new Date().toISOString(),
    })

    for (const action of actions) await this.#db.jobs.enqueue(action, { ticketId: record.id })
    this.#log.info("ticket.intake", { id: record.id, priority, queue, graded })
    return record
  }

  /**
   * The only interesting method. One semantic call sits in the middle of
   * ordinary code, and the decisions around it are ordinary too.
   */
  private async grade(ticket: Ticket, plan: string): Promise<TriageResult> {
    let t: Triage
    try {
      t = await triage(
        { subject: ticket.subject, body: ticket.body, plan },
        // Same ticket re-submitted (a retry, a webhook replay) must not drift
        // across a threshold and produce a different priority.
        { cache: "30m", timeoutMs: 3_000 },
      )
    } catch (error) {
      // Support does not stop because a model is unavailable. Degrade to the
      // rules we had before, and say so in the record.
      if (error instanceof SemanticError || error instanceof LowConfidenceError) {
        this.#log.warn("triage.degraded", { reason: String(error) })
        return this.fallback(ticket, plan)
      }
      throw error
    }

    const priority: Priority =
      t.blocksRevenue && plan !== "free"
        ? "critical"
        : t.urgency >= 80 || t.frustration >= 90
          ? "high"
          : t.urgency >= 40
            ? "normal"
            : "low"

    const actions: string[] = []
    if (priority === "critical") actions.push("page-oncall")
    if (t.churnSignal) actions.push("notify-csm")
    if (t.department === "security") actions.push("alert-security")

    return { priority, queue: t.department, actions, graded: true }
  }

  /** No model, no judgement: keyword rules and the plan. Deliberately blunt. */
  private fallback(ticket: Ticket, plan: string): TriageResult {
    const text = `${ticket.subject} ${ticket.body}`.toLowerCase()
    const looksUrgent = /\b(down|outage|failing|urgent|broken)\b/.test(text)
    return {
      priority: looksUrgent && plan === "enterprise" ? "high" : "normal",
      queue: "integration",
      actions: [],
      graded: false,
    }
  }

  /** Used by the autoresponder worker before it sends anything. */
  async canAutoReply(ticketId: string): Promise<boolean> {
    const ticket = await this.#db.tickets.find(ticketId)
    if (!ticket) return false
    if (ticket.priority === "critical") return false // never, regardless of judgement
    try {
      return await safeToAutoReply({ subject: ticket.subject, body: ticket.body })
    } catch {
      return false // when in doubt, a human answers
    }
  }
}
