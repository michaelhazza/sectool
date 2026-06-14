# Spec Conformance Log

**Spec:** `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md`
**Plan:** `tasks/builds/ui-live-config/plan.md` (+ `claude-plan-review-log.md`)
**Spec commit at check:** `6ac13e8` (HEAD)
**Commit at finish:** `948f83b`
**Branch:** `feature/ui-live-config`
**Base:** `822a79e` (feature/flyio-dashboard-deployment — the stack base)
**Scope:** all of spec (C0–C8, BUILD COMPLETE per progress.md), full changed-code set
**Changed-code set:** 40 files (excluding spec/plan/progress/learnings/todo docs)
**Run at:** 2026-06-14T00:00:00Z

---

## Summary

- Requirements extracted:     ~38 concrete spec-named requirements + ImplInv 1–9 + §13 named tests
- PASS:                       all except the one below
- MECHANICAL_GAP → fixed:     0
- DIRECTIONAL_GAP → deferred: 1 (configSha threading — §7/ImplInv-6 half-wired)
- AMBIGUOUS → deferred:       0
- OUT_OF_SCOPE → skipped:     0

**Verdict:** NON_CONFORMANT (1 directional gap — the §7/ImplInv-6 write-then-scan end-to-end path is half-wired; routed to `tasks/todo.md`). Everything else is conformant; lint + typecheck green.

---

## Safety contract (§3) — CONFORMANT

- **Scan-time allowlist is still the sole authority.** `src/live/` (the `assertAllowlisted` / `preflight` gate) is **untouched** by this branch (`git diff base...HEAD -- src/live/ src/scan/` → empty). The surviving invariant — no code path scans a host absent from the allowlist at scan time — is intact. CI preflight in `on-demand-scan.yml` is unchanged (still re-validates the staging URL against the committed allowlist inside the CLI).
- **CLAUDE.md old language removed/rewritten.** The "Non-negotiable safety contract" section now states the §3.2 contract. The only "no override path" / "requires a PR" strings remaining in CLAUDE.md are the line *describing that the old language was removed* — not a live contradiction.
- **v1 spec §4 amended** (Status line + inline `[Amended 2026-06-14]` note at §4 items 3/8, superseded-by pointer; §4 preserved). **ADR-0007** created. **No stale "PR review" copy in `TargetsSafety.tsx`** (the only UI hit is `FindingDetail.tsx` for `baseline.json`, correctly still PR-gated — baseline editing is out of scope per §2/§14).
- Residual contradictions in non-deliverable docs (`CODEOWNERS`, `docs/capabilities.md` "no override path") are noted under Observations, not gaps — neither is in the changed-code set nor named as a deliverable.

## ImplInv 1–9 — each has enforcing code + a test

| # | Invariant | Code | Test | Verdict |
|---|---|---|---|---|
| 1 | writes touch ONLY the two config paths | `config-git.ts` frozen `CONFIG_PATHS`; `commitConfigChange` rejects non-whitelisted + stages `git add -- <CONFIG_PATHS>` | "git add -A never invoked" | PASS |
| 2 | worktree clean before/after; dirty → 409, never `reset --hard` | `assertConfigWorktreeClean` (porcelain -- CONFIG_PATHS; detached/wrong-branch fail closed) | "dirty worktree → ConfigWorktreeDirtyError without resetting"; "non-config dirty ignored" | PASS |
| 3 | token never in remotes/.git config/argv/logs/errors/audit/HTTP | token only in scoped spawn env via `GIT_ASKPASS`; never on `process.env`; read-only calls omit it; `scrubToken` on all output | "token never leaks [SAFETY]" — absent from process.env after success AND failed push, plus commit/.git config/stderr/thrown error | PASS |
| 4 | revert only `config(dashboard)` config-only commits; full re-validation | `computeConfigRevert` (prefix + config-only check) → C4 re-runs `validateProjection` then forwards | "revert of non-config(dashboard) → NotARevertableConfigCommitError"; "revert makes a reverting commit" | PASS |
| 5 | pushed commit is source of truth; jsonl is hash-chained cache | `config-audit-cache.ts` (genesis + sha256 chain; M5 missing-file benign); C4 append best-effort post-push → `auditWarning` | "audit append failure → auditWarning"; cache hash-chain break detection | PASS |
| 6 | immediate scan uses/verifies pushed SHA — dispatch on branch, SHA as input | `dispatchScan` configSha→`inputs.config_sha`; `ref=CONFIG_BRANCH`; YAML reachability + checkout; `handleScanPost` uses `ref: configBranch` | dispatch unit tests. **Caller-side threading absent — see DIRECTIONAL gap** | **HALF-WIRED** |
| 7 | explicit staging; path-limited rollback (never reset --hard); post-rollback no config staged; non-config preserved | `pathLimitedRollback` (reset --soft + restore --staged --worktree; post `git diff --cached` assertion → GitRollbackFailedError) | "rolls back config paths only, leaving non-config modified + staged untouched" | PASS |
| 8 | every mutation auth+CSRF/origin+TOTP-step-up+schema gated; cookie is only proof | `handleConfigWrite`: Basic Auth upstream (server.ts:1393) → `checkCsrfOrigin` → `checkStepUp` → `configWriteDeps.ok` → parse → service schema-validate → commit. GET history/health = read routes | route tests: no Basic Auth→401; no/invalid/wrong-nonce cookie→403 nothing committed; CSRF/Origin→403 | PASS |
| 9 | readers + writers share the same `CONFIG_REPO_DIR` | `load.ts` loaders take `{configDir}`; `env.ts` `configDir = resolve(configRepoDir,'config')`; GET routes + `handleScanPost` + write service all use `resolvedEnv.configDir` | "consistency: committed allowlist == what loadTargets reads" asserted against the temp dir | PASS |

## §6 / §5 / §13 — CONFORMANT

- **§6 routes** all present and gated: POST/PUT/DELETE repos, staging-targets (incl. `addHost` atomic — one commit two files), allowlist (DELETE rejects in-use host 409); `GET /api/config/history` (read, no step-up); `POST /api/config/revert/:commit` (constrained, 2FA-gated); `POST /api/config/step-up`. Status mapping (`mapWriteError`): 422/409/502/500/400 per spec. `GET /api/config/health` exposes `configWriteDeps`.
- **§5 step-up:** HMAC-SHA256 cookie over `AUDIT_STEPUP_SIGNING_SECRET` (NOT TOTP — named test passes); claims `{principalHash, csrfNonce, scope:'config-write', exp}`; `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300`; `requireStepUp` checks signature+scope+TTL+csrfNonce+principalHash; cookie is the only write proof. §10 fail-closed: `assertProductionConfig` hard-fails core-four, degrades write deps closed via `configWriteDeps`.
- **§13 named tests** all present: TOTP valid/expired/skew; cookie-signed-with-signing-secret-not-TOTP, different-nonce/principal/expired→forbidden; dirty→409-no-reset, push-failure rollback config-only preserving non-config modified+staged, token-never-leaks (incl. process.env, after failed push), non-FF replay-once, add-A-never, computeConfigRevert validation; validate→commit→re-read, 401/403/422/409, addHost ONE commit, malformed-host pre-commit reject, revert→400 on non-config(dashboard), history readback, loadTargets consistency, audit-append→auditWarning; cache hash-chain break + missing-file benign; dispatch ref=CONFIG_BRANCH + config_sha + SHA-not-as-ref + back-compat. (The write-then-scan consistency assertion is covered only at the `dispatchScan` unit level — no end-to-end test emits a real pushed SHA, consistent with the gap below.)

## configSha threading status (the asked-for check)

**HALF-WIRED.** Present: `dispatchScan` accepts `configSha` and emits `inputs.config_sha`; `on-demand-scan.yml` declares the input, verifies reachability from `CONFIG_BRANCH`, checks the SHA out; `handleScanPost` dispatches with `ref: resolvedEnv.configBranch ?? 'main'` (H2 fixed). **Missing:** `handleScanPost` never passes `configSha`, and nothing stores the last-pushed SHA for a scan to read (`rg configSha src/ui/server.ts` → no match). So a post-edit scan dispatches with no `config_sha`, the workflow checks out the branch tip, and the branch-propagation race MEDIUM-3/ImplInv-6 set out to close is re-introduced. The C6 builder documented this as deferred (chunk-learnings.md lines 31, 41); it was never tracked as a backlog item until this run.

## Mechanical fixes applied

None. Every concrete spec-named artifact (files, exports, schema paths, error codes, routes, env fields, the `audit totp-init` CLI command, StepUpModal/ConfigHistory components, addHost checkbox, api.ts helpers, docs, Dockerfile git) is present. Lint + typecheck green — no surgical addition warranted.

## Directional gap (routed to tasks/todo.md)

**configSha threading half-wired (§7 / ImplInv-6).** Routed because the fix requires a design choice (where the SHA comes from / its lifetime). NOT a safety regression — the scan-time allowlist gate is untouched and CI re-validates the committed config. See `tasks/todo.md` → "Deferred from spec-conformance review — ui-live-config (2026-06-14)".

## Observations (not gaps)

- `CODEOWNERS:1` and `docs/capabilities.md:21` still say config "requires PR review" / "no override path". Mildly stale against the new contract, but neither is a spec-named deliverable for this build nor in the changed-code set. Optional docs-hygiene follow-up; not routed.

## Files modified by this run

- `tasks/todo.md` (appended the one directional finding)
- this log

No source files were modified (zero mechanical fixes).

## Next step

**NON_CONFORMANT** — 1 directional gap (configSha threading). A correctness/consistency race, **not** a safety-contract regression, so it does not block on safety grounds, but the §7/ImplInv-6 end-to-end guarantee is not delivered. The main session should close it (pick a SHA-source mechanism + add the end-to-end write→scan test) or consciously accept it as a tracked deferral before `pr-reviewer`. Since no source files were changed by this run, `pr-reviewer` can run against the current branch state as-is.
