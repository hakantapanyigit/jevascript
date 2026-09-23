import { SemanticContext } from "./context.ts"
import { globalRuntime, type Runtime } from "./config.ts"
import type { State } from "./types.ts"

/** Separate module so `define.ts` can build contexts without importing `index.ts`. */
export function semanticContext(state: State, runtime: Runtime = globalRuntime): SemanticContext {
  return new SemanticContext(state, runtime)
}
