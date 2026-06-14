# ADR-0007: live config editing via the dashboard (2FA-gated, git-as-source-of-truth)

**Status:** accepted
**Date:** 2026-06-14
**Domain:** safety contract / config authoring
**Supersedes:** —
**Superseded by:** —

## Context

The original audit-tool-v1 spec (§4) established a "no override path" contract:
the only way to authorise a new scanning target or allowlisted host was a
human-reviewed PR to `config/allowed-staging-hosts.json` (CODEOWNERS gate). This
was a deliberate control — an attacker or misconfigured operator could not cause
the tool to scan an arbitrary host without a second human reviewing the change.

The operator (michael@breakoutsolutions.com, 2026-06-14) directed a new build
(`ui-live-config`) to allow managing the full target registry and host allowlist
directly from the dashboard, without hand-editing JSON or opening a PR. The
primary motivation is operational convenience: the team manages a growing number
of staging hosts and wants to add/remove them without a git workflow.

The build needed a replacement contract that preserved the core scan-time safety
invariant while removing the PR-review gate. The full analysis is in
`docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md` §3 and the
plan's system invariants block.

## Decision

We will adopt **B2: live editing of all config including the allowlist, with no
host restriction, gated by 2FA + git history**.

Specifically:

- The dashboard exposes write routes (`POST`/`PUT`/`DELETE`) for repos, staging
  targets, and allowlisted hosts. Every write route requires both the shared Basic
  Auth credential AND a valid TOTP step-up cookie (RFC-6238, 5-minute TTL, HMAC-
  signed with a dedicated `AUDIT_STEPUP_SIGNING_SECRET`).
- Every change is schema-validated against the existing `TargetRegistrySchema` /
  `AllowlistSchema` (including the cross-check that every enabled staging target's
  host is on the post-change allowlist) before being committed.
- The write path commits to git as the single source of truth — `git push` is the
  commit point. The commit carries a structured audit trailer (actor, action,
  target, UTC time). A hash-chained operational audit cache (`config-audit.jsonl`)
  provides a fast read model; git is the authoritative record.
- Every committed change is revertable via a constrained `POST /api/config/revert`
  route (2FA-gated; makes a new forward commit, never rewrites history).
- The scan-time safety invariant is unchanged: `assertAllowlisted` (in
  `src/live/gate.ts`) still rejects any host absent from the allowlist before any
  network I/O. CI re-validates via the existing preflight on every scan run.
- `AUDIT_GIT_WRITE_TOKEN` — a fine-grained GitHub PAT with `contents:write` on
  this repo only — is the protected high-value secret. It is never placed in
  remote URLs, argv, `.git/config`, or `process.env`; it is supplied only via a
  `GIT_ASKPASS` helper in a scoped spawn env, and scrubbed from any error messages
  surfaced to callers.

The working clone lives at `CONFIG_REPO_DIR` (default `/data/repo` on the fly.io
volume, or `REPO_ROOT` in local dev). `src/config/load.ts` was parameterised
(`configDir` option) so config readers and the write service read the same
directory (ImplInv-9).

## Consequences

- **Positive:**
  - Operators can add/edit/remove scanning targets and allowlisted hosts from the
    dashboard in seconds, without a git workflow.
  - Every change is still committed to git with a structured audit trailer — the
    change history is as complete as before, and one-click revert is available.
  - The core scan-time invariant (no scan of a non-allowlisted host) is unchanged.
  - The hash-chained audit cache makes in-place tampering detectable.
  - A leaked dashboard password alone is not sufficient to make a config change —
    the TOTP device is also required.

- **Negative:**
  - The PR-review gate is removed. A single operator holding both the password and
    the TOTP device can authorise and scan any host on the internet, with no second
    human in the loop.
  - Attribution is to "a config admin" only — not to a specific person — because
    auth is a single shared Basic Auth credential (§2 non-goal: per-user identity
    deferred).
  - `AUDIT_GIT_WRITE_TOKEN` is a new high-value secret on the dashboard box. If
    compromised, an attacker can push arbitrary content to `CONFIG_BRANCH`. The
    fine-grained scope (`contents:write` on this repo only) limits blast radius.

- **Neutral:**
  - Four new secrets (`AUDIT_TOTP_SECRET`, `AUDIT_STEPUP_SIGNING_SECRET`,
    `AUDIT_GIT_WRITE_TOKEN`, `AUDIT_GIT_AUTHOR`) and two new env vars
    (`CONFIG_BRANCH`, `CONFIG_REPO_DIR`) are required for the editing feature.
    The dashboard degrades to read-only if any of these is absent — editing fails
    closed, it does not fail open.
  - `CONFIG_BRANCH` must be set as both a fly.io env var and a GitHub repository
    variable (`vars.CONFIG_BRANCH`) so the on-demand-scan workflow uses the same
    branch for the SHA reachability check.

## Alternatives considered

- **B1: registry-only editing (repos + staging targets but NOT the allowlist).**
  Rejected — the operator explicitly wanted allowlist editing from the dashboard;
  half-measures that still require a PR for allowlist changes leave the most
  frequent operation (adding a new staging host) outside the UI.

- **Domain-suffix meta-allowlist (restrict editable hosts to *.breakoutsolutions.com
  or similar).** Rejected — operator decision: there is intentionally no host
  restriction; input hygiene (valid DNS name per schema) is enforced, but that is
  not a security boundary. Adding a domain constraint would be a false sense of
  security (subdomains can be pointed at arbitrary infrastructure) and limits
  legitimate use of third-party staging environments.

- **Approval queue / two-person rule.** Rejected — the operator accepted that the
  only gate is 2FA. An approval queue requires a second operator account, which
  conflicts with the single-shared-credential model (§2 non-goal). This can be
  revisited when per-user identity is implemented (§14).

- **PR auto-merge via API (keep git as the authoring surface, automate the PR).**
  Rejected — adds GitHub API complexity, requires branch protection rules, and
  still serialises on reviewer availability. The direct-commit-to-branch model
  is simpler and more immediate, compensated by the audit trail.

## When to revisit

- If per-user identity / SSO is implemented (§14 fast-follow): the shared-
  credential model means attribution is degenerate today; with per-user identity
  the audit log becomes meaningful attribution. At that point the residual risk
  shifts from "anyone with the shared password + TOTP" to "any authenticated user
  + TOTP" — revisit whether a two-person or approval-queue rule is warranted.
- If a security incident occurs involving misuse of the config-editing feature
  (unauthorised host added, data exfiltrated via a scan): re-evaluate whether the
  PR-review gate should be restored for allowlist changes specifically.
- If the `AUDIT_GIT_WRITE_TOKEN` is ever scoped broader than `contents:write` on
  this repo only: re-evaluate the blast-radius assessment.

## References

- Spec: `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md` §3.2, §3.3, §7, §10
- Superseded contract: `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md` §4 items 3, 8
- Plan: `tasks/builds/ui-live-config/plan.md` (system invariants block, architecture decisions D1–D8)
- Implementation: `src/ui/config-git.ts`, `src/ui/stepup.ts`, `src/ui/config-write.ts`, `src/ui/env.ts`
- Related ADR: `0006-flyio-loopback-relaxation.md` (deployment security baseline this builds on)
- Deployment: `docs/deployment.md` §Live config editing secrets
