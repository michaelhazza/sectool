# Chunk learnings — flyio-dashboard build

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
