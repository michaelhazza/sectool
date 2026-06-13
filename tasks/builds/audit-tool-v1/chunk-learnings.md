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

## P2-3 — Wrapped static scanners + normalizers (2026-06-13)

**What worked:**
- Injectable `exec` parameter pattern (each scanner takes an optional `ExecXxx` function): the `ExecSemgrep / ExecGitleaks / ExecOsv` types return `Promise<T>` (not declared `async`), so test stubs can be plain arrow functions returning `Promise.resolve(...)` — this avoids the `@typescript-eslint/require-await` error that fires when an `async` function has no `await`.
- For gitleaks: the `Secret` field is the raw credential; passing it through `redactString()` at normalization time ensures it never appears on any `Finding` field. The `Match` field often contains the secret value too, so it must also be individually redacted before landing in `evidence.raw`.
- For semgrep vulnClass mapping: checking `result.extra.metadata.category` first, then falling back to token-matching on the rule id, gives reasonable coverage without needing a full lookup table per upstream check id.
- For osv: the `groups[].max_severity` field (populated by osv-scanner) is the most reliable severity source; fallback to the first CVSS numeric score from `severity[]` handles cases where the group is absent.
- `normalizeSemgrepResult` uses the `check_id` as both `ruleId` and `symbol` — semgrep rules don't have a meaningful route/function context at this normalization layer; P3-3 custom YAML rules will refine this when they arrive.

**Watch-out for future chunks:**
- The `ExecSemgrep` type takes `(dir, ruleArgs)` — the default implementation passes `--config p/owasp-top-ten` and `--config rules/semgrep/`. P3-3 custom YAML rules live in `rules/semgrep/` and will be picked up automatically by the default exec; no changes to `semgrep.ts` are needed.
- Gitleaks exits 1 when it finds leaks (normal) and 0 when clean — the `defaultExecGitleaks` implementation wraps `execFile` in a try/catch to distinguish exit 1 (leaks found, not an error) from exit 2+ (tool error, rethrow). P6 benchmark/Docker tests should verify this exit-code handling against a real binary.
- `FingerprintInput` for gitleaks uses `Description` (not `Secret`) as the snippet preimage so the fingerprint is stable after redaction. The `Secret` value would fork fingerprints if it changed (e.g. key rotation), whereas the `Description` (rule description) is stable.
- The `ExecOsv` injectable type for `runOsv` does not expose an exit code — osv-scanner exits 1 when vulnerabilities are found (same pattern as gitleaks). The real `defaultExecOsv` does not catch non-zero exits; if the real binary exits 1 on findings, `execFileAsync` will throw and bubble up to the orchestrator as a family failure. This needs to be fixed before P6 real-binary runs. Consider the same try/catch pattern used in gitleaks.

## P4-5 — Auth/login exchange, carrier-aware successCheck (2026-06-13)

**What worked:**
- `EvalResult` discriminated union with an explicit `ok: boolean` field cleanly separates success cases (`ok:true`) from failure (`ok:false`), avoiding `@typescript-eslint/no-unsafe-assignment` that fires when narrowing via `'key' in obj` on types with mixed shapes.
- Returning `{ kind, reason, message }` explicitly from the `!evalResult.ok` branch (rather than object spread) avoids the "unsafe assignment of error typed value" lint error from rest-spreading a union with a typed error property.
- Injectable `HttpClient` pattern: `(req: HttpRequest) => Promise<HttpResponse>` (not `async`). Test stubs are plain arrow functions returning `Promise.resolve(...)` — avoids `@typescript-eslint/require-await` that fires on `async` arrow functions with no `await`.
- `Promise.reject(new Error(...))` in test stubs instead of `throw` inside an `async` arrow — matches the non-async pattern while still testing the throw path.
- `resolveEnv(name)` reads `process.env[name]` with `noUncheckedIndexedAccess` in play — returns `string | undefined`; the `!username || !password` guard handles both undefined and empty-string cases.
- CSRF capture is best-effort (wrapped in try/catch); GET failure is non-fatal so the login proceeds without a token.

**Watch-out for future chunks:**
- `Session.bearerToken` and `Session.cookieHeader` carry raw credential values. Any code that logs or persists a `Session` (P4-6 ZAP/Nuclei wrappers, P5-6 CLI wiring) MUST call `redactString()` from `src/report/redaction.ts` on these fields before writing to disk or stdout.
- `loginForTarget` selects `auth.testUsers[0]` for the primary session. P4-6 IDOR checks need TWO sessions (one per user) — callers must call `establishSession` directly for each `testUsers[i]` entry rather than relying on `loginForTarget`.
- `UnauthenticatedWithGap.coverageGap` is a string suitable for `targets[].coverageGaps` in the `RunReport` (§6.9). P5-6 / the live engine must propagate it there.
- `LoginFailure` is the direct type for `meta.failures` entries — callers add `{ target: target.name, family: 'probe'|'zap'|'nuclei', reason: failure.message }` to `meta.failures` when they receive a `LoginFailure` on an `activeScan:true` target.

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

## P4-6 — ZAP + Nuclei wrappers (scope-confined) (2026-06-13)

**ZAP orchestration mode decision (§16 open question):** Automation Framework YAML mode
(`zap.sh -autorun -cmd -silent` with YAML piped to stdin). Chosen over the daemon/API mode
because: (1) produces structured JSON output in a single subprocess invocation — no daemon
lifecycle; (2) ZAP 2.14+ ships the automation framework built-in — no extra add-ons; (3) the
automation-framework mode is the better fit for single-pass CI execution. The daemon/API mode
would be preferable for interactive/incremental use but is not our primary use case.

**What worked:**
- Injectable `ExecZap` / `ExecNuclei` function types (no async keyword on the type — tests
  use plain arrow functions returning `Promise.resolve(...)` to avoid `@typescript-eslint/require-await`).
- ZAP active/passive classification via plugin id range: plugin ids >= 10000 are active
  (ZAP convention); others are passive. Produces `ZAP-A-*` vs `ZAP-P-*` checkIds.
- `withHostBudget` one-token-per-run pattern: acquire one token before handing off to the
  subprocess. The subprocess is always serialized per host; it manages its own internal pacing
  but the token ensures the per-host budget is honoured for the entire run slot.
- Off-host filtering via URL hostname comparison in both wrappers (§4.4 scope confinement).
- Nuclei JSONL parsing: split on newline, skip blank lines, skip non-JSON lines (Nuclei prints
  progress to stdout in some modes). Non-zero exit code 1 = findings found (same pattern as gitleaks).
- ZAP report handles two layouts: `{ alerts: [...] }` (flat) and `{ sites: [{ alerts: [...] }] }`
  (nested). `collectAlerts()` normalizes both.

**Watch-out for future chunks:**
- `runZap` throws (does not return a failure Finding) when `activeScan:true` but sessions are
  missing — callers (P5-6 live engine wiring) must catch this and mark the target `failed` in
  `meta.failures` before surfacing to the report builder.
- `Session.bearerToken` and `Session.cookieHeader` are passed directly to Nuclei `-H` args
  in `buildNucleiArgs`. These must NOT be logged; callers should ensure sessions are not
  printed to stdout/stderr. P5-6 wiring must apply `redactString()` to any session fields
  written to disk or stdout.
- For the two-user IDOR/access-control checks (§7.3), callers must call `establishSession`
  directly for each `testUsers[0]` and `testUsers[1]` and pass both sessions as `sessions`
  to `runZap`. The `loginForTarget` helper only establishes one session.
- P6 real-binary integration tests must verify: (a) `defaultExecZap` produces a parseable
  ZapReport from a live ZAP run; (b) `defaultExecNuclei` handles exit code 1 correctly;
  (c) off-host scope confinement holds against the live fixture.
- The `defaultExecOsv` note from P2-3 applies equally here: if the real ZAP binary exits
  non-zero on findings (check ZAP docs), `defaultExecZap` may need the same try/catch as
  gitleaks. The current implementation only catches Nuclei's non-zero exit; ZAP's behavior
  depends on the automation-framework version. Verify at P6.
