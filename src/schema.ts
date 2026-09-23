import { evaluateWith } from "./evaluate.ts"
import { globalRuntime, type Runtime } from "./config.ts"
import type { AnyOutput, OutputValue } from "./outputs.ts"
import type { SemanticProvider, State } from "./types.ts"

export interface SchemaDefinition<O extends AnyOutput> {
  name: string
  /** Bump when the wording changes, so old results stay interpretable. */
  version?: string
  /**
   * Domain context applied to every field of the schema.
   *
   * This is the closest thing to a system prompt, but it is not one: it is not
   * an instruction the model obeys, it is the frame each question is asked in.
   * Say what the data is and what the words mean in your business. Do not say
   * how to behave — there is no behaviour to steer.
   */
  instructions: string
  /**
   * Background merged into the state on every call — a policy, a price list, a
   * tier definition. Kept separate from the input so the two never blur.
   */
  context?: Record<string, unknown>
  output: O
  defaults?: {
    timeoutMs?: number
    cache?: string | number
    samples?: number
  }
}

export interface SchemaOptions {
  provider?: SemanticProvider
  timeoutMs?: number
  cache?: string | number
  samples?: number
}

export interface Evaluator<O extends AnyOutput> {
  (data: State, options?: SchemaOptions): Promise<OutputValue<O>>
  readonly name: string
  readonly version: string | undefined
  readonly definition: SchemaDefinition<O>
}

/**
 * A reusable evaluator: instructions, background and output shape declared
 * once, then applied to data.
 *
 * Every field resolves in a single request, however many there are.
 */
export function defineSchema<const O extends AnyOutput>(definition: SchemaDefinition<O>): Evaluator<O> {
  return defineSchemaWith(globalRuntime, definition)
}

export function defineSchemaWith<const O extends AnyOutput>(runtime: Runtime, definition: SchemaDefinition<O>): Evaluator<O> {
  const call = (data: State, options: SchemaOptions = {}): Promise<OutputValue<O>> =>
    evaluateWith(runtime, {
      data,
      question: definition.instructions,
      // Background stays in its own labelled field rather than merged, so input
      // can never quietly overwrite the policy it is being judged against.
      ...(definition.context ? { context: definition.context } : {}),
      output: definition.output,
      ...definition.defaults,
      ...options,
      metric: { name: definition.name, ...(definition.version ? { version: definition.version } : {}) },
    })

  const evaluator = call as Evaluator<O>
  Object.defineProperty(evaluator, "name", { value: definition.name, configurable: true })
  Object.defineProperty(evaluator, "version", { value: definition.version, configurable: true })
  Object.defineProperty(evaluator, "definition", { value: definition, configurable: true })
  return evaluator
}
