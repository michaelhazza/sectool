---
name: performance
description: Use when investigating or preventing a slow endpoint, query, or page — N+1 patterns, indexing for speed, caching, pagination cost, payload size, bundle size, or memory growth. Measure before optimizing; every change names its metric and baseline.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## performance` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Performance

Optimisation without a measurement is a guess that costs complexity either way. Name the metric, capture the baseline, change one thing, re-measure.

## Measure first

- Before any optimisation: name the metric (p95 latency, query time, bundle KB, RSS) and record the baseline. A change that can't show its before/after numbers is refactoring, not optimisation.
- Pick the measurement from the symptom, don't profile everything: first load slow → TTFB decomposition (DNS/TLS/server) + LCP; interaction slow → INP + long tasks; post-navigation slow → route-level code and data fetch; backend slow → endpoint p95 + query plan.
- Load-test the p95, not the mean — the mean hides the tail that users actually feel, and cache-warm dev runs measure nothing.
- Profile before attributing: the slow layer is routinely not the suspected one (serialisation and N+1 fan-out outrank the "slow query" more often than not).
- Never report a number that wasn't measured: an unmeasured scorecard cell says "not measured", estimated impact is labelled "potential", and lab (synthetic) vs field (real-user) numbers are never interchanged — treating one as the other is fabrication.
- Performance budgets belong in CI (bundle-size gate, endpoint-p95 gate) — a budget that isn't gated regresses silently.

## Database

- N+1 detection: any per-row `await` inside a loop over query results is the signature — batch into one `IN (...)` query or a join, then map in memory. Works in dev at 10 rows, degrades linearly in production.
- Index the predicate you actually query: the index must match the WHERE + ORDER BY shape (composite in filter-then-sort order; partial index when the hot query always carries the same status predicate). An index on the column alone doesn't serve `WHERE status = 'x' ORDER BY created_at` — verify with EXPLAIN, not intuition.
- Every list query carries LIMIT or pagination at write time — an unbounded list query is correct at ten rows and a timeout at a hundred thousand; bounding is write-time discipline, not a later optimisation.
- LIMIT + keyset pagination over OFFSET at depth — OFFSET N scans and discards N rows, so page 1000 costs 1000 pages; keyset cursors are constant-cost (tiebreaker and cursor-correctness rules: see the db-concurrency skill).
- Push filters, sorts, and aggregates into SQL before LIMIT — fetching wide then filtering in application code pays transfer and memory for rows you discard.

## Caching

- Every cache names its invalidation owner and its TTL rationale — "cache it" without "who evicts it, when, and why that TTL" is a staleness bug scheduled for later. Process-local negative caches in multi-instance runtimes silently drop work: see the db-concurrency skill.
- Cache keys carry every input that changes the value (tenant, locale, version) — an under-keyed cache serves one tenant's data to another.
- Measure the hit rate after shipping — a cache with a low hit rate is pure complexity; remove it.

## Payloads and memory

- SELECT the columns you use; project at the boundary — `SELECT *` on wide tables (JSONB blobs, text columns) pays parse and transfer cost for every consumer that wanted three fields.
- Trim response payloads to what the client renders; list endpoints return list-shaped projections, not full detail rows.
- Memory growth: unbounded in-process maps/arrays keyed on request-derived values are leaks by construction — cap with LRU or move to a shared store; re-check after long-soak, not one request.

## Client and bundle

- Client-facing surfaces carry named Core Web Vitals budgets: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 — budget numbers to gate against, not aspirations.
- Lazy-load routes and heavy components; the initial bundle carries only the first screen's code.
- Watch dependency weight at add time — one convenience import of a moment/lodash-class library outweighs months of micro-optimisation; prefer platform APIs or per-function imports.
- Per-row fetch fan-out in the UI is the client-side N+1: one batched fetch + client-side join (render-storm specifics: see the frontend-correctness skill).

## Hot paths

- Expensive or slow work (report generation, email sends, external-API fan-out, bulk writes) runs as a background job on the queue/scheduler, never inside an HTTP request handler — inline it and the client holds a connection for the duration, retries double the work, and one slow dependency stalls the request pool.
- No per-call dynamic `import()` in request paths — module resolution cost on every call; hoist to module scope.
- No synchronous filesystem or crypto calls in request handlers — one sync call serialises the whole event loop under load.
- Locks and contention on hot write paths (never hold locks across slow I/O, SKIP LOCKED claim shapes): see the db-concurrency skill.
