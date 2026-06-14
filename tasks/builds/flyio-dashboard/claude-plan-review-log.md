# claude-plan-review-log — flyio-dashboard

- Plan: `tasks/builds/flyio-dashboard/plan.md`
- Spec: `docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md`
- Reviewer: claude-plan-review.v1 — Round 1 of 3
- Verdict: CHANGES_REQUESTED (2 HIGH, 5 MEDIUM, 3 LOW) → **all applied**

## Findings and dispositions

| ID | Sev | Chunk | Finding | Disposition |
|---|---|---|---|---|
| H1 | HIGH | C6 | `writeReport` builds path from `report.runId` (schema = `z.string().min(1)`, no RUN_ID_RE); envelope-only traversal guard bypassable | **Applied** — assert `envelope.runId === report.runId`, validate canonical runId against RUN_ID_RE before any path build; test added |
| H2 | HIGH | C6 | dedup checks envelope runId but write uses `report.runId` → dup can overwrite | **Applied** — single canonical runId for dedup+path+event; mismatch → 422; test added |
| M1 | MED | C6 | `writeTrend` is whole-file RMW, not atomic append; concurrent uploads drop lines | **Applied** — serialize write+trend under `withWorkspaceLock`; wording corrected; test added |
| M2 | MED | C5 | `preflight` validates URL only, not repo enablement | **Applied** — explicit `registry.repos.find(enabled)` check separate from preflight; repo-side test added |
| M3 | MED | C5 | `loadTargets` `ConfigError` could surface as misleading 400 | **Applied** — ConfigError → 500, distinct from caller 400; test added |
| M4 | MED | C1 | `startServer`/`handleFixPost` origin-guard threading under-described; risk of half-migrated guard | **Applied** — C1 enumerates `handleFixPost` origin replacement, `server.listen` bindHost, `doUi` log line |
| M5 | MED | §9 map | write-then-trend partial-failure + report.runId traversal unmapped | **Applied** — 6 new rows added to §9→chunk map |
| L1 | LOW | C6 | malformed-runId status ambiguous (409/400) | **Applied** — fixed to 400 (client error, not provenance conflict) |
| L2 | LOW | C7 | uploader moved to `ci/` — eslint inclusion unconfirmed | **Applied** — verified eslint ignores only `migrations/`+`scripts/`; C7 must `eslint ci/upload-report.mjs` (+ add `ci/**/*.mjs` glob if needed) |
| L3 | LOW | C10 | runtime-checked secrets leave dashboard "green yet non-functional" | **Applied** — ADR/deployment doc records degradation mode + post-deploy smoke check |

## Verification of HIGH/M2 claims against source (coordinator)
- `src/report/json.ts:199` — `resolve(base, report.runId)` confirmed (H1/H2 real).
- `src/schemas/report.ts:37` — `runId: z.string().min(1)` confirmed (no RUN_ID_RE).
- `src/live/preflight.ts:59-79` — gates URL/host only, no repo arg (M2 real).
- `eslint.config` — ignores only `migrations/**`, `scripts/**` (L2: `ci/` is linted).

All findings legitimate; no pushback. Plan patched in place. Round 1 closed.
Lifetime cap: 3 rounds — 1 used. Proceeding to build (automated mode, operator
plan-gate pre-authorized).
