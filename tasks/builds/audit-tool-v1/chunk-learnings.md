# Chunk Learnings — audit-tool-v1

## P1-3 — Fingerprint module (2026-06-13)

**What worked:**
- `node:crypto` `createHash('sha256')` is available in Node 20 ESM with no extra dependency.
- Discriminated union on `kind: 'static' | 'live'` for `FingerprintInput` keeps the preimage logic clean and type-safe.
- `normalizeSymbol` lowercases + trims; this satisfies the BS-RLS-001 pgTable name case-stability requirement described in §6.6.
- The reformatting snippet test must use snippets that are token-for-token identical after whitespace collapse — do NOT use a raw snippet that has no surrounding space vs. one that does (they will differ after collapse).

**Watch-out for future chunks:**
- `FingerprintInput` has a `kind` discriminant (`'static'` | `'live'`) — callers (P2-3 normalizers, P4 live normalizers) must pass the right kind.
- `normalizeSymbol` lowercases the symbol — P3-1 BS-RLS-001 rule must pass the raw pgTable name literal; the normalizer handles case.
- `normalizePath` only strips one leading `./` or `/`. If a repo root absolute path is passed, callers should strip the repo root first before calling `normalizePath`.
- The `fingerprint()` function returns 64-hex — `displayId()` is the only correct way to get the `f-<16hex>` display form. Never slice the fingerprint directly at call sites.

## P1-4 — CLI skeleton (2026-06-13)

**What worked:**
- `parseOrExit` wrapper pattern: a helper that accepts a `() => void` callback and catches `parseArgs` errors, writing the subcommand-specific usage string and calling `process.exit(1)`. This avoids the TypeScript definite-assignment problem (can't use `let values; try { values = ... } catch { exit() }` because TS doesn't understand that `process.exit()` is `never` in catch).
- Outer variables (`let url: string | undefined`) are written from inside the `parseOrExit` callback closure — TS sees them as potentially uninitialized after the try/catch, so the closure write + outer `let` pattern works.
- `NODE_ENV !== 'test'` guard on the `main()` call at module level works with Vitest because Vitest sets `NODE_ENV=test` by default.
- `class ExitSignal extends Error` — required by `@typescript-eslint/only-throw-error`; cannot throw plain class instances.
- `// eslint-disable-next-line @typescript-eslint/no-unused-vars` on each stub function is the correct way to suppress the unused-param warning. The `_` prefix alone is NOT enough with the project's typescript-eslint config.
- Stub args `_args: SomeType` still need the `eslint-disable-next-line` comment even with the underscore prefix.
- `vi.spyOn(process.stdout, 'write').mockImplementation(...)` + `vi.spyOn(process, 'exit').mockImplementation(...)` is the correct in-process capture pattern for CLI tests.

**Watch-out for future chunks:**
- P5-6 replaces the stub bodies with real wiring. At that point, the `eslint-disable-next-line` comments and `_args` renames must be removed and replaced with real parameter names.
- The `parseOrExit` closure pattern (writing outer `let` variables from inside the callback) is verbose but type-safe. P5-6 should keep this pattern or refactor entirely — not mix it with the `let values; try { ... }` pattern.
- `validateConfigOrExit()` runs AFTER arg parsing in every subcommand — this means `--help` always exits before config validation, which is intentional. P5-6 must preserve this ordering.
- The `main()` export is used by tests; the `process.argv.slice(2)` call at module level is guarded by `NODE_ENV !== 'test'`. Any refactoring of the module-level guard must keep this.

## P1-2 — Config loader + cross-checks (2026-06-13)

**What worked:**
- Branded `LoadedAllowlist` via `as unknown as LoadedAllowlist` cast pattern (no runtime overhead, purely type-level brand). The `declare const _brand: unique symbol` pattern does NOT work at runtime — use the intersection-type + cast pattern instead.
- `BenchmarkAllowlistSchema` (structural-only, no DNS check) is needed for `loadBenchmarkAllowlist()` because `AllowlistSchema` rejects dotted-decimal IPv4 including `127.0.0.1` via `isDnsName`. The production loader uses `AllowlistSchema`; the benchmark loader uses the structural schema then enforces loopback-only manually.
- Tests write/restore fixture files around `beforeEach`/`afterEach` to avoid test pollution. The `benchmark/allowlist.benchmark.json` file gets created on disk by tests — this is expected (untracked, belongs to P1-5 chunk).
- Path resolution: `import.meta.url` → `fileURLToPath` → `dirname` → walk up two levels to repo root. Works correctly under vitest (which runs TypeScript directly).

**Watch-out for future chunks:**
- `LoadedAllowlist` is the type P4-1 (`assertAllowlisted`) must accept — it imports from `src/config/load.ts`. The brand is a type intersection; callers need to import the type from `load.ts`, not redefine it.
- `loadTargets()` takes a `LoadedAllowlist` parameter to run the cross-check. The CLI (P1-4) must call `loadAllowlist()` first, then pass it to `loadTargets()`.
- `benchmark/allowlist.benchmark.json` does NOT exist on disk in the committed tree — P1-5 must create it as a build artifact. Tests in P1-2 create it transiently during test runs.
- The `config/targets.json` ships with `automation-v1` repo ENABLED (1 repo, `enabled: true`) and the staging target DISABLED (`enabled: false`). This is intentional per §6.2: disabled off-allowlist is valid.
