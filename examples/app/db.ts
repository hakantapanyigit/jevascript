/** Stand-in for whatever you actually use. Nothing here is interesting. */
export interface Ticket {
  customerId: string
  subject: string
  body: string
}

export interface TicketRecord extends Ticket {
  id: string
  priority: string
  queue: string
  slaMinutes: number | null
  gradedBy: string
  createdAt: string
}

export interface Db {
  customers: { find(id: string): Promise<{ id: string; plan: string } | undefined> }
  tickets: {
    insert(record: Omit<TicketRecord, "id">): Promise<TicketRecord>
    find(id: string): Promise<TicketRecord | undefined>
  }
  jobs: { enqueue(name: string, payload: Record<string, unknown>): Promise<void> }
}

export function createMemoryDb(
  customers: Record<string, { id: string; plan: string }>,
  jobs: { name: string; payload: Record<string, unknown> }[] = [],
): Db & { jobs_: typeof jobs } {
  const tickets = new Map<string, TicketRecord>()
  let counter = 0
  return {
    jobs_: jobs,
    customers: { async find(id) { return customers[id] } },
    tickets: {
      async insert(record) {
        const full = { ...record, id: `T-${++counter}` }
        tickets.set(full.id, full)
        return full
      },
      async find(id) { return tickets.get(id) },
    },
    jobs: { async enqueue(name, payload) { jobs.push({ name, payload }) } },
  }
}
