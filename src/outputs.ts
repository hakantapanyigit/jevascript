import type { ChoiceOptionSpec, JsonValue } from "./types.ts"

export interface BooleanOutput {
  readonly kind: "boolean"
  readonly describe?: string
  readonly trueWhen?: string | JsonValue
  readonly falseWhen?: string | JsonValue
}

export interface NumberOutput {
  readonly kind: "number"
  readonly min: number
  readonly max: number
  readonly describe?: string
  readonly levels?: readonly string[]
}

export interface EnumOutput<T extends string = string> {
  readonly kind: "enum"
  readonly options: Readonly<Record<T, string | ChoiceOptionSpec>>
  readonly describe?: string
}

export interface ObjectOutput<F extends Record<string, AnyOutput> = Record<string, AnyOutput>> {
  readonly kind: "object"
  readonly fields: F
}

export type AnyOutput = BooleanOutput | NumberOutput | EnumOutput | ObjectOutput

export type OutputValue<O> = O extends BooleanOutput
  ? boolean
  : O extends NumberOutput
    ? number
    : O extends EnumOutput<infer T>
      ? T
      : O extends ObjectOutput<infer F>
        ? { [K in keyof F]: OutputValue<F[K]> }
        : never

export function boolean(options: Omit<BooleanOutput, "kind"> = {}): BooleanOutput {
  return { kind: "boolean", ...options }
}

export function number(options: { min?: number; max?: number; describe?: string; levels?: readonly string[] } = {}): NumberOutput {
  // Spread first: an explicit `min: undefined` must not overwrite the default.
  return { ...options, kind: "number", min: options.min ?? 0, max: options.max ?? 100 }
}

export function enumOf<const T extends readonly string[]>(options: T, describe?: string): EnumOutput<T[number]>
export function enumOf<const T extends Readonly<Record<string, string | ChoiceOptionSpec>>>(
  options: T,
  describe?: string,
): EnumOutput<keyof T & string>
export function enumOf(options: readonly string[] | Readonly<Record<string, string | ChoiceOptionSpec>>, describe?: string): EnumOutput {
  const map: Record<string, string | ChoiceOptionSpec> = Array.isArray(options)
    ? Object.fromEntries((options as readonly string[]).map((key) => [key, key]))
    : { ...(options as Record<string, string | ChoiceOptionSpec>) }
  return { kind: "enum", options: map, ...(describe !== undefined ? { describe } : {}) }
}

export function object<const F extends Record<string, AnyOutput>>(fields: F): ObjectOutput<F> {
  return { kind: "object", fields }
}

/** Output-shaped score, as distinct from the question-shaped `score(criterion)`. */
export function numberRange(min = 0, max = 100, describe?: string): NumberOutput {
  return { kind: "number", min, max, ...(describe !== undefined ? { describe } : {}) }
}
