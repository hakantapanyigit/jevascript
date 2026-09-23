import type { SemanticAnswer } from "./types.ts"

export interface SemanticCache {
  get(key: string): Promise<SemanticAnswer | undefined> | SemanticAnswer | undefined
  set(key: string, value: SemanticAnswer, ttlMs: number): Promise<void> | void
}

/** Parses "5m", "1h", "30s", "250ms", or a raw millisecond number. */
export function parseTtl(ttl: string | number): number {
  if (typeof ttl === "number") return ttl
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(ttl.trim())
  if (!match) throw new Error(`Invalid cache ttl: ${JSON.stringify(ttl)}. Use e.g. "5m", "1h", "250ms".`)
  const value = Number(match[1])
  const unit = match[2] as "ms" | "s" | "m" | "h" | "d"
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
  return value * scale
}

/** FNV-1a, 128-bit-ish via two independent lanes. Adequate for cache keys. */
export function hashKey(input: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0
  }
  return a.toString(36) + b.toString(36)
}

interface Entry {
  value: SemanticAnswer
  expiresAt: number
}

export class MemoryCache implements SemanticCache {
  #entries = new Map<string, Entry>()

  constructor(private readonly maxEntries = 5_000) {}

  get(key: string): SemanticAnswer | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    // Refresh recency for the LRU eviction below.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: SemanticAnswer, ttlMs: number): void {
    if (ttlMs <= 0) return
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.#entries.clear()
  }
}
