# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] — 2026-09-23

A correctness release. Several options did not mean what they said, and some of those
failures pointed the unsafe way: an uncertain answer could read as "yes". Every fix below
has a regression test.

### Upgrade notes

Most code upgrades without changes. Three things can surface:

- **Types are stricter where they were wrong.** Result types now follow the options.
  `is("…", { allowUnknown: true })` is typed `boolean | "unknown"`, and `detailed: true`
  is typed as the detailed object. If you pass an options *variable* typed `IsOptions`,
  the result is the union of every shape it could be — narrow it, or pass the options
  inline.
- **A 10-second timeout now applies by default.** It was documented but never enforced.
  Set `defaults.timeoutMs` (or the call's `timeoutMs`) to change it, `0` for none.
- **Cache keys have changed.** Existing entries in a custom `cacheStore` miss once and
  are then rewritten.

### Fixed

- `batch({ x: is("…", { allowUnknown: true }) })` and a `defineRule` with
  `defaults: { allowUnknown: true }` returned `"unknown"` while typed `boolean`. Since
  `"unknown"` is truthy, `if (x)` treated an uncertain answer as true.
- `batch()` ignored `minConfidence`, `fallback` and `detailed`: it paid for the samples,
  then never applied the gate. A question now resolves identically in `batch()` and on
  its own.
- `defaults.minConfidence` made every `is()` and probability-backed `score()` throw
  `LowConfidenceError`, because only a per-call `minConfidence` triggered sampling.
- A cached answer dropped its measured confidence, so any repeat call with
  `minConfidence` threw.
- Cache keys walked `Date`, `Map` and `Set` as empty objects, so states differing only by
  a date shared one cached answer. Keys now follow JSON semantics exactly and are SHA-256
  (previously a 64-bit non-cryptographic hash).
- Each retry got a fresh timeout, so `timeoutMs: 5000` could take 15 s or more. Timeouts
  and caller aborts were retried as well. One deadline now covers the whole call and
  neither is retried. A `Retry-After` longer than the remaining deadline (or 30 s) fails
  immediately instead of sleeping.
- `evaluate()` gave the fields `a__b` and `a.b` the same key, so one answered for both.
- `number({ min: undefined })` produced `NaN` bounds.
- A rubric score took its width from the answer's `probabilities`, so a provider that
  omitted them collapsed every score to the bottom of the range.
- `DetailedScore.level` was documented as 1-indexed; it is 0-indexed.
- The Jev adapter accepted any `choice` string and any number as a probability. A choice
  outside the options, a probability outside [0, 1], a rubric position off the rubric, an
  answer of the wrong kind, or a non-JSON body are now `ProviderError`s.
- `some()` and `every()` always spent N requests. They now stop when the answer is decided.
- A failed request in `filter`/`some`/`every`/`rank` let the other workers keep sending.
  No new requests start after a failure.
- `compare()` ignored `cache`.
- Collection events reported `cached: false`, no `usage`, and a `requestCount` that
  ignored cache hits.
- Reading configuration crashed on runtimes without `process` (edge workers).
- `src/` used TypeScript parameter properties, which Node's type stripping rejects.

### Added

- `SemanticTimeoutError` (a `ProviderError`, with `timeoutMs`).
- Result-type helpers: `IsResult`, `ScoreResult`, `ChooseResult`, `TruthValue`,
  `ChoiceKey`, and `RuleValue`, `RuleOptions`, `RuleDefaults`, `MetricOptions` for
  definitions.
- Provider errors carry the API's own message (`Unknown model: …`) instead of the raw
  body.
- `Retry-After` given as an HTTP date is honoured.
- `npm run test:live`: contract tests against the live API, reading `JEV_API_KEY` from
  `.env` when present, or from the environment. The offline suite grew from 53 to 89 tests
  and no longer touches the network.
- `repository`, `bugs` and `author` in `package.json`, so npm links back to the source.
- CI on Node 22 and 24, Dependabot, and a security policy (`SECURITY.md`).

### Changed

- Sample rounds run concurrently, so `samples: 3` costs three requests but no extra
  latency.
- `defineMetric` and `defineRule` no longer accept per-call `detailed`, or (for rules)
  `allowUnknown`: whether a rule can say "unknown" belongs to its definition, which keeps
  its return type honest.
- `JsonValue` accepts readonly arrays and objects.
- `tsconfig` enables `erasableSyntaxOnly`.

## [0.1.0] — 2026-09-23

Initial release: `is`, `score` and `choose` as ordinary values; request batching;
measured confidence; caching; `defineSchema`, `defineMetric`, `defineRule`; collections;
the Jev provider; and `jevascript/testing`.

[0.1.1]: https://github.com/hakantapanyigit/jevascript/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hakantapanyigit/jevascript/releases/tag/v0.1.0
