/**
 * Compile-time checks: `npm test` typechecks this file, so a wrong result
 * type fails the build. The single runtime test only keeps node:test happy.
 *
 * The point is soundness. A result typed `boolean` that can be "unknown" at
 * runtime is worse than no type: "unknown" is truthy, so `if (x)` says yes.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  choose,
  defineRule,
  is,
  score,
  semantic,
  type DetailedChoice,
  type DetailedScore,
  type DetailedTruth,
  type IsOptions,
  type QuestionSpec,
  type Rule,
  type RuleDefinition,
} from "jevascript"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function expectType<A, B>(_: Equal<A, B>): void {}

type Resolved<P> = P extends Promise<infer V> ? V : never

// The calls are never awaited at runtime; only their types are inspected.
const s = semantic("t")
const dynamic: IsOptions = {}
const definition: RuleDefinition = { name: "r", condition: "c" }
declare const lazy: <T>() => T

function check(): void {
  expectType<Resolved<ReturnType<typeof s.is<{}>>>, boolean>(true)
  const plain = lazy<ReturnType<typeof s.is<{ threshold: 0.7 }>>>()
  expectType<Resolved<typeof plain>, boolean>(true)
  const unknown = lazy<ReturnType<typeof s.is<{ allowUnknown: true }>>>()
  expectType<Resolved<typeof unknown>, boolean | "unknown">(true)
  const both = lazy<ReturnType<typeof s.is<{ allowUnknown: true; detailed: true }>>>()
  expectType<Resolved<typeof both>, DetailedTruth<boolean | "unknown">>(true)
  const dyn = lazy<ReturnType<typeof s.is<typeof dynamic>>>()
  expectType<Resolved<typeof dyn>, boolean | "unknown" | DetailedTruth<boolean | "unknown">>(true)

  expectType<typeof numberSpec, QuestionSpec<number>>(true)
  expectType<typeof detailSpec, QuestionSpec<DetailedScore>>(true)
  expectType<typeof unknownSpec, QuestionSpec<boolean | "unknown">>(true)
  expectType<typeof chooseSpec, QuestionSpec<"a" | "b">>(true)
  expectType<typeof chooseDetail, QuestionSpec<DetailedChoice<"a" | "b">>>(true)

  expectType<typeof rulePlain, Rule<boolean>>(true)
  expectType<typeof ruleUnknown, Rule<boolean | "unknown">>(true)
  expectType<typeof ruleDynamic, Rule<boolean | "unknown">>(true)
}

const numberSpec = score("x", { range: [0, 10] })
const detailSpec = score("x", { detailed: true })
const unknownSpec = is("x", { allowUnknown: true })
const chooseSpec = choose(["a", "b"], { instructions: "d" })
const chooseDetail = choose({ a: "A", b: "B" }, { detailed: true })
const rulePlain = defineRule({ name: "r", condition: "c", defaults: { threshold: 0.7 } })
const ruleUnknown = defineRule({ name: "r", condition: "c", defaults: { allowUnknown: true } })
const ruleDynamic = defineRule(definition)

describe("result types", () => {
  it("are checked at compile time", () => {
    assert.equal(typeof check, "function")
  })
})
