# Build progress — flyio-dashboard

**Build slug:** flyio-dashboard
**Spec:** `docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md`
**Plan:** `tasks/builds/flyio-dashboard/plan.md`

## Status: COMPLETE

All 10 chunks shipped on 2026-06-14.

## Chunk completion summary

| Chunk | Title | Status |
|---|---|---|
| C1 | DATA_DIR / BIND_HOST / ALLOWED_ORIGIN env plumbing + path relocation | Done |
| C2 | Basic Auth middleware (env-gated, production fail-closed) | Done |
| C3 | scan-jobs.jsonl append-only store + fold helper | Done |
| C4 | GET /healthz + GET /api/scan-jobs | Done |
| C5 | POST /api/scan (registry validation + correlation nonce + dispatch) | Done |
| C6 | POST /api/upload (bearer + provenance binding + schema + atomic write) | Done |
| C7 | CI: on-demand-scan.yml + weekly upload step + uploader script | Done |
| C8 | Dockerfile.ui + fly.toml | Done |
| C9 | UI: Run-a-scan panel + api helpers + trigger-provenance badge | Done |
| C10 | docs/deployment.md + ADR + KNOWLEDGE.md | Done |

## Key decisions recorded

- **ADR-0006** (`docs/decisions/0006-flyio-loopback-relaxation.md`): fly.io
  deployment relaxes loopback-only binding; compensated by Basic Auth + fly proxy
  TLS termination + production fail-closed startup check. Also records Plan gap 7
  (scan/upload secrets runtime-checked, not startup-required).
- **Plan gap 3** (uploader placement): `ci/upload-report.mjs` chosen over
  `scripts/` (framework-managed, eslint-excluded, at risk of `sync.js` overwrite).
- **Plan gap 7** (runtime-secret degradation): `AUDIT_GH_DISPATCH_TOKEN`,
  `AUDIT_WORKFLOW_REPO`, `AUDIT_UPLOAD_TOKEN` are runtime-checked. Missing dispatch
  token → 502 on click. Missing upload token → 401 to CI (silent). Post-deploy
  smoke check documented in `docs/deployment.md` to catch this.

## Notable pre-existing issues (out of scope, flagged)

- `/api/trend` vs `/api/history/trend` mismatch between `server.ts` and
  `ui/src/api.ts` — pre-existing, not fixed in this build (Plan gap 5).
