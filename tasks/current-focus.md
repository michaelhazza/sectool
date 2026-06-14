# Current Focus

**Status:** MERGE_READY

**Slug:** flyio-dashboard
**Branch:** feature/flyio-dashboard-deployment (PR base: claude/lucid-albattani-kczh64)
**Spec:** docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md

> Update this file when starting a new sprint, spec, or active feature branch. Status field is read by `context-pack-loader` to auto-pick a context pack.
>
> Allowed status values:
> - `NONE` — no active feature.
> - `PLANNING` — spec phase. Coordinator: `spec-coordinator`.
> - `BUILDING` — implementation phase. Coordinator: `feature-coordinator`.
> - `REVIEWING` — branch-level review pass.
> - `MERGE_READY` — all gates green; PR awaiting merge.
> - `MERGED` — landed; sprint closing out.

## Notes

**Status: MERGE_READY (flyio-dashboard)** — fly.io deployment of the dashboard
with on-demand scan triggering. 10 chunks built (env/auth/scan-jobs/healthz/
scan-jobs API/`POST /api/scan`/`POST /api/upload`/CI workflows + uploader/
Dockerfile.ui + fly.toml/UI Run-a-scan panel/docs). Reviewed: claude-plan-review
(2 HIGH + 5 MED applied pre-build), spec-conformance (dropdown contract fixed),
adversarial-reviewer (2 confirmed + 3 likely holes fixed: bearer compare,
exact-URL scan gate, upload TOCTOU dedup, Basic-Auth method scoping, slow-loris
timeouts, read-route traversal guard). Local gates green: lint ✓ typecheck ✓
build:server ✓ build:client ✓ test:unit 924/924 ✓. Benchmark is Docker-only
locally (scanner binaries live in the image) — validated by CI's benchmark job.
PR open for final human review (not auto-merged, per operator). Also fixed a
pre-existing Windows fast-glob bug in the AST harness. Last updated: 2026-06-14.

**Prior (audit-tool-v1):** MERGED baseline at branch base 306410b.
