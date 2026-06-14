# Build progress — ui-live-config

**Build slug:** ui-live-config
**Spec:** `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md`
**Plan:** `tasks/builds/ui-live-config/plan.md`
**Status:** BUILD COMPLETE (C0–C8 all delivered)

---

## Chunk summary

| # | Chunk | Status | Key files |
|---|---|---|---|
| C0 | `CONFIG_REPO_DIR`-aware config reads | done | `src/config/load.ts`, `src/ui/env.ts`, `src/ui/server.ts` |
| C1 | TOTP verify module + `audit totp-init` CLI helper | done | `src/ui/totp.ts`, `src/ui/totp.test.ts`, `src/cli.ts` |
| C2 | Step-up cookie protocol | done | `src/ui/stepup.ts`, `src/ui/stepup.test.ts`, `src/ui/stepup.routes.test.ts`, `src/ui/env.ts`, `src/ui/server.ts` |
| C3 | `config-git.ts` working clone + token channel + path-limited rollback | done | `src/ui/config-git.ts`, `src/ui/git-askpass.cjs`, `src/ui/config-git.test.ts` |
| C4 | Config-write service + write API routes | done | `src/ui/config-write.ts`, `src/ui/config-write.test.ts`, `src/ui/config-write.routes.test.ts`, `src/ui/server.ts` |
| C5 | Hash-chained audit cache (`config-audit.jsonl`) | done | `src/ui/config-audit-cache.ts`, `src/ui/config-audit-cache.test.ts` |
| C6 | `/api/scan` + `on-demand-scan.yml` `config_sha` wiring | done | `src/ui/dispatch.ts`, `.github/workflows/on-demand-scan.yml`, `src/ui/dispatch.test.ts`, `src/ui/server.test.ts` |
| C7 | UI editor forms + 2FA modal + History/revert + secrets-health gating | done | `ui/src/api.ts`, `ui/src/types.ts`, `ui/src/screens/TargetsSafety.tsx`, `ui/src/components/StepUpModal.tsx`, `ui/src/server.ts` |
| C8 | Contract docs rewrite + deployment.md + Dockerfile.ui git | done | `CLAUDE.md`, `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md`, `docs/decisions/0007-live-config-editing.md`, `docs/deployment.md`, `Dockerfile.ui`, `KNOWLEDGE.md` |

---

## Build-complete summary (C8)

**Contract docs rewrite** — `CLAUDE.md` "Non-negotiable safety contract" section
rewritten to accurately reflect the §3.2 replacement contract: the scan-time
allowlist invariant is unchanged; authoring moved to 2FA-gated live edit with git
history. Old "no override path / requires a PR" language removed (it contradicted
the code). Links to the new spec and ADR-0007.

**v1 spec §4 amendment** — `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md`
Status line updated; a `[Amended 2026-06-14]` note added inside §4 (after item 10)
identifying items 3 and 8 as superseded while preserving all other items unchanged.
Mirrors the existing amendment pattern for §5.2/§5.3.

**ADR-0007** — `docs/decisions/0007-live-config-editing.md` created (next number
after 0006). Records: the decision (B2 live editing incl. allowlist), rejected
alternatives (B1 registry-only / domain-suffix meta-allowlist / approval queue /
PR auto-merge), compensating controls (2FA + git + audit cache + scoped token),
and the accepted residual risk (password + TOTP holder can scan any host).

**deployment.md** — extended with: the four new secrets table
(`AUDIT_TOTP_SECRET`, `AUDIT_STEPUP_SIGNING_SECRET`, `AUDIT_GIT_WRITE_TOKEN`,
`AUDIT_GIT_AUTHOR`) and two new env vars (`CONFIG_BRANCH`, `CONFIG_REPO_DIR`);
the `audit totp-init` enrollment procedure; fail-closed degradation table; the
`CONFIG_BRANCH` sync requirement (fly.io env + GitHub `vars.CONFIG_BRANCH`);
working-clone-on-volume explanation; post-deploy smoke check for config editing.

**Dockerfile.ui** — `git` added to the runtime stage via `apt-get install
--no-install-recommends git`. Required at runtime by `ensureClone()` and
`commitConfigChange()` in `src/ui/config-git.ts`.

**KNOWLEDGE.md** — note added: live-config feature put `AUDIT_GIT_WRITE_TOKEN`
on the dashboard box; git is the config source of truth via a working clone on
the volume; token handled only via `GIT_ASKPASS` in scoped spawn env.

---

## Safety-critical notes for G2 reviewer

- The "no code path scans a non-allowlisted host at scan time" invariant in
  `src/live/gate.ts` `assertAllowlisted` is unchanged and must remain unchanged.
- C3's `CONFIG_PATHS` whitelist, `assertConfigWorktreeClean`, `pathLimitedRollback`,
  and the token-scoped spawn env are the highest-risk implementation artifacts —
  verify C3 hardest.
- The `config_sha` input name in `src/ui/dispatch.ts` MUST exactly match
  `inputs.config_sha:` in `.github/workflows/on-demand-scan.yml` — a typo here
  causes a CI-only 422 and every post-edit scan silently fails to dispatch with
  the pinned SHA.
- `CONFIG_BRANCH` must match between fly.io `[env]` and GitHub `vars.CONFIG_BRANCH`.
