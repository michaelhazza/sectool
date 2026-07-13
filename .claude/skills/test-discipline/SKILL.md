---
name: test-discipline
description: Use when writing or modifying tests, mocks, fixtures, or acceptance criteria; when a test passes suspiciously easily; after reordering calls in code under test; or when deciding what KIND of test a requirement needs (pure unit vs DB-integration vs gate).
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## test-discipline` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Test discipline

Rules for tests that actually prove something, distilled from post-mortems of tests that passed while the feature was broken.

## Tests that prove nothing (audit for these)

- Assertions only inside a loop or `if` over possibly-empty data pass vacuously. Every test has at least one assertion that runs unconditionally. `if (cond) return;` at the top of a test reports PASSED with zero assertions — use the runner's skip API (`ctx.skip()`).
- Never re-implement production logic inline in a test — a re-implemented classifier tests a copy, not the code. Assert semantic contracts (WHERE predicates, call args, one row at the durable layer), never source text or internal call sequences; deliberately verify the test fails pre-fix; canonicalise nondeterministic output before comparing.
- For bug-fix repro tests, have a fresh-context subagent write the failing repro WITHOUT knowledge of the fix — a test written by the fix's author can be unconsciously shaped to pass the fix rather than to reproduce the bug.
- Verify every `vi.mock` path exactly matches the production import specifier — a mismatched relative path silently never intercepts and the suite goes false-green. A `vi.fn()` spy never wired to the mocked module can never fail; mocking both sides of a seam lets the mock supply a field the real path never populates.
- `vi.unmock` after import is a no-op — mock declarations hoist above imports and the system-under-test binds to the mocked dependency. Split integration tests into a file with no top-level mock (or isolate modules and re-import everything), and sanity-assert the rewire happened (`dynamicImport.fn !== topLevelImport.fn`).
- Integration tests touching FORCE-RLS tables must set the tenant GUC first, or writes affect 0 rows and the assertions never fire.
- When a later change tightens a contract an earlier-authored test file exercises, re-run that file; at integration, run ALL branch-authored test files — per-chunk targeted runs plus a curated subset ship red tests.
- A green test on a pure helper the production path never calls is a dead test — for "invariant holds at read time" requirements, conformance means every production read site routes through the canonical filter.
- Tests that mock the consequence rather than the implementation survive contract changes they should catch: assert the path taken (which dependencies were called, in what order), not just one side effect on a pre-mocked surface.
- Positional mocks (`mockResolvedValueOnce` at index N) silently break when a refactor reorders calls — failure-path tests go false-green because the injected rejection hits a different call. After any reorder, grep tests for positional mocks and re-wire.
- A test file outside the runner's include globs provides zero coverage regardless of content; check globs before treating a test-shaped file as active (or deleting it as unused). Judge/rubric threshold-scale agreement (prompt scale = threshold constant = clamp): see the llm-integration skill.

## Match the test to the failure mode

- Pure-function/service-mocked tests can never catch: DB CHECK-constraint violations, RLS/session-variable behaviour, ON-CONFLICT arbiter matching, or transaction-abort semantics. When a write path touches a table whose migrations define cross-column constraints, grep the migrations first and pin a real-DB integration test.
- Separate pure computation from I/O: the pure function takes a fully-enumerated input struct (caller-supplied timestamps, no clock/DB) and returns deterministic output; a thin coordinator does the reads/writes. This is what makes logic testable without a DB — and identifies exactly what ISN'T covered.
- When a refactor moves observable side effects into storage-layer arithmetic (e.g. behaviour driven by absence from an `ON CONFLICT ... RETURNING` set), pure tests can no longer prove equivalence — the conflict arbiter is the real unique index; use a fixture-DB test.
- External-provider payload shapes need a captured real-delivery fixture committed to the repo and a test reading the pinned path from it — documentation-faith fails silently (`undefined` passes idempotency checks against itself).
- Extending a widely-used shared helper: strictly additive (new options optional, defaults reproduce current behaviour), pinned by a frozen snapshot of the pre-change implementation as a fixture asserting observable equivalence — deliberate divergence then surfaces in review as a fixture edit.
- Not every path needs the same coverage shape: structural invariants suit cheap static gates, propagation logic suits unit tests, security context suits integration tests. Choose by failure mode, not habit.

## Fixtures and determinism

- Interleaved/out-of-order fixtures catch ordering bugs that in-order fixtures never fire (audit SQL time-window joins, reconciliation order). Fixtures always write in-order by default — that's the blind spot.
- Cross-source parity (a catalogue vs the schema consumers actually see): a ~20-line test iterating one side asserting membership in the other, both directions, is the cheapest drift gate there is.
- Discriminated-union validators: every variant branch calls a variant-specific validator (envelope-only validation silently accepts malformed variants), and unknown discriminant values are rejected explicitly — TS unions protect in-process callers only.
- Regression tests for retired/disabled behaviour: pin the retirement with a test asserting the typed "retired" failure, so accidental re-enablement fails loudly.
- CLI-entry guards on modules exporting both testable functions and a top-level entrypoint (Node ESM: compare `import.meta.url` to `process.argv[1]`) — otherwise importing from a test executes main() with side effects.
- Idempotency-sensitive closures (`release()`, `close()`) get a call-twice test.
- Fixtures for config-driven gates use the VERBATIM shipped config string — a convenient simplification that works in both of two diverged code paths proves nothing about what ships.
- Type fixture-builder params against the production contract, not `ReturnType<typeof helper>` — the helper's literal-inferred shape freezes defaults, so the first fixture needing a non-default value fails typecheck far from the cause.
- Purity is an import-graph property, not a runtime-call property: a "pure, no-IO" test importing a constant from an IO-initialising barrel drags connector init into the chain — extract the symbol to a zero-import leaf module, and hoist mocks of IO-bearing services BEFORE importing the router. Circular module loads don't throw; they silently yield `undefined` exports.
- Intercept seams inside long functions via optional injected params defaulting to the live implementation (`?? liveDefault`) — existing callers stay byte-identical; tests inject fakes through the params instead of modifying the seam module.
- `@ts-expect-error` applies to the immediately following line, not the property the assertion is "about" — read the next non-comment line to confirm what it covers. Related tell: excess object-literal properties on a generically-typed array suppress contextual typing, so a wrong field name surfaces as a confusing implicit-any on the callback param.

## Acceptance criteria (spec-side)

- Write goals as verifiable assertions before starting: "add validation" becomes "these invalid inputs return 400". Prefer assertions checkable by deterministic tooling over human judgment.
- Numeric performance targets separate a wide runaway ceiling from the tight binding gate, and binding budgets derive from measured runs, never projections.
- Every "budget may be exceeded when Y" carve-out pairs with a required evidence artifact — an exception invocable without evidence is budget creep.
- Check every commissioned test against the declared testing posture (e.g. pure-function-primary + CI-only static gates): integration/E2E/component plans, local runs of CI-only gates, and "pure" tests writing the real filesystem are spec defects, not extra rigor. "Optional" tests of forbidden categories are still violations; restate the policy verbatim, never paraphrased.
- Don't mandate tests the posture cannot express: DB behaviours (trigger rollback, RLS no-leak, unique-constraint arbitration) need a DB-level harness or an explicit carve-out; TSX components need extracted pure helpers first. Every promised test names its pure helper plus the file it lives in.
