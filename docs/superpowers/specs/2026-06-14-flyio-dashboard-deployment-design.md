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
│   └── scan-jobs.json  (trigger audit log)               │
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
`scan-jobs.json`) live on the persistent volume.

### 3.2 Path configuration

`src/ui/server.ts` currently hardcodes `REPORTS_DIR`, `HISTORY_DIR`,
`CONFIG_DIR`, `FIXES_JSON` relative to `REPO_ROOT`. We introduce a single
`DATA_DIR` env var (default = `REPO_ROOT` for local/dev parity; set to `/data`
on fly.io) that relocates the runtime-writable dirs. `CONFIG_DIR` and `SPA_DIR`
stay relative to the image (read-only, baked in).

## 4. New endpoints

### 4.1 POST /api/scan — trigger a scan

Triggered by the UI "Run a scan" form. Body (all fields optional, but at least
one required):

```jsonc
{ "repo": "<registered-repo-name>", "stagingUrl": "<registered-staging-url>" }
```

Server-side flow:

1. **Auth:** Basic Auth (human session) — already enforced by the global gate.
2. **CSRF/origin:** same nonce + `ALLOWED_ORIGIN` check as `/api/fix`.
3. **Validate against registry — the safety gate.** `repo` must match an
   `enabled` repo in `targets.json`; `stagingUrl` must match an `enabled`
   staging target whose host is on the allowlist. Anything else → `400`, no
   dispatch. This is enforced with the SAME `loadAllowlist` / `loadTargets`
   functions the CLI uses, so the UI cannot express a scan the CLI would refuse.
4. **Dispatch:** call GitHub `POST /repos/{owner}/{repo}/actions/workflows/
   on-demand-scan.yml/dispatches` with `ref` + `inputs: { repo, staging_url }`,
   using a fine-grained PAT (`AUDIT_GH_DISPATCH_TOKEN`, fly.io secret,
   `actions:write` on this repo only).
5. **Record:** append a row to `scan-jobs.json` (`{ id, requestedBy: "team",
   repo, stagingUrl, dispatchedAt, status: "dispatched" }`). Respond `202` with
   the job id.

The UI shows the dispatched job as "in progress" and polls `/api/reports` (or
`/api/scan-jobs`) until a newer report appears.

> **Note on selection UI:** the form presents **dropdowns populated from
> `/api/config/targets` and `/api/config/allowlist`** — never free-text. Free-text
> entry is not offered. Even so, the server-side registry check in step 3 is the
> real guarantee; the dropdown is convenience, not security.

### 4.2 POST /api/upload — CI pushes a finished report

The one new **inbound trust boundary**. Called by CI at the end of a scan.

1. **Auth:** `Authorization: Bearer <AUDIT_UPLOAD_TOKEN>` — a secret DISTINCT
   from the human Basic Auth password. Constant-time compared. Missing/wrong →
   `401`, before any body read. Basic Auth gate is bypassed for this route (it
   uses bearer instead), so CI never needs the human password.
2. **Body cap:** larger than `/api/fix` (reports can be MBs) — cap at e.g. 25 MiB;
   over → `413`.
3. **Schema validation:** parse against the existing Zod `RunReport` schema.
   Invalid → `422`, nothing written.
4. **Write:** atomically write `reports/<runId>/report.json` (+ `.md`, `.sarif`
   if included in the payload) to the volume, and append the trend line to
   `history/trend.jsonl`. Reuses the existing `writeReport` / `writeTrend` logic
   where possible. `runId` is validated to match `RUN_ID_RE` to prevent path
   traversal.
5. Respond `200 { runId }`.

> The CI→fly.io payload is a multi-file bundle (report.json + report.md +
> report.sarif + the trend line). Decision: POST a single JSON envelope
> `{ runId, report, markdown, sarif, trendLine }` rather than multipart — simpler
> to validate and matches how the data already exists in memory at the end of a run.

### 4.3 GET /api/scan-jobs — trigger history

Returns the `scan-jobs.json` rows (most recent first) so the UI can show
"Scan dispatched 2m ago — waiting for results." Read-only, Basic-Auth-gated.

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
current `audit ui` localhost experience with zero friction. The gate activates
only when the secrets are present (i.e. on fly.io). This is logged at startup
("Basic Auth: enabled/disabled") so the state is never ambiguous.

### 5.2 Secrets summary

| Secret | Lives in | Purpose |
|---|---|---|
| `AUDIT_BASIC_AUTH_USER/PASS` | fly.io | Human dashboard login |
| `AUDIT_UPLOAD_TOKEN` | fly.io **and** GitHub Actions | CI → fly.io upload auth |
| `AUDIT_GH_DISPATCH_TOKEN` | fly.io | fly.io → GitHub workflow_dispatch |
| `FLY_UPLOAD_URL` | GitHub Actions | Where CI POSTs results (`https://sectool.fly.dev/api/upload`) |

### 5.3 Origin guard generalization

`src/ui/server.ts` hardcodes `expectedOrigin = http://127.0.0.1:${port}` for the
`/api/fix` CSRF check. Generalize to an `ALLOWED_ORIGIN` env var (default
`http://127.0.0.1:<port>` when unset, for local parity; set to
`https://sectool.fly.dev` on fly.io). Applies to `/api/fix` and the new
`/api/scan`. **Loopback binding is also generalized:** the server currently binds
`127.0.0.1` only; on fly.io it must bind `0.0.0.0` so fly's proxy can reach it.
Introduce `BIND_HOST` env (default `127.0.0.1`; `0.0.0.0` on fly.io). The §5.2
"never 0.0.0.0" invariant from v1 is **consciously relaxed for the fly.io
deployment only**, compensated by Basic Auth + the fly proxy (TLS-terminated,
no raw port exposure). Recorded as an ADR (§9).

## 6. CI changes

### 6.1 New workflow — on-demand-scan.yml

`.github/workflows/on-demand-scan.yml`: `workflow_dispatch` with inputs `repo`
(string, optional) and `staging_url` (string, optional). Mirrors
`weekly-audit.yml`'s build+run, but scopes the `audit run` to the provided
`--repo` / `--url`. Ends with the upload step (§6.3). The same staging-auth
secrets as the weekly workflow are wired in.

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

A small step (inline `node` script or `curl`) that reads the run's
`report.json` / `.md` / `.sarif` + computes the trend line, packages the §4.2
envelope, and POSTs it. Lives once, called by both workflows. Failure to upload
is **non-fatal** to the scan (the artifact is still in GH Actions) but is logged
loudly.

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
- [ ] Basic Auth middleware (env-gated)
- [ ] `POST /api/scan` + registry validation + workflow_dispatch
- [ ] `POST /api/upload` + bearer auth + schema validation + atomic write
- [ ] `GET /api/scan-jobs` + `GET /healthz`
- [ ] `scan-jobs.json` store helper
- [ ] `.github/workflows/on-demand-scan.yml`
- [ ] `weekly-audit.yml` upload step
- [ ] Shared CI uploader script
- [ ] UI: Run-a-scan panel + nav + api helpers
- [ ] Unit tests: auth gate, registry validation rejects off-allowlist,
      upload schema rejection, runId traversal rejection, origin guard
- [ ] ADR: "fly.io deployment relaxes loopback-only binding; compensated by
      Basic Auth + fly proxy"
- [ ] Docs: `docs/deployment.md` (deploy steps, secret setup, first-run)
- [ ] KNOWLEDGE.md note on the two-image split

## 10. Failure modes

| Scenario | Behavior |
|---|---|
| fly.io down when CI finishes | Report still in GH Actions artifacts; re-upload on next run or manual replay. Non-fatal. |
| Dispatch token expired | `/api/scan` returns `502` with a plain-English "couldn't reach GitHub" message; nothing recorded as dispatched. |
| Upload token wrong | `401`, no write. Logged. |
| Malformed report uploaded | `422`, no write. Logged. |
| Two scans dispatched at once | Each gets a job id; CI runs them as separate workflow runs; uploads are independent (distinct runIds). |
| Volume full | Write fails → `500` on upload; alert via logs. (Volume sized with headroom; reports are small.) |

## 11. Open questions

- **fly.io region** — default to the region nearest the team (e.g. `lhr`)?
  Assumed yes; trivial to change.
- **Report retention on the volume** — keep all, or prune to last N runs? v1:
  keep all (reports are small); revisit if volume pressure appears.
