/**
 * The one place the runtime is configured. Every other module imports `semantic`
 * from here instead of from the package — the same shape as a `db.ts` module.
 *
 * Code written against the module-level `semantic` works unchanged: only the
 * import line differs.
 *
 * Nothing here touches the global `semantic`; this is a private instance with
 * its own provider, cache and metrics hook.
 */
import { createSemantic, jev } from "jevascript"

export const semantic = createSemantic({
  provider: jev(), // JEV_API_KEY, and optionally JEV_MODEL / JEV_BASE_URL, from the environment
  defaults: { timeoutMs: 5_000 },
  observability: {
    onEvaluation(event) {
      // Straight into whatever you already use for metrics.
      console.log(
        `  metric semantic.eval  name=${event.metric?.name ?? "-"}@${event.metric?.version ?? "-"} ` +
          `fields=${event.questionCount} requests=${event.requestCount} ` +
          `ms=${event.latencyMs} tokens=${event.usage?.inputTokens ?? 0} cached=${event.cached}`,
      )
    },
  },
})
