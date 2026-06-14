# Deployment guide — sectool fly.io dashboard

This document covers deploying and operating the `sectool` report dashboard on
fly.io. The dashboard is the lightweight UI image (`Dockerfile.ui`); it does NOT
contain scanner binaries.

## Prerequisites

- [flyctl](https://fly.io/docs/flyctl/) installed and authenticated (`fly auth login`).
- The `sectool` app created in your fly.io org (`fly apps create sectool`).
- A GitHub fine-grained PAT for `AUDIT_GH_DISPATCH_TOKEN` (see Secrets below).

---

## Two-image architecture

This repo ships two Docker images with distinct purposes:

| Image | File | Contents | Where it runs |
|---|---|---|---|
| Scanner image | `Dockerfile` | Node + Semgrep + gitleaks + osv-scanner + OWASP ZAP + Nuclei | GitHub Actions CI only |
| Dashboard image | `Dockerfile.ui` | Node + compiled server + SPA (`ui/dist/`) + `config/` (read-only) | fly.io |

The `Dockerfile.ui` multi-stage build compiles `dist/` and `ui/dist/` in a builder
stage, then copies only the compiled output and `config/` into a slim runtime stage
(`node:20-bookworm-slim`). No scanner binaries are present in the deployed image.

---

## Deploy steps

### 1. Create the persistent data volume

Runtime-writable data (`reports/`, `history/`, `scan-jobs.jsonl`) lives on a
fly.io volume mounted at `/data`. Create it once:

```sh
fly volumes create sectool_data --region syd --size 10
```

The volume name `sectool_data` matches the `[mounts]` stanza in `fly.toml`.

### 2. Set secrets

See the full secrets table in the next section. Set all secrets before the first
deploy so the server can pass its production fail-closed startup check.

### 3. Deploy

```sh
fly deploy
```

`fly.toml` references `Dockerfile.ui` as the build source. The deploy builds the
image, pushes it, and starts one machine in the `syd` region.

### 4. Verify the health check

```sh
fly status
```

The fly proxy polls `GET /healthz` every 30 seconds. A healthy machine shows
`passing` for the health check. If the machine is `critical`, check startup logs:

```sh
fly logs
```

A missing required secret (from the fail-closed set) produces a startup error
naming the missing variable — the server refuses to bind and the health check
fails loudly.

---

## Secrets setup

### fly.io secrets (set on the fly app)

Set all of the following with `fly secrets set KEY=value`. They are injected as
environment variables at runtime and are never baked into the image.

| Secret | Description | Example / notes |
|---|---|---|
| `AUDIT_BASIC_AUTH_USER` | Basic Auth username for the dashboard | Any non-empty string |
| `AUDIT_BASIC_AUTH_PASS` | Basic Auth password for the dashboard | Use a long random string |
| `ALLOWED_ORIGIN` | Exact origin the browser connects from | `https://sectool.fly.dev` |
| `AUDIT_UPLOAD_TOKEN` | Bearer token CI presents to `/api/upload` | 32+ random hex bytes |
| `AUDIT_GH_DISPATCH_TOKEN` | Fine-grained PAT for dispatching and verifying scans | See note below |
| `AUDIT_WORKFLOW_REPO` | `owner/repo` that holds `on-demand-scan.yml` | e.g. `breakoutsolutions/sectool` |

**`AUDIT_GH_DISPATCH_TOKEN` MUST be a fine-grained PAT scoped to ONLY
`AUDIT_WORKFLOW_REPO`, with Actions read+write permissions only — no broader
repository or organisation permissions.** This token is used for two purposes:
dispatching on-demand scans (`POST /repos/{owner}/{repo}/actions/workflows/…/dispatches`)
and verifying upload provenance (`GET /repos/{owner}/{repo}/actions/runs/{id}`).
Granting broader scopes creates unnecessary blast radius if the token is
compromised.

Example bulk set:

```sh
fly secrets set \
  AUDIT_BASIC_AUTH_USER="sectool-admin" \
  AUDIT_BASIC_AUTH_PASS="<random-password>" \
  ALLOWED_ORIGIN="https://sectool.fly.dev" \
  AUDIT_UPLOAD_TOKEN="<random-token>" \
  AUDIT_GH_DISPATCH_TOKEN="<fine-grained-pat>" \
  AUDIT_WORKFLOW_REPO="breakoutsolutions/sectool"
```

Note: `DATA_DIR` and `BIND_HOST` are set in `fly.toml [env]` (not secrets) and
do not need to be set here.

### GitHub Actions secrets (set on the repo that holds the workflows)

CI needs two secrets to deliver uploads to the dashboard:

| Secret | Description |
|---|---|
| `FLY_UPLOAD_URL` | Full URL of the dashboard upload endpoint, e.g. `https://sectool.fly.dev/api/upload` |
| `AUDIT_UPLOAD_TOKEN` | Same bearer token as the fly secret above |

Set these in **Settings → Secrets and variables → Actions** on the repo that
holds `.github/workflows/on-demand-scan.yml` and `.github/workflows/weekly-audit.yml`.

---

## Runtime-secret degradation mode

The production fail-closed startup set is: `AUDIT_BASIC_AUTH_USER`,
`AUDIT_BASIC_AUTH_PASS`, `ALLOWED_ORIGIN`, and `BIND_HOST`. Missing any of these
prevents the server from starting at all.

The remaining secrets (`AUDIT_GH_DISPATCH_TOKEN`, `AUDIT_WORKFLOW_REPO`,
`AUDIT_UPLOAD_TOKEN`) are **runtime-checked, not startup-required.** This means
the dashboard can be "up, authenticated, and returning green health checks" yet
structurally unable to operate in important ways:

- **Missing `AUDIT_GH_DISPATCH_TOKEN` or `AUDIT_WORKFLOW_REPO`:** the "Run a
  scan" button returns `502` only when clicked. The rest of the dashboard
  (viewing reports, history) continues to work. The degradation is silent until
  an operator clicks the button.
- **Missing `AUDIT_UPLOAD_TOKEN`:** CI uploads receive `401` and fail. The
  dashboard shows no new reports. This is silent — the health check remains
  green, and there is no dashboard indicator that CI uploads are failing.

**Always run the post-deploy smoke check below immediately after a fresh deploy
or after rotating any of these secrets.**

### Post-deploy smoke check

After deploying (or after rotating `AUDIT_GH_DISPATCH_TOKEN`, `AUDIT_WORKFLOW_REPO`,
or `AUDIT_UPLOAD_TOKEN`):

1. Open the dashboard at `https://sectool.fly.dev` and log in with Basic Auth.
2. Navigate to "Run a scan", select a registered repo and staging URL, and click
   "Run scan".
3. Confirm the scan job appears in the job list with state `in_progress`.
4. Wait for the GitHub Actions workflow to complete (visible in the Actions tab of
   `AUDIT_WORKFLOW_REPO`).
5. Confirm the job flips to `complete` in the dashboard job list and a new report
   appears in the report history.

If step 2 returns an error (502), `AUDIT_GH_DISPATCH_TOKEN` or
`AUDIT_WORKFLOW_REPO` is missing or invalid. If step 5 does not complete (job
stays `in_progress` or `timed_out`), the CI upload is failing — check the
Actions log for the upload step and verify `FLY_UPLOAD_URL` and `AUDIT_UPLOAD_TOKEN`
match the fly secrets.

---

## First-run checklist

After a fresh deploy with all secrets set:

- [ ] `fly status` shows health check `passing`.
- [ ] `https://sectool.fly.dev/healthz` returns `{"ok":true}` (no auth required).
- [ ] `https://sectool.fly.dev/` prompts for Basic Auth and loads the dashboard.
- [ ] Complete the post-deploy smoke check above.

---

## Replay procedure

A replay re-uploads a previously stored scan result without re-running the
scanners. Use this when an upload failed (e.g. the dashboard was down or the
upload token was wrong at CI time) and you want to ingest a report from a prior
GitHub Actions run.

### Via the dashboard UI

From the dashboard, find the job in the scan-jobs list, click "Replay" (if the
UI exposes this control), and confirm.

### Via GitHub Actions (manual dispatch)

Dispatch `on-demand-scan.yml` manually from the GitHub Actions UI or via the
API, supplying `replay_run_id`:

- `target_repo`: the registered repo name (must match the original scan).
- `staging_url`: the staging URL used in the original scan.
- `job_id`: a new correlation nonce (the dashboard will mint one if you trigger
  via the UI; for a manual dispatch you must supply a valid 32-hex string).
- `replay_run_id`: the `runId` of the run to replay (the directory name under
  `reports/` from the original CI run, e.g. `2026-06-14T03-00-00Z-abcdef12`).

When `replay_run_id` is non-empty, the workflow skips the scan step and
re-uploads the stored artifacts with `trigger=replay`. The upload endpoint
applies GitHub run provenance verification (relaxed freshness window) and
accepts the report.

---

## Routine operations

### Viewing logs

```sh
fly logs
```

### SSH into a running machine

```sh
fly ssh console
```

The data volume is mounted at `/data`. Reports are under `/data/reports/`,
trend history under `/data/history/`, and the scan-jobs event log at
`/data/history/scan-jobs.jsonl`.

### Rotating secrets

```sh
fly secrets set AUDIT_UPLOAD_TOKEN="<new-token>"
```

After rotating `AUDIT_UPLOAD_TOKEN`, update the matching GitHub Actions secret
and run the post-deploy smoke check.

### Scaling / region changes

The app is configured for `min_machines_running = 1` to keep the volume always
reachable during CI uploads. Do not scale to zero when uploads are expected.

Region is set to `syd` in `fly.toml`. To change region, update `fly.toml` and
re-create the volume in the new region (volumes are region-local).
