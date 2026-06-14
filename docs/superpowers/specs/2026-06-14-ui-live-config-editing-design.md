# Spec — live config editing via the dashboard (2FA-gated, git-as-source-of-truth)

**Status:** draft (awaiting operator review)
**Spec date:** 2026-06-14
**Author:** claude (brainstorming session; operator: michael@breakoutsolutions.com)
**Build slug:** ui-live-config
**Depends on:** the flyio-dashboard feature (PR #1) — this builds on the deployed
dashboard, its Basic Auth gate, and its env/secret plumbing.

> ⚠️ **This spec deliberately changes the project's central safety contract.**
> It supersedes the audit-tool-v1 §4 "no override path" invariant and the CLAUDE.md
> "Non-negotiable safety contract" section. The replacement contract is defined in
> §3 and MUST be mirrored into CLAUDE.md as part of this build (§11). Operator has
> consciously chosen this (B2: live editing of all config including the allowlist,
> with no host restriction, gated by 2FA + audit + git history).

---

## 1. Goal

Let the team manage the target registry **and the host allowlist** directly from
the dashboard — add/edit/disable/remove repos, staging targets, and allowlisted
hosts — without hand-editing JSON or opening a PR. Changes take effect for the
running dashboard and for the next CI scan, gated by a second authentication
factor, and every change is recorded in git for history and one-click revert.

## 2. Non-goals

- **Per-user identity / SSO.** Auth stays a single shared Basic Auth credential
  plus a single shared TOTP secret. The audit log records "a config admin", not
  which person (operator accepted this; revisit if attribution is needed).
- **Host restriction.** There is intentionally NO domain-suffix limit — any host
  may be added (operator decision). Input is still validated as a well-formed DNS
  name (the existing allowlist schema), but that is input hygiene, not a security
  boundary.
- **Approval queue / two-person rule.** The only gate on a write is 2FA.
- **Editing baseline/suppressions via UI.** Out of scope for v1 (deferred §14).
- **Running scans on fly.io.** Unchanged — scans still run in GitHub Actions.

## 3. Safety-contract change (THE critical section)

### 3.1 Old contract (removed)

The audit-tool-v1 spec §4 and CLAUDE.md state: *"Live scanning runs ONLY against
hosts on the checked-in staging allowlist. There is no flag, override, or config
path that targets a non-allowlisted host… Never weaken this."* The allowlist was
a **git-reviewed artifact**: the only way to authorise a new host was a human-
reviewed PR. **This spec removes that review gate.**

### 3.2 New contract

> **Live scanning runs only against hosts on the staging allowlist. The allowlist
> is editable through the dashboard by an operator who holds BOTH the shared
> dashboard credential AND a valid TOTP second factor. Every allowlist (and
> registry) change is (a) schema-validated, (b) committed to git as the single
> source of truth before it takes effect, and (c) recorded in an append-only
> audit log. There is no code path that scans a host absent from the allowlist at
> scan time — the allowlist is still the sole authority; what changed is that
> authoring it moved from PR-review to 2FA-gated live edit with git history.**

The invariant that survives unchanged: **a scan never targets a host that is not
in the allowlist at the moment the scan runs.** CI re-validates against the
git-committed allowlist exactly as before (§4.3). What is removed is *only* the
"a human must review the PR before the host is authorised" step.

### 3.3 What is and is not protected

| Property | Before | After |
|---|---|---|
| Scan only allowlisted hosts | ✅ (CI preflight) | ✅ unchanged (CI preflight) |
| Allowlist change needs human review | ✅ (PR) | ❌ removed — 2FA instead |
| Allowlist change is attributable | ✅ (PR author) | ⚠️ to "a config admin" only (shared creds) |
| Allowlist change is recorded/revertable | ✅ (git) | ✅ (git auto-commit + audit log) |
| Arbitrary third-party host can be authorised | ❌ (review would catch it) | ⚠️ **yes** — no host restriction; relies on 2FA + audit |
| Write requires a second factor | n/a | ✅ TOTP step-up |

The residual risk the operator is accepting: **anyone holding both the dashboard
password and the TOTP device can authorise and scan any host on the internet.**
The compensating controls are the 2FA gate (a leaked password alone is not
enough), the git history + audit log (every change is recorded and revertable),
and the git-write token being the protected high-value secret (§10).

## 4. Architecture — git as the source of truth

### 4.1 The working clone

On fly.io the server no longer reads config from the **baked, read-only image**.
Instead, on first boot it ensures a **git working clone of this repo on the
`/data` volume** (`/data/repo`), checked out to the configured branch. Config is
read from `/data/repo/config/*.json`. The clone persists across restarts on the
volume; on a fresh volume it is created by cloning via the git-write token.

`DATA_DIR` stays for reports/history; a new `CONFIG_REPO_DIR` (default
`/data/repo`, and `REPO_ROOT` locally) points at the working clone. Locally
(dev), `CONFIG_REPO_DIR` is just the project checkout — edits commit to the local
repo exactly as on fly.io, so local and prod behave identically.

### 4.2 Write path

A config write is an atomic sequence; if any step fails, nothing changes:

1. **Auth:** Basic Auth (already) + valid TOTP step-up (§5). Fail → 401/403.
2. **Validate** the proposed config against the existing Zod schema
   (`TargetRegistrySchema` / `AllowlistSchema`) — including the cross-check that
   every enabled staging target's host is on the (post-change) allowlist. Invalid
   → 422, nothing written.
3. **Write + commit + push:** write the JSON file(s) in the working clone, `git
   add` + `git commit` (message names the change + "via dashboard" + timestamp) +
   `git push` to the branch, using the git-write token. Push failure (token,
   network, non-fast-forward) → the commit is rolled back (`git reset --hard` to
   the prior HEAD), 502, nothing changes.
4. **Re-read** config from the working tree → the change is now live for the
   dashboard. Append an audit-log entry (§8).
5. Respond 200 with the new state.

### 4.3 How scans stay consistent

CI is unchanged: `on-demand-scan.yml` / `weekly-audit.yml` check out the repo and
`audit run` reads `config/*.json` + re-validates the URL against the allowlist via
the existing `preflight`. Because every UI write is committed+pushed to the branch
(§4.2 step 3), CI always reads the latest allowlist. The dashboard never shows a
host that is not committed to git (the commit precedes the re-read), so "what the
UI shows" and "what a scan can target" never diverge — the central safety win of
model (i).

## 5. Authentication — 2FA step-up

### 5.1 Mechanism (TOTP)

RFC-6238 TOTP (authenticator-app codes) — standard, offline, no SMS/email infra.
A single shared secret is stored as a fly secret `AUDIT_TOTP_SECRET` (base32).
Verification uses a small, well-reviewed TOTP routine (e.g. `otplib`, or a ~40-
line HMAC-SHA1 implementation to avoid a dependency — builder picks; if a dep is
added it is version-pinned). A ±1 time-step (30s) window is accepted for clock
skew. Per-code single-use is NOT enforced in v1 (shared secret); the replay
window and its mitigation are covered in §12 and §14.

### 5.2 Enrollment

`AUDIT_TOTP_SECRET` is generated once (a CLI helper `audit totp-init` prints the
base32 secret + an `otpauth://` URI + an ASCII QR) and set as a fly secret. The
team enrolls by scanning the QR into their authenticator app. No per-user
enrollment state is stored. Re-keying = regenerate the secret + re-enroll.

### 5.3 Which routes require step-up

Step-up (a valid TOTP code) is required on **every config-mutating route** (§6) —
`POST`/`PUT`/`DELETE` on repos, staging targets, and allowlist hosts. It is NOT
required for any read route or for `/api/scan` / `/api/upload` (those keep their
existing gates). After a successful code, a **step-up session** is granted for a
short window (default 5 min) so a burst of edits doesn't re-prompt each time; the
window is a signed, short-TTL cookie/token bound to the CSRF nonce, not a
long-lived session. The code is sent in an `X-Audit-TOTP` header on the write
request (or exchanged once for the short-TTL step-up token).

## 6. Config-write API

All routes are same-origin, CSRF-nonce + `ALLOWED_ORIGIN` gated (reusing the
`/api/fix` / `/api/scan` guard), Basic-Auth gated, and TOTP-step-up gated. All
mutations go through the §4.2 write path (validate → commit → re-read → audit).

| Method + path | Body | Effect |
|---|---|---|
| `POST /api/config/repos` | repo entry | add a repo |
| `PUT /api/config/repos/:name` | partial repo | edit/enable/disable a repo |
| `DELETE /api/config/repos/:name` | — | remove a repo |
| `POST /api/config/staging-targets` | staging entry (+ optional `addHost`) | add a staging target; if `addHost`, also add its host to the allowlist in the same commit |
| `PUT /api/config/staging-targets/:name` | partial | edit/enable/disable |
| `DELETE /api/config/staging-targets/:name` | — | remove |
| `POST /api/config/allowlist` | host entry | add an allowlisted host |
| `DELETE /api/config/allowlist/:host` | — | remove a host (rejected 409 if an enabled staging target still uses it — the schema cross-check) |
| `GET /api/config/history` | — | recent config commits + audit entries (for the History/revert view) |
| `POST /api/config/revert/:commit` | — | make a reverting commit for a prior change |

Responses: `200` with the new state; `401` (no/invalid Basic Auth), `403`
(CSRF/origin or **missing/invalid TOTP**), `422` (schema invalid), `409`
(constraint, e.g. removing an in-use host), `502` (git commit/push failed —
nothing changed). Validation reuses the existing schemas verbatim so the UI can
never write a config the CLI would reject.

## 7. Git integration

A small `src/ui/config-git.ts` module wraps the working clone: `ensureClone()`
(clone if absent, else `fetch` + fast-forward), `commitConfigChange(files,
message)` (stage + commit + push, returning the new SHA, or rolling back on push
failure), and `recentConfigCommits(n)` (for History). It shells `git` (already a
runtime dependency for clones) with the `AUDIT_GIT_AUTHOR` identity and an
`https://x-access-token:<AUDIT_GIT_WRITE_TOKEN>@github.com/...` remote. All commit
messages are prefixed `config(dashboard):` and include the actor label + UTC time.
Concurrent writes are serialized with the existing `withWorkspaceLock` (or a
config-specific lock) so two simultaneous edits cannot interleave a push.

**Push-failure safety:** a non-fast-forward (someone pushed to the branch
meanwhile) triggers `fetch` + replay-once; if it still fails, roll back the local
commit and return 502 — the UI shows "couldn't save, try again", and the live
config is untouched.

## 8. Audit log + history / revert

Two complementary records:
- **Git history** is the durable, authoritative record — every change is a commit
  on the branch, diffable and revertable.
- **`/data/history/config-audit.jsonl`** is an append-only operational log:
  `{ at, actor: "config-admin", action, target, before, after, commitSha }`, used
  to render the History view fast without walking git, and to capture intent
  (e.g. "added host X") alongside the raw diff.

The **History view** (UI §9) lists recent entries (audit log joined to commit
SHAs) with a **Revert** button → `POST /api/config/revert/:commit` makes a new
reverting commit (also 2FA-gated, also audited). Revert never rewrites history.

## 9. UI

Extends the existing **Sites and Safety** screen (today read-only) into an editor;
the "Read-only view" footer note is removed for config admins.

- **Inline actions:** each repo / staging target / allowlist row gains
  Edit · Disable · Remove. A primary **Add repo** / **Add staging target** /
  **Add host** button per section opens a form (the staging form is the one from
  the flyio-dashboard plan, now a create/edit form rather than read-only).
- **Add-staging-target form** surfaces the host's allowlist status live; if the
  host isn't allowlisted it shows *"Host not allowlisted — also add it"* with a
  checkbox that sets `addHost` (§6), so target + host land in one commit.
- **2FA step-up modal:** on the first write in a session (or after the 5-min
  window lapses), a modal asks for the 6-digit code before the save proceeds.
  Clear errors for wrong/expired codes. `api.ts` gains the config-write helpers
  (mirroring the `sendForFixing` CSRF pattern, plus the TOTP header) and the
  step-up exchange.
- **History view:** a new panel/section listing recent config changes (action,
  target, time, commit link) with a **Revert** button. Backed by
  `GET /api/config/history`.
- **Empty/loading/error states**, mobile-responsive forms (single column, ≥44px
  targets), no hover-only actions — consistent with the existing design system.
- **First-run enrollment:** if `AUDIT_TOTP_SECRET` is set but the operator has no
  step-up session, the modal explains 2FA; the actual QR enrollment is operator-
  side (`audit totp-init`), documented in `docs/deployment.md`.

## 10. Secrets & configuration

| Name | Where | Purpose |
|---|---|---|
| `AUDIT_GIT_WRITE_TOKEN` | fly.io | **NEW high-value secret** — push access to this repo for config commits. Fine-grained PAT, `contents:write` on THIS repo only. The primary thing 2FA + audit protect. |
| `AUDIT_TOTP_SECRET` | fly.io | shared TOTP base32 secret for step-up |
| `AUDIT_GIT_AUTHOR` | fly.io | commit identity, e.g. `sectool-dashboard <ops@breakoutsolutions.com>` |
| `CONFIG_REPO_DIR` | fly.io env | working-clone path (default `/data/repo`; `REPO_ROOT` locally) |
| `CONFIG_BRANCH` | fly.io env | branch the dashboard commits to (e.g. the repo default branch) |

Production fail-closed (§5.1 of the flyio-dashboard spec) extends: when config
editing is enabled (TOTP secret present), `AUDIT_GIT_WRITE_TOKEN` +
`AUDIT_GIT_AUTHOR` + `CONFIG_BRANCH` must be present or the **write routes are
disabled** (read-only dashboard still serves) — editing degrades closed, it never
silently commits with a missing identity.

## 11. Contract documentation rewrite (CLAUDE.md + v1 spec)

This build MUST update the prose that the change contradicts — otherwise the next
reader/agent hits a direct contradiction:
- **CLAUDE.md** "Non-negotiable safety contract" section → replace the "no flag,
  override, or config path" language with the §3.2 contract (allowlist still sole
  authority at scan time; authoring is now 2FA-gated live edit + git history),
  linking this spec.
- **audit-tool-v1 spec §4** → add an amendment note pointing here (mirroring how
  the v1 spec already records the §5.2/§5.3 operator amendments).
- **ADR** `docs/decisions/<n>-live-config-editing.md` — records the contract
  change, the B2 decision, the rejected alternatives (B1 / domain-suffix bound /
  approval queue), and the residual risk accepted.

## 12. Failure modes

| Scenario | Behavior |
|---|---|
| Wrong/expired TOTP | 403, nothing written; modal shows "invalid code". |
| Git push fails (token/network/non-FF) | local commit rolled back, 502, live config untouched; UI "couldn't save". |
| Volume lost / fresh machine | `ensureClone()` re-clones from the branch on boot; live config == git == last committed state. |
| Two operators edit at once | serialized by the config lock; second write replays on top of the first (fetch+ff) or 502s to retry. |
| TOTP code replay within its 30s window | accepted (shared-secret TOTP). Mitigation: the short step-up window + audit log; per-code single-use is deferred (§14) as it needs server-side used-code tracking. Documented residual. |
| Schema cross-check fails (e.g. enabled target whose host isn't allowlisted) | 422, nothing written — the existing `loadTargets` invariant is enforced before commit. |
| Remove a host still in use | 409, nothing written. |

## 13. Testing

- **Unit:** TOTP verify (valid/expired/skew); write-path validate→commit→re-read
  happy path (against a temp git repo); push-failure rollback leaves config
  unchanged; each route's auth gate (no Basic Auth → 401; no/invalid TOTP → 403;
  CSRF/origin → 403); schema rejection → 422; host-in-use removal → 409;
  add-staging-with-`addHost` writes both files in one commit; revert makes a
  reverting commit; history reads back.
- **Safety-critical assertions:** a write with valid Basic Auth but NO TOTP is
  rejected with nothing committed; the committed allowlist is what a subsequent
  `loadTargets`/`preflight` reads (consistency); a malformed host is rejected by
  the schema before commit.
- Git integration tests use a local temp bare repo as the "remote" (no network).
- Frontend: none-for-now (per testing posture); validated by `build:client` +
  review.

## 14. Open questions / deferred

- **Per-code single-use (anti-replay).** v1 accepts a code within its 30s window
  more than once. A used-code cache (server-side, last N codes) closes it; deferred
  pending whether the short step-up window is judged sufficient.
- **Per-user identity / attribution.** Deferred (operator chose shared creds). If
  needed later, OAuth + per-user audit actor.
- **Baseline/suppression editing via UI.** Deferred.
- **Auto-merge vs direct-commit-to-branch.** v1 commits directly to
  `CONFIG_BRANCH`. If the team prefers config changes land via auto-merged PRs
  (for CI checks on the change), revisit.
- **Domain-suffix meta-allowlist as an opt-in guardrail.** Rejected for v1 (no
  host restriction). Could be offered later as an optional toggle without changing
  the model.
