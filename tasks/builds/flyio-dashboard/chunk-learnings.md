# Chunk learnings — flyio-dashboard build

## Chunk 5 — POST /api/scan (registry validation + correlation nonce + dispatch)

**Completed:** 2026-06-14

**What was implemented:**
- `src/fix/github.ts` (modify) — exported `authHeaders` and `defaultGitHubClient` (previously module-private), per Plan gap 1. No other changes.
- `src/ui/dispatch.ts` (new) — `dispatchScan(params, client)` builds the GitHub workflow_dispatch URL from `parseOwnerRepo(workflowRepo)` (AUDIT_WORKFLOW_REPO), NEVER from targetRepo. Passes `{ ref, inputs: { target_repo, staging_url, job_id } }`. Returns `{ ok: true }` on 204 or `{ ok: false, status }` otherwise. Reuses `GitHubHttpClient` + `authHeaders` + `defaultGitHubClient` + `parseOwnerRepo` from `src/fix/github.ts`.
- `src/ui/server.ts` (modify) — Added `handleScanPost`: CSRF+origin → field validation → TWO independent registry checks (repo check + preflight URL check) → mint jobId → `appendEvent('requested')` → `dispatchScan` → `appendEvent('dispatched'/'dispatch_failed')` → 202/502. Added `handleScanPost` call in `handleRequest` (POST /api/scan route). Updated `handleRequest` signature to accept `envReader` + `githubClient` for dispatch. Updated `startServer` to resolve `dispatchGithubClient` (uses `githubClientArg ?? defaultGitHubClient`) and pass it through. Added imports: `ConfigError`, `defaultGitHubClient`, `appendEvent`, `preflight`, `dispatchScan`.
- `src/ui/dispatch.test.ts` (new) — 9 tests covering URL construction (invariant #2), method, headers, body inputs, and all DispatchResult variants.
- `src/ui/server.test.ts` (modify) — Added `vi.mock` for `config/load.js` and `live/preflight.js` (passthrough by default, overridable per-test). Added 11 new tests in 3 describe blocks: CSRF/origin guard (403 before any registry load), field validation (400 for missing/empty fields), registry safety gate (off-allowlist, unregistered repo, disabled repo, ConfigError→500, dispatch-to-AUDIT_WORKFLOW_REPO not scan target, happy path 202 with 32-hex jobId, dispatch failure → 502).

**Watch-out for future chunks:**
- `handleRequest` now takes 6 params: `(req, res, resolvedEnv, fixHandler, envReader, githubClient)`. Any chunk that modifies `handleRequest` must include the last two params.
- `githubClient` passed to `startServer` opts is now used for BOTH the fix path (via `makeProductionFixHandler`) AND the scan dispatch path. Tests that inject a `githubClient` for dispatch testing should be aware it also affects fix requests. In practice, fix tests use injected `fixHandler` spies so they never reach the GitHub client.
- `loadAllowlist` and `loadTargets` in `handleScanPost` are called with no injectable — they read from fixed config paths. Tests must use `vi.mock('../config/load.js')` + `vi.mocked(...).mockReturnValueOnce()` to control registry state. The mock is set up as a passthrough (wraps original) in server.test.ts `vi.mock` factory so existing tests are unaffected.
- `preflight` is also mocked in server.test.ts via `vi.mock('../live/preflight.js')` passthrough pattern.
- The `ref` hardcoded to `'main'` in `dispatchScan` call from `handleScanPost`. If a future chunk needs a configurable ref, it must be threaded through the env/request.
- `mockReset()` in the registry safety gate `beforeEach` clears both the call history AND the default implementation. Each registry-gate test MUST provide its own `mockReturnValueOnce` / `mockImplementationOnce` for all three mocked functions it relies on.

## Chunk 4 — GET /healthz + GET /api/scan-jobs

**Completed:** 2026-06-14

**What was implemented:**
- `src/ui/server.ts` (modify) — added `GET /healthz` handler directly in `handleRequest` BEFORE the auth gate (returns `200 {"ok":true}`, static, no data leak); added `GET /api/scan-jobs` handler in `handleApi` (calls `foldJobs(dataDir, Date.now())`, sorts most-recent-first by `requestedAt` desc, read error → `200 []`). Added `foldJobs` import from `./scan-jobs.js`. Extended `handleApi` signature with `dataDir: string` param; updated the one call site.
- `src/ui/server.test.ts` (modify) — added `extraHeaders?` param to the existing `get()` helper (matched to auth.test.ts's existing helper style); added `appendEvent` import; added two describe blocks: `GET /healthz` (unauthenticated 200 + exempt from auth gate even when enabled) and `GET /api/scan-jobs` (401 without creds when gate on, 200 with correct creds, most-recent-first ordering, state/runId correctness, empty-state 200 []).

**Watch-out for future chunks:**
- `handleApi` now takes a 6th param `dataDir: string`. Any chunk that adds another call site to `handleApi` must include it.
- The existing `get()` helper in `server.test.ts` now accepts `extraHeaders?: Record<string, string>` — no longer a zero-arity (path-only) function. Existing tests are unaffected (extra param is optional).
- `/healthz` is handled BEFORE the auth gate check in `handleRequest` (returns early). The `isExempt` check below it still lists `/healthz` — this is harmless redundancy (the route already returned) but is left as-is per surgical-changes rule.
- `foldJobs` is called with `Date.now()` (no injected clock in `StartServerOpts`). If a future chunk adds a `clock` injectable, the C4 call site in `handleApi` should be updated to use it.

## Chunk 2 — Basic Auth middleware (env-gated, production fail-closed)

**Completed:** 2026-06-14

**What was implemented:**
- `src/ui/auth.ts` (new) — `basicAuthGate(parsedHeader, resolvedEnv) → 'pass' | 'reject'` using `crypto.timingSafeEqual` with equal-length padded buffers; `isAuthEnabled(resolvedEnv)` returning true when authUser+authPass set OR isProduction.
- `src/ui/env.ts` (modify) — Added `authUser`/`authPass` fields to `ResolvedEnv`; added `StartupConfigError` class (extends Error, has `kind = 'StartupConfigError'`); added `assertProductionConfig(resolvedEnv, env)` that inspects RAW env reader values (not defaulted resolved values) so unset BIND_HOST/ALLOWED_ORIGIN are caught even though resolveEnv defaults them.
- `src/ui/server.ts` (modify) — Wired `basicAuthGate` into `handleRequest` (after URL parse, exempting `/healthz` and `/api/upload`); calls `assertProductionConfig` in `startServer` BEFORE `server.listen` (rejects promise on throw); added auth state console.log; `handleRequest` now takes `ResolvedEnv` directly (removed separate reportsDir/historyDir params); `currentResolved` re-assigned when port=0 re-resolves.
- `src/ui/auth.test.ts` (new) — 27 tests covering all plan cases.

**Watch-out for future chunks:**
- `handleRequest` now takes `(req, res, resolvedEnv: ResolvedEnv, fixHandler)` — the old `(req, res, allowedOrigin, reportsDir, historyDir, fixHandler)` signature is gone. Any chunk adding new routes must thread them through `resolvedEnv` fields.
- `ResolvedEnv` now has `authUser` and `authPass` fields. Both are `string | undefined`.
- `assertProductionConfig` takes `(resolvedEnv, env)` — BOTH the resolved struct AND the raw EnvReader. This is necessary so it can detect unset vars that resolveEnv would default.
- `startServer` catches `assertProductionConfig` throws and returns `Promise.reject(...)` — the server never binds on missing production config. Tests that start a server with production env (FLY_APP_NAME set) must supply all four required vars or expect rejection.
- The `console.log("Basic Auth: ...")` line fires on every startServer call — test output will contain this. This is expected and matches the plan's logging requirement.

## Chunk 1 — DATA_DIR / BIND_HOST / ALLOWED_ORIGIN env plumbing + path relocation

**Completed:** 2026-06-14

**What was implemented:**
- `src/schemas/run-id.ts` — extracted `RUN_ID_RE` constant
- `src/ui/env.ts` — `resolveEnv(env, port)` pure function returning `ResolvedEnv`
- `src/ui/server.ts` — threaded `resolveEnv` through `startServer`; replaced inline `expectedOrigin` in `handleFixPost` with `allowedOrigin`; threaded `reportsDir`/`historyDir` through `handleApi` and `makeProductionFixHandler`; extended `startServer` signature to `(port, opts?: FixHandler | StartServerOpts)` (backwards-compat)
- `src/cli.ts` — replaced inline `RUN_ID_RE` with import from `src/schemas/run-id.ts`; updated `doUi` log to use `srv.allowedOrigin`
- `src/ui/env.test.ts` — all 4 plan-specified test cases

**Watch-out for future chunks:**
- The vitest runner is broken in the local dev environment due to an empty `node_modules/esbuild/node_modules/@esbuild/` directory (esbuild binary missing). ALL vitest runs fail with "You installed esbuild for another platform" even on the pre-existing code. This is a pre-existing environment issue; G2 in CI should be fine. Do not attempt to run vitest locally without first running `npm ci` to reinstall.
- `startServer` now accepts `opts?: FixHandler | StartServerOpts`. Existing tests passing a positional `FixHandler` continue to work. New tests (C2+) should use the `StartServerOpts` object form with `fixHandler` key.
- `AuditServer` now has an `allowedOrigin: string` field. Tests and callers that destructure or type-assert `AuditServer` need to account for it.
- `handleApi` now takes `reportsDir` and `historyDir` as extra parameters. Any chunk that adds new routes to `handleApi` must thread these params.
- `makeProductionFixHandler` now takes `reportsDir` as its first arg. C2 server.ts modifications that call this function need to pass it.
- `resolveEnv` re-invoked when `port=0` (OS-assigned port) to get the correct `allowedOrigin`. If C2 changes startup order, ensure `resolveEnv` is called after the real port is known.
