# Build plan — live config editing via the dashboard (slug: ui-live-config)

**Spec:** `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md` (authoritative)
**Depends on:** flyio-dashboard feature (already on this branch): `src/ui/server.ts`,
`src/ui/auth.ts`, `src/ui/env.ts`, `src/ui/dispatch.ts`, `src/report/lock.ts`,
`src/config/load.ts`, `src/schemas/targets.ts`, `src/schemas/allowlist.ts`,
`src/fix/github.ts`, `ui/src/*`, `.github/workflows/on-demand-scan.yml`, `Dockerfile.ui`.

> ⚠️ This build **deliberately rewrites the project's central safety contract**
> (CLAUDE.md "Non-negotiable safety contract" + audit-tool-v1 §4 "no override path").
> The replacement contract is spec §3.2. The contract-doc rewrite (Chunk 8) is a
> REQUIRED deliverable, not a nicety — without it the next reader/agent hits a direct
> contradiction. The surviving invariant is unchanged: **no code path scans a host
> absent from the allowlist at scan time** (CI preflight, §4.3). What changed is only
> that *authoring* the allowlist moved from PR-review to 2FA-gated live edit + git history.

## Contents
1. Model-collapse check
2. Architecture notes
3. System invariants block (§11.5 ImplInv)
4. Chunk decomposition
5. Per-chunk detail (C1–C8)
6. Risks & mitigations
7. G2 verification + executor notes

---

## Model-collapse check

1. Does this decompose into ingest → extract → transform → render? **No.** This is a
   stateful, security-gated write path (auth → 2FA step-up → schema-validate → git
   commit/push → audit append → re-read), not a content-extraction pipeline.
2. Could a frontier multimodal model do any step in one call? **No.** Every step is a
   deterministic security boundary — TOTP verification, HMAC cookie signing, git
   plumbing with a path-whitelist, schema cross-checks. A model call in any of these
   positions would be a non-deterministic hole in a safety contract the operator is
   already consciously weakening.
3. Collapse into one model call? **Reject.** Determinism, auditability, and the
   token-never-leaks invariant are the entire point. There is nothing to collapse;
   the work is plumbing, not inference. No LLM is involved in this feature at all.

---

## Architecture notes

### Decisions

**D1 — Git is the durable source of truth; the JSONL audit file is a cache (§4.2, §8, ImplInv-5).**
The single commit point is `git push`. Everything before it is reversible; after it,
the change has happened. The operational audit append + config re-read happen *after*
the push and are best-effort — failure there yields `200 + auditWarning`, never a
false rollback. *Rejected:* the "atomic, nothing changes if any step fails" framing
(HIGH-1) — false, because the cache append is post-push.

**D2 — One step-up protocol: an HMAC-signed cookie, not a header (§5.3, MEDIUM-2).**
`POST /api/config/step-up` exchanges (Basic Auth + CSRF + TOTP code) for an
`HttpOnly; Secure; SameSite=Strict`, 5-min TTL cookie signed with a **dedicated**
`AUDIT_STEPUP_SIGNING_SECRET` (NOT derived from `AUDIT_TOTP_SECRET` — MEDIUM round 2:
keep the possession-factor domain and the session-signing domain separate). The cookie
is the **only** accepted step-up proof on write routes (no raw `X-Audit-TOTP`).
*Rejected:* per-request TOTP header (replay/ambiguity surface, header-or-token confusion).

**D3 — Token never touches argv/URL/config (§7, ImplInv-3, ⚠ safety-critical).**
`config-git.ts` supplies `AUDIT_GIT_WRITE_TOKEN` to git only via a `GIT_ASKPASS` helper
(or a `0600` temp credential-helper file deleted in `finally`). The remote is the plain
`https://github.com/<owner>/<repo>.git`. `git -c http.extraHeader=…` is **explicitly
disallowed** (header lands in argv). A redaction guard scrubs the token pattern from any
git stderr surfaced to the caller. *Rejected:* `https://x-access-token:<token>@github.com/...`
(leaks via process args, `.git/config`, crash logs).

**D4 — Explicit path-list staging + path-limited rollback (§4.2, §7, ImplInv-7, ⚠).**
Stage exactly `git add config/targets.json config/allowed-staging-hosts.json` — **never
`git add -A` / `git add .`**. Rollback on push failure is `reset --soft <priorHead>` +
`restore --staged --worktree --source=<priorHead> -- <config paths>` — **never
`reset --hard`**. Pre-existing non-config staged/worktree state survives untouched, and
a post-rollback assertion verifies no config path remains staged (else 500, not a dirty
index). *Rejected:* `reset --hard` (destroys unrelated working state); bare `reset --soft`
(leaves config staged).

**D5 — SHA is a workflow input, not the dispatch ref (§7, ImplInv-6, ⚠).**
GitHub's `workflow_dispatch.ref` accepts a **branch/tag name only, not a raw SHA**.
So dispatch with `ref = CONFIG_BRANCH` AND a new `config_sha` input; the workflow
verifies the SHA is reachable from `CONFIG_BRANCH`, then `git checkout <config_sha>`.
Reuse `GitHubHttpClient` from `src/fix/github.ts` (and `dispatchScan` in
`src/ui/dispatch.ts`, extended) for the dispatch — no new HTTP dependency.
*Rejected:* dispatching with the SHA as `ref` (GitHub rejects it — HIGH round 2).

**D6 — Constrained revert, not raw `git revert` (§6, §8, HIGH-3).**
`POST /api/config/revert/:commit` accepts only a commit whose message has the
`config(dashboard):` prefix and whose diff touches only `config/*.json`; applies the
inverse to a **temp worktree first**, runs the SAME full schema + cross-check validation
against the resulting config, and only then makes a NEW forward commit (never rewrites
history). *Rejected:* raw `git revert <sha>` (could undo unrelated commits or produce an
invalid current config).

**D7 — Reuse the existing schemas verbatim for write validation (§4.2 step 2, §6).**
`TargetRegistrySchema` / `AllowlistSchema` and the host↔allowlist cross-check already
encoded in `loadTargets` are the write validator, so the UI can never persist a config
the CLI would reject. The cross-check (`enabled staging target host ∈ allowlist`) is run
against the **post-change** state before commit. *Rejected:* a separate write-time schema
(would drift from the read path — the exact bug §4.3 prevents).

**D8 — Working clone on the volume, replacing the baked read-only config (§4.1, §10).**
On fly.io the server reads config from a git working clone at `CONFIG_REPO_DIR`
(default `/data/repo`) on the persistent volume, created by `ensureClone()` on boot via
the write token. The baked `config/` in `Dockerfile.ui` remains as a fallback/seed only.
Locally, `CONFIG_REPO_DIR = REPO_ROOT` (the project checkout), so dev and prod behave
identically. `DATA_DIR` still owns reports/history.

### Patterns
- **Adapter** — `config-git.ts` adapts raw git plumbing to a small internal contract
  (`ensureClone`, `commitConfigChange`, `recentConfigCommits`); callers never see git argv.
- **Dependency inversion** — write routes call a `config-write` service; the service calls
  schemas + `config-git` + the audit cache; nothing skips a layer.
- **Reuse over new** — `withWorkspaceLock` (config lock), `GitHubHttpClient` + `dispatchScan`,
  `jsonResponse`/`readBody`/CSRF+origin guard, the existing schemas. No new primitives where
  an existing one fits.

### Plan gaps the builder must NOT improvise on
1. **TOTP dependency — recommendation: a small in-repo HMAC-SHA1 TOTP module, NO new
   dependency.** Node's `crypto` already provides `createHmac('sha1', …)`; RFC-6238 is ~40
   lines (counter = floor(epoch/30), HMAC-SHA1, dynamic truncation, 6-digit mod). The repo's
   only runtime deps are scanner/UI-shaped; adding `otplib` widens the supply-chain surface of
   a security-critical possession factor for ~40 lines of well-understood code. Build it in
   `src/ui/totp.ts`. (If the builder hits a real blocker, escalate — do **not** silently add a dep.)
2. **Reuse `GitHubHttpClient` (`src/fix/github.ts`) for the SHA-reachability/dispatch calls.**
   Extend `dispatchScan` (`src/ui/dispatch.ts`) to carry the `config_sha` input. Do not
   introduce a second HTTP client or `fetch` call.
3. **`Dockerfile.ui` MUST include `git`** in the runtime stage — the working clone needs the
   git binary at runtime.
4. **Working-clone location:** `CONFIG_REPO_DIR` (default `/data/repo`, on the volume) — NOT
   the baked read-only `config/` in the image. Locally it is `REPO_ROOT`. Baked config is a seed only.
5. **Local dev parity:** `CONFIG_REPO_DIR=REPO_ROOT` commits to the local repo; the same
   dirty-config guard applies, so a local edit behaves exactly like prod.
6. **Audit cache path:** `resolve(historyDir, 'config-audit.jsonl')`, distinct from
   `scan-jobs.jsonl` / `trend.jsonl`.

---

## System invariants block (§11.5 ImplInv — binding; a violation is wrong even if its local test passes)

| # | Invariant | Enforced in chunk(s) |
|---|---|---|
| 1 | Config writes touch ONLY `config/targets.json` + `config/allowed-staging-hosts.json` | C3, C4 |
| 2 | Worktree clean for config paths before AND after each write; dirty → 409, never `reset --hard` | C3 |
| 3 | ⚠ Git-write token NEVER in remotes/`.git/config`/argv/logs/errors/audit/HTTP responses | C3 |
| 4 | Revert applies only to `config(dashboard)` commits touching only config paths; full re-validation before commit | C4 |
| 5 | Pushed commit is source of truth; `config-audit.jsonl` is a (hash-chained) cache | C4, C5 |
| 6 | ⚠ Immediate scan uses/verifies the pushed SHA — dispatch on branch, SHA as an **input** | C6 |
| 7 | ⚠ Explicit config-path staging (never `add -A`); rollback restores only those paths (never `reset --hard`); post-rollback no config path staged; non-config state preserved | C3, C4 |
| 8 | Every config mutation is auth + CSRF/origin + TOTP-step-up + schema gated; the cookie is the only step-up proof | C2, C4 |
| 9 | ⚠ Config readers (`loadAllowlist`/`loadTargets`, GET `/api/config/*`, the write-service cross-check) read the SAME `CONFIG_REPO_DIR` the writer commits to — what the UI shows == what a scan targets (H1) | C0, C4 |

⚠ = safety-critical. Chunks C0, C3, C4, C6 carry the safety-critical invariants and must get the
sharpest review.

---

## Chunk decomposition (ordered, forward-only dependencies)

| # | Chunk | Depends on | Safety-critical |
|---|---|---|---|
| **C0** | **`CONFIG_REPO_DIR`-aware config reads** (parameterise `loadAllowlist`/`loadTargets`; thread into server GET routes) | — | ⚠ (consistency) |
| C1 | TOTP verify module + `audit totp-init` CLI helper | — | |
| C2 | Step-up cookie protocol (`POST /api/config/step-up` + HMAC cookie + fail-closed env) | C1 | ⚠ (gate) |
| C3 | `config-git.ts` — working clone, token channel, path-limited staging/rollback, revert primitive | C0 | ⚠⚠⚠ |
| C4 | Config-write service + write API routes (repos/staging/allowlist/addHost/history/revert) | C0, C2, C3 | ⚠ |
| C5 | Hash-chained audit cache (`config-audit.jsonl`) | C3 | |
| C6 | `/api/scan` + `on-demand-scan.yml` `config_sha` wiring | C3, C4 | ⚠ |
| C7 | UI editor forms + 2FA modal + History/revert + secrets-health gating | C2, C4, C5 | |
| C8 | Contract docs rewrite (CLAUDE.md + v1 §4 amendment + ADR) + `deployment.md` + `Dockerfile.ui` git | C1–C7 | |

C0/C1/C3 are independent foundations; C4 is the join point. **C0 is the
prerequisite that makes the §13 consistency invariant achievable** — without it the
dashboard commits to `CONFIG_REPO_DIR` but `loadAllowlist`/`loadTargets` keep
reading the baked image config (H1 from plan review).

---

## Per-chunk detail

### C0 — `CONFIG_REPO_DIR`-aware config reads ⚠ (consistency — H1 from plan review)

**Scope.** Make every config *reader* obtain its directory from the resolved env's
`CONFIG_REPO_DIR` instead of the hardcoded module-relative `config/`, so the
dashboard reads back exactly what the writer (C3/C4) commits. Foundation for
invariant 9 and the §13 consistency test. No write logic here.

**The gap (verified against the repo).** `src/config/load.ts` hardcodes
`_repoRoot = join(_moduleDir,'..','..')` then `ALLOWLIST_PATH`/`TARGETS_PATH` under
it; `loadAllowlist()` / `loadTargets(allowlist)` take **no dir argument**.
`src/ui/server.ts` `CONFIG_DIR = resolve(REPO_ROOT,'config')` backs the GET
`/api/config/*` routes. Nothing reads `CONFIG_REPO_DIR`. Left unfixed, on fly.io the
writer commits to `/data/repo/config` while readers read the baked `/app/config` →
split brain; and locally (`CONFIG_REPO_DIR==REPO_ROOT`) the consistency test passes
spuriously.

**Files.**
- modify `src/config/load.ts` — add an optional `opts?: { configDir?: string }` to
  `loadAllowlist`, `loadTargets`, `loadBaseline` (default = the current
  module-relative path, so existing CLI callers are unchanged). Resolve
  `ALLOWLIST_PATH`/`TARGETS_PATH`/`BASELINE_PATH` from `opts.configDir` when given.
- modify `src/ui/server.ts` — derive `CONFIG_DIR` from `resolvedEnv.configRepoDir`
  (the working clone's `config/`), and pass `{ configDir }` into the
  `loadAllowlist`/`loadTargets` calls in `makeProductionFixHandler` AND the new
  config-write service (C4). The GET `/api/config/*` routes read the same dir.
- modify `src/ui/env.ts` — resolve `configRepoDir` (default `REPO_ROOT` locally,
  `/data/repo` when `FLY_APP_NAME`/explicit). (C2 also touches env.ts for the
  step-up secrets — coordinate; C0 lands the `configRepoDir` field, C2 the rest.)

**Contracts.** Existing CLI behaviour is byte-identical when `opts` is omitted
(default path). The dashboard always passes `configDir = <configRepoDir>/config`.
The write-service cross-check (C4/D7) validates the **in-memory post-change
projection**, never a stale disk re-read.

**Error handling.** A missing config dir/file behaves exactly as today (the
existing `ConfigError`/empty handling), now relative to the resolved dir.

**Test considerations.** `loadAllowlist({configDir})` / `loadTargets(.,{configDir})`
read from the given dir; default (no opts) reads the shipped path (existing tests
unchanged). **Consistency test (invariant 9, §13):** write a config file under a
temp `configDir`, then `loadTargets({configDir})` returns exactly that content —
asserted against the temp dir, NOT `REPO_ROOT/config`, so it cannot pass spuriously
in local dev.

**Verification commands.** `npx eslint src/config/load.ts src/ui/server.ts src/ui/env.ts`;
targeted: `npx vitest run src/config/load.test.ts`.

**Dependencies.** None (foundation). C3, C4 depend on it.

---

### C1 — TOTP verify module + `audit totp-init` CLI helper

**Scope.** A self-contained RFC-6238 TOTP module and a CLI enrollment helper. No HTTP, no
git, no cookies. Does NOT enforce per-code single-use (deferred §14) — accepts a ±1 step
(30s) window.

**Files.**
- create `src/ui/totp.ts`
- create `src/ui/totp.test.ts`
- modify `src/cli.ts` — add `totp-init` to `COMMANDS`, a `TOTP_INIT_USAGE`, a `parseTotpInit`,
  a `doTotpInit`, and the dispatch `case`.

**Module shape.**
- *Public:* `verifyTotp(secret /* base32 */, code, opts?: { window?: number; now?: number }): boolean`;
  `generateSecret(): string` (base32); `otpauthUri(secret, label, issuer): string`;
  `asciiQr(text): string`.
- *Hidden:* base32 decode, HMAC-SHA1 via `crypto.createHmac`, counter math
  (`floor(now/1000/30)`), dynamic truncation, the window loop, constant-time 6-digit compare.

**Contracts / implementation notes.**
- Use `node:crypto` `createHmac('sha1', key)` — **no new dependency** (plan gap 1).
- `verifyTotp` compares against steps `[-window … +window]` with `timingSafeEqual` on the
  6-digit strings (pad to equal length). Reject non-6-digit input early.
- `doTotpInit` prints the base32 secret, an
  `otpauth://totp/sectool:ops?secret=…&issuer=sectool` URI, and an ASCII QR — to stdout only.
  Nothing written to disk; the operator sets the fly secret themselves. NEVER print into any
  committed file.

**Error handling.** Malformed base32 → `verifyTotp` returns `false` (never throws into the
request path). `totp-init` is stdout-only; bad args → existing `parseOrExit` usage message.

**Test considerations (maps §13 "TOTP verify (valid/expired/skew)").**
- valid current-step code → true; code from a step outside the window → false; ±1 skew → true;
  wrong-length / non-numeric → false; tampered last digit → false;
- `generateSecret()` round-trips through `verifyTotp` with a freshly computed code.

**Verification commands.** `npx eslint src/ui/totp.ts src/ui/totp.test.ts src/cli.ts`;
targeted: `npx vitest run src/ui/totp.test.ts` (pure functions, no IO).

---

### C2 — Step-up cookie protocol ⚠ (gate)

**Scope.** The `POST /api/config/step-up` exchange route, HMAC cookie sign/verify, and the
fail-closed env extension. Provides a reusable `requireStepUp(req)` guard that C4 consumes.
Does NOT mutate any config.

**Files.**
- create `src/ui/stepup.ts` (cookie sign/verify + the `requireStepUp` decision function +
  `handleStepUpExchange`)
- create `src/ui/stepup.test.ts`
- modify `src/ui/env.ts` — resolve `stepupSigningSecret`, `gitWriteToken`, `gitAuthor`,
  `configBranch`, `configRepoDir`, `totpSecret`; add a `configWriteDeps: { ok; missing[] }`
  resolver; **extend** `assertProductionConfig` per §10 (below).
- modify `src/ui/server.ts` — wire `POST /api/config/step-up`; thread the resolved deps through
  `handleRequest`. (Route body lives in `stepup.ts`; server is the adapter.)
- create/extend `src/ui/stepup.routes.test.ts`

**Module shape.**
- *Public:* `signStepUpCookie(claims, secret): string`; `verifyStepUpCookie(value, secret, now): Claims | null`;
  `requireStepUp(req, { signingSecret, csrfNonce, principalHash, now }): 'ok' | 'forbidden'`;
  `handleStepUpExchange(req, res, resolvedEnv)`.
- *Hidden:* HMAC over the canonical claim string, base64url encoding, the 5-min TTL check,
  `principalHash` derivation (sha256 of the Basic Auth principal), `Set-Cookie` assembly, cookie parsing.

**Contracts.**
- Cookie claims: `{ principalHash, csrfNonce, scope: 'config-write', exp }`. Signed with
  `AUDIT_STEPUP_SIGNING_SECRET` (§5.3) — **never** `AUDIT_TOTP_SECRET` (named §13 test).
- `Set-Cookie`: `audit_stepup=<value>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300`.
- `POST /api/config/step-up`: Basic Auth (upstream) + `X-Audit-CSRF` match + Origin match
  (reuse the `handleFixPost` guard pattern) + body `{ code }`. Valid TOTP (`verifyTotp` from C1
  against `AUDIT_TOTP_SECRET`) → `200` + `Set-Cookie`. Wrong/expired code → `403 { error:
  'invalid code' }`. Missing signing/TOTP secret → route disabled (fail closed).
- `requireStepUp` → `forbidden` unless a present, unexpired cookie has `scope === 'config-write'`,
  a valid signature, `csrfNonce === req X-Audit-CSRF`, and `principalHash === current principal`.
- **M2 (operative binding under shared creds):** with a single shared Basic Auth credential (§2),
  `principalHash` is near-degenerate (every authenticated request shares it), so the
  **load-bearing step-up protections are the `csrfNonce` binding + the 5-min TTL + the signature**.
  `principalHash` is kept as cheap defence-in-depth and forward-compat for per-user identity (§14);
  the "different principal → forbidden" unit test documents that future boundary, not a present
  multi-principal isolation guarantee. No route may claim multi-principal isolation today.

**§10 fail-closed extension (extend `assertProductionConfig`).** When config editing is enabled
(`AUDIT_TOTP_SECRET` present), production startup additionally requires `AUDIT_GIT_WRITE_TOKEN`,
`AUDIT_STEPUP_SIGNING_SECRET`, `AUDIT_GIT_AUTHOR`, `CONFIG_BRANCH`. If TOTP is present but any of
these is missing, the **write routes are disabled** (read-only dashboard still serves) — editing
degrades closed; it never commits with a missing identity or signs cookies with a missing key.
Expose `configWriteDeps: { ok; missing[] }` so C4 can 403 and C7 can render the precise reason.

**Error handling.** Invalid/expired/forged cookie → `requireStepUp` `'forbidden'` (C4 → 403).
Exchange route: bad code → 403; CSRF/origin → 403; missing signing/TOTP secret → 403 with a
"config editing not configured" reason (no cookie set).

**Test considerations (maps §13).**
- cookie is signed with `AUDIT_STEPUP_SIGNING_SECRET`, **not** the TOTP secret (named §13 test);
- cookie bound to a different CSRF nonce → forbidden; different principal → forbidden;
- expired cookie (now > exp) → forbidden;
- valid code → 200 + a `Set-Cookie` with all four attributes;
- wrong/expired code → 403, no cookie.

**Verification commands.** `npx eslint src/ui/stepup.ts src/ui/env.ts src/ui/server.ts <tests>`;
targeted: `npx vitest run src/ui/stepup.test.ts` (cookie sign/verify are pure).

---

### C3 — `config-git.ts` working clone + token channel + path-limited staging/rollback ⚠⚠⚠

**Scope.** The git adapter. Owns the working clone, the token-safe channel, the explicit-path
staging, the path-limited rollback, push-failure replay-once, and the post-push SHA. Carries
ImplInv 1, 2, 3, 7. Does NOT validate schemas (caller's job) and does NOT touch the HTTP layer.
Highest-risk chunk — build and review in isolation against a temp bare repo.

**Files.**
- create `src/ui/config-git.ts`
- create `src/ui/git-askpass.cjs` (or generate the helper at runtime in a temp dir) — the
  `GIT_ASKPASS` script that echoes the token from an env var the parent sets
- create `src/ui/config-git.test.ts`

**Module shape.**
- *Public:* `ensureClone(opts): Promise<void>`; `commitConfigChange(files: ConfigFileWrite[],
  message: string): Promise<{ sha: string }>`; `recentConfigCommits(n): Promise<ConfigCommit[]>`;
  `assertConfigWorktreeClean(): Promise<void>`; **`computeConfigRevert(commitSha):
  Promise<{ files: ConfigFileWrite[] }>`** — computes the inverse config content of a prior
  `config(dashboard)` commit by reading the parent's config blobs (in an isolated `git worktree
  add` temp tree or via `git show <parent>:<path>`), returning the file contents to *re-validate
  then commit forward* via `commitConfigChange` (M4 — keeps ALL git argv + the token inside
  `config-git.ts`; C4 never spawns git directly). Typed error set: `ConfigWorktreeDirtyError`,
  `GitPushError`, `GitRollbackFailedError`, `NotARevertableConfigCommitError`.
- *Hidden:* the askpass/credential-helper plumbing, the `priorHead` capture, `reset --soft` +
  `restore --staged --worktree`, the post-rollback `git diff --cached --name-only` assertion,
  the fetch+replay-once on non-fast-forward, the stderr redaction guard.

**Contracts / binding rules.**
- **ImplInv-1:** the only stageable paths are `config/targets.json` +
  `config/allowed-staging-hosts.json`, encoded as a frozen module-level `CONFIG_PATHS` whitelist.
  `commitConfigChange` writes only those files and stages exactly `git add <CONFIG_PATHS>` —
  **never `git add -A` / `git add .`**.
- **ImplInv-2:** before any write and before any fast-forward, `assertConfigWorktreeClean()` runs
  `git status --porcelain -- <CONFIG_PATHS>`; any dirty config path → throw
  `ConfigWorktreeDirtyError` (C4 → 409). Detached HEAD or wrong branch → fail closed with a
  diagnostic. Non-config dirty paths are **ignored** (not blocked, not touched).
- **ImplInv-3 ⚠ (token channel — spawn-env scoped, H3 from plan review):** remote is plain
  `https://github.com/<owner>/<repo>.git`. The token from `AUDIT_GIT_WRITE_TOKEN` is passed to git
  ONLY via `GIT_ASKPASS`, and ONLY through the **explicit `env` option of the specific
  authenticated spawn** (`spawn(git, args, { env: { ...minimalEnv, AUDIT_GIT_ASKPASS_TOKEN: token,
  GIT_ASKPASS: helperPath } })`). Binding rules the builder must NOT relax:
  - the token is **never placed on `process.env`** (so no later child / crash-dump / env logger can
    leak it) — it lives only in the scoped spawn env of the push/clone/fetch that needs auth;
  - **read-only git invocations** (`status`, `diff`, `log`/`recentConfigCommits`, the revert
    temp-worktree diff) spawn **without** the token var at all;
  - **Forbidden:** token-in-URL, `git -c http.extraHeader=…`, writing the token to `.git/config`,
    interpolating it into any argv/command string, or putting it on `process.env`.
  - the redaction guard `scrubToken()` wraps not just git stderr but **any thrown error message /
    `.cause` / serialised spawn-options** before it is surfaced, logged, thrown, or returned.
- **ImplInv-7 ⚠:** push is the commit point. On push failure: record `priorHead = HEAD` (captured
  before commit), `git reset --soft <priorHead>`, then
  `git restore --staged --worktree --source=<priorHead> -- <CONFIG_PATHS>`. **Never `reset --hard`.**
  Post-rollback assertion: `git diff --cached --name-only` contains none of `CONFIG_PATHS` — if it
  does, throw `GitRollbackFailedError` (C4 → 500). Pre-existing non-config staged/worktree state is preserved.
- Non-fast-forward push → `git fetch` + fast-forward + replay-once; if it still fails →
  path-limited rollback + `GitPushError` (C4 → 502).
- `ensureClone`: clone if `CONFIG_REPO_DIR` absent; else `fetch` + fast-forward. Checkout
  `CONFIG_BRANCH`. Uses the same token channel.
- Commit message convention: **`config(dashboard): <action> <target>`** (the `config(dashboard):`
  prefix is what C4's revert filter keys on). The structured audit trailer is appended as git
  trailers: `Audit-Actor:`, `Audit-Action:`, `Audit-Target:`, `Audit-Time:` (UTC).

**Concurrency (M1 from plan review).** BOTH `commitConfigChange` AND `ensureClone`'s fetch/
fast-forward run inside `withWorkspaceLock` with the SAME config-specific `lockPath`
(`resolve(configRepoDir, '.config-write-lock')`), so a boot-time reclone/ff and a live write
can't interleave on the working tree (a concurrent fetch must not move HEAD/worktree under an
in-flight commit). Distinct from the reports `.upload-lock`.

**Error handling.** `ConfigWorktreeDirtyError` → 409; `GitPushError` → 502; `GitRollbackFailedError`
→ 500 (all in C4). Every error message passes through `scrubToken` first.

**Test considerations (maps §13 — use a local temp **bare** repo as the remote, no network).**
- happy path: write → commit → push → returns SHA; committed tree matches the proposed config;
- **dirty config worktree → throws `ConfigWorktreeDirtyError` (no `reset`)** (named §13);
- **push failure rolls back config paths only**, leaving a separately-modified non-config tracked
  file AND a separately-staged non-config file untouched; config == `priorHead`;
  `git diff --cached` shows no config paths (round 2/3 named §13 — seed both files, force a push
  failure, assert both survive);
- **the git-write token never appears** in any commit, `.git/config`, error string, returned
  value, **or `process.env` after a write/failed push** (explicit assertion, HIGH-2/H3 / §13
  safety-critical) — grep the temp repo + `.git/config` + captured stderr + the thrown error
  string + `process.env`; and assert a forced-push-failure error message is token-free;
- non-fast-forward triggers fetch + replay-once;
- `add -A` is never invoked (assert via the staged set after a commit, or a spy on the git runner);
- **`computeConfigRevert`** returns the parent's config content for a `config(dashboard)` commit
  and rejects (`NotARevertableConfigCommitError`) a commit touching non-config paths (M4).

**Dependencies.** C0 (reads/writes under `CONFIG_REPO_DIR`).

**Verification commands.** `npx eslint src/ui/config-git.ts src/ui/config-git.test.ts`;
targeted: `npx vitest run src/ui/config-git.test.ts` (temp dir + temp bare repo it creates/tears
down — no network).

---

### C4 — Config-write service + write API routes ⚠

**Scope.** The §6 write API: POST/PUT/DELETE on repos, staging-targets (incl. `addHost` atomic),
allowlist; `GET /api/config/history`; `POST /api/config/revert/:commit`. Each route runs the §4.2
write path: auth → CSRF/origin → step-up → schema-validate (post-change) → `commitConfigChange` →
audit append → re-read. The service is the deep module; the routes are thin adapters.

**Files.**
- create `src/ui/config-write.ts` (the service: read-current → mutate-in-memory → validate →
  commit → re-read; one function per mutation kind)
- create `src/ui/config-write.test.ts`
- modify `src/ui/server.ts` — add route dispatch (method + path-regex on
  `/api/config/(repos|staging-targets|allowlist|history|revert)`), wire resolvedEnv + the C2
  `requireStepUp` guard + the C3 module + the C5 audit cache.
- create `src/ui/config-write.routes.test.ts`

**Module shape.**
- *Public (service):* `addRepo`, `editRepo`, `removeRepo`, `addStagingTarget` (with optional
  `addHost`), `editStagingTarget`, `removeStagingTarget`, `addHost`, `removeHost`,
  `revertConfigCommit(commitSha)`, `listHistory(n)` — each returns the new projected state + the
  pushed SHA (or a typed error).
- *Hidden:* read-current-from-worktree, the in-memory mutation, the schema + cross-check
  invocation, the mutation→files mapping, audit-trailer assembly, the post-push re-read, the
  `auditWarning` path.

**Contracts.**
- Status codes (§6): `200` new state (+ pushed SHA); `401` no/invalid Basic Auth; `403`
  CSRF/origin **or** missing/invalid step-up cookie; `422` schema invalid; `409` constraint
  (in-use host; dirty config worktree); `502` git commit/push failed (nothing changed); `500`
  rollback-failed / internal.
- **Gate order on every mutating route (ImplInv-8):** Basic Auth (upstream) → CSRF + Origin
  (reuse `handleFixPost` pattern) → `requireStepUp` (C2) → parse body → schema-validate the
  **post-change** config (reuse `TargetRegistrySchema`/`AllowlistSchema` + the `loadTargets`
  host↔allowlist cross-check, D7) → `commitConfigChange` (C3) → audit append (C5) → re-read.
  A failure at or before validate writes nothing.
- **`addHost` atomic (§6):** `POST /api/config/staging-targets` with `{ ..., addHost: true }`
  writes BOTH `targets.json` and `allowed-staging-hosts.json` in **one** `commitConfigChange`
  call (one commit touching both files).
- **`DELETE /api/config/allowlist/:host`:** if an enabled staging target still uses the host, the
  cross-check fails → `409`, nothing committed.
- **Revert (D6, ImplInv-4) — composes the C3 primitive (M4):** `revertConfigCommit` calls
  `config-git.computeConfigRevert(sha)` (which validates the `config(dashboard):`-prefix +
  config-only-paths and returns the parent's config content, or throws
  `NotARevertableConfigCommitError` → `400`); the service then runs the SAME full schema +
  cross-check against the resulting config (invalid → `409`, nothing committed) and, on success,
  forwards through `commitConfigChange` (a NEW forward commit, never a history rewrite), pushed +
  audited; 2FA-gated like any write. C4 NEVER spawns git directly — all git stays in `config-git.ts`.
- **`GET /api/config/history`:** cache (C5) joined to commit SHAs, git (`recentConfigCommits`) as
  fallback; read route — NO step-up required.
- **Post-push best-effort (D1, §4.2 step 5):** if the C5 audit append or the re-read fails AFTER a
  successful push, respond `200` with an `auditWarning` field — never imply rollback.

**Error handling.** Map C3 errors: `ConfigWorktreeDirtyError`→409, `GitPushError`→502,
`GitRollbackFailedError`→500. Schema failure→422 with `error.issues`. In-use host→409. All error
bodies pass through `scrubToken` (defense in depth).

**Test considerations (maps §13 — most named tests land here).**
- write-path validate→commit→re-read happy path (temp git repo);
- push-failure rollback leaves config unchanged;
- each route's auth gate: no Basic Auth → 401; **no/invalid step-up cookie → 403, nothing committed**
  (§13 safety-critical); CSRF/origin → 403;
- schema rejection → 422; **malformed host rejected by schema before commit** (§13 safety-critical);
- host-in-use removal → 409, no commit;
- **add-staging-with-`addHost` produces ONE commit touching both files** (§13 + safety-critical);
- revert makes a reverting commit; revert of a non-`config(dashboard)` commit → **400** (§13 safety-critical);
- history reads back;
- **the committed allowlist is exactly what a subsequent `loadTargets`/`preflight` reads**
  (consistency, §13 safety-critical);
- audit cache append failure after a successful push → `200 + auditWarning` (D1).

**Verification commands.** `npx eslint <C4 files>`; targeted:
`npx vitest run src/ui/config-write.test.ts` (service tests against a temp git repo; no network).

---

### C5 — Hash-chained audit cache (`config-audit.jsonl`)

**Scope.** The operational audit *cache* — a fast read model for History, hash-chained so in-place
tampering is detectable. NOT the authority (git is, ImplInv-5). Append + verified read +
integrity-warning fallback.

**Files.**
- create `src/ui/config-audit-cache.ts`
- create `src/ui/config-audit-cache.test.ts`

**Module shape.**
- *Public:* `appendAuditEntry(entry, path): void`; `readAuditChain(path): { entries: AuditEntry[];
  integrityOk: boolean; present: boolean }`.
- *Hidden:* `prevHash` chaining, `canonical(entry-without-hash)` serialization, the sha256 link
  computation, broken-link detection.

**Contracts.**
- Entry: `{ at, actor, action, target, commitSha, prevHash, hash }` where
  `hash = sha256(prevHash + canonical(entry-without-hash))` (§8). First entry's `prevHash` is a
  fixed genesis constant.
- Path: `resolve(historyDir, 'config-audit.jsonl')` (plan gap 6).
- `readAuditChain` verifies every link; a broken link → `integrityOk: false` (C4/C7 surface a
  "config audit cache integrity warning" and History falls back to git via `recentConfigCommits`).
- **Missing file is NOT an integrity failure (M5 from plan review):** an absent
  `config-audit.jsonl` (fresh/lost volume, or before the first edit) returns
  `{ entries: [], integrityOk: true, present: false }` — NO warning. Only a parse error or a
  broken hash link sets `integrityOk: false`. Conflating "absent" with "tampered" would fire a
  spurious integrity alarm on every fresh volume, eroding trust in the signal precisely when it
  must be credible.
- Append is best-effort from C4's perspective (D1): a throw here AFTER a successful push must not
  roll back — C4 turns it into `auditWarning`.

**Error handling.** Append IO failure → throws (C4 catches → `auditWarning`). Read of a
**missing** file → `{ entries: [], integrityOk: true, present: false }` (benign, no warning); read
of a **corrupt/broken-link** file → `{ entries: [], integrityOk: false, present: true }` (warning).
Never throws into the request path.

**Test considerations (maps §13 "audit cache hash-chain break is detected on read").**
- append N entries → `readAuditChain` returns them with `integrityOk: true`;
- **tamper one entry's `action`/`target` in place → `integrityOk: false`** (named §13 test);
- truncated/garbage file → `integrityOk: false`, no throw;
- **missing file → `integrityOk: true, present: false`, NO warning** (M5 — fresh-volume case);
- canonical serialization is stable (key-order independent).

**Verification commands.** `npx eslint <C5 files>`; targeted:
`npx vitest run src/ui/config-audit-cache.test.ts` (pure + tmp file, no network).

---

### C6 — `/api/scan` + `on-demand-scan.yml` `config_sha` wiring ⚠

**Scope.** Close the write-then-scan propagation race (§7, ImplInv-6). `commitConfigChange` already
returns the pushed SHA (C3); thread it through dispatch as a workflow **input** (not as `ref`), and
teach the workflow to verify + checkout that SHA.

**Files.**
- modify `src/ui/dispatch.ts` — add optional `configSha` to `DispatchParams`; include it as the
  `config_sha` input; `ref` stays `CONFIG_BRANCH` (a real branch).
- modify `src/ui/server.ts` `handleScanPost` — **replace the existing hardcoded `ref: 'main'`**
  (currently at ~`server.ts:580`, from the flyio-dashboard build) with `resolvedEnv.configBranch`
  (H2 from plan review — if `CONFIG_BRANCH != 'main'` the dispatch + the workflow reachability check
  key off the wrong branch and every post-edit scan fails). Pass the latest pushed SHA as
  `configSha` when available; reuse the existing `GitHubHttpClient` (plan gap 2).
- modify `.github/workflows/on-demand-scan.yml` — add a `config_sha` input; after `checkout`, add a
  step that **verifies `config_sha` is reachable from `CONFIG_BRANCH`** then `git checkout <config_sha>`.
  **M3 (input-name contract):** the dispatch body key `config_sha` MUST exactly equal the YAML
  `inputs.config_sha:` declaration name — a typo here is caught ONLY by CI (GitHub returns 422
  "Unexpected inputs" and every post-edit scan fails dispatch), there is no G1 coverage. Add a
  linking comment in both files.
- modify `src/ui/dispatch.test.ts` (+ a server scan test).

**Module shape.**
- *Public:* `dispatchScan(params)` gains `configSha?` and emits `inputs.config_sha`.
- *Hidden:* nothing new — same client.

**Contracts (ImplInv-6 ⚠).**
- Dispatch body: `ref: <CONFIG_BRANCH>`, `inputs: { target_repo, staging_url, job_id, config_sha }`.
  The SHA is **NEVER** used as the dispatch `ref` (GitHub rejects a raw SHA; explicit §13 assertion).
- Workflow reachability check (before scanning): `git merge-base --is-ancestor "$config_sha"
  "origin/$CONFIG_BRANCH"`; fail → hard error (do not scan a SHA not reachable from the branch).
  Then `git checkout "$config_sha"`.
- `config_sha` is **optional** (a scan unrelated to a config edit, or a replay, omits it — the
  workflow checks out the branch tip as today when empty).

**Error handling.** Missing/unreachable SHA in the workflow → fail the job loudly (never scan stale
or arbitrary config). Server-side dispatch failures keep the existing 502 + event path.

**Test considerations (maps §13 "write returns the pushed SHA and a scan dispatched right after
sends `ref=CONFIG_BRANCH` + `config_sha` input; assert the SHA is NOT used as the dispatch ref").**
- a write returns the pushed SHA (C3/C4) and the immediately-following dispatch sends
  `ref === resolvedEnv.configBranch` (NOT the literal `'main'`, NOT the SHA) with
  `inputs.config_sha === <pushed SHA>` and `ref !== <SHA>` (H2 + §13);
- omitting `configSha` produces a dispatch with no `config_sha` input (back-compat).

**Verification commands.** `npx eslint src/ui/dispatch.ts src/ui/server.ts src/ui/dispatch.test.ts`;
targeted: `npx vitest run src/ui/dispatch.test.ts`. (The YAML reachability step is validated by
CI/review, not a local unit test.)

---

### C7 — UI editor forms + 2FA modal + History/revert + secrets-health gating

**Scope.** Turn `TargetsSafety.tsx` (read-only today) into an editor; add the 2FA step-up modal;
add a History view with Revert; gate the editor on resolved write-dependency health. Server-side
gates are the security boundary; this is UX. Frontend component tests are deferred (§13 LOW-1, §14)
— validated by `build:client` + review.

**Files.**
- modify `ui/src/api.ts` — config-write helpers (mirror `sendForFixing`'s CSRF pattern) + the
  step-up exchange + history fetch + revert + `fetchConfigHealth`.
- modify `ui/src/types.ts` — add `ConfigHistoryEntry`, `ConfigWriteDeps`, request/response shapes.
- modify `ui/src/screens/TargetsSafety.tsx` — inline Edit/Disable/Remove per row; Add buttons +
  forms per section; the "not allowlisted — also add it" `addHost` checkbox on the staging form;
  the disabled-reason banner; the History panel with Revert.
- create `ui/src/components/StepUpModal.tsx` — the 6-digit-code modal.
- create `ui/src/components/ConfigHistory.tsx` (or inline in TargetsSafety).
- modify `ui/src/screens/RunAScan.tsx` — only if the staging create/edit form is shared.
- modify `src/ui/server.ts` — add a `GET /api/config/health` endpoint exposing `configWriteDeps`
  (from C2) so the UI can render the precise disabled reason.
- modify `ui/src/vocabulary.ts` if the allowlist label/help encodes "PR review" language.

**Module shape.**
- *Public (api.ts):* `stepUp(code)`, `addRepo/editRepo/removeRepo`, `addStagingTarget(entry,
  { addHost })`, `editStagingTarget/removeStagingTarget`, `addHost/removeHost`, `fetchConfigHistory`,
  `revertConfig(commit)`, `fetchConfigHealth`.
- *Hidden:* the CSRF-fetch-then-POST dance, the 403→re-prompt-step-up flow, optimistic vs refetch
  state, modal open/close state.

**Contracts / UX (§9).**
- Editor shown only when `configWriteDeps.ok` (TOTP + step-up signing secret + git-write token +
  author + branch all present); else read-only with a precise disabled reason (e.g. "config editing
  disabled — `AUDIT_GIT_WRITE_TOKEN` not set"). The "Read-only view" footer reflects the resolved
  state, not a user role (LOW-2).
- **2FA modal:** opens on the first write in a session (or after the 5-min window lapses, i.e. a
  write returns 403). Submits the 6-digit code to `POST /api/config/step-up`; on success retries the
  pending write. Clear errors for wrong/expired codes.
- **Add-staging form:** surfaces the host's allowlist status live; if not allowlisted, shows "Host
  not allowlisted — also add it" with a checkbox that sets `addHost` so target + host land in one commit.
- **History view:** lists recent changes (action, target, time, commit link) with a Revert button →
  constrained `POST /api/config/revert/:commit` (2FA-gated; re-prompts step-up if needed). If
  `integrityOk` is false, show the integrity warning and note History fell back to git.
- Empty/loading/error states; mobile-responsive single-column forms; ≥44px targets; no hover-only
  actions (consistent with the existing design system).
- Remove the stale read-only copy in `TargetsSafety.tsx` ("Changes require a PR review.", "no
  override path exists", "added … via PR", "approved via PR") — it now contradicts the new contract;
  replace with the live-edit + git-history framing.

**Permissions.** No per-user role (§2). Visibility is gated only by `configWriteDeps.ok`; the actual
security gate is server-side (auth + CSRF + step-up + schema). A client bypassing the UI and calling
the API directly is still fully gated.

**Error handling.** Surface 401/403/409/422/502 as specific plain-language messages (wrong code,
in-use host 409, schema 422, "couldn't save" 502). A 403 on a write opens the step-up modal.

**Test considerations (frontend tests deferred — §13 LOW-1).** Validated by `build:client` + review.
Reviewer should eyeball: modal opens on first write; invalid code blocks submit; `addHost` sends a
single payload; in-use-host 409 surfaced; revert re-prompts step-up; disabled reason renders when
deps unhealthy. (Standing up a React test harness is the §14 fast-follow.)

**Verification commands.** `npx eslint <touched ui files> src/ui/server.ts`. (Client typecheck/build run at G2.)

---

### C8 — Contract docs rewrite + deployment + Dockerfile.ui git

**Scope.** Rewrite the prose the new contract contradicts, document operations, and add `git` to the
dashboard image. REQUIRED by §11 — without it the next reader hits a direct contradiction.

**Files.**
- modify `CLAUDE.md` — replace the "Non-negotiable safety contract" section with the §3.2 contract:
  allowlist still sole authority **at scan time**; authoring moved from PR-review to 2FA-gated live
  edit + git history; link this spec. Keep the "never weaken to pass a test" spirit for the surviving
  invariant (no scan of a non-allowlisted host at scan time).
- modify `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md` — add an amendment note at §4 (and
  the Status line) pointing to this spec, mirroring the existing §5.2/§5.3 operator amendments (e.g.
  "[Amended 2026-06-14: §4 'no override path' superseded by the 2FA-gated live-config-editing contract
  — see `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md` §3.2]"). Do NOT delete §4.
- create `docs/decisions/0007-live-config-editing.md` (next number after 0006) from `_template.md` —
  record the contract change, the B2 decision, rejected alternatives (B1 / domain-suffix bound /
  approval queue), and the residual risk accepted (§3.3: anyone with the password + TOTP device can
  authorise + scan any host; compensating controls: 2FA, git history + hash-chained cache, the write
  token as the protected high-value secret).
- modify `docs/deployment.md` — add the new secrets (`AUDIT_GIT_WRITE_TOKEN`, `AUDIT_TOTP_SECRET`,
  `AUDIT_STEPUP_SIGNING_SECRET`, `AUDIT_GIT_AUTHOR`) + env (`CONFIG_REPO_DIR`, `CONFIG_BRANCH`); the
  `audit totp-init` enrollment procedure; the extended fail-closed set + degrade-closed behavior
  (§10); the working-clone-on-volume note.
- modify `Dockerfile.ui` — install `git` in the runtime stage (plan gap 3); note the working clone
  lives at `CONFIG_REPO_DIR` on the volume, not the baked read-only `config/` (plan gap 4).

**Module shape.** Docs + Dockerfile only — no public code surface.

**Contracts.** The CLAUDE.md edit must preserve the surviving invariant in spirit: "no code path
scans a host absent from the allowlist at scan time." The v1 amendment ADDS a note (the v1 spec keeps
its historical §4, mirroring prior amendments).

**Test considerations.** `Dockerfile.ui` change validated by the image build (review/CI), not a unit
test. Docs reviewed for the contradiction being fully resolved (no remaining "no override path" /
"requires a PR" claims in CLAUDE.md or the UI).

**Verification commands.** Lint any touched `ui/src` file. The doc set + Dockerfile are review-validated.

---

## Risks & mitigations

- **Split-brain (UI shows a host a scan can't target, or vice-versa).** Mitigated by the commit
  preceding the re-read (§4.3) and CI re-validating against the git-committed allowlist via preflight.
  The post-push SHA-as-input (C6) closes the branch-propagation race.
- **Token leak (the highest-value secret, §10).** Mitigated by the C3 token channel (askpass / 0600
  helper, never argv/URL/config) + the redaction guard + an explicit "token never appears" test. This
  is the safety-critical center of the build — review C3 hardest.
- **Partial prior run leaves a half-written config worktree.** Mitigated by
  `assertConfigWorktreeClean()` failing closed (409) — never `reset --hard` (ImplInv-2).
- **Rollback leaves a dirty index.** Mitigated by the post-rollback `git diff --cached` assertion →
  500 rather than a silent dirty state (ImplInv-7).
- **Audit cache divergence / tamper.** Mitigated by treating git as authoritative (D1) and the hash
  chain detecting in-place tamper, with History falling back to git.
- **TOTP replay within a 30s window.** Accepted residual (§12/§14) — compensated by the short 5-min
  step-up window + audit log; per-code single-use is a deferred fast-follow.
- **Fresh/lost volume.** `ensureClone()` re-clones from the branch on boot; live config == git == last
  committed state (§12).
- **Load-bearing assumption:** `CONFIG_REPO_DIR` is a real git checkout in both dev and prod. If it
  isn't (e.g. a bare image without `git`), writes fail closed. C8's Dockerfile.ui git install is
  therefore a hard runtime dependency of C3/C4, even though it lands last.

## Deferred (do NOT build in v1 — §2, §14)
Per-user identity / SSO; per-code single-use anti-replay; baseline/suppression editing via UI;
auto-merge-via-PR instead of direct-commit; domain-suffix meta-allowlist; the React component-test
harness (LOW-1 fast-follow — the security gate is server-side).

---

## G2 — end-of-construction verification (coordinator-owned, run ONCE against integrated branch state)

`npm run lint`, `npm run typecheck`, `npm run build`, `npm run build:client`. Do NOT run these
per-chunk. (CI additionally runs the full gate + benchmark suite as the pre-merge gate.)

## Executor notes

- Suggested order: C1 and C3 first (independent), then C2, then C4 (the join), then C5, C6, C7, C8.
  C4 cannot start until C2 (`requireStepUp`) and C3 (`commitConfigChange`) exist.
- All git tests use a **local temp bare repo as the remote** — no network (§13).
- **Never weaken the surviving safety invariant to make a test pass:** no code path may scan a host
  absent from the allowlist at scan time. The spec removed the PR-review gate, not the scan-time
  allowlist authority.
- **Test gates and whole-repo verification scripts (`npm run test:gates`, `npm run test:qa`,
  `npm run test:unit`, `npm test`, `scripts/verify-*.sh`, `scripts/gates/*.sh`, `scripts/run-all-*.sh`)
  are CI-only. They do NOT run during local execution of this plan, in any chunk, in any form.
  Targeted execution of unit tests authored within this plan is allowed; running the broader suite is not.**
