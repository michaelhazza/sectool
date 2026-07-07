# Current Focus

**Status:** NONE

**Slug:** —
**Branch:** —
**Spec:** —

> No active build. The concurrency lock is released — a new sprint/spec/build may
> start. All prior builds have landed on the default branch (`claude/lucid-albattani-kczh64`).

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

**MERGED (full-audit) — PR #3, 2026-07-05.** Full-mode security audit of the app
and its scan surfaces. Fixed H1 (gitUrl https-pin), M2 (loginPath root-relative),
M1 (read-token off argv → host-scoped `GIT_CONFIG` header), M3 (ZAP includePaths
regex-escaping), L1 (case-insensitive allowlist), L2 (repo-name charset), L4
(opt-in HMAC audit-cache chain via `AUDIT_CACHE_HMAC_SECRET`), plus clone
transport pinning (`GIT_ALLOW_PROTOCOL`). Two external PR-review rounds folded in
(token host-scoping to github.com; `GIT_ALLOW_PROTOCOL`). Test-stability:
`maxRetries` teardowns + `testTimeout`/`hookTimeout` 30s for the real-`git`
integration suites on Windows. Merge commit `d6b6025`; CI green. Operational
follow-ups tracked in `tasks/todo.md` (`origin:audit:full:2026-07-02`): rotate the
`.dispatch-token` PAT; set `AUDIT_CACHE_HMAC_SECRET` to enable L4 tamper-evidence;
Docker ZAP re-verify for M3.

**MERGED (ui-live-config) — PR #2, 2026-06-14.** Live config/allowlist editing via
the dashboard (2FA-gated, git as source of truth). Rewrote the v1 §4 "no override
path" contract (ADR-0007). 8 chunks; claude-plan-review + adversarial review
applied pre-build.

**MERGED (flyio-dashboard) — PR #1, 2026-06-14.** fly.io deployment of the
dashboard with on-demand scan triggering. 10 chunks; claude-plan-review +
spec-conformance + adversarial-reviewer applied.

**Prior (audit-tool-v1):** MERGED baseline at branch base 306410b.
