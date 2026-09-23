/**
 * An ordinary node:http server. Run it, curl it.
 *
 *   npm run example examples/app/server.ts
 *   curl -s localhost:8787/tickets -d '{"customerId":"c_1","subject":"...","body":"..."}'
 */
import { createServer } from "node:http"
import { createMemoryDb } from "./db.ts"
import { TicketService } from "./tickets.ts"

const db = createMemoryDb({
  c_1: { id: "c_1", plan: "enterprise" },
  c_2: { id: "c_2", plan: "free" },
})
const service = new TicketService(db, {
  info: (m, f) => console.log(`  info  ${m}`, f ?? ""),
  warn: (m, f) => console.warn(`  warn  ${m}`, f ?? ""),
})

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body, null, 2))
  }

  try {
    if (req.method === "POST" && req.url === "/tickets") {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const ticket = await service.intake(JSON.parse(Buffer.concat(chunks).toString()))
      return send(201, ticket)
    }

    if (req.method === "GET" && req.url?.startsWith("/tickets/") && req.url.endsWith("/can-auto-reply")) {
      const id = req.url.split("/")[2]!
      return send(200, { id, canAutoReply: await service.canAutoReply(id) })
    }

    send(404, { error: "not found" })
  } catch (error) {
    send(500, { error: String(error) })
  }
})

server.listen(8787, () => console.log("listening on :8787"))
