---
name: fail-loud
description: Use when writing error handling — catch blocks, fallbacks, defaults for failed lookups, fire-and-forget calls, external-provider failures, safety/permission checks, or anything that could report success without the underlying operation durably happening. Also use when deciding 4xx vs 5xx, retry vs dead-letter, or what a "cannot verify" outcome should do.
---

# Fail loud, fail closed

Silent failure is the defect class reviewers catch most often after tenant isolation: no-ops reported as success, errors flattened to empty results, fallbacks that quietly bypass safety checks.

## The prime directive

A caller must never observe success when the operation didn't durably happen. No success signal on a failed emit; no 202 "submitted" when the enqueue was caught-and-logged; no webhook ack without a terminal outcome row; no "completed" ledger slot for an unimplemented handler (it suppresses the real path downstream). The React-side shapes of this rule (toast on a false success flag, adapters swallowing errors, permission gating): see the frontend-correctness skill.

## Fail-closed defaults

- Any pre-action safety lookup (suppression list, blocklist, permission, compliance state) fails CLOSED: `.catch(() => false)` on a gate converts lookup errors into bypasses. The declared default of a policy flag IS the semantics of the failure path — for authz/compliance, default to the blocking side. Scrutinise every mechanical `let x = false` near a gate. Never wrap a security assertion in `if (field) { verify(field) }` — assert presence first; compare against positive allowlists (allowlist the safe environment, never blocklist production); cover EVERY entry/exit path — early returns, second submit paths, alternate dispatch routes.
- Masking/redaction failure blocks the outbound call; a rate limiter whose store is down never returns acquired; gates never default a missing report to pass. Unknown/null enum states map to a conservative branch, never the permissive default.
- Boolean env parsers return false when unset, so a kill switch that defaults ACTIVE needs explicit unset-means-true semantics. When a mode flag's "on" values depend on another env var, assert the pair at startup — hard-fail in production. Fail-closed cross-field boot guards read raw `process.env`, never the schema-parsed value: a schema `.default()` makes an unset var look explicitly set and the guard fails OPEN.
- Terminal-state success columns are facts about the past — a revoked connection still carries `lastSuccessfulAt` — so health/completion predicates require current-active-status AND the success marker, through ONE exported helper shared by every consumer, or the trigger path drifts from the display path.
- Never let one value carry two semantics (`'0'` as both no-capacity and route-to-review; `'off'` persisted as both string and null): one semantic per value — null for unset, explicit enum members for modes; unavailability is computed effective state with a reason, never a mutation of stored preference rows.
- "Inconclusive" verification outcomes are treated as "fail" in rollback/suspension logic — a change whose safety cannot be confirmed is operationally a broken change; infrastructure outages don't grant immunity.
- When a stricter resolution path returns null meaning "deny", never fall back to the legacy permissive path on that null — gate the fallback on whether the new path was applicable at all. Client-side permission gating during async load: see the frontend-correctness skill.
- Ownership lookups distinguish three states — owner (owned) / null (unowned, no boundary) / undefined (not found or cross-tenant) — and the distinction survives every layer. `undefined ?? null` at any layer turns "lookup failed" into "no privacy boundary".

## Boundary validation and coercion traps

- LLM/model-generated structured output gets a runtime schema parse before persistence — TS unions are erased at JSON boundaries. Write routes enforce reject-mode validation: warn-mode middleware passes malformed bodies into handlers that cast with `as z.infer<...>`.
- Cap every sweep query (LIMIT), polling loop (max attempts plus an explicit gave-up state), self-re-enqueueing job, pagination chain, and retry loop; fetch N+1 to detect overflow. Route malformed required inputs to an explicit reject/review path, never a neutral default.
- ORM `.set({field: undefined})` omits the column entirely — clearing requires explicit null, and `value ?? undefined` collapses intentional unassigns. `obj?.field !== 'x'` is true when obj is null, silently passing presence checks. Never `!` on genuinely nullable DB values; never collapse tri-state loading/true/false to boolean before gating.
- A 0-row optimistic UPDATE has multiple causes — distinguish not-found from already-in-target-state from expired; they map to different responses.

## Catch blocks

- No empty catches. Never `.catch(() => {})`. Every fire-and-forget promise gets `.catch()` with a logged warning naming caller and callee — even when the callee "never throws" today; one unhandled rejection can kill a long-lived worker.
- Fire-and-forget is acceptable only for non-critical observability. Producers on critical paths (user submissions, paid jobs) throw on failure and rethrow enqueue errors. Re-throw retryables so the transaction rolls back and the queue retries; every external-call failure path (401 on a cached token, 429) gets an explicit recovery contract.
- Split failure domains exactly at the external call's resolution: one catch wrapping both the provider call AND the post-success bookkeeping write reports a successful send as failure and invites double-send retries. Provider error → finalise failed; bookkeeping error after success → log loudly, return success, keep the durable "attempted" row as the honest indeterminate state.
- A helper that deliberately swallows its own error RETURNS a result (`{committed}`), never void — await-without-return on a no-throw helper tells the caller nothing about durability; pair with a bounded inline retry plus an out-of-band sweep backstop. Client API adapters swallowing errors into empty results: see the frontend-correctness skill.
- A runtime branch covering a case the system's invariants make impossible throws a typed, greppable error — returning silent false says "recoverable" when the truth is "invalid configuration that was promised impossible".
- Partially-wired features: replace the unsafe method body with a runtime throw carrying a typed reason and tracking pointer — never leave a half-implementation an accidental caller could execute.

## Error translation and status codes

- The 4xx/5xx split is a retry-semantics contract, not cosmetics. Validate typed fields (UUID, enum, int) at the route/parser surface where the structured 400 exists — pushing validation to a storage-layer cast converts caller errors into opaque 500s (a raw `::uuid` cast 500s malformed IDs; `.max()` on every numeric/array/string — min alone lets a hostile client go unbounded; clamp `parseInt`, which truncates `'60abc'` to 60; `Number.isFinite` + range on env numerics). Throwing-parse inside an async wrapper can bypass error-translation middleware entirely (500 + page instead of 400): use non-throwing validation and raise the shape your error-normalisation layer recognises. Check the middleware's forwarded-field whitelist before throwing errors with custom fields.
- Map every SDK/internal error — including the catch-all — to a closed contract enum at the SERVICE boundary (one canonical mapper, fail-closed on unknown); routes translate via an exhaustive switch with `default: throw`. Map `instanceof` domain errors before the generic catch-all; never coerce missing status (`status || 500`) before mapping; classify custom error types explicitly in retry logic — security violations are non-retryable, never the retryable default. Drizzle wraps pg errors (`'Failed query: ...'`) with the real code on `err.cause` — check both levels.
- Typed-exception cleanup needs typed-throw discipline at every internal failure site: a catch dispatching cleanup on `instanceof TypedError` silently skips cleanup for raw driver/network errors — wrap every internal call whose failure must trigger the cleanup so it rethrows the typed class; audit the throw sites, not just the catch's coverage.
- Sentinel errors used as internal control flow by shared primitives are caught and translated at the immediate call site; a test asserts the sentinel never escapes into the public return shape.
- On endpoints with replace/PATCH semantics, REJECT (403) unprivileged requests containing privileged-only fields — silent stripping lets a partial update erase privileged state while returning 200. Validation schemas for such endpoints use strict/unknown-key-rejecting mode.

## Observability of failure

- Trust the structured category field the error's owner set; substring-matching on messages misclassifies on the first rewording. General logging/metrics discipline (structured logger shape, correlation IDs, log levels, lifecycle choke-point logging, paired events): see the logging-observability skill.
- Never silently truncate inputs to embeddings/summaries/search: every cap is an exported named constant and every truncation emits a structured warning with sizes.
- Durable audit rows are written in-transaction with the state change; post-commit best-effort events are supplementary. Privileged mutations an operator could dispute get an append-only audit row. Audit rows claim what actually RAN: distinguish a flag-gated admission path from a legacy fallthrough with a runtime admission-passed boolean — deriving the audit decision from static config records approvals that never happened.
- A fixed failure-summary constant concatenated with variable detail must be true for EVERY branch that can fire it — a multi-branch check with a single-branch summary persists findings naming the wrong cause; make the lead cause-neutral or split one probe per sub-assertion.
- Emitters writing into durable or user-visible storage persist closed enums + counts, never verbatim upstream-derived strings — the producer's content hygiene is not the consumer's guarantee; lock with a `not.toContain(rawText)` regression test.
- Drift detectors on operator-visible state hash a NORMALISED representation (filter cosmetic mutations) and act only after ≥2 consecutive mismatched checks — single-check raw-content detectors false-positive on transformation layers and erode trust.
