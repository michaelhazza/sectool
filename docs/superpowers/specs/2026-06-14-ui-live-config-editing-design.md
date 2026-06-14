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

A config write has a single **commit point** — the `git push`. Everything before
the push is reversible (rollback leaves config untouched); once the push
succeeds, **git is the durable, authoritative record** and the change has
happened (HIGH-1 from review — the prior "atomic, nothing changes if any step
fails" framing was false, because the operational audit append and re-read happen
*after* the push):

1. **Auth:** Basic Auth (already) + valid TOTP step-up (§5). Fail → 401/403.
2. **Validate** the proposed config against the existing Zod schema
   (`TargetRegistrySchema` / `AllowlistSchema`) — including the cross-check that
   every enabled staging target's host is on the (post-change) allowlist. Invalid
   → 422, nothing written.
3. **Stage + commit (not yet pushed):** write the JSON file(s) in the working
   clone (config paths only, §ImplInv), `git add` + `git commit`. The commit
   message carries the **audit intent in a structured trailer** (actor, action,
   target, UTC time) so the durable audit record is part of the atomic git object,
   not a separate file that could diverge.
4. **Push — the commit point:** `git push` to `CONFIG_BRANCH`. Failure (token,
   network, non-fast-forward) → roll back the local commit (`git reset --hard` to
   the prior HEAD), respond 502, **nothing changed**. On a non-fast-forward,
   `fetch` + replay-once before giving up (§7).
5. **After the push (best-effort, never un-commits):** capture the pushed SHA,
   append an entry to the operational audit cache (§8), and re-read config from the
   working tree. If the cache append or re-read fails, the change is STILL
   committed — respond `200` with an `auditWarning` field rather than implying it
   was rolled back. The durable record is the git commit + its trailer; the JSONL
   cache is an accelerator, not the source of truth.
6. Respond 200 with the new state (+ pushed SHA).

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
`POST`/`PUT`/`DELETE` on repos, staging targets, and allowlist hosts, and the
revert route. It is NOT required for any read route or for `/api/scan` /
`/api/upload` (those keep their existing gates).

**One protocol (MEDIUM-2 — no header-or-token ambiguity):** a dedicated exchange
route `POST /api/config/step-up` takes Basic Auth + CSRF nonce + the 6-digit TOTP
code and, on success, sets a **step-up cookie**: `HttpOnly`, `Secure`,
`SameSite=Strict`, **5-minute TTL**, HMAC-signed (key = a server secret derived
from `AUDIT_TOTP_SECRET`), with claims `{ principalHash, csrfNonce, scope:
"config-write", exp }`. `principalHash` binds it to the current Basic Auth
principal; `csrfNonce` binds it to this origin/session. Every config-mutating
route requires a valid, unexpired step-up cookie whose `csrfNonce` matches the
request's `X-Audit-CSRF` and whose scope is `config-write`; otherwise `403`. The
cookie is the ONLY accepted step-up proof (no raw `X-Audit-TOTP` on write routes).
There is no long-lived session; when the 5-minute window lapses the next write
returns `403` and the UI re-prompts for a code.

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

**Revert is constrained, not a raw `git revert` (HIGH-3 from review).** A raw
revert of an arbitrary SHA could undo unrelated code/docs commits or produce an
invalid *current* config. `POST /api/config/revert/:commit` therefore:
- accepts ONLY a commit whose message has the `config(dashboard):` prefix and
  whose diff touches ONLY `config/*.json` (else `400` — "not a revertable config
  commit");
- only on `CONFIG_BRANCH`;
- applies the inverse change to a **temp worktree first**, then runs the SAME full
  schema + cross-check validation as a normal write against the *resulting*
  config. If the reverted state is invalid in the current context (e.g. it would
  re-add a host an enabled target no longer needs, or remove a host still in use)
  → `409` with the reason, **nothing committed**;
- on success, makes a NEW forward commit (never rewrites history), pushed and
  audited like any other write, and is itself 2FA-gated.

## 7. Git integration

A small `src/ui/config-git.ts` module wraps the working clone:
- `ensureClone()` — clone if absent, else `fetch` + fast-forward.
- `commitConfigChange(files, message)` — stage config paths only, commit, push;
  returns the new SHA, or rolls back the local commit on push failure.
- `recentConfigCommits(n)` — for History.

**Token handling (HIGH-2 — the token must never appear in the remote URL).**
Embedding the token in `https://x-access-token:<token>@github.com/...` leaks it via
process args, `.git/config`, error output, and crash logs. Instead the remote is
the plain `https://github.com/<owner>/<repo>.git`, and the token is supplied
**out-of-band** for each git call via a `GIT_ASKPASS` helper (or `git -c
http.extraHeader=...` with the value sourced from the environment, never argv).
The token is read from `AUDIT_GIT_WRITE_TOKEN` at call time and is **never**
written to `.git/config`, never interpolated into a command string, and never
included in any error, log line, audit row, or HTTP response. A redaction guard
scrubs the token pattern from any git stderr surfaced to the caller.

**Dirty-worktree handling (MEDIUM-1 — fail closed, never reset user state).**
Before any write and before any fast-forward, the worktree MUST be clean *for the
config paths*. The module:
- writes ONLY `config/*.json` (the whitelist in §ImplInv); never touches other
  paths;
- if the worktree has uncommitted changes to `config/*.json` (a partial prior
  write, manual edit, or interrupted run) → **fail closed with a diagnostic**
  (`409`, "config worktree dirty — manual reconciliation needed"), NOT a
  `reset --hard` that could destroy state;
- if HEAD is detached or on the wrong branch → fail closed with the diagnostic;
- uncommitted changes OUTSIDE `config/*.json` are ignored (don't block config
  writes, aren't touched by them). For local dev, `CONFIG_REPO_DIR` may be the
  project checkout; the same dirty-config guard applies, so local edits behave
  identically to prod.

Concurrent writes are serialized with a config-specific lock (reusing the
`withWorkspaceLock` primitive) so two edits cannot interleave a push.

**Push-failure safety:** a non-fast-forward triggers `fetch` + replay-once; if it
still fails, roll back the local commit and return 502 — the live config is
untouched.

**Post-push SHA (MEDIUM-3 — close the propagation race).** `commitConfigChange`
returns the pushed SHA. `/api/scan` dispatch (and the response of a config write)
carry that SHA so a scan triggered immediately after an edit uses the **exact ref
just pushed** (the `workflow_dispatch` `ref` is set to the SHA, not a branch name
that might resolve stale). A write does not report success until the push is
confirmed (the remote branch resolves to the pushed SHA).

## 8. Audit log + history / revert

Two records, with a clear authority order (MEDIUM-4 — the JSONL file is NOT an
independent tamper-proof log; the same process writes it and volume loss erases
it):
- **Git history is the durable, authoritative audit record.** Every change is a
  commit on the branch with the structured audit trailer (§4.2 step 3) — actor,
  action, target, UTC time — diffable, signed by the push, and revertable. This is
  the source of truth for "who/what/when".
- **`/data/history/config-audit.jsonl` is an operational audit *cache*** — a fast
  read model for the History view so it doesn't walk git on every load. To make
  in-place tampering detectable it is a **hash chain**: each entry carries
  `{ at, actor, action, target, commitSha, prevHash, hash }` where
  `hash = sha256(prevHash + canonical(entry-without-hash))`. On read the chain is
  verified; a broken link surfaces a "config audit cache integrity warning" and
  the History view falls back to reading git directly. The cache is never the
  authority — git is.

The **History view** (UI §9) lists recent entries (cache joined to commit SHAs,
git as fallback) with a **Revert** button → the constrained `POST
/api/config/revert/:commit` (§6), 2FA-gated and audited. Revert never rewrites
history.

## 9. UI

Extends the existing **Sites and Safety** screen (today read-only) into an editor.
Because credentials are shared (no per-user role, §2), the editor is shown **when
config editing is enabled and its write dependencies are healthy** (TOTP secret +
git-write token + author + branch all present, §10); otherwise the screen renders
read-only with a precise disabled reason (e.g. "config editing disabled —
`AUDIT_GIT_WRITE_TOKEN` not set"). The "Read-only view" footer reflects that
resolved state rather than implying a user role (LOW-2 from review).

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

## 11.5 Implementation invariants (§ImplInv)

Binding rules every chunk must honour (from the spec review). A change that
violates one is wrong even if its local test passes:

1. **Config writes may only modify the known config JSON paths** — exactly
   `config/targets.json` and `config/allowed-staging-hosts.json` (and
   `config/baseline.json` only if/when baseline editing ships). No other path is
   ever staged by the config-write module.
2. **The worktree must be clean for config paths before AND after each write.** A
   dirty config worktree fails closed (`409`) — never `reset --hard` over it.
3. **The git-write token must never appear** in remotes/`.git/config`, process
   args, logs, thrown errors, audit rows, or any HTTP/UI response. Supplied
   out-of-band per call; scrubbed from surfaced git output.
4. **Revert applies only to `config(dashboard)` commits touching only config
   paths**, and must pass the same full schema + cross-check validation as a
   normal write before it commits.
5. **A pushed git commit is the durable source of truth;**
   `config-audit.jsonl` is a (hash-chained) cache, never the authority.
6. **An immediate scan after a config edit must use or verify the pushed SHA** —
   dispatch with the SHA as the ref, not a possibly-stale branch name.
7. **Every config mutation is auth + CSRF/origin + TOTP-step-up + schema gated**
   before the commit point; the step-up cookie is the only accepted step-up proof.

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
| Dirty config worktree (partial/manual edit) | 409 + diagnostic; no write, no `reset --hard`. |
| Audit cache append fails after a successful push | 200 + `auditWarning`; change stays committed (git is the record). |
| Scan dispatched immediately after an edit | dispatched with the pushed SHA as the ref, so it reads the just-committed config (no branch-propagation race). |
| Audit cache file tampered/corrupted | integrity warning on read; History falls back to git; durable record intact. |

## 13. Testing

- **Unit:** TOTP verify (valid/expired/skew); write-path validate→commit→re-read
  happy path (against a temp git repo); push-failure rollback leaves config
  unchanged; each route's auth gate (no Basic Auth → 401; no/invalid TOTP → 403;
  CSRF/origin → 403); schema rejection → 422; host-in-use removal → 409;
  add-staging-with-`addHost` writes both files in one commit; revert makes a
  reverting commit; history reads back; **dirty config worktree → 409 (no reset)**;
  **push failure rolls back the local commit (HEAD unchanged)**; **write returns
  the pushed SHA and a scan dispatched right after uses that SHA as the ref**
  (MEDIUM-3 write-then-scan consistency); **audit cache hash-chain break is
  detected on read**.
- **Safety-critical assertions (the security boundary is server-side):** valid
  Basic Auth + missing/invalid step-up cookie → `403`, **nothing committed**;
  step-up cookie bound to a different CSRF nonce/principal → `403`; the committed
  allowlist is exactly what a subsequent `loadTargets`/`preflight` reads
  (consistency); a malformed host is rejected by the schema before commit;
  add-staging-with-`addHost` produces ONE commit touching both files; removing an
  in-use host → `409`, no commit; revert of a non-`config(dashboard)` commit →
  `400`; **the git-write token never appears** in any commit, `.git/config`, error
  string, audit row, or HTTP response (explicit assertion, HIGH-2).
- **Frontend tests (LOW-1 — reasoned decision: deferred, not skipped).** The
  reviewer flagged the write UI as security-sensitive. The actual security gate is
  the API: every mutation is auth + CSRF + TOTP-step-up + schema gated *server-
  side*, so a client that bypasses the UI and calls the API directly is still
  fully gated — the above server tests ARE the security tests. Frontend component
  tests would catch UX regressions (modal shows, button disables), not security
  holes, and the repo has no React test harness today. v1 therefore keeps frontend
  none-for-now (validated by `build:client` + review); standing up a component-test
  harness + the reviewer's UX cases (2FA modal opens on first write, invalid code
  blocks submit, `addHost` single payload, in-use-host 409 surfaced, revert
  re-prompts step-up) is recorded in §14 as a fast-follow.
- Git integration tests use a local temp bare repo as the "remote" (no network).

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
- **Frontend component-test harness (LOW-1 fast-follow).** Stand up a React test
  harness and cover the write-UI UX cases (2FA modal opens on first write, invalid
  code blocks submit, `addHost` single payload, in-use-host 409 surfaced, revert
  re-prompts step-up). Deferred because the security gate is server-side and the
  repo has no frontend harness yet; this is UX-regression coverage, not a security
  gap.
