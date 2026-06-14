# Spec — fly.io dashboard deployment with on-demand scan triggering

**Status:** draft (awaiting operator review)
**Spec date:** 2026-06-14
**Author:** claude (brainstorming session; operator: michael@breakoutsolutions.com)
**Build slug:** flyio-dashboard
**Supersedes (partially):** the audit-tool-v1 spec §2 non-goal "Hosted / multi-user
SaaS dashboard." This deployment is **internal-team, single-tenant, shared-secret
auth** — not multi-user SaaS — but it does make the dashboard internet-reachable,
which the v1 spec scoped out. This document records that scope change explicitly.

---

## 1. Goal

Deploy the existing `audit ui` dashboard to fly.io (`sectool.fly.dev`) so the
internal Breakout team can browse audit results from anywhere, and **trigger
scans on demand** from the UI. Scanning itself continues to run in GitHub
Actions (where the scanner image, repo access, and secrets already live) — fly.io
hosts only the UI, the result store, and the trigger/upload plumbing.

### Why not run scanning on fly.io

The scanner image is heavy (Semgrep, ZAP, Nuclei, JRE — see `Dockerfile`) and
scans are bursty. Running them on fly.io would mean a large always-on machine or
cold-start pain, plus duplicating the repo-access and staging-auth secrets onto a
second platform. GitHub Actions already does this work on the weekly cron. The
on-demand path reuses that exact machinery.

## 2. Non-goals

- **Running scanners on fly.io.** All scanning stays in GitHub Actions.
- **Multi-user auth / SSO / per-user accounts.** One shared Basic Auth credential
  for the whole internal team. No user model.
- **Weakening the §4 safety contract.** The allowlist remains the sole authority
  on what can be live-scanned. The UI cannot scan anything not already registered
  and allowlisted. This spec adds NO override path. (Restated as a hard
  requirement in §7.)
- **Public / customer access.** Internal team only.
- **Editing target-repo code.** Unchanged from v1 — the tool orchestrates, never
  writes target code.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  fly.io — sectool.fly.dev  (lightweight Node image)       │
│                                                          │
│  src/ui/server.ts (extended)                             │
│   ├── Basic Auth gate (all routes except /healthz)       │
│   ├── GET  /api/* ............ existing read-only views   │
│   ├── POST /api/fix .......... existing (origin generalized)│
│   ├── POST /api/scan ......... NEW — trigger CI scan      │
│   ├── GET  /api/scan-jobs .... NEW — list trigger history │
│   └── POST /api/upload ....... NEW — CI pushes results    │
│                                                          │
│  Persistent volume  /data                                │
│   ├── reports/  (CI writes via /api/upload)              │
│   ├── history/  (trend.jsonl, appended on upload)        │
│   └── scan-jobs.jsonl  (trigger audit log)               │
└──────────────────────────────────────────────────────────┘
      │ workflow_dispatch (GitHub REST API)         ▲ POST report
      ▼                                             │ (bearer)
┌──────────────────────────────────────────────────┴───────┐
│  GitHub Actions                                          │
│   on-demand-scan.yml  (NEW, workflow_dispatch)           │
│   weekly-audit.yml    (existing + upload step appended)  │
│     build scanner image → audit run → POST → /api/upload │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Two images, one repo

The repo currently ships ONE `Dockerfile` (the scanner image: ~heavy). We add a
second, lightweight image for fly.io:

- **`Dockerfile`** (existing, unchanged) — scanner image used by CI.
- **`Dockerfile.ui`** (new) — `node:20-bookworm-slim`, builds `dist/` + the React
  SPA (`ui/dist/`), copies checked-in `config/`, runs `node dist/cli.js ui`. No
  scanner binaries. This is what fly.io builds and deploys.

Config files (`targets.json`, `allowed-staging-hosts.json`, `baseline.json`) are
version-controlled and baked into the image. They are read-only on fly.io — the
dashboard never mutates them. Only runtime artifacts (`reports/`, `history/`,
`scan-jobs.jsonl`) live on the persistent volume.

### 3.2 Path configuration

`src/ui/server.ts` currently hardcodes `REPORTS_DIR`, `HISTORY_DIR`,
`CONFIG_DIR`, `FIXES_JSON` relative to `REPO_ROOT`. We introduce a single
`DATA_DIR` env var (default = `REPO_ROOT` for local/dev parity; set to `/data`
on fly.io) that relocates the runtime-writable dirs. `CONFIG_DIR` and `SPA_DIR`
stay relative to the image (read-only, baked in).

## 4. New endpoints

### 4.1 POST /api/scan — trigger a scan

Triggered by the UI "Run a scan" form. Body — **both fields required** in v1
(see "Scan scope semantics" below):

```jsonc
{ "repo": "<registered-repo-name>", "stagingUrl": "<registered-staging-url>" }
```

Server-side flow:

1. **Auth:** Basic Auth (human session) — already enforced by the global gate.
2. **CSRF/origin:** same nonce + `ALLOWED_ORIGIN` check as `/api/fix`.
3. **Validate against registry — the safety gate.** `repo` must match an
   `enabled` repo in `targets.json`; `stagingUrl` must match an `enabled`
   staging target whose host is on the allowlist. Both required and non-empty.
   Anything else → `400`, no dispatch. This is enforced with the SAME
   `loadAllowlist` / `loadTargets` functions the CLI uses, so the UI cannot
   express a scan the CLI would refuse.
4. **Mint a correlation job.** Generate a random `jobId` (crypto, 16+ bytes hex).
   This is the provenance token that binds the eventual upload back to THIS
   dispatch (§4.2). Append a **`requested`** event to the scan-jobs log (§4.3)
   BEFORE the GitHub call, so a crash mid-dispatch still leaves a trace — but
   `requested` is NOT shown as "in progress" (§4.3 state machine).
5. **Dispatch to the FIXED audit-tool workflow repo** — not the scan target.
   The `on-demand-scan.yml` workflow lives only in THIS repo, so the dispatch
   URL is built from `AUDIT_WORKFLOW_REPO` (e.g. `breakoutsolutions/sectool`),
   never from the selected scan target:
   `POST /repos/{AUDIT_WORKFLOW_REPO}/actions/workflows/on-demand-scan.yml/dispatches`
   with `ref` + `inputs: { target_repo, staging_url, job_id }`, using a
   fine-grained PAT (`AUDIT_GH_DISPATCH_TOKEN`, fly.io secret, `actions:write` on
   the audit-tool repo only). The scan target is `inputs.target_repo` (renamed
   from `repo` to remove any "dispatch repo vs. scan repo" ambiguity); `job_id`
   is the correlation nonce CI echoes back.
   - On `204` → append a **`dispatched`** event for `jobId`; respond `202 { jobId }`.
   - On GitHub failure (token expired, network) → append a **`dispatch_failed`**
     event for `jobId`; respond `502` with a plain-English message. The job is
     never presented as in-progress.

> **Why a correlation nonce, not a run id?** GitHub's `workflow_dispatch` REST
> call returns `204 No Content` — it does NOT return the id of the workflow run
> it triggered. fly.io therefore cannot learn the run id at dispatch time to
> correlate the later upload. The fly-generated `jobId`, passed as a workflow
> input and echoed back by CI, is the binding instead. (§4.2 enforces the match.)

The UI shows the dispatched job as "in progress" and polls `/api/scan-jobs`
until that `jobId` flips to `uploaded`.

### Scan scope semantics — why both fields are required

`audit run --repo X` with **no** `--url` scans X statically **and live-scans
every enabled staging target** (`doRun`, cli.ts: when `--url` is absent the
staging filter falls through to all enabled targets). An on-demand endpoint that
passed through a repo-only request would therefore fan a live scan across the
whole portfolio — a broad-scan footgun. v1 closes this by requiring **both**
`repo` and `stagingUrl`, so the dispatched CI command is always the fully-scoped
`audit run --repo <repo> --url <stagingUrl>` (exactly one repo, exactly one
staging host).

`repo` and `stagingUrl` are **independent** selections — they need not be
related. This tool models static repo scanning and live staging scanning as
separate surfaces with no 1:1 mapping, so the endpoint does NOT require the URL
to "belong to" the repo; it only requires each to be independently registered,
enabled, and (for the URL) allowlisted. Static-only and live-only on-demand
modes are a deliberate **future enhancement** (§11), not v1 — the weekly cron
already covers full-portfolio scanning.

> **Note on selection UI:** the form presents **dropdowns populated from
> `/api/config/targets` and `/api/config/allowlist`** — never free-text. Free-text
> entry is not offered. Even so, the server-side registry check in step 3 is the
> real guarantee; the dropdown is convenience, not security.

### 4.2 POST /api/upload — CI pushes a finished report

The one new **inbound trust boundary**. Called by CI at the end of a scan. The
bearer token authenticates the *caller*; the envelope's `jobId`/`trigger` fields
authenticate the *report↔run relationship* (the HIGH finding from review — a
leaked token must not be able to inject an arbitrary report into the trusted
dashboard).

Envelope:

```jsonc
{
  "trigger": "on-demand" | "scheduled" | "replay",
  "jobId": "<correlation nonce from /api/scan>",   // required when trigger=on-demand
  "targetRepo": "<repo>", "stagingUrl": "<url>",    // echoed back for cross-check
  "runId": "<RUN_ID_RE>",
  // GitHub provenance — required for scheduled & replay (bind to a real CI run):
  "githubRunId": "<actions run id>", "githubWorkflow": "<workflow name>",
  "githubSha": "<commit sha>", "sourceRunId": "<original runId>",   // sourceRunId: replay only
  "report": { /* RunReport */ }, "markdown": "...", "sarif": "...", "trendLine": { }
}
```

1. **Auth:** `Authorization: Bearer <AUDIT_UPLOAD_TOKEN>` — a secret DISTINCT
   from the human Basic Auth password. Constant-time compared. Missing/wrong →
   `401`, before any body read. Basic Auth gate is bypassed for this route (it
   uses bearer instead), so CI never needs the human password.
2. **Body cap:** larger than `/api/fix` (reports can be MBs) — cap at e.g. 25 MiB;
   over → `413`.
3. **Provenance binding (the HIGH fix):**
   - `trigger: "on-demand"` → `jobId` MUST match a scan-jobs entry currently in
     `dispatched` state, and the envelope `targetRepo`/`stagingUrl` MUST equal
     that entry's recorded values. No match, already-`uploaded`, or mismatched
     target → `409 Conflict`, nothing written. (Already-uploaded guard makes the
     endpoint idempotent-safe and blocks replay of a captured envelope.)
   - `trigger: "scheduled"` → the weekly cron has no fly-issued `jobId`. It is
     NOT accepted on bearer auth alone. It MUST carry `githubRunId` +
     `githubWorkflow` + `githubSha`, and these are **verified server-side against
     `AUDIT_WORKFLOW_REPO` via the GitHub API** (using `AUDIT_GH_DISPATCH_TOKEN`,
     which gains `actions:read`): the run must exist, belong to the expected
     workflow, be `status=completed`, and be recent (within a freshness window).
     The fields are **proof checked against GitHub, not self-asserted metadata**.
     Mismatch/unknown run → `409`. Its `runId` MUST also be new (duplicate on the
     volume → `409`). (OIDC is the stronger option, deferred as overkill — §11.)
   - `trigger: "replay"` → operator-initiated re-upload of a prior run (§6.3).
     Carries `sourceRunId` (the original) + the same GitHub provenance fields,
     verified the same way (the freshness window is relaxed for replay since the
     run may be old, but existence + workflow + completion are still checked);
     recorded with `replayed: true` so history distinguishes it from both cron
     and operator-triggered scans. Duplicate live `runId` → `409`.

   > **Residual risk (stated honestly).** Server-side verification proves a real
   > matching CI run happened; it does NOT cryptographically prove the report
   > *body* came from that run ("real run, fabricated body" remains theoretically
   > possible for a holder of both the upload token AND knowledge of a real
   > run id). This is acceptable for an internal tool where the token is a
   > CI-only secret; OIDC would close it (§11). The §7 claim is scoped to match.
4. **Schema validation:** parse `report` against the existing Zod `RunReport`
   schema. Invalid → `422`, nothing written.
5. **Write:** atomically write `reports/<runId>/report.json` (+ `.md`, `.sarif`
   if included) to the volume, and append the trend line to
   `history/trend.jsonl`. Reuses the existing `writeReport` / `writeTrend` logic
   (now `DATA_DIR`-aware, §3.2). `runId` is validated to match `RUN_ID_RE`
   before any path is built, to prevent traversal.
6. **Record ingest — by trigger** (scheduled/replay have NO fly-issued `jobId`):
   - `on-demand` → append an `uploaded` event for `jobId`; respond
     `200 { runId, jobId }`.
   - `scheduled` / `replay` → append a separate `report_ingested` event
     (`{ event, trigger, runId, githubRunId, replayed?, at }`) — no `jobId`;
     respond `200 { runId, jobId: null }`.

   The response shape is `{ runId, jobId: string | null }` — `jobId` is present
   only for on-demand uploads.

> The CI→fly.io payload is a single JSON envelope (above) rather than multipart —
> simpler to validate and matches how the data already exists in memory at the
> end of a run.

### 4.3 GET /api/scan-jobs — trigger history

Returns the current state of each job (most recent first) so the UI can show
"Scan dispatched 2m ago — waiting for results." Read-only, Basic-Auth-gated.

**Storage is an append-only event log, not a mutable JSON object** (the
concurrency MEDIUM from review). Every state change is a line append to
`history/scan-jobs.jsonl`:

```jsonc
{"event":"requested","jobId":"a1b2…","targetRepo":"X","stagingUrl":"https://…","at":"…"}
{"event":"dispatched","jobId":"a1b2…","at":"…"}
{"event":"requested","jobId":"c3d4…","targetRepo":"Y","stagingUrl":"https://…","at":"…"}
{"event":"dispatch_failed","jobId":"c3d4…","reason":"github 401","at":"…"}
{"event":"uploaded","jobId":"a1b2…","runId":"2026-…","at":"…"}
```

**Folding rule.** Group events by `jobId`. **Immutable identity fields
(`targetRepo`, `stagingUrl`, first `at`) are taken from the `requested` event;
the current state is the latest status event.** This is NOT a naive "last event
wins" — later events (`dispatched`, `uploaded`) deliberately omit the target
metadata to keep records small, so a completed job must still surface its
`targetRepo`/`stagingUrl` from its `requested` event. (A test asserts a
completed job still shows its target.)

**State machine** (state = latest status event per `jobId`):

| Last event | UI state |
|---|---|
| `requested` | pre-dispatch (transient; only seen if a crash interrupted dispatch) — NOT "in progress" |
| `dispatched` | **in progress** (until `uploaded` or TTL) |
| `dispatch_failed` | **failed** (never shown as in-progress) |
| `uploaded` | complete |
| `dispatched`, no `uploaded` after TTL | **timed out** (derived, not stored) |

**Append semantics.** One JSON object per line, newline-terminated, each record
small (a few fields). A reader folds line by line and tolerates **only a single
malformed trailing partial line** (a write torn by a crash) — it never tries to
repair earlier lines. Concurrent appends from parallel dispatches don't race on a
read-modify-write because there is no read-modify-write: each event is a single
newline-terminated append. (`withWorkspaceLock` exists in `src/report/lock.ts`
if a stronger guarantee is ever wanted, but per-line append is sufficient here.)

### 4.4 GET /healthz — fly.io health check

Unauthenticated, returns `200 {"ok":true}`. The ONLY route exempt from Basic
Auth. No data leak (static OK body).

## 5. Auth

### 5.1 Human access — HTTP Basic Auth

A global middleware in front of all routes except `/healthz` and `/api/upload`
(which uses bearer). Credentials from fly.io secrets:
`AUDIT_BASIC_AUTH_USER` + `AUDIT_BASIC_AUTH_PASS`. Constant-time comparison.
Missing/wrong → `401` with `WWW-Authenticate: Basic realm="sectool"`.

When these env vars are UNSET (local dev), the gate is disabled — preserving the
current `audit ui` localhost experience with zero friction.

**Fail-closed in production (the auth MEDIUM from review).** "Disabled when
unset" is convenient locally but dangerous on fly.io: a missing or mid-rotation
secret could silently publish the dashboard unauthenticated — especially since
`BIND_HOST=0.0.0.0` is deliberately allowed there. Rule:

- **Production is inferred from `FLY_APP_NAME` being set** (fly.io sets this
  automatically), or explicitly from `REQUIRE_AUTH=true`.
- In production mode, **missing required config is a hard startup failure** —
  the server refuses to listen and exits non-zero. The dashboard never comes up
  unauthenticated or misconfigured on fly.io. Required in production:
  `AUDIT_BASIC_AUTH_USER`/`PASS`, **`ALLOWED_ORIGIN`** (no localhost default —
  the origin guard must be explicit), and **`BIND_HOST`**. Any missing → refuse
  to start, naming the missing var.
- Outside production (no `FLY_APP_NAME`, no `REQUIRE_AUTH`), unset secrets just
  disable the gate and fall back to the localhost defaults as today.

Startup logs the resolved state explicitly ("Basic Auth: enabled (production)" /
"disabled (local dev)") so it is never ambiguous.

### 5.2 Secrets summary

| Secret | Lives in | Purpose |
|---|---|---|
| `AUDIT_BASIC_AUTH_USER/PASS` | fly.io | Human dashboard login |
| `AUDIT_UPLOAD_TOKEN` | fly.io **and** GitHub Actions | CI → fly.io upload auth |
| `AUDIT_GH_DISPATCH_TOKEN` | fly.io | fly.io → GitHub workflow_dispatch + upload run-verification (`actions:read`+`write` on the audit-tool repo only, §4.2) |
| `AUDIT_WORKFLOW_REPO` | fly.io | Fixed `owner/repo` the dispatch targets (the audit-tool repo, e.g. `breakoutsolutions/sectool`) — NOT the scan target |
| `FLY_UPLOAD_URL` | GitHub Actions | Where CI POSTs results (`https://sectool.fly.dev/api/upload`) |

### 5.3 Origin guard generalization

`src/ui/server.ts` hardcodes `expectedOrigin = http://127.0.0.1:${port}` for the
`/api/fix` CSRF check. Generalize to an `ALLOWED_ORIGIN` env var (default
`http://127.0.0.1:<port>` when unset, for local parity; set to
`https://sectool.fly.dev` on fly.io). Applies to `/api/fix` and the new
`/api/scan`. **Loopback binding is also generalized:** the server currently binds
`127.0.0.1` only; on fly.io it must bind `0.0.0.0` so fly's proxy can reach it.
Introduce `BIND_HOST` env (default `127.0.0.1`; `0.0.0.0` on fly.io). In
production both `ALLOWED_ORIGIN` and `BIND_HOST` are **required** (§5.1
fail-closed) — no silent localhost default when the app is internet-facing. The
§5.2 "never 0.0.0.0" invariant from v1 is **consciously relaxed for the fly.io
deployment only**, compensated by Basic Auth + the fly proxy (TLS-terminated,
no raw port exposure). Recorded as an ADR (§9).

## 6. CI changes

### 6.1 New workflow — on-demand-scan.yml

`.github/workflows/on-demand-scan.yml`: `workflow_dispatch` with inputs
`target_repo` (string, required), `staging_url` (string, required), and `job_id`
(string, required — the correlation nonce from §4.1). Mirrors `weekly-audit.yml`'s
build+run, scoping `audit run --repo <target_repo> --url <staging_url>` (always
fully scoped — never the bare-`--repo` fan-out, §4.1). Ends with the upload step
(§6.3) called with `trigger=on-demand` and the echoed `job_id`. The same
staging-auth secrets as the weekly workflow are wired in.

A second `workflow_dispatch` input `replay_run_id` (string, optional) supports
operator replay (§6.3, the replay LOW from review): when set, the workflow skips
scanning and re-uploads the named prior run's artifacts in `trigger=replay` mode.

> **Safety note:** even though `staging_url` arrives as a workflow input, the
> `audit run` command re-validates it against the checked-in allowlist (existing
> `preflight` / §4 behavior). A dispatch carrying an off-allowlist URL fails at
> the `audit` layer exactly as a manual CLI run would. Two independent checks
> (fly.io server + audit CLI) must both pass.

### 6.2 weekly-audit.yml — append upload step

After the existing artifact upload, add a step that POSTs the produced report(s)
to `$FLY_UPLOAD_URL` with the bearer token, so the weekly run also lands in the
dashboard. (Reuses the §6.3 uploader.)

### 6.3 Upload step

A small reusable script (`scripts/upload-report.mjs` or inline `node`) that reads
the run's `report.json` / `.md` / `.sarif` + computes the trend line, packages
the §4.2 envelope (with `trigger` + `jobId`), and POSTs it. Called by:

- **on-demand-scan.yml** — `trigger=on-demand`, passing the dispatched `job_id`.
- **weekly-audit.yml** — `trigger=scheduled`, no `jobId`.
- **Replay** — `on-demand-scan.yml` with `replay_run_id` set re-POSTs a prior
  run's stored artifacts as `trigger=replay` with `sourceRunId=<replay_run_id>`
  (the operator recovery path for when fly.io was down at original upload time).
  Recorded with `replayed: true` so history distinguishes manual recovery from
  the weekly cron. Artifacts come from the GH Actions artifact retained for that
  run, or from a committed report dir.

Failure to upload is **non-fatal** to the scan (the artifact is still in GH
Actions) but is logged loudly and surfaces as a non-zero step (visible in the
Actions UI) without failing the scan job overall.

## 7. Safety contract — explicit preservation

Restating the non-negotiable, because this change widens the attack surface:

1. **No new scan target path.** `/api/scan` can only dispatch scans for
   registry-registered, allowlist-approved targets. The validation uses the same
   `loadAllowlist`/`loadTargets`/`preflight` code as the CLI. There is no flag,
   header, or body field that bypasses it.
2. **Defense in depth.** Off-allowlist requests are rejected twice: at the fly.io
   server (before dispatch) and at the `audit` CLI inside CI (before any packet).
3. **Upload cannot inject arbitrary files.** `/api/upload` validates `runId`
   against `RUN_ID_RE` and the body against the `RunReport` Zod schema; only
   known-shape files at computed paths are written.
4. **The allowlist file is read-only on fly.io** (baked into the image, on no
   writable volume path). The dashboard exposes no endpoint that edits it.
5. **Upload provenance, not just upload auth.** No trigger class is accepted on
   bearer auth alone; every upload is bound to a verified run:
   - `on-demand` → must carry a `jobId` matching a live `dispatched` job with the
     same target; already-uploaded job rejected (replay guard). The `jobId` is a
     server-minted secret nonce, so a leaked upload token alone cannot forge it.
   - `scheduled` / `replay` → `githubRunId`/`githubWorkflow`/`githubSha` are
     **verified server-side against the GitHub API** (run exists, right workflow,
     completed, fresh) + non-duplicate `runId`. These are checked facts, not
     self-asserted metadata.
   - **Residual gap (honest scope):** server-side verification proves a real
     matching run occurred but does not cryptographically prove the report *body*
     originated from it — "real run id + fabricated body" remains possible for a
     holder of both the CI-only upload token and a known run id. Accepted for an
     internal tool; OIDC would close it (deferred, §11). (§4.2.)

## 8. UI changes

- New "Run a scan" screen/panel: two dropdowns (repo, staging target) sourced
  from existing `/api/config/*` endpoints, a "Run scan" button → `POST /api/scan`.
- A "scan in progress" indicator driven by `/api/scan-jobs` + polling
  `/api/reports` for a newly-arrived run.
- `ui/src/api.ts`: add `triggerScan()` and `fetchScanJobs()` helpers (mirroring
  the existing `sendForFixing` CSRF pattern).
- Sidebar gets a "Run a scan" nav entry.

## 9. Deliverables checklist

- [ ] `Dockerfile.ui` (lightweight UI image)
- [ ] `fly.toml` (app config, volume mount `/data`, health check `/healthz`,
      internal port, `[http_service]` with forced HTTPS)
- [ ] `DATA_DIR` / `BIND_HOST` / `ALLOWED_ORIGIN` env plumbing in `server.ts`
      (and `DATA_DIR`-awareness in `src/report/json.ts` + `src/report/trend.ts`,
      which currently hardcode `REPO_ROOT` paths)
- [ ] Basic Auth middleware (env-gated, fail-closed in production §5.1)
- [ ] `POST /api/scan` + registry validation + correlation-nonce mint +
      workflow_dispatch (both fields required §4.1)
- [ ] `POST /api/upload` + bearer auth + provenance binding (§4.2) +
      schema validation + atomic write
- [ ] `GET /api/scan-jobs` (fold append-only event log) + `GET /healthz`
- [ ] `scan-jobs.jsonl` append-only event store + fold helper (path defined once
      as a single constant, not string-literal-duplicated)
- [ ] `.github/workflows/on-demand-scan.yml` (job_id + replay_run_id inputs)
- [ ] `weekly-audit.yml` upload step (`trigger=scheduled`)
- [ ] Shared CI uploader script (`scripts/upload-report.mjs`)
- [ ] UI: Run-a-scan panel + nav + api helpers + trigger-provenance badge (operator / scheduled / replay)
- [ ] Unit tests (the review-required set):
      - auth gate rejects when unauthenticated
      - **production fail-closed:** startup fails when `FLY_APP_NAME` set (or
        `REQUIRE_AUTH=true`) and Basic Auth secrets missing
      - registry validation rejects off-allowlist / unregistered / disabled
      - **`/api/scan` rejects repo-only and URL-only payloads** (both required)
      - **`/api/upload` rejects a valid report for unknown/mismatched `jobId`**
        (409) and for already-`uploaded` jobId (replay guard)
      - **`/api/upload` flips the matching job `dispatched`→`uploaded`**
      - **`scheduled`/`replay` upload rejected when GitHub run-verification fails
        (unknown run / wrong workflow / not completed), and duplicate `runId`
        rejected (409); response is `{ runId, jobId: null }` for these triggers**
      - **scan-job fold preserves `targetRepo`/`stagingUrl` from the `requested`
        event through `dispatched`/`uploaded` (not lost to last-event-wins)**
      - **production startup fails when `ALLOWED_ORIGIN` or `BIND_HOST` unset**
      - upload schema rejection (422) + runId traversal rejection
      - **parallel `/api/scan` dispatches don't drop/corrupt scan-jobs entries**
      - **`/api/scan` dispatches to `AUDIT_WORKFLOW_REPO`, not the scan target**
      - **dispatch failure records `dispatch_failed` (not `dispatched`); job is
        not presented as in-progress**
      - origin guard (ALLOWED_ORIGIN)
- [ ] ADR: "fly.io deployment relaxes loopback-only binding; compensated by
      Basic Auth + fly proxy + production fail-closed"
- [ ] Docs: `docs/deployment.md` (deploy steps, secret setup, first-run, replay)
- [ ] KNOWLEDGE.md note on the two-image split + workflow_dispatch-has-no-run-id

## 10. Failure modes

| Scenario | Behavior |
|---|---|
| fly.io down when CI finishes | Report still in GH Actions artifacts; re-upload on next run or manual replay. Non-fatal. |
| Dispatch token expired | `/api/scan` returns `502`; a `dispatch_failed` event is recorded for the jobId (NOT `dispatched`), so the UI shows it as failed, never as in-progress. |
| Upload token wrong | `401`, no write. Logged. |
| Malformed report uploaded | `422`, no write. Logged. |
| Two scans dispatched at once | Each gets a job id; CI runs them as separate workflow runs; uploads are independent (distinct runIds). |
| Volume full | Write fails → `500` on upload; alert via logs. (Volume sized with headroom; reports are small.) |

## 11. Open questions / deferred

- **fly.io region** — default `syd` (Sydney; Breakout is AU-based). Confirm
  there's no fly.io constraint pushing elsewhere; trivial to change.
- **Report retention on the volume** — keep all, or prune to last N runs? v1:
  keep all (reports are small); revisit if volume pressure appears.
- **GitHub OIDC verification for uploads** (deferred). v1 binds uploads via a
  correlation nonce (on-demand) and GitHub run-provenance fields + runId dedup
  (scheduled/replay). True OIDC token verification on `/api/upload` would be
  stronger but is overkill for an internal-team tool; revisit if the upload
  surface ever widens.
- **Static-only / live-only on-demand modes** (deferred, not v1). v1 requires
  both `repo` and `stagingUrl` to avoid the bare-`--repo` all-staging fan-out
  (§4.1). A future iteration can add an explicit `mode: static|live|full` field
  and the corresponding scoped CI commands once the report-writing path for
  single-surface runs is designed (`audit run` currently always scans both
  surfaces it's given; `scan-source`/`scan-live` don't emit reports).
