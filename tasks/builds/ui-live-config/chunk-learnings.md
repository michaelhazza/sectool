# Chunk learnings — ui-live-config

## C3 — config-git.ts working clone + token channel + path-limited rollback (2026-06-14)

**What was implemented.**
`src/ui/config-git.ts` — full git adapter: `ensureClone`, `commitConfigChange`, `recentConfigCommits`, `assertConfigWorktreeClean`, `computeConfigRevert`. All five public functions plus typed errors (`ConfigWorktreeDirtyError`, `GitPushError`, `GitRollbackFailedError`, `NotARevertableConfigCommitError`). Single `runGit` helper with scoped token env (ImplInv-3). `CONFIG_PATHS` frozen array exported (ImplInv-1). `pathLimitedRollback` internal (ImplInv-7). 26 tests all green.
`src/ui/git-askpass.cjs` — Node.js GIT_ASKPASS helper, reads `AUDIT_GIT_ASKPASS_TOKEN` from its own env, echoes it to stdout. On non-Windows, `chmod 0700` applied at module load via `ensureAskpassExecutable()`.
`src/ui/config-git.test.ts` — 26 tests against a local bare repo (no network). Covers all §13 C3 cases including token-never-leaks (5 assertions), rollback-non-config-preserved, add-A-never-invoked, NFF replay-once, computeConfigRevert happy + two error paths.

**`git-askpass.cjs` lint note.** The `.cjs` extension is not covered by eslint's `disableTypeChecked` override (which targets `**/*.js`, not `**/*.cjs`). Linting it with `npx eslint src/ui/git-askpass.cjs` fails because the project service can't find it in tsconfig. The G1 gate lints only the `.ts` files; the `.cjs` file is a 6-line plain-JS runtime helper, reviewed inline. If the project's eslint config gains a `.cjs` rule in the future, add `'**/*.cjs'` to the disableTypeChecked override. Tracked in `tasks/todo.md`.

**Windows / autocrlf.** Tests use `git clone -c core.autocrlf=false` and `git config core.autocrlf false` in all clone operations. Without this, git on Windows converts LF → CRLF on checkout, causing `git status --porcelain` to show config files as modified immediately after clone, which triggers `ConfigWorktreeDirtyError`. Production (Linux fly.io) is unaffected — autocrlf is false by default.

**`ensureClone` dir creation.** `git clone` creates the destination directory itself. `ensureClone` must NOT `mkdir(configRepoDir)` before the clone — the implementation uses `mkdir(parent)` + best-effort `rm(configRepoDir)` instead. If you call `mkdir(configRepoDir)` before clone, git fails with "destination already exists".

**`commitConfigChange` content-identity guard.** If the file content written is identical to the tracked content (no change), `git add` stages nothing and `git commit` exits 1 ("nothing to commit"). Callers (C4) should diff against current content before calling, or accept that identical-content writes fail at the git layer with an error (not a silent no-op).

**Non-FF replay-once design.** On a non-FF push failure, the replay path: (1) `reset --soft priorHead` + `restore --staged --worktree` to un-commit cleanly, (2) `fetch origin`, (3) `merge --ff-only origin/<branch>`, (4) re-write files + re-stage + re-commit, (5) retry push. This preserves the pre-existing worktree state during the replay.

**Watch-out for future chunks.**
- C4 calls `commitConfigChange(files, message, opts)` with `opts.actor/action/target` for audit trailers. The commit message it passes MUST start with `config(dashboard):` for `computeConfigRevert`'s validation to work.
- C4 `revertConfigCommit` calls `computeConfigRevert(sha, { configRepoDir })` then passes the returned `files` straight to `commitConfigChange`. The returned `files` may have empty `content` for paths that were added (not modified) in the commit being reverted — C4 must handle the empty-content case (probably: delete the file from the worktree rather than writing empty JSON).
- C4 and C6 need `commitConfigChange`'s returned `sha` — it's already the pushed SHA (captured via `git rev-parse HEAD` after the push succeeds).
- The `ensureAskpassExecutable()` call is a module-level side-effect that runs on import. On Windows this is a no-op. No caller needs to await it.
- ESM import: `import { ... } from './config-git.js'` (`.js` extension required).

## C6 — /api/scan + on-demand-scan.yml config_sha wiring (2026-06-14)

**What was implemented.**
`src/ui/dispatch.ts` — added optional `configSha?: string` to `DispatchParams`. When provided and non-empty, it is included in `inputs` as `inputs['config_sha']`. The `ref` field remains the branch name (never the SHA). Both the interface JSDoc and a module-level comment note that the key name `config_sha` MUST match the YAML `inputs.config_sha:` declaration exactly (a mismatch is a CI-only 422).
`src/ui/server.ts` `handleScanPost` — replaced hardcoded `ref: 'main'` with `ref: resolvedEnv.configBranch ?? 'main'` (H2 fix). No `configSha` is threaded here because `handleScanPost` is triggered from the UI independently of a config edit; C4's config-write routes would need to pass it post-push.
`.github/workflows/on-demand-scan.yml` — added `config_sha` optional string input (with mismatch-warning comment). Changed `checkout@v4` to `fetch-depth: 0` so full history is available for `merge-base`. Added "Verify and pin config SHA (ImplInv-6)" step that runs when `config_sha != ''`: fetches `CONFIG_BRANCH` from `vars.CONFIG_BRANCH || 'main'`, runs `git merge-base --is-ancestor`, fails loudly if unreachable, then `git checkout <sha>`.
`src/ui/dispatch.test.ts` — added 6 C6 tests: configSha sends `ref === configBranch` (not SHA), `inputs.config_sha === sha`, ref !== sha; omitting configSha produces no `config_sha` key; undefined configSha same; all base inputs still present.
`src/ui/server.test.ts` — added 2 server tests: `CONFIG_BRANCH=staging-config` → dispatch ref is `'staging-config'` not `'main'`; no `CONFIG_BRANCH` → ref defaults to `'main'`.

**`fetch-depth: 0` note.** The existing `checkout@v4` step used default `fetch-depth: 1` (shallow clone). The `git merge-base --is-ancestor` command requires full history to determine reachability. Changed to `fetch-depth: 0` on the Checkout step. This is a load-bearing change for the verify step; without it, `merge-base` would fail for commits not in the shallow window.

**`vars.CONFIG_BRANCH` note.** The workflow uses `${{ vars.CONFIG_BRANCH || 'main' }}` (a repository variable, not a secret) to read the branch. If the operator doesn't set `CONFIG_BRANCH` as a repo var, it falls back to `'main'`. This must match what the server's `resolvedEnv.configBranch` resolves to.

**Watch-out for future chunks.**
- C4 and C7: when the config-write flow returns the pushed SHA, threading it to the immediately-following scan dispatch (via a `configSha` field on the post-config-write scan trigger) closes the full write-then-scan race. The current C6 change only fixes the `ref` field; `configSha` is not yet threaded from C4's `commitConfigChange` result to `handleScanPost`. The plan note ("at minimum make handleScanPost capable of accepting/forwarding a configSha") is met — `dispatchScan` now accepts it; the threading from C4→scan is a C7/C4 integration step.
- The `CONFIG_BRANCH` repo variable must be set in the GitHub repo settings to match the `CONFIG_BRANCH` env var on fly.io. Document in C8's deployment.md.

## C2 — Step-up cookie protocol (2026-06-14)

**What was implemented.**
`src/ui/stepup.ts` — `signStepUpCookie`, `verifyStepUpCookie`, `requireStepUp`, `handleStepUpExchange`, `hashPrincipal`. HMAC-SHA256 over base64url-encoded canonical claim JSON, 5-min TTL cookie with all four required attributes (HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300). The `handleStepUpExchange` takes a `helpers` parameter (csrfNonce, readBody, jsonResponse) so the route logic stays in stepup.ts while the server is a thin adapter.
`src/ui/env.ts` — added `stepupSigningSecret`, `gitWriteToken`, `gitAuthor`, `configBranch`, `totpSecret`, and `configWriteDeps: { ok, missing }` to `ResolvedEnv`. `assertProductionConfig` extended with a comment: write deps degrade closed (not a startup failure). `resolveEnv` computes `configWriteDeps.ok` only when `totpSecret` is set.
`src/ui/server.ts` — imported `handleStepUpExchange` from `./stepup.js`; wired `POST /api/config/step-up` inside `handleRequest`, passing `resolvedEnv` (the local parameter, not the closure's `currentResolved`).
`src/ui/stepup.test.ts` — 16 pure tests: sign/verify round-trip, signing-secret vs TOTP-secret distinction, tamper detection, expiry, requireStepUp with all forbidden cases.
`src/ui/stepup.routes.test.ts` — 7 HTTP tests: valid code → 200 + cookie with all four attrs; cookie signed with SIGNING_SECRET not TOTP_SECRET; wrong code → 403 no cookie; missing CSRF → 403; wrong Origin → 403; missing Basic Auth → 401; missing secrets → 403 "not configured".

**Watch-out for future chunks.**
- C4 calls `requireStepUp(req, { signingSecret, csrfNonce, principalHash, now })`. It needs to extract the `principalHash` from the current request's Authorization header using `hashPrincipal(credential)` — the same pattern used inside `handleStepUpExchange`. Import `requireStepUp` and `hashPrincipal` from `./stepup.js`.
- `handleStepUpExchange` in stepup.ts accepts `resolvedEnv: ResolvedEnv` directly. When C4 needs to check `configWriteDeps.ok`, that field is now on `resolvedEnv`. No wrapper needed.
- The `csrfNonce` passed to `requireStepUp` should be the request's `X-Audit-CSRF` header value — compared against the cookie's stored `csrfNonce`. The guard verifies both that the cookie's nonce matches the request header AND that the cookie signature is valid.
- ESM import paths: `import { ... } from './stepup.js'` (`.js` extension required as with all other src/ui imports).

## C1 — TOTP verify module + `audit totp-init` CLI helper (2026-06-14)

**What was implemented.**
`src/ui/totp.ts` — RFC-6238 TOTP in ~80 lines using `node:crypto` only (no new deps).
`src/ui/totp.test.ts` — 18 pure-function tests including RFC-6238 Appendix B vectors.
`src/cli.ts` — `totp-init` added to `COMMANDS`, with `TOTP_INIT_USAGE`, `parseTotpInit`, `doTotpInit` (dynamic import pattern matching `doUi`), and a dispatch `case`.

**ASCII QR decision.** A real QR renderer needs Reed-Solomon polynomial arithmetic and mask-pattern logic (~400 lines). Per the plan's "use your judgment" note, `asciiQr()` prints the `otpauth://` URI prominently with enrollment instructions instead. This is the correct trade-off — no new dependency, no broken renderer, operator can paste the URI into any authenticator app.

**Watch-out for future chunks.**
- `src/cli.ts` uses ESM (`type: module`). Any dynamic module load in new CLI commands must use `import('…').then(…)` (not `require()`), matching the `doUi` / `doTotpInit` pattern.
- The round-trip test for `generateSecret` uses a local `computeHotp` helper in the test file (mirrors the totp.ts algorithm). If `hotp` is ever exported from `totp.ts`, prefer importing it in the test rather than keeping two copies of the algorithm.
- RFC-6238 test vectors: secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` (base32 of ASCII "12345678901234567890"), T=59s → counter=1 → code `287082`; T=1111111109s → counter=37037036 → code `081804`.
- C2 (`stepup.ts`) calls `verifyTotp` from `./totp.js` — the import path is `src/ui/totp.js` (ESM `.js` extension required). No changes needed to `totp.ts` for C2 to consume it.
