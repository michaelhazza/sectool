# Spec — audit-tool review-follow-up hardening (2026-07-10)

**Status:** accepted
**Spec date:** 2026-07-10
**Last updated:** 2026-07-10
**Author:** claude (fable) — from the 2026-07-10 fable diff-review, verified against shipped `main`
**Build slug:** review-followup-hardening

## Lifecycle Declaration

| Field | Value |
|---|---|
| Capability cluster | Live Scanning, Target Registry & Safety, Benchmark & Quality |
| Capability owner | michaelhazza |
| Lifecycle state on launch | Growth (hardening shipped, live capabilities) |
| Risk surface | Controlled live HTTP traffic to Breakout-owned staging hosts (allowlist-gated); CI artifacts containing security findings. |
| Review cadence | on-incident-only (small hardening batch) |

## ABCd Lifecycle Estimate

| Dimension | Sizing | Notes |
|---|---|---|
| Acquire | S | No external dependency; all changes are in-repo. |
| Build | S | Three localized changes + three tests; no new subsystem. |
| Carry | S | One eslint rule + one gitignore line + a redirect-policy branch — negligible upkeep. |
| decommission | S | Each item is independently revertable. |

---

## 1. Context and provenance

A retrospective adversarial review (2026-07-10, on the Phase-1 spec/scaffold
diff) surfaced 11 findings. Verification against shipped `main` (HEAD `294e77b`,
all gates green, 1091 unit tests passing) found **6 already resolved** in the
implementation, **2 cosmetic**, and **3 genuinely open**. This spec covers only
the 3 open items. The resolved/cosmetic items are recorded in §6 for the record;
they are **not** in scope.

The most important open item (HARD-1) is a residual gap in the **non-negotiable
staging-only safety contract**: the live-scan invariant "no network I/O to a
non-allowlisted host at scan time" is enforced at the CLI seed and in the
probes/scanners, but the authenticated-login pre-step follows HTTP redirects
without re-validating the destination host. This spec **strengthens** that
invariant; it does not weaken it. Never weaken the allowlist gate to satisfy a
test.

## 2. Goals

1. Close the off-host-redirect gap in the live-scan auth pre-step so the
   "no I/O to a non-allowlisted host" invariant holds for every live egress,
   not just the seed request and the probes/scanners (HARD-1).
2. Prevent accidental commit of sensitive scan output by gitignoring the
   report output directory (HARD-2).
3. Add a mechanical guard so the allowlist/target brand cannot be forged by an
   out-of-band `as`-cast outside the two authorized modules (HARD-3).

## 3. Non-goals

- No change to the allowlist gate semantics, the branded-type design, the
  scanner set, the report schema, or any resolved finding.
- No re-litigation of the six resolved findings (§6).
- The two cosmetic doc findings (§6) are out of scope; optionally fixed in the
  same PR as a trivial doc touch, but not required.
- No new capability; this is hardening of shipped capabilities.

## 4. Framing assumptions

- Shipped `main` is the baseline. Each item below cites current `file:line`.
- Testing posture is runtime-primary (per `docs/spec-context.md`): **every item
  ships with a test that fails before the fix and passes after**. This mirrors
  the repo's benchmark-first discipline.
- All targets are Breakout-owned staging hosts; HARD-1's exploitability is
  bounded (it requires an owned staging host's login endpoint to emit an
  off-host 3xx), but the invariant is non-negotiable and the fix is cheap.
- Mobile capability: N/A — pure backend/CLI + config, no UI surface.

## 5. Work items

### HARD-1 — Auth login pre-step must not follow off-host redirects (safety)

**Severity:** high (safety-contract surface) · **Cluster:** Live Scanning

**Current state (evidence).**
- `src/live/auth.ts:201-206` — `defaultHttpClient` calls
  `fetch(req.url, { method, headers, ...body })` with **no `redirect` option**,
  so undici's default `redirect: 'follow'` is in effect.
- `src/live/auth.ts:263-264` — `establishSession` builds
  `loginUrl = target.url + auth.loginPath` from an already-gated `AllowedTarget`
  (host is allowlisted) and a root-relative `auth.loginPath`
  (`RootRelativePathSchema`, `src/schemas/targets.ts`), then issues GET/POST via
  the injectable `httpClient`.
- The four passive probes already handle this correctly — they use Node core
  `http/https.request` (no auto-follow) and record an off-host redirect as
  `scopeExcluded` (`src/live/probes/headers.ts:210-223`). Auth is the lone live
  egress that still auto-follows.

**Failure it causes.** If an allowlisted staging host's login endpoint returns a
`3xx` with `Location:` pointing at a non-allowlisted host, `fetch` follows it and
issues the **credential-bearing** request to that off-host target — a runtime
violation of the "no I/O to a non-allowlisted host" invariant and a potential
credential leak. Confirmed still open on `main`; the 2026-07-02 audit closed the
URL-**concatenation** vector (`RootRelativePathSchema`) but not redirect-follow.

**Required change.**
1. In `defaultHttpClient` (`src/live/auth.ts:201-206`) set `redirect: 'manual'`
   on the `fetch` call so 3xx responses are returned to the caller instead of
   being transparently followed. Surface the `Location` header (already captured
   into `rawHeaders`) in the returned `HttpResponse` (add optional `location?`).
2. In `establishSession`, apply an explicit redirect policy after each GET/POST:
   on a `3xx` status, resolve `Location` against the current request URL; if the
   resolved **host differs from `target.hostname`**, do **not** follow — return
   `{ kind: 'failure', reason: 'scope-violation', message: ... }` naming the
   off-host target (never fetch it). A **same-host** redirect may be followed by
   re-issuing through `httpClient` to the resolved same-host URL, bounded by a
   small hop cap (max 5) to prevent loops.
3. Keep the policy in `establishSession` (where `target.hostname` is in scope),
   so the `httpClient` seam stays a thin transport and tests can inject 3xx
   responses.

**Acceptance test** (`src/live/auth.test.ts`): with an injected `httpClient`
that returns `302` + `Location: http://evil.example/` for the login GET (or
POST), assert (a) no request is ever issued to `evil.example` (the fake client
records the off-host URL was never requested), and (b) the result is
`kind: 'failure', reason: 'scope-violation'`. Add a companion test that a
**same-host** `302` (e.g. `/login` → `/login?step=2`) is followed and can still
succeed. Both must fail before the change and pass after.

**Safety-contract note.** This narrows egress; it cannot broaden it. The
existing §4.7 zero-request abort test and the seed-gate are unchanged.

### HARD-2 — Gitignore the report output directory

**Severity:** medium · **Cluster:** Target Registry & Safety / scaffold

**Current state (evidence).**
- Reports are written to `resolve(REPO_ROOT, 'reports')` →
  `<repo>/reports/<runId>/report.{json,md,sarif,html}`
  (`src/cli.ts:614,890-893`; `src/report/json.ts:197-205`).
- `.gitignore` (13 lines) has **no** `reports/` entry; there is no
  `reports/.gitignore` and none is written at runtime.
  `git check-ignore reports/report.json` → **not ignored**.

**Failure it causes.** A routine `git add -A && git commit` after a local
`audit run` commits detailed live/static vulnerability findings into git
history — contradicting the "reports are CI artifacts, not committed" guarantee
(the committed `history/trend.jsonl` is counts-only by design; the full reports
must stay out).

**Required change.** Add `reports/` to `.gitignore` (near
`node_modules/`/`coverage/`). Do not touch `history/` (intentionally committed).

**Acceptance test** (`benchmark/gitignore.test.ts` or in
`src/report/json.test.ts`): assert `reports/` is present in the repo `.gitignore`
and — where `git` is available — that `git check-ignore -q reports/report.json`
exits 0. Fails before, passes after.

### HARD-3 — Mechanical guard against out-of-band brand casts

**Severity:** medium (defense-in-depth) · **Cluster:** Target Registry & Safety

**Current state (evidence).**
- The `LoadedAllowlist` brand is minted only by the unexported `mintAllowlist`
  in `src/config/load.ts:23-31`, and `AllowedTarget` only by the unexported
  `mintAllowedTarget` in `src/live/gate.ts:9-18` — both via `as unknown as`.
  `assertAllowlisted(url, allowlist: LoadedAllowlist)` and the scanner wrappers
  accept only these branded types (compile-time gate — this part is RESOLVED).
- **Gap:** nothing fails if a future module writes
  `foo as unknown as LoadedAllowlist` / `... as AllowedTarget` to forge the
  brand outside the two authorized files. The CI "self-scan" runs the tool's own
  `BS-*` SAST rules (app-vuln classes), not brand provenance
  (`.github/workflows/ci.yml`). Test helpers legitimately mint the brand via
  cast (`src/live/gate.test.ts:8-14`), so a guard must exempt test files.

**Failure it causes.** The "allowlist is the sole authority" guarantee rests on
the brand being unforgeable; a stray cast in a new module would type-check and
bypass provenance with no signal in lint or CI.

**Required change.** Add an eslint `no-restricted-syntax` rule (flat config,
`eslint.config.js`) that flags a TS type-assertion (`TSAsExpression` /
`TSTypeAssertion`) whose asserted type is `AllowedTarget` or `LoadedAllowlist`,
with a message pointing at `load.ts`/`gate.ts` as the only mint sites. Scope it
via a `files`/`ignores` block that **exempts** `src/config/load.ts`,
`src/live/gate.ts`, and `**/*.test.ts` (test helpers). Keep it in the main
`eslint .` gate.

**Acceptance test** (`benchmark/brand-guard.test.ts`): a fixture snippet
containing `x as unknown as AllowedTarget` in a non-exempt path fails the rule
(assert via the ESLint `Linter` API), while the same cast inside
`src/live/gate.ts` and inside a `*.test.ts` passes. Fails before the rule is
added, passes after. Confirm `npm run lint` stays green on the current tree (the
two mint sites + existing test casts must remain clean).

## 6. Out of scope — resolved / cosmetic (record only)

**Resolved in shipped `main` (do not re-implement):**
- Fingerprint for osv/gitleaks — concrete deterministic keys (`osv.ts`,
  `gitleaks.ts`, `fingerprint.test.ts`).
- Rule `vulnClass`/`confidence` — every rule emits both.
- Rate-limit — Zod hard-reject (`targets.ts`, `min(1).max(25)`) + per-host token
  bucket (`src/live/ratelimit.ts`) + scanner rate flags.
- `RunReport` schema — `src/schemas/report.ts`, runtime-validated on ingest.
- Report ordering determinism — `sortFindings` ends in a `fingerprint` tiebreak
  (`src/report/json.ts`) → total order.
- eslint ignoring `.claude/` — moot; lint passes clean.

**Cosmetic (optional trivial doc touch, not required):**
- `tasks/builds/audit-tool-v1/intent.md` — "verbatim-identical" claim is stale.
- `CLAUDE.md` — "All four base gates" alongside five listed commands (benchmark
  is the annotated fifth/quality gate).

## 7. File inventory (lock)

| Path | Change |
|---|---|
| `src/live/auth.ts` | HARD-1 — `redirect: 'manual'` in `defaultHttpClient`; redirect policy in `establishSession`; surface `Location` in `HttpResponse` |
| `src/live/auth.test.ts` | HARD-1 — off-host-redirect (blocked) + same-host-redirect (followed) tests |
| `.gitignore` | HARD-2 — add `reports/` |
| `benchmark/gitignore.test.ts` (or `src/report/json.test.ts`) | HARD-2 — assert `reports/` ignored |
| `eslint.config.js` | HARD-3 — `no-restricted-syntax` brand-cast rule + exemptions |
| `benchmark/brand-guard.test.ts` | HARD-3 — rule fires on non-exempt cast, passes on exempt |

No schema, config-registry, migration, or report-format changes. `HttpResponse`
gains an optional `location?: string` field — a backward-compatible additive
change to the internal type in `src/live/auth.ts`.

## 8. Execution model & safety contracts

- All three changes are inline/synchronous within the existing CLI/lint paths.
  No new write path, queue, or state machine.
- HARD-1 is a **narrowing** of live egress: the redirect policy can only refuse
  requests, never originate an off-host one. The existing `assertAllowlisted`
  chokepoint, seed gate, and §4.7 abort test are untouched. A scope-violation
  failure is terminal for that test-user session and surfaces in the run's
  coverage as an auth failure.
- HARD-2 and HARD-3 are build-time/scaffold changes with no runtime effect on
  scanning.

## 9. Deferred items

- **Redirect re-validation against the full allowlist vs same-host only.** This
  spec chooses same-host-only for the auth flow (matches §4.4 scope
  confinement). Following a redirect to a *different* allowlisted host is
  intentionally treated as a scope violation. Reason: scan confinement is
  per-target-host.
- **DNS/IP-pinning of the redirect host.** Same rationale as the original spec
  §13 (hostname-level gate; targets are PR-reviewed owned hosts).

## 10. Testing posture

Each work item ships a test that fails before and passes after (§4/§5). No item
is "done" without its test. Run before hand-off completion: `npm run lint`,
`npm run typecheck`, `npm run test:unit`, `npm run build`. (Benchmark
recall/precision runs in the scanner Docker image in CI and is unaffected.)

## 11. Self-consistency

- 3 work items (§5) = 3 §7 inventory groups = 3 goals (§2). ✓
- 6 resolved + 2 cosmetic (§6) = the 11-finding review minus the 3 in scope. ✓
- HARD-1 touches the safety contract and is framed as a narrowing with a named
  mechanism (`redirect: 'manual'` + host check) and a zero-off-host-request
  test. ✓
- Every item names a concrete acceptance test with a before/after assertion. ✓

---

*Hand-off: this spec is buildable as-is. To build, run `feature-coordinator`
(it produces a plan, gates it, then builds each item chunk-by-chunk with the
per-item tests as G1 acceptance). The three items are independent and may build
in any order; HARD-1 is highest priority (safety surface).*

