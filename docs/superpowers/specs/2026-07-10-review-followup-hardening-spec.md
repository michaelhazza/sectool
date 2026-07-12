# Spec — audit-tool review-follow-up hardening (2026-07-10)

**Status:** accepted
**Spec date:** 2026-07-10
**Last updated:** 2026-07-10 (rev 2 — applied operator review: redirect origin/method semantics, GET+POST test split, brand-forgery ban)
**Author:** claude (fable) — from the 2026-07-10 fable diff-review, verified against shipped `main`
**Build slug:** review-followup-hardening

> **Revision log.** rev 2 folds in an operator gate-check that returned NEEDS
> REVISION on rev 1: HARD-1 now pins the redirect boundary to **exact origin**
> (not `hostname`, which ignored scheme/port), defines **status-specific method
> semantics** and **malformed-`Location`** handling via a shared, unit-tested
> `classifyRedirect` helper, and requires **distinct GET and POST** acceptance
> cases (the POST is the credential-bearing path). HARD-3's goal is narrowed
> from "cannot be forged" to a concrete, enforceable ban: since the branded
> types are constructible only via an unsafe assertion, and `src/` (non-test)
> contains exactly two such assertions — both the authorized mint sites — the
> rule **bans `as any` / `as unknown as` in production `src/`** outside the two
> mint files, which closes the forge path syntactically (verified: 0 other
> occurrences). Acceptance tests now load the real `eslint.config.js`.

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
3. Remove the syntactic forge path for the allowlist/target brand by banning
   unsafe assertions (`as any` / `as unknown as`) in production `src/` outside
   the two authorized mint modules, plus a named tripwire for the brands
   themselves (HARD-3).

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

**Redirect contract — shared `classifyRedirect` helper (`src/live/redirect.ts`, new).**
A single pure function classifies every hop *before* any transport, so GET and
POST share one audited boundary:

```
classifyRedirect(currentUrl: string, status: number,
                 location: string | undefined, targetOrigin: string): RedirectDecision
```

`RedirectDecision` (discriminated union):
- `{ kind: 'not-redirect' }` — status ∉ {301,302,303,307,308}.
- `{ kind: 'invalid', reason: 'redirect-missing-location' }` — 3xx with no `Location`.
- `{ kind: 'invalid', reason: 'redirect-invalid-location' }` — `Location` fails
  `new URL(location, currentUrl)`, **or** the resolved scheme ∉ {`http:`,`https:`}
  (blocks `javascript:`, `data:`, `file:`, `mailto:`, …).
- `{ kind: 'scope-violation', location }` — resolved URL's **origin** ≠
  `targetOrigin`. **Origin = scheme + host + port**, compared exactly
  (`new URL(location, currentUrl).origin === targetOrigin`). This single check
  subsumes host change, HTTPS→HTTP downgrade, and port change — the three
  vectors a hostname-only check misses.
- `{ kind: 'follow', url, method, body }` — same-origin; method/body per status:
  **301/302/303 → `GET`, body dropped, `Content-Type` dropped**;
  **307/308 → method and body preserved**.

`targetOrigin` is `new URL(target.url).origin`, captured once in
`establishSession`. The helper never performs I/O.

**Required change.**
1. `defaultHttpClient` (`src/live/auth.ts:201-206`): set `redirect: 'manual'`
   so 3xx responses are returned, not followed; surface the `Location` header
   (already in `rawHeaders`) as an optional `location?: string` on `HttpResponse`.
2. **GET pre-fetch** (CSRF, `auth.ts:269-273`): after each response, call
   `classifyRedirect`. `follow` → re-issue via `httpClient` to `url` with the
   decided method (same-origin only), bounded by a **hop cap of 5**.
   `scope-violation` / `invalid` → **terminal** `{ kind: 'failure', reason,
   message }` (the reason code, verbatim); the redirected URL is **never
   fetched**. `not-redirect` → proceed as today.
3. **POST credential** (`auth.ts:299-316`): **never follow a redirect.** Pass the
   response — including a 3xx — to `evaluateLoginResponse`; a 3xx that carries the
   session carrier (Set-Cookie for `cookie`, body token for `bearer`) is success
   (the cookie rides the redirect response — confirmed at `auth.ts:318-338`), and
   a 3xx without one is a login failure. The `Location` target is never requested,
   so the credential is never replayed off-origin (this is the "reject POST
   redirects entirely" contract — justified because the flow demonstrably does not
   need to follow them). If the builder finds `evaluateLoginResponse` rejects a
   3xx status outright, adjust it to evaluate the carrier on 3xx as above.
4. Reason codes are a closed set: `scope-violation`, `redirect-missing-location`,
   `redirect-invalid-location` (added to the `AuthResult` failure `reason` union).

**Acceptance tests.** `classifyRedirect` gets pure unit tests
(`src/live/redirect.test.ts`) for every decision branch incl. 301/302/303→GET and
307/308→preserve. `establishSession` gets integration tests
(`src/live/auth.test.ts`) with an injected `httpClient` that **records the exact
ordered request log**; each must fail before the change and pass after:

| # | Stage | Redirect | Assert |
|---|---|---|---|
| a | GET | `https://staging.example/login` → `http://staging.example/login` (downgrade) | no request to the `http://` URL; terminal `scope-violation` |
| b | GET | `→ https://staging.example:8443/login` (port change) | no request to `:8443`; terminal `scope-violation` |
| c | GET | `→ https://evil.example/` (host change) | no request to `evil.example`; terminal `scope-violation` |
| d | GET | same-origin `/login → /login?step=2` (302) | followed as GET; reaches form |
| e | **POST** | same-origin 302 **with Set-Cookie** | session established; request log is **exactly** `[GET /login, POST /login]` — **no third request** |
| f | **POST** | 302 → `https://evil.example/` | **no request to `evil.example`**; result is login-failure (or session iff the 3xx itself carried the cookie); assert the redirect URL was never fetched |
| g | either | 3xx with **no** `Location` | terminal `redirect-missing-location`; nothing fetched |
| h | either | 3xx `Location: javascript:alert(1)` (and a malformed value) | terminal `redirect-invalid-location`; nothing fetched |

Test (e) is the crux: it proves the **credential-bearing POST** path is guarded
by asserting the exact pre-redirect request set and the absence of any request to
the redirect target — not merely the final result.

**Safety-contract note.** This narrows egress; it cannot broaden it. The existing
§4.7 zero-request abort test and the seed-gate are unchanged.

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

**Scope of the guarantee (honest framing).** A name-matching lint rule alone is
*not* an unforgeability proof — import aliases (`import { AllowedTarget as AT }`),
local `type` aliases, and bare `as any` all evade a rule keyed on the literal
type name. The durable invariant instead comes from two facts working together:
(1) the branded types are constructible only through an **unsafe assertion** — a
plain object is not assignable to `Brand & {...}`, so TypeScript forces
`as unknown as X` or `as any`; and (2) production `src/` (non-test) contains
**exactly two** such assertions today, both the authorized mint sites
(`src/config/load.ts:30`, `src/live/gate.ts:17`) — verified: zero others. So
banning `as any` / `as unknown as` in production `src/` outside those two files
removes the *only syntactic bridge* an arbitrary value could use to reach the
brand. A determined author editing a mint file or adding an exemption can still
forge — that residual is a code-review boundary, not a lint one, and is accepted.

**Required change.** In `eslint.config.js` add a `files: ['src/**/*.ts']` /
`ignores: ['**/*.test.ts', 'src/config/load.ts', 'src/live/gate.ts']` block with
two `no-restricted-syntax` selectors:
- **Rule A (the ban):** forbid `TSAsExpression[typeAnnotation.type='TSAnyKeyword']`
  (`x as any`) and the `as unknown as …` chain
  (`TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']`).
  Message: "unsafe assertion banned in production src; the allowlist/target brand
  may only be minted in load.ts/gate.ts (HARD-3)."
- **Rule B (the tripwire):** forbid any `TSAsExpression`/`TSTypeAssertion` whose
  asserted type text is `AllowedTarget` or `LoadedAllowlist`, as a friendlier,
  directly-named diagnostic. Redundant with Rule A for the common case but names
  the exact footgun.

Keep both in the main `eslint .` gate. Confirm `npm run lint` stays green on the
current tree (the two mint sites and all `*.test.ts` casts are exempt).

**Acceptance test** (`benchmark/brand-guard.test.ts`): drive the **real**
`eslint.config.js` via the `ESLint` class (`new ESLint({ cwd: repoRoot })` +
`lintText(code, { filePath })`, or `lintFiles` over temp fixtures) — not an inline
`Linter.verify()`, so the test proves the shipped flat-config `files`/`ignores`
selection actually applies. Assert:
- `const t = x as unknown as AllowedTarget` at `src/__fixtures__/forge.ts`
  (non-exempt) → ≥1 error.
- the same text at `filePath` `src/live/gate.ts` → 0 errors (exempt).
- the same text at `filePath` `src/foo.test.ts` → 0 errors (exempt).
- a plain `y as any` at a non-exempt `src/*.ts` path → error (Rule A).
Fails before the rules are added, passes after.

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
| `src/live/redirect.ts` (new) | HARD-1 — pure `classifyRedirect` helper (origin/method/malformed decisions) |
| `src/live/redirect.test.ts` (new) | HARD-1 — unit tests for every `RedirectDecision` branch |
| `src/live/auth.ts` | HARD-1 — `redirect: 'manual'` + `location?` on `HttpResponse`; GET follows same-origin (hop cap 5) via `classifyRedirect`; POST never follows (3xx evaluated in place); `AuthResult` reason union gains the 3 redirect codes |
| `src/live/auth.test.ts` | HARD-1 — integration tests (a)–(h) with an ordered request-log fake client, incl. the POST off-origin case (e/f) |
| `.gitignore` | HARD-2 — add `reports/` |
| `benchmark/gitignore.test.ts` (or `src/report/json.test.ts`) | HARD-2 — assert `reports/` ignored |
| `eslint.config.js` | HARD-3 — `src/`-scoped block: Rule A (ban `as any` / `as unknown as`) + Rule B (named brand tripwire), exempting the two mint files + `*.test.ts` |
| `benchmark/brand-guard.test.ts` (new) | HARD-3 — drives the real `eslint.config.js` via the `ESLint` class over fixtures |
| `src/__fixtures__/forge.ts` (new, test fixture) | HARD-3 — non-exempt file containing a forbidden cast for the acceptance test |

No schema, config-registry, migration, or report-format changes. Additive,
backward-compatible internal-type changes only: `HttpResponse` gains
`location?: string`; the `AuthResult` failure `reason` union gains
`scope-violation` / `redirect-missing-location` / `redirect-invalid-location`.

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

- **Redirect re-validation against the full allowlist vs exact-origin only.**
  This spec confines the auth flow to the target's **exact origin** (matches
  §4.4 scope confinement). A redirect to a *different* allowlisted host — or to
  the same host on a different scheme/port — is intentionally a scope violation,
  not followed. Reason: scan confinement is per-target-origin; broadening to
  "any allowlisted origin" is a deliberate non-goal.
- **DNS/IP-pinning of the redirect host.** Same rationale as the original spec
  §13 (hostname-level gate; targets are PR-reviewed owned hosts).

## 10. Testing posture

Each work item ships a test that fails before and passes after (§4/§5). No item
is "done" without its test. Run before hand-off completion: `npm run lint`,
`npm run typecheck`, `npm run test:unit`, `npm run build`. (Benchmark
recall/precision runs in the scanner Docker image in CI and is unaffected.)

## 11. Self-consistency

- 3 work items (§5) = 3 goals (§2); §7 inventory groups them (HARD-1 spans the
  new `redirect.ts` helper + `auth.ts` + their tests). ✓
- 6 resolved + 2 cosmetic (§6) = the 11-finding review minus the 3 in scope. ✓
- HARD-1's boundary is **exact origin** (scheme+host+port), stated identically in
  the helper contract, the required-change steps, and the test matrix (downgrade
  + port + host cases). The credential POST never follows a redirect; the GET
  follows same-origin only, hop-capped. ✓
- HARD-3's claim matches its mechanism: the ban removes the only syntactic forge
  bridge (`as any` / `as unknown as`), verified against 0 non-mint occurrences;
  the residual (editing a mint/exempt file) is explicitly a code-review boundary,
  not claimed as lint-enforced. ✓
- Every item names a concrete acceptance test that loads the real artifact
  (injected client with a request log for HARD-1; the real `eslint.config.js` for
  HARD-3) with a before/after assertion. ✓

---

*Hand-off: this spec is buildable as-is. To build, run `feature-coordinator`
(it produces a plan, gates it, then builds each item chunk-by-chunk with the
per-item tests as G1 acceptance). The three items are independent and may build
in any order; HARD-1 is highest priority (safety surface).*

