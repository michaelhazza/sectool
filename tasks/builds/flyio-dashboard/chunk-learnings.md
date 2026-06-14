# Chunk learnings — flyio-dashboard build

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
