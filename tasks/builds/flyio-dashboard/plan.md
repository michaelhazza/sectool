# Build plan — fly.io dashboard deployment with on-demand scan triggering

**Build slug:** flyio-dashboard
**Spec:** `docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md`
**Plan author:** architect agent
**Plan date:** 2026-06-14
**Classification:** Major (new internet-facing trust boundary, two inbound auth boundaries, CI changes, UI changes, safety-critical registry + provenance gates).

## Contents

1. Model-collapse check
2. System invariants
3. Architecture notes (+ primitives reuse)
4. Contracts (C1–C6)
5. Execution-safety contracts + dependency graph
6. Chunks 1–10
7. Plan gaps / decisions the builder must NOT improvise
8. Deferred items
9. Executor notes

---

## Model-collapse check

The feature decomposes into trigger → CI scan → upload → render, but this is NOT
an ingest→extract→transform→render LLM pipeline. There is no multimodal extraction
step, no model call anywhere on this path. The "scan" step is OWASP ZAP / Nuclei /
Semgrep shelled out in GitHub Actions — irreducible external tools, not a model
call. Collapsing into "one model call with a structured-output schema" is not
applicable: the work is deterministic orchestration (HTTP dispatch, file writes,
schema validation, constant-time auth), and the safety contract specifically
requires deterministic, auditable, non-model gates (allowlist enforcement,
provenance binding). **Reject collapse — the domain is deterministic security
plumbing, not a perception/extraction pipeline. A model call would weaken the
auditability the §7 safety contract depends on.**
---

## System invariants (read before touching any chunk)

These hold across every chunk. A change that violates one is wrong even if its
local test passes.

1. **Allowlist is the sole scan-target authority.** `/api/scan` may only dispatch
   a scan for a `repo` that is an `enabled` entry in `targets.json` AND a
   `stagingUrl` that is an `enabled` staging target whose host is on the
   allowlist — validated with the SAME `loadAllowlist`/`loadTargets` the CLI uses.
   No flag, header, or body field bypasses it. (Spec §4.1 step 3, §7.1.)
2. **Dispatch target is fixed, never caller-controlled.** The workflow_dispatch URL
   is built from `AUDIT_WORKFLOW_REPO` env, never from the selected scan target.
   (Spec §4.1 step 5.)
3. **Every upload is provenance-bound, not just bearer-authed.** No trigger class
   is accepted on the bearer token alone. (Spec §4.2 step 3, §7.5.)
4. **`runId` is path-validated against `RUN_ID_RE` before any path is built.**
   (Spec §4.2 step 5, §7.3.)
5. **Production fails closed.** When `FLY_APP_NAME` is set (or `REQUIRE_AUTH=true`),
   missing `AUDIT_BASIC_AUTH_USER`/`PASS`, `ALLOWED_ORIGIN`, or `BIND_HOST` is a
   hard startup failure — the server refuses to listen. (Spec §5.1.)
6. **Config files are read-only on fly.io.** Only `reports/`, `history/`,
   `scan-jobs.jsonl` are writable (under `DATA_DIR`). `CONFIG_DIR`/`SPA_DIR` stay
   baked into the image. No endpoint mutates config. (Spec §3.1, §7.4.)
7. **scan-jobs is an append-only event log.** Never a read-modify-write of a
   mutable object. Each event is one newline-terminated append. State is derived
   by folding. (Spec §4.3.)
---

## Architecture notes

### Decisions and rejected alternatives

- **`DATA_DIR` single env var, default = `REPO_ROOT`** (not per-dir env vars).
  Problem: three runtime-writable dirs (`reports/`, `history/`, plus the new
  `scan-jobs.jsonl`) must relocate to the fly volume `/data` while config + SPA
  stay baked in. Considered: separate `REPORTS_DIR`/`HISTORY_DIR` env vars
  (rejected — three vars to keep in sync, more fail-closed surface, no benefit
  since they always move together). Chosen: one `DATA_DIR` that the server
  resolves `reports/`, `history/` under; default `REPO_ROOT` preserves local-dev
  parity with zero config.

- **Reuse the existing `GitHubHttpClient` injectable contract from
  `src/fix/github.ts` for run-verification** — do NOT introduce a new HTTP client
  or dependency. `src/fix/github.ts` already defines `GitHubHttpClient`,
  `GitHubRequest`, `GitHubResponse`, an `authHeaders` helper, a `parseOwnerRepo`
  parser, and a `fetch`-based default client. The upload run-verification call
  (§4.2) and the workflow_dispatch call (§4.1) are both GitHub REST calls and MUST
  reuse this contract and the same injectable-client testing pattern. The one
  required change: the default `fetch` client (`defaultGitHubClient`) is currently
  module-private — export it (or a shared equivalent) so the dispatch + verify
  modules can use it without re-implementing `fetch`. **This is a primitive-reuse
  decision the builder must NOT improvise around by adding `octokit`, `axios`, or a
  fresh fetch wrapper.** (See "Primitives reuse" below.)

- **Provenance binding is a dedicated pure module, not inline in the route.** The
  on-demand path (jobId↔dispatched-job match) and the scheduled/replay path
  (server-side GitHub run verification) are both branchy correctness-critical
  logic. They go in `src/ui/provenance.ts` (pure, injectable client + clock +
  scan-jobs reader) so they are unit-testable without a live HTTP server. The route
  handler is a thin adapter: read body → call provenance verifier → on pass, write.

- **scan-jobs store is a deep module** (`src/ui/scan-jobs.ts`) exposing a tiny
  interface (`appendEvent`, `foldJobs`, `SCAN_JOBS_PATH`) over an append-only
  JSONL file. Folding rule, malformed-trailing-line tolerance, and the
  requested-event identity-field carry-forward all hide behind `foldJobs`. Callers
  never parse the file. The path is a single exported constant (§9 deliverable:
  "path defined once as a single constant, not string-literal-duplicated").

- **Basic Auth + bearer are middleware in front of the existing router**, not woven
  into each handler. One gate decides: `/healthz` → no auth; `/api/upload` → bearer
  only; everything else → Basic Auth (when enabled). This keeps the existing
  read-only handlers untouched.

### Patterns selected

- **Adapter**: route handlers adapt HTTP req/res to the pure `provenance.ts` and
  `scan-jobs.ts` modules.
- **Dependency inversion** via injectable deps on `startServer` (GitHub client, env
  reader, clock, data dir) — mirrors the existing `fixHandler` injection so tests
  never hit network/real-clock. No new pattern invented.
- No queue, no DB, no new framework. The execution model is **synchronous inline**
  for `/api/scan` (mint nonce → append → dispatch → respond) and **synchronous
  inline** for `/api/upload` (auth → verify → validate → atomic write → append →
  respond). Durability is the append-only log + atomic file writes, not a job
  table. (This matches the existing CLI, which has no queue.)

### Primitives reuse (Section 1 of the authoring checklist)

| Need | Existing primitive | Decision |
|---|---|---|
| GitHub REST call (dispatch + verify) | `GitHubHttpClient`/`GitHubRequest`/`GitHubResponse` + `defaultGitHubClient` + `authHeaders` in `src/fix/github.ts` | **Reuse.** Export the default client; build the dispatch + verify calls on the same contract. No new HTTP dep. |
| owner/repo parsing | `parseOwnerRepo` in `src/fix/github.ts` | **Reuse** for `AUDIT_WORKFLOW_REPO` → `{owner,repo}`. |
| Registry validation | `loadAllowlist`/`loadTargets` in `src/config/load.ts`; `preflight` in `src/live/preflight.ts` | **Reuse** verbatim in `/api/scan` so the UI cannot express a scan the CLI would refuse. |
| Report write / trend append | `writeReport(report, reportsDir?)`, `writeTrend(line, trendPath?)` (both already take a path override) | **Reuse** — `/api/upload` passes `DATA_DIR`-derived paths. No signature change. |
| Report schema | `RunReportSchema` in `src/schemas/report.ts` | **Reuse** for upload `report` validation. |
| runId regex | `RUN_ID_RE` in `src/cli.ts` (`findLatestReport`, currently inline) | **Extract** to a shared constant (e.g. `src/schemas/run-id.ts`) and reuse for the traversal guard. Do not re-author a second regex. |
| Random nonce | `randomBytes` (already imported in `server.ts` for `CSRF_NONCE`) | **Reuse.** |
| CSRF/origin pattern | existing `/api/fix` guard in `server.ts` | **Generalize** to `ALLOWED_ORIGIN`, apply to `/api/scan`. |
| Per-key serialization | `withFixLock` in `server.ts` | Not reused; append-only log has no RMW (documented in §4.3). |

**No genuinely new primitive is invented.** New files (`scan-jobs.ts`,
`provenance.ts`, `auth.ts`, `env.ts`, `dispatch.ts`) are new *modules* composing
existing primitives, not new data stores or external dependencies.
---

## Contracts

### C1 — `/api/scan` request

```jsonc
{ "repo": "<registered-repo-name>", "stagingUrl": "<registered-staging-url>" }
```
- Both fields **required and non-empty** (spec §4.1 "Scan scope semantics").
- Producer: UI "Run a scan" form. Consumer: `handleScanPost`.
- Response: `202 { "jobId": "<32hex>" }` on dispatch; `400` registry/validation
  fail (no dispatch); `403` CSRF/origin fail; `502` GitHub dispatch failure.

### C2 — scan-jobs event records (append-only JSONL, one object per line)

```jsonc
{"event":"requested","jobId":"<32hex>","targetRepo":"X","stagingUrl":"https://…","at":"<ISO>"}
{"event":"dispatched","jobId":"<32hex>","at":"<ISO>"}
{"event":"dispatch_failed","jobId":"<32hex>","reason":"github 401","at":"<ISO>"}
{"event":"uploaded","jobId":"<32hex>","runId":"<RUN_ID>","at":"<ISO>"}
{"event":"report_ingested","trigger":"scheduled","runId":"<RUN_ID>","githubRunId":"…","replayed":false,"at":"<ISO>"}
```
- **Source-of-truth precedence (mandatory):** immutable identity fields
  (`targetRepo`, `stagingUrl`, first `at`) come from the `requested` event; the
  current **state** is the latest *status* event for that `jobId`. NOT last-event-
  wins for identity. (Spec §4.3 folding rule.)
- `report_ingested` events have NO `jobId` (scheduled/replay have no fly-issued
  nonce) — they are not folded into a job; they exist for audit only.
- Nullability: `reason` only on `dispatch_failed`; `runId` only on `uploaded`/
  `report_ingested`; `replayed` only on `report_ingested`.

### C3 — folded job (GET /api/scan-jobs response element)

```jsonc
{
  "jobId": "<32hex>",
  "targetRepo": "X",
  "stagingUrl": "https://…",
  "state": "in_progress" | "complete" | "failed" | "timed_out" | "pre_dispatch",
  "requestedAt": "<ISO>",
  "runId": "<RUN_ID> | null"
}
```
- State machine (spec §4.3): latest status event → `requested`=`pre_dispatch`,
  `dispatched`=`in_progress` (→`timed_out` if no `uploaded` after TTL, derived not
  stored), `dispatch_failed`=`failed`, `uploaded`=`complete`.
- Returned most-recent-first. Read-only, Basic-Auth-gated.

### C4 — `/api/upload` envelope

```jsonc
{
  "trigger": "on-demand" | "scheduled" | "replay",
  "jobId": "<32hex>",                 // required iff trigger=on-demand
  "targetRepo": "<repo>", "stagingUrl": "<url>",
  "runId": "<RUN_ID_RE>",
  "githubRunId": "<actions run id>",  // required for scheduled & replay
  "githubWorkflow": "<workflow name>",
  "githubSha": "<commit sha>",
  "sourceRunId": "<original runId>",  // replay only
  "report": { /* RunReport */ }, "markdown": "...", "sarif": "...", "trendLine": { }
}
```
- Producer: CI uploader (C7). Consumer: `handleUploadPost`.
- Response: `200 { runId, jobId: string | null }` (`jobId` non-null only for
  on-demand). Errors: `401` bad bearer (before body read); `413` over 25 MiB;
  `409` provenance/dedup fail; `422` schema fail; `500` write fail.

### C5 — env contract (resolved once at startup; `src/ui/env.ts`)

| Var | Local default | Production (FLY_APP_NAME set) | Used by |
|---|---|---|---|
| `DATA_DIR` | `REPO_ROOT` | `/data` | report/history/scan-jobs paths |
| `BIND_HOST` | `127.0.0.1` | **required** | `server.listen` |
| `ALLOWED_ORIGIN` | `http://127.0.0.1:<port>` | **required** | `/api/fix`, `/api/scan` origin guard |
| `AUDIT_BASIC_AUTH_USER`/`PASS` | unset → gate disabled | **required** | Basic Auth |
| `REQUIRE_AUTH` | unset | optional force-prod | auth mode inference |
| `AUDIT_UPLOAD_TOKEN` | unset | runtime-required for upload | bearer compare |
| `AUDIT_GH_DISPATCH_TOKEN` | unset | runtime-required for scan + verify | dispatch + run-verify |
| `AUDIT_WORKFLOW_REPO` | unset | runtime-required for scan + verify | dispatch URL + verify repo |
| `FLY_UPLOAD_URL` | n/a (CI only) | n/a | CI uploader |

"Required in production" (fail-closed startup set) = `AUDIT_BASIC_AUTH_USER`/`PASS`,
`ALLOWED_ORIGIN`, `BIND_HOST` only (§5.1). Scan/upload secrets are runtime-checked
(see Plan gap 7). Missing fail-closed-set var in production → hard startup failure
naming the var.

### C6 — GitHub run-verification result (`src/ui/provenance.ts`)

Input: `{ githubRunId, githubWorkflow, githubSha, expectedRepo, freshnessWindowMs }`
+ injectable `GitHubHttpClient` + `clock`. Verifies via
`GET /repos/{owner}/{repo}/actions/runs/{githubRunId}`:
- run exists,
- belongs to expected workflow **matched by workflow file path or numeric workflow
  id — NEVER the mutable `name`/display field** (spec §4.2; a dedicated test),
- `status === "completed"`,
- `head_sha === githubSha`,
- `run_started_at`/`created_at` within freshness window (relaxed for replay).
Returns `{ ok: true }` or `{ ok: false, reason }`. Pure of HTTP via the injected
client.
---

## Execution-safety contracts (checklist Section 10)

- **`/api/scan` dispatch** — idempotency: `non-idempotent (intentional)` per
  request; each click mints a fresh `jobId`, so two clicks = two independent jobs
  (spec §10 "Two scans dispatched at once"). Retry classification: `unsafe` at the
  GitHub layer — but the caller does not auto-retry; a `dispatch_failed` is terminal
  for that jobId and the user re-clicks to mint a new one. Concurrency: append-only
  log, no RMW, no race (spec §4.3).
- **`/api/upload` on-demand** — idempotency: `state-based`. Guard: "jobId is in
  `dispatched` state AND not already `uploaded` AND `targetRepo`/`stagingUrl` match
  the requested event." Losing/duplicate caller → `409`, nothing written. This is
  the §4.2 replay guard. Map: provenance/dedup conflict → **409** (never a bubbled
  500).
- **`/api/upload` scheduled/replay** — idempotency: `state-based` on `runId`
  uniqueness (duplicate live `runId` on the volume → `409`) + GitHub-verified
  provenance. Schema fail → **422**. Bad runId shape → reject before path build.
- **Terminal events:** each job has exactly one terminal status event —
  `dispatch_failed` (failed) OR `uploaded` (complete). `requested`/`dispatched` are
  non-terminal. No status event is appended for a job after its terminal event.
- **No silent partial / "exists is not correct":** the report-write + trend-append
  run **serialized under `withWorkspaceLock`** (M1 — `writeTrend` is a whole-file
  read-modify-write, not an append, so concurrent uploads would otherwise drop
  lines; this is NOT an "atomic append"). The `uploaded` event is appended ONLY
  after BOTH writes succeed. If `writeReport` succeeds but `writeTrend` fails, the
  upload returns `500` and does NOT append `uploaded` — the job stays
  `in_progress`/`timed_out`, surfacing the failure rather than lying. If a prior
  partial run left a half-written `reports/<runId>/`, the runId-dedup check treats
  the existing dir as a duplicate → `409`; a `replay` is the operator recovery path,
  not a silent overwrite. The runId used for dedup, path build, and event is the
  single canonical runId (envelope `runId` asserted equal to `report.runId`, H1/H2).

## Phase / chunk dependency graph

```
C1 env+paths ──┬─> C2 auth ──┬─> C5 /api/scan ──┐
               │             │                   ├─> C7 CI (dispatch target + uploader)
               ├─> C3 scan-jobs store ──> C4 healthz+scan-jobs ──┘
               └─> C6 /api/upload (needs C3 store + C1 paths + provenance) ──> C7
C8 Dockerfile.ui + fly.toml  (behavioural dep on C1..C6; no source dep; build after C6)
C9 UI panel + api helpers     (needs C4+C5+C6 routes live)
C10 docs + ADR + KNOWLEDGE    (last; documents shipped behaviour)
```
No backward dependencies. Each chunk is forward-only.
---

## Chunks

### Chunk 1 — DATA_DIR / BIND_HOST / ALLOWED_ORIGIN env plumbing + path relocation

**Scope.** Introduce the resolved-env layer and relocate runtime-writable paths.
Does NOT add auth, routes, or the production fail-closed *enforcement* (that is C2,
which consumes this). This chunk resolves + threads env and generalizes the origin
guard; enforcement of fail-closed lands in C2.

**Spec refs:** §3.2, §5.3, §9 (DATA_DIR/BIND_HOST/ALLOWED_ORIGIN bullet).

**Files.**
- `src/ui/env.ts` (new) — `resolveEnv(env, port)` → typed config object (C5). Pure
  function over an injected `EnvReader` (reuse the `EnvReader` type shape from
  `src/fix/github.ts`); returns `{ dataDir, bindHost, allowedOrigin, isProduction,
  reportsDir, historyDir, configDir }`. `isProduction = !!FLY_APP_NAME ||
  REQUIRE_AUTH==='true'`.
- `src/schemas/run-id.ts` (new) — extract `RUN_ID_RE` to a single shared constant
  (Plan gap 2). Re-import it in `src/cli.ts` `findLatestReport` (replace the inline
  copy) and in C6.
- `src/ui/server.ts` (modify) — replace module-level `REPORTS_DIR`/`HISTORY_DIR`
  computed from `REPO_ROOT` with values derived from `resolveEnv`.
  `CONFIG_DIR`/`SPA_DIR` stay image-relative. Extend `startServer(port, opts?)` to
  accept `{ env?, fixHandler?, githubClient?, clock? }` so tests drive env without
  `process.env` mutation.
  **M4 — enumerate the full threading (do NOT leave the origin guard half-migrated):**
  the current handler chain (`handleRequest` → `handleFixPost`) threads `port` and
  recomputes `expectedOrigin = http://127.0.0.1:${port}` inline (`server.ts:333,450`),
  and `server.listen` is hardcoded to `127.0.0.1` (`server.ts:508`). C1 must:
    - thread `bindHost` into `server.listen(port, bindHost, …)`;
    - replace the inline `expectedOrigin` in **`handleFixPost`** with the resolved
      `allowedOrigin` (so `/api/fix` AND the new `/api/scan` share ONE generalized
      guard — §5.3; leaving `/api/fix` on the hardcoded origin while only `/api/scan`
      uses `ALLOWED_ORIGIN` is a split-guard bug);
    - update `doUi` (`src/cli.ts:899`), which calls `startServer(args.port)` and
      prints a hardcoded `http://127.0.0.1:${srv.port}` line — make the log reflect
      the resolved `bindHost`/origin.
- `src/report/json.ts`, `src/report/trend.ts` — **no signature change** (Plan gap
  4): they already accept a path override. The server passes `reportsDir`/
  `historyDir` from `resolveEnv` at the C6 call site. Do NOT refactor `REPO_ROOT`
  internals.

**Module shape.**
- *Public interface:* `resolveEnv(env, port) → ResolvedEnv`; `startServer(port,
  opts?)`; the shared `RUN_ID_RE`.
- *Hidden:* production-inference rule, path joining, default fallbacks.

**Error handling.** `resolveEnv` does not throw here (enforcement is C2); returns
the resolved object with possibly-undefined production-required fields.

**Test considerations (pr-reviewer).** `resolveEnv` empty env → localhost defaults.
`DATA_DIR=/data` → reports/history under `/data`. `FLY_APP_NAME=x` →
`isProduction=true`. **Origin guard test (spec §9 "origin guard (ALLOWED_ORIGIN)")**:
`/api/fix` rejects when Origin ≠ resolved `allowedOrigin`.

**Verification commands.**
- `npx eslint src/ui/env.ts src/ui/server.ts src/schemas/run-id.ts src/cli.ts`
- Targeted: `npx vitest run src/ui/env.test.ts`

**Dependencies.** None (foundation).

---

### Chunk 2 — Basic Auth middleware (env-gated, production fail-closed)

**Scope.** A single auth gate in front of the router. `/healthz` exempt;
`/api/upload` bypasses Basic Auth (uses bearer in C6); all else → Basic Auth when
enabled. Adds the **production fail-closed startup check**. SAFETY-RELEVANT.

**Spec refs:** §5.1, §5.3, §4.4 (healthz exemption), §9 (auth gate / fail-closed /
ALLOWED_ORIGIN+BIND_HOST startup-fail tests).

**Files.**
- `src/ui/auth.ts` (new) — `basicAuthGate(parsedHeader, resolvedEnv) → 'pass' |
  'reject'` using `crypto.timingSafeEqual`; the route adapter emits
  `WWW-Authenticate: Basic realm="sectool"` on reject. `isAuthEnabled(resolvedEnv)`
  (true when user+pass set OR production). Pure decision function; HTTP-writing stays
  in the route adapter.
- `src/ui/env.ts` (modify) — add `assertProductionConfig(resolvedEnv)` that throws a
  named `StartupConfigError` listing every missing required var when `isProduction`
  and any of `AUDIT_BASIC_AUTH_USER`/`PASS`/`ALLOWED_ORIGIN`/`BIND_HOST` is unset.
- `src/ui/server.ts` (modify) — call `assertProductionConfig` inside `startServer`
  BEFORE `server.listen`; on throw, reject the start promise (server never binds).
  Wire `basicAuthGate` into `handleRequest` as the first step after URL parse,
  exempting `/healthz` and `/api/upload`. Log resolved auth state
  ("Basic Auth: enabled (production)" / "disabled (local dev)").

**Module shape.**
- *Public interface:* `basicAuthGate`, `isAuthEnabled`, `assertProductionConfig`,
  `StartupConfigError`.
- *Hidden:* header parsing, constant-time compare, realm string.

**Error handling.** Missing/wrong credentials → `401` + `WWW-Authenticate`.
Production missing config → `StartupConfigError` → `startServer` rejects → process
exits non-zero (`doUi` catch already exits 1 on start failure).

**Test considerations.** (spec §9)
- auth gate rejects when unauthenticated (no/incorrect header → 401).
- **production fail-closed:** `FLY_APP_NAME` set (or `REQUIRE_AUTH=true`) + Basic
  Auth secrets missing → `assertProductionConfig`/`startServer` throws; no listen.
- **production startup fails when `ALLOWED_ORIGIN` or `BIND_HOST` unset.**
- local dev (no FLY_APP_NAME, no secrets) → gate disabled, requests pass.
- `/healthz` reachable without auth even when gate enabled.

**Verification commands.**
- `npx eslint src/ui/auth.ts src/ui/env.ts src/ui/server.ts`
- Targeted: `npx vitest run src/ui/auth.test.ts`

**Dependencies.** C1.

---

### Chunk 3 — scan-jobs.jsonl append-only store + fold helper

**Scope.** The event-log primitive. Append + fold + path constant. No routes yet.

**Spec refs:** §4.3 (storage, folding rule, state machine, append semantics), §9
(append-only store + fold helper bullet; "path defined once as a single constant").

**Files.**
- `src/ui/scan-jobs.ts` (new):
  - `SCAN_JOBS_PATH(dataDir)` — single source of truth for the path
    (`<dataDir>/history/scan-jobs.jsonl`). No string-literal duplication elsewhere.
  - `appendEvent(event, dataDir)` — one `JSON.stringify(event) + '\n'` via
    `fs.appendFileSync` (append flag — NOT read-modify-write). Creates the dir if
    absent.
  - `foldJobs(dataDir, nowMs)` → `FoldedJob[]` — read, split on `\n`, parse each
    line, **tolerate only a single malformed trailing partial line** (never repair
    earlier lines), group by `jobId`, apply the §4.3 folding rule (identity from
    `requested`, state from latest status event), derive `timed_out` from
    `dispatched` + TTL using injected `nowMs`. `report_ingested` events (no jobId)
    are excluded from the folded job list.
  - Event-variant union type (C2) + `FoldedJob` (C3).

**Module shape.**
- *Public interface:* `SCAN_JOBS_PATH`, `appendEvent`, `foldJobs`, event union type,
  `FoldedJob`.
- *Hidden:* line parsing, trailing-partial-line tolerance, fold/group logic, TTL
  derivation, latest-status-event selection.

**Error handling.** Missing file → `foldJobs` returns `[]`. Malformed trailing line
→ skipped, earlier lines preserved. Append failure (volume full) propagates to
caller (C5/C6 map to HTTP 500).

**Test considerations.** (spec §9)
- **fold preserves `targetRepo`/`stagingUrl` from the `requested` event through
  `dispatched`/`uploaded`** (NOT lost to last-event-wins) — the named §4.3 test.
- `dispatched` with no `uploaded` past TTL → `timed_out` (injected `nowMs`).
- `dispatch_failed` → `failed`, never `in_progress`.
- malformed trailing line tolerated; malformed interior line does NOT corrupt the
  fold of valid lines.
- **parallel appends don't drop/corrupt entries** — concurrent `appendEvent` calls,
  assert every line is present and parseable (store-layer half of the §9
  parallel-dispatch invariant).

**Verification commands.**
- `npx eslint src/ui/scan-jobs.ts`
- Targeted: `npx vitest run src/ui/scan-jobs.test.ts` (tmp dir; filesystem-only, no
  network).

**Dependencies.** C1 (for `dataDir`).
---

### Chunk 4 — GET /healthz + GET /api/scan-jobs

**Scope.** The two read routes. `/healthz` unauthenticated static OK;
`/api/scan-jobs` Basic-Auth-gated, returns folded jobs most-recent-first.

**Spec refs:** §4.3, §4.4, §9.

**Files.**
- `src/ui/server.ts` (modify) — add `GET /healthz` → `200 {"ok":true}` (handled
  before the auth gate, since it is exempt). Add `GET /api/scan-jobs` →
  `foldJobs(dataDir, Date.now())` sorted most-recent-first, JSON.

**Module shape.**
- *Public interface:* two HTTP routes.
- *Hidden:* fold call + sort (delegated to C3).

**Error handling.** `/api/scan-jobs` read error → `200 []` (consistent with the
existing read-route convention in `handleApi`). `/healthz` never leaks data (static
body).

**Test considerations.** `/healthz` → 200 `{ok:true}`, reachable without auth.
`/api/scan-jobs` returns folded jobs, gated by Basic Auth when enabled, most-recent
first.

**Verification commands.**
- `npx eslint src/ui/server.ts`
- Targeted: route cases authored in `src/ui/server.test.ts`.

**Dependencies.** C2 (auth gate), C3 (fold).

---

### Chunk 5 — POST /api/scan (registry validation + correlation nonce + dispatch)  ⚠ SAFETY-CRITICAL

**Scope.** The trigger endpoint. CSRF/origin gate → **registry safety gate** → mint
jobId → append `requested` → dispatch to `AUDIT_WORKFLOW_REPO` → append
`dispatched`/`dispatch_failed` → respond. This is **invariants 1 and 2**; the
builder must treat registry validation and the fixed dispatch target as
non-negotiable and must NOT trust the request body's repo or build the dispatch URL
from the scan target.

**Spec refs:** §4.1 (all steps), §4.1 "Scan scope semantics" (both fields required),
§6.1 (dispatch shape), §7.1, §7.2, §10 (dispatch-failure row).

**Files.**
- `src/ui/dispatch.ts` (new) — `dispatchScan({ workflowRepo, targetRepo, stagingUrl,
  jobId, token, ref }, client) → Promise<DispatchResult>`. Builds `POST
  /repos/{owner}/{repo}/actions/workflows/on-demand-scan.yml/dispatches` with `ref`
  + `inputs: { target_repo, staging_url, job_id }`. **owner/repo come from
  `parseOwnerRepo(AUDIT_WORKFLOW_REPO)` (reuse), NEVER from the scan target.** Uses
  the reused `GitHubHttpClient` + `authHeaders`. 204 → ok; else → `{ ok:false,
  status }`.
- `src/ui/server.ts` (modify) — `handleScanPost`:
  1. CSRF nonce + `ALLOWED_ORIGIN` origin check (reuse generalized guard from C1).
     Fail → `403`.
  2. Read/parse body (reuse `readBody`, tight cap). Require non-empty `repo` AND
     `stagingUrl`; **reject repo-only / url-only with `400`** (spec §9).
  3. **Registry safety gate (TWO independent checks — M2 fix):** `loadAllowlist()`
     + `loadTargets()` (reuse).
       - **Repo check (explicit, NOT covered by preflight):** `preflight()`
         (`src/live/preflight.ts:59`) gates ONLY the staging URL/host — it never
         inspects a repo. The builder MUST add a separate
         `registry.repos.find(r => r.name === repo && r.enabled)` check; an
         unregistered/disabled `repo` → `400` even when the URL is allowlisted.
         (Invariant 1 — a builder wiring only `preflight` would leave `target_repo`
         unvalidated.)
       - **URL check:** run `stagingUrl` through `preflight(stagingUrl, allowlist,
         registry)` to reuse the exact allowlist+registry gate the CLI uses.
     Any failure → `400`, **no dispatch, no `requested` event** (validation precedes
     the mint so a rejected request leaves no job trace).
     **M3 — error classification:** a `ConfigError` thrown by
     `loadAllowlist`/`loadTargets` (e.g. a baked-image config inconsistency) is a
     SERVER misconfig → `500`, distinct from a caller's unregistered repo/url →
     `400`. Do not collapse them (a misconfigured image must not return a
     misleading "your target isn't registered" 400).
  4. Mint `jobId = randomBytes(16).toString('hex')` (32 hex). Append `requested`
     (targetRepo/stagingUrl/at) BEFORE the GitHub call.
  5. `dispatchScan(...)` with `AUDIT_WORKFLOW_REPO` + `AUDIT_GH_DISPATCH_TOKEN`:
     - 204 → append `dispatched`; respond `202 { jobId }`.
     - failure → append `dispatch_failed` (reason); respond `502` plain-English.

**Module shape.**
- *Public interface:* `dispatchScan(...)`; route `POST /api/scan`.
- *Hidden:* registry validation chain, nonce mint, event sequencing, dispatch URL
  construction.

**Error handling.** `403` CSRF/origin; `400` missing field / failed registry gate
(no dispatch); `502` GitHub failure (with `dispatch_failed` recorded); `500`
unexpected. Missing `AUDIT_GH_DISPATCH_TOKEN`/`AUDIT_WORKFLOW_REPO` surfaces at
runtime as a dispatch failure → `502` (runtime-checked per Plan gap 7).

**Test considerations (pr-reviewer — treat as the safety surface).** (spec §9)
- **registry validation rejects off-allowlist / unregistered / disabled** → 400, no
  dispatch. **Must include a repo-side case (M2): a valid+allowlisted `stagingUrl`
  with an unregistered/disabled `repo` → 400** (proves the repo check is independent
  of the URL preflight, not only URL-side rejection).
- **`ConfigError` from the registry load → 500, not 400** (M3 — server misconfig
  distinct from caller registry miss).
- **rejects repo-only and URL-only payloads** (both required) → 400.
- **dispatches to `AUDIT_WORKFLOW_REPO`, not the scan target** — assert the dispatch
  URL repo via an injected client spy even when `targetRepo` is a different (valid)
  registered repo.
- **dispatch failure records `dispatch_failed` (not `dispatched`); job not
  in-progress** — inject a non-204 client; assert the appended event + `502`.
- happy path: valid repo+url → `requested`+`dispatched` appended, `202 { jobId }`,
  jobId is 32 hex.
- CSRF/origin reject → `403` before any registry load or dispatch.

**Verification commands.**
- `npx eslint src/ui/dispatch.ts src/ui/server.ts`
- Targeted: `npx vitest run src/ui/dispatch.test.ts` + scan-route cases in
  `src/ui/server.test.ts`.

**Dependencies.** C1 (origin/env), C2 (auth gate in front), C3 (append events).

---

### Chunk 6 — POST /api/upload (bearer + provenance binding + schema + atomic write)  ⚠ SAFETY-CRITICAL

**Scope.** The inbound trust boundary. Bearer auth → body cap → provenance binding
(on-demand jobId match / scheduled+replay GitHub run verification) → runId traversal
guard → schema validation → atomic write → ingest record. This is **invariants 3,
4**. The provenance binding is the HIGH fix; the builder must NOT accept any trigger
on bearer alone, and must verify the GitHub run **by workflow path/id, never display
name**.

**Spec refs:** §4.2 (all steps), §7.3, §7.5, §10 failure modes, §9 (upload test set).

**Files.**
- `src/ui/provenance.ts` (new) — pure verification module:
  - `verifyOnDemand({ jobId, targetRepo, stagingUrl }, foldedJobs) →
    { ok, reason? }`: jobId must be a job currently in `dispatched` state (not
    `uploaded`), with matching recorded `targetRepo`/`stagingUrl`.
  - `verifyGithubRun({ githubRunId, githubWorkflow, githubSha, expectedRepo,
    relaxFreshness }, client, clock) → { ok, reason? }` (C6 contract): existence +
    **workflow match by file path or numeric id (never `name`)** + `completed` +
    head_sha match + freshness window (relaxed for replay). Reuse `GitHubHttpClient`
    + `authHeaders` + `parseOwnerRepo`.
  - `runIdExistsOnVolume(runId, reportsDir)` — duplicate-runId dedup check.
- `src/ui/server.ts` (modify) — `handleUploadPost`:
  1. **Bearer auth FIRST, before any body read:** `Authorization: Bearer
     <AUDIT_UPLOAD_TOKEN>`, `timingSafeEqual`. Missing/wrong → `401`. (Basic Auth
     gate already bypassed for this route by C2.)
  2. Body cap 25 MiB (override the 64 KiB default for this route only — see Plan gap
     6) → `413`.
  3. Parse + branch on `trigger`:
     - `on-demand`: `verifyOnDemand` against `foldJobs(dataDir, Date.now())`. Fail
       (no match / already uploaded / target mismatch) → `409`.
     - `scheduled` / `replay`: require `githubRunId`+`githubWorkflow`+`githubSha`;
       `verifyGithubRun` (replay relaxes freshness). Fail → `409`. Also
       `runIdExistsOnVolume` → duplicate → `409`.
  4. **Canonical runId guard (H1 + H2 fix — SAFETY-CRITICAL).** `writeReport`
     (`src/report/json.ts:199`) builds the output dir from **`report.runId`**, and
     `RunReportSchema.runId` is only `z.string().min(1)` — it does NOT enforce
     `RUN_ID_RE`. Validating only the envelope `runId` is therefore a bypassable
     traversal guard: a body with a clean envelope `runId` but
     `report.runId = "../../config"` would write outside `reports/`. The builder
     MUST, before building ANY path:
       - assert `envelope.runId === report.runId` (mismatch → `422`), AND
       - validate that single canonical runId against the shared `RUN_ID_RE`
         (fail → `400`; a malformed runId is a client error, NOT a `409`).
     The SAME canonical runId is used for the dedup check, the path build, and the
     `uploaded`/`report_ingested` event — never the envelope value for one and
     `report.runId` for another (H2: divergence would let a dup pass dedup yet
     overwrite an existing `reports/<report.runId>/`).
  5. **Dedup** (`runIdExistsOnVolume(canonicalRunId, reportsDir)`) — for
     scheduled/replay (and as a guard generally), an existing `reports/<runId>/`
     → `409` (replay is the explicit recovery path, never a silent overwrite).
  6. `RunReportSchema.safeParse(report)` → invalid → `422`, nothing written.
  7. **Serialized write (M1 fix).** `writeTrend` (`src/report/trend.ts`) is a
     read-modify-write over the whole trend file (read all lines → filter → rewrite
     via tmp+rename), NOT an append — concurrent uploads (weekly + on-demand, or two
     replays) can interleave and silently drop a trend line (last-rename-wins).
     Wrap the report-write + trend-append step in `withWorkspaceLock`
     (`src/report/lock.ts`, the existing primitive referenced by spec §4.3) so the
     two uploads serialize. Do NOT describe this as an "atomic append" — it is a
     lock-serialized read-modify-write. **Append `uploaded`/`report_ingested` ONLY
     after both writes succeed**; any write failure → `500`, no ingest event (no
     silent partial — execution-safety contracts).
  8. Respond: on-demand → append `uploaded` for jobId → `200 { runId, jobId }`;
     scheduled/replay → append `report_ingested` (trigger, runId, githubRunId,
     replayed?) → `200 { runId, jobId: null }`.

**Module shape.**
- *Public interface:* `verifyOnDemand`, `verifyGithubRun`, `runIdExistsOnVolume`;
  route `POST /api/upload`.
- *Hidden:* GitHub run JSON shape, workflow-path/id matching, freshness math, ingest
  branching, atomic-write ordering.

**Error handling.** `401` bad bearer (pre-body); `413` oversize; `409` provenance/
dedup; `422` schema; `500` write failure (no ingest event); traversal-shaped runId
rejected before path build.

**Test considerations (pr-reviewer — safety surface).** (spec §9)
- **rejects a valid report for unknown/mismatched `jobId` (409)** and for already-
  `uploaded` jobId (replay guard, 409).
- **flips the matching job `dispatched`→`uploaded`** (happy on-demand path).
- **scheduled/replay rejected when GitHub run-verification fails** (unknown run /
  wrong workflow / not completed); **duplicate `runId` rejected (409)**; response is
  `{ runId, jobId: null }` for these triggers.
- **valid run id but WRONG workflow path/id rejected** (matches by path/id, not
  display name) — the named §4.2 test; inject a client returning a run whose `name`
  matches but whose `path`/`workflow_id` does not.
- **upload schema rejection (422)** + **runId traversal rejection** (e.g.
  `../../etc`-shaped runId → rejected before any path build).
- **H1: `report.runId` traversal — clean envelope `runId` but
  `report.runId="../../config"` → `422`/`400`, NO file written** (the bypass the
  envelope-only guard would miss).
- **H2: envelope `runId` ≠ `report.runId` → `422`** (canonical-runId mismatch),
  no write, no overwrite of an existing run dir.
- **M1: two concurrent uploads with distinct runIds both land their trend lines**
  (serialized write+trend under `withWorkspaceLock` — neither line dropped).
- bad/missing bearer → `401` before body read.
- write failure mid-upload → `500`, no `uploaded` event (job not marked complete).

**Verification commands.**
- `npx eslint src/ui/provenance.ts src/ui/server.ts`
- Targeted: `npx vitest run src/ui/provenance.test.ts` + upload-route cases in
  `src/ui/server.test.ts`.

**Dependencies.** C1 (paths + shared RUN_ID_RE), C2 (bearer bypass of Basic Auth),
C3 (jobs append + fold).
---

### Chunk 7 — CI: on-demand-scan.yml + weekly upload step + uploader script

**Scope.** The GitHub Actions side: new dispatchable workflow, shared uploader,
weekly upload step. No `src/` changes. SAFETY-NOTE: the dispatched workflow still
re-validates the staging URL against the allowlist at the `audit` CLI layer
(defense in depth via existing `preflight`).

**Spec refs:** §6.1, §6.2, §6.3, §7.2 (two independent checks), §9.

**Files.**
- `.github/workflows/on-demand-scan.yml` (new) — `workflow_dispatch` inputs
  `target_repo` (required), `staging_url` (required), `job_id` (required),
  `replay_run_id` (optional). Mirrors `weekly-audit.yml` build+run but **always
  fully scoped**: `audit run --repo <target_repo> --url <staging_url>` (never the
  bare-`--repo` fan-out — spec §4.1). On `replay_run_id` set → skip scan, re-upload
  stored artifacts in `trigger=replay`. Ends with the upload step
  (`trigger=on-demand`, echoes `job_id`). Wires the same staging-auth secrets as
  weekly + `AUDIT_UPLOAD_TOKEN` + `FLY_UPLOAD_URL`.
- `ci/upload-report.mjs` (new) — reads `reports/<runId>/report.json` + `.md` +
  `.sarif`, computes/loads the trend line, packages the §4.2 envelope (`trigger` +
  optional `jobId` + GitHub provenance from the Actions context: `github.run_id`,
  workflow ref/path, `github.sha`), POSTs to `$FLY_UPLOAD_URL` with
  `Authorization: Bearer $AUDIT_UPLOAD_TOKEN`. **Upload failure is non-fatal to the
  scan but exits non-zero (visible red step)** — does not fail the scan job overall
  (spec §6.3, §10).
  **Placement decision (Plan gap 3, RESOLVED by coordinator):** lives at
  `ci/upload-report.mjs` — a project-owned path, NOT repo-root `scripts/` (which is
  framework-managed and could be clobbered by `sync.js`, and is eslint-excluded).
  **L2 — lint coverage:** eslint ignores only `migrations/**` and `scripts/**`, so
  `ci/` IS linted; C7 MUST run `npx eslint ci/upload-report.mjs` and, if the flat
  config's `files` glob doesn't match `.mjs`, add `ci/**/*.mjs` to the eslint
  `files` so this security-relevant envelope-assembly script gets a real G1 gate
  (review alone is insufficient for the provenance envelope). Note the spec §6.3/§9
  path delta (`scripts/` → `ci/`) in the build log.
- `.github/workflows/weekly-audit.yml` (modify) — after the existing artifact
  upload, add a step invoking the uploader with `trigger=scheduled` (no jobId),
  passing the GitHub provenance fields so server-side verification (C6) binds it.

**Module shape.**
- *Public interface:* the workflow inputs + the uploader's env contract.
- *Hidden:* envelope assembly, provenance-field extraction from Actions context.

**Error handling.** Uploader non-2xx from fly → log loudly + exit non-zero, scan job
stays green. Missing `FLY_UPLOAD_URL`/token → skip with a loud warning (weekly must
still archive artifacts).

**Test considerations.** YAML is not unit-tested (static gates only). If the
uploader's envelope-assembly is extracted into a pure helper it MAY get a targeted
test; otherwise validated by review + the C6 server tests exercising the envelope
shape. Do NOT add an e2e CI test (against the testing posture).

**Verification commands.**
- `npx eslint <uploader path>` only if the chosen path is eslint-included (repo-root
  `scripts/` is excluded — see Plan gap 3). Workflows have no lint gate here.

**Dependencies.** C5 (dispatch contract / inputs), C6 (upload envelope contract).

---

### Chunk 8 — Dockerfile.ui + fly.toml

**Scope.** The lightweight UI image + fly app config. No source changes.

**Spec refs:** §3.1, §9 (Dockerfile.ui, fly.toml bullets).

**Files.**
- `Dockerfile.ui` (new) — `node:20-bookworm-slim`; `npm ci`; `npm run build`
  (server `dist/`) + `npm run build:client` (SPA `ui/dist/`); copy checked-in
  `config/`; no scanner binaries; `CMD ["node","dist/cli.js","ui"]`. Reads
  `DATA_DIR`/`BIND_HOST`/`ALLOWED_ORIGIN` + secrets from the fly environment.
- `fly.toml` (new) — app `sectool`; `[mounts]` volume → `/data`; `[http_service]`
  internal port (the `ui` default 4173 unless overridden), `force_https = true`;
  health check → `GET /healthz`; region `syd` (spec §11 open question — default;
  builder must not silently pick another).

**Module shape.** Infra artifacts; public interface is the image + fly config.

**Error handling.** Health check failing keeps fly from routing traffic; production
fail-closed (C2) ensures a misconfigured secret set aborts startup so the health
check fails loudly rather than serving unauthenticated.

**Test considerations.** No unit tests (infra). Reviewer checks: slim base, no
scanner binaries, volume at `/data`, healthz wired, force_https, `BIND_HOST=0.0.0.0`
set in the fly env so fly's proxy can reach the server.

**Verification commands.** None at G1 (no lint/test target for Dockerfile/toml). G2
build is unaffected (separate Dockerfile).

**Dependencies.** Behavioural dependency on C1–C6; no source dependency — author
after C6.

---

### Chunk 9 — UI: Run-a-scan panel + api helpers + trigger-provenance badge

**Scope.** SPA additions: a new "Run a scan" screen with two dropdowns + button, an
in-progress indicator driven by `/api/scan-jobs` polling, api helpers, a sidebar nav
entry, and a trigger-provenance badge (operator / scheduled / replay) on report
views.

**Spec refs:** §4.1 selection-UI note, §8, §9 (UI bullet).

**Files.**
- `ui/src/api.ts` (modify) — add `triggerScan(repo, stagingUrl)` (mirror the
  `sendForFixing` CSRF pattern: fetch nonce, POST `/api/scan` with `X-Audit-CSRF`)
  and `fetchScanJobs()` (GET `/api/scan-jobs`).
- `ui/src/screens/RunAScan.tsx` (new) — two dropdowns populated from
  `fetchTargetsConfig()` (repos + staging targets) and `fetchAllowlistConfig()`
  (host display). **Dropdowns only — never free-text** (spec §4.1). "Run scan"
  button → `triggerScan` → poll `fetchScanJobs()` until the jobId flips to
  `complete` (or `failed`/`timed_out`).
- `ui/src/App.tsx` (modify) — add `'runAScan'` to the `Screen` union + route.
- `ui/src/components/Sidebar.tsx` (modify) — add a "Run a scan" nav entry (desktop
  sidebar + mobile bottom nav).
- `ui/src/vocabulary.ts` (modify) — add the `NAV_LABELS` entry.
- Trigger-provenance badge: a small component on report/job rows reflecting
  `trigger`/`replayed` (operator vs scheduled vs replay).

**Module shape.**
- *Public interface:* `triggerScan`, `fetchScanJobs`, the new screen + nav entry.
- *Hidden:* polling loop, dropdown population, CSRF fetch.

**UX considerations.**
- **Loading/empty/error states:** disable the button while dispatching; show "Scan
  dispatched — waiting for results" while `in_progress`; clear failure message on
  `dispatch_failed`/`timed_out`/`502`. Empty config → disabled dropdowns with an
  explanatory note.
- **Permissions:** entire dashboard is behind Basic Auth (single shared credential)
  — no per-screen gating beyond that.
- **Real-time:** poll `/api/scan-jobs` on an interval, cleared on unmount/terminal
  state (no websocket; matches the existing read-only SPA).
- **Mobile capability:** Tier 2 (operator workflow). Responsive single-column form
  below md; the two dropdowns stack; "Run scan" primary button ≥44px touch target;
  add the nav entry to the mobile bottom nav (now 6 items — confirm layout) or a
  More affordance; no hover-only interactions.

**Test considerations.** Frontend tests are `none_for_now` per the testing posture —
do NOT add component tests. Validation is via `npm run build:client` (G2) + review.

**Verification commands.**
- `npx eslint ui/src/api.ts ui/src/screens/RunAScan.tsx ui/src/App.tsx
  ui/src/components/Sidebar.tsx ui/src/vocabulary.ts`
- (Client build runs at G2, not per-chunk.)

**Dependencies.** C4 (`/api/scan-jobs`), C5 (`/api/scan`), C6 (`/api/upload` so jobs
reach `complete`).

---

### Chunk 10 — docs/deployment.md + ADR + KNOWLEDGE.md

**Scope.** Documentation only.

**Spec refs:** §5.3 (ADR), §9 (ADR, docs, KNOWLEDGE bullets), §5.2 (secrets table).

**Files.**
- `docs/deployment.md` (new) — deploy steps, the §5.2 secret-setup table, first-run,
  replay procedure. **State explicitly that `AUDIT_GH_DISPATCH_TOKEN` must be a
  fine-grained PAT scoped to ONLY `AUDIT_WORKFLOW_REPO`, Actions read+write only — no
  broader repo/org perms** (spec §9 docs bullet; it both dispatches and verifies
  upload provenance).
- `docs/decisions/<NNNN>-flyio-loopback-relaxation.md` (new ADR) — "fly.io
  deployment relaxes loopback-only binding; compensated by Basic Auth + fly proxy
  (TLS-terminated) + production fail-closed." Records the v1 "never 0.0.0.0"
  invariant consciously relaxed for fly.io only, and the Plan gap 7 decision on
  runtime-vs-startup secret checks.
- `KNOWLEDGE.md` (modify) — note the two-image split (`Dockerfile` scanner vs
  `Dockerfile.ui` lightweight) and the **workflow_dispatch-has-no-run-id** gotcha
  (why a correlation nonce is needed — §4.1).
- **L3 — document the runtime-secret degradation mode.** The ADR/deployment doc
  MUST record that scan/upload secrets are runtime-checked, not startup-required
  (Plan gap 7): the dashboard can be "up, authenticated, and green" yet structurally
  unable to dispatch (missing `AUDIT_GH_DISPATCH_TOKEN` → 502 only on click) or
  ingest (missing `AUDIT_UPLOAD_TOKEN` → 401 to CI, silent). `docs/deployment.md`
  MUST include a **post-deploy smoke check** (trigger one scan end-to-end + confirm
  the upload lands) so this silent-degradation mode is caught at deploy time.

**Test considerations.** None (docs).

**Verification commands.** None.

**Dependencies.** All prior chunks (documents shipped behaviour). Author last.
---

## Plan gaps / decisions the builder must NOT improvise

1. **GitHub API client — reuse, do not add a dependency.** `src/fix/github.ts`
   already provides `GitHubHttpClient`/`GitHubRequest`/`GitHubResponse`,
   `authHeaders`, `parseOwnerRepo`, and a `fetch`-based default client
   (`defaultGitHubClient`, currently module-private). The builder MUST reuse this
   contract for both the workflow_dispatch call (C5) and the run-verification call
   (C6), and export the default client (or factor a tiny shared one) — **NOT**
   introduce `octokit`/`axios`/a new fetch wrapper. The injectable-client testing
   pattern is already established and must be mirrored.

2. **`RUN_ID_RE` is currently inline in `src/cli.ts`** (`findLatestReport`). Extract
   it to a single shared constant (`src/schemas/run-id.ts`, done in C1) and reuse it
   in the upload traversal guard (C6) and CLI. Do NOT author a second copy — a
   divergent regex is a traversal-guard hazard.

3. **Uploader script placement (C7).** Repo-root `scripts/` is framework-managed and
   eslint-excluded per CLAUDE.md (deployed by `sync.js`). The spec names
   `scripts/upload-report.mjs`. Decide with the operator whether the uploader lives
   at repo-root `scripts/` (eslint-excluded, risk of `sync.js` overwrite) or a
   project-owned path (e.g. `ci/upload-report.mjs`). **Do not silently drop it into
   the framework-managed dir without confirming it won't be clobbered.**

4. **`writeReport`/`writeTrend` are NOT modified.** They already accept a path
   override; DATA_DIR-awareness is delivered by the C6 call site passing resolved
   paths. Do not refactor `REPO_ROOT` internals out of those modules (would touch
   the CLI's report-writing path unnecessarily).

5. **Pre-existing `/api/trend` vs `/api/history/trend` mismatch.** `ui/src/api.ts`
   `fetchTrend()` calls `/api/history/trend` but `server.ts` serves `/api/trend`.
   Pre-existing, OUT OF SCOPE. Flagged so the builder does not "fix" it mid-chunk as
   an unrelated change. Note in the build log; address separately if it actually
   breaks the trend view.

6. **Body-cap override for `/api/upload` (25 MiB).** The existing `readBody` is
   hardcoded to 64 KiB (`MAX_BODY_BYTES`). C6 needs a per-route cap. Parameterize
   `readBody` (add a `maxBytes` arg defaulting to the existing 64 KiB) rather than
   raising the global cap — `/api/fix` and `/api/scan` keep the tight cap; only
   `/api/upload` gets 25 MiB.

7. **Scan/upload secrets: runtime-checked, not startup-required.** Spec §5.1 names
   ONLY `AUDIT_BASIC_AUTH_USER/PASS`, `ALLOWED_ORIGIN`, `BIND_HOST` as the
   production fail-closed startup set. `AUDIT_GH_DISPATCH_TOKEN`,
   `AUDIT_WORKFLOW_REPO`, `AUDIT_UPLOAD_TOKEN` are runtime-checked: a missing
   dispatch token → `/api/scan` 502; a missing upload token → `/api/upload` 401.
   Rationale: the read-only dashboard should still serve during a scan/upload secret
   rotation. Pin this exactly in C2/C5/C6; record the decision in the ADR (C10). Do
   NOT promote these into the startup fail-closed set without operator sign-off.

---

## Deferred items (from the spec, not built here)

- **GitHub OIDC verification for uploads** — deferred (spec §11). v1 uses
  correlation nonce + GitHub run-provenance verification + runId dedup. The honest
  residual gap ("real run id + fabricated body") is accepted for an internal tool.
- **Static-only / live-only on-demand modes** — deferred (spec §11). v1 requires
  both `repo` and `stagingUrl`. No `mode` field in this build.
- **Report retention / volume pruning** — deferred (spec §11): keep all in v1.
- **fly.io region confirmation** — default `syd`; confirm with operator (spec §11).

---

## Executor notes

Test gates and whole-repo verification scripts (`npm run test:gates`,
`npm run test:qa`, `npm run test:unit`, `npm test`, `scripts/verify-*.sh`,
`scripts/gates/*.sh`, `scripts/run-all-*.sh`) are CI-only. They do NOT run during
local execution of this plan, in any chunk, in any form. Targeted execution of unit
tests authored within this plan is allowed; running the broader suite is not.

**G2 (end-of-construction, coordinator-owned, run ONCE against integrated branch
state):** `npm run lint`, `npm run typecheck`, `npm run build`, `npm run
build:client`. (`npm run benchmark` is a CI/G2 concern, not per-chunk.) Do not run
these per-chunk.

New `src/**/*.test.ts` files authored by this plan: `src/ui/env.test.ts`,
`src/ui/auth.test.ts`, `src/ui/scan-jobs.test.ts`, `src/ui/dispatch.test.ts`,
`src/ui/provenance.test.ts`, and route cases in `src/ui/server.test.ts`. These map
1:1 to the §9 deliverables checklist — every §9 test is covered: auth gate,
production fail-closed, ALLOWED_ORIGIN/BIND_HOST startup-fail, registry rejection,
both-fields-required, upload jobId mismatch/replay-guard, dispatched→uploaded flip,
scheduled/replay verification-fail + dup runId + `jobId:null`, wrong-workflow-path
rejection, fold identity-carry, schema 422 + traversal, parallel-append integrity,
dispatch-to-AUDIT_WORKFLOW_REPO, dispatch_failed-not-in-progress, origin guard.

**§9-checklist → chunk map (every spec test mapped):**

| §9 test | Chunk |
|---|---|
| auth gate rejects unauthenticated | C2 |
| production fail-closed (secrets missing) | C2 |
| production fail when ALLOWED_ORIGIN / BIND_HOST unset | C2 |
| registry rejects off-allowlist / unregistered / disabled | C5 |
| /api/scan rejects repo-only and URL-only | C5 |
| /api/scan dispatches to AUDIT_WORKFLOW_REPO not scan target | C5 |
| dispatch failure → dispatch_failed (not in-progress) | C5 |
| /api/upload rejects unknown/mismatched jobId + already-uploaded (409) | C6 |
| /api/upload flips dispatched→uploaded | C6 |
| scheduled/replay rejected on GitHub verify fail + dup runId + jobId:null | C6 |
| valid run id but WRONG workflow path/id rejected | C6 |
| upload schema rejection (422) + runId traversal rejection | C6 |
| report.runId traversal (H1) — clean envelope runId, bad report.runId → no write | C6 |
| envelope runId ≠ report.runId (H2) → 422, no overwrite | C6 |
| write-then-trend partial failure → 500, no `uploaded` event | C6 |
| concurrent uploads both land trend lines (M1, serialized) | C6 |
| repo-side registry rejection (M2) — allowlisted URL + disabled repo → 400 | C5 |
| ConfigError from registry load → 500 not 400 (M3) | C5 |
| scan-job fold preserves targetRepo/stagingUrl through states | C3 |
| parallel /api/scan dispatches don't drop/corrupt entries | C3 (store) + C5 (route) |
| origin guard (ALLOWED_ORIGIN) | C1 |
| GET /healthz | C4 |
