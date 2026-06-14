# Todo

Active backlog. Items captured here are queued for work; resolved items move to `tasks/todo-archive/<quarter>.md` once a section is fully `[x]`.

## How items land here

- `triage-agent` captures ideas + bugs surfaced during dev sessions.
- Review agents (`pr-reviewer`, `spec-conformance`, `chatgpt-pr-review`, `chatgpt-spec-review`) route deferred / directional findings here.
- Audit runs (`audit-runner`) write deferred items here under a `## Deferred from <scope> audit — <YYYY-MM-DD>` section.

## Item shape

```markdown
- [ ] [origin:<source>:<YYYY-MM-DD>] [status:open|deferred|resolved] Short title
  - Why: one or two sentences.
  - Approach: one or two sentences.
  - Risk: one sentence (optional).
```

`origin` lets you grep the source of every backlog item. Examples: `origin:pr-1234-r2-f3`, `origin:setup-audit:2026-05-03`.

---

## Sections

### Framework adoption gaps

- [ ] [origin:validate-setup:2026-06-12] [status:open] Two origin-repo specs cited by agents are absent everywhere
  - Why: `.claude/agents/spec-coordinator.md` and `finalisation-coordinator.md` cite `tasks/builds/development-lifecycle-governance-upgrade/spec.md` and `docs/superpowers/specs/2026-04-30-dev-pipeline-coordinators-spec.md` as authoritative; neither exists in this repo or the framework submodule.
  - Approach: the governing tables (intent field rules, Lifecycle Declaration, ABCd) are already inlined in the agent files and `docs/spec-authoring-checklist.md`, so the pipeline runs without them; import from the origin repo or localise the citations when convenient.
  - Risk: low — citations are provenance pointers, not runtime dependencies.
- [ ] [origin:validate-setup:2026-06-12] [status:open] doc-sync coverage gaps
  - Why: `references/verification-commands.md`, `references/local-override-convention.md`, `docs/frontend-design-examples.md`, `docs/mobile-capability-principles.md`, `docs/spec-authoring-checklist.md` are neither in the `docs/doc-sync.md` table nor explicitly excluded.
  - Approach: add rows or exclusions to `docs/doc-sync.md` during the first finalisation pass.
- [ ] [origin:validate-setup:2026-06-12] [status:open] Author `architecture.md` so context-pack anchors resolve
  - Why: all 5 context packs reference `architecture.md` anchors; the doc doesn't exist yet (fresh adoption).
  - Approach: author after audit-tool v1 lands its real architecture; anchor IDs per framework convention.

## From builder — 2026-06-14

- [ ] [origin:builder-C3:2026-06-14] [status:resolved 2026-06-14] eslint config does not cover `.cjs` files — `src/ui/git-askpass.cjs` cannot be linted with the project-service-aware ruleset.
  - Why: `eslint.config.js` disableTypeChecked override targets `**/*.js` and `ci/**/*.mjs` but not `**/*.cjs`. The `git-askpass.cjs` file is a 6-line plain-JS runtime helper; its lint is excluded from G1. The file is reviewed inline.
  - Approach: add `'**/*.cjs'` to the `disableTypeChecked` override files array in `eslint.config.js`. Low risk change.
  - Risk: low — the file is trivial and reviewed; no current lint enforcement.

- [ ] [origin:builder-C9:2026-06-14] [status:open] Pre-existing: `Sidebar.tsx` line 56 has an unused `cls: string` parameter in the `navBtn` curried function — flagged by `@typescript-eslint/no-unused-vars` when linted with `--no-ignore`. Not introduced by C9; in unchanged code.
  - Why: The main `eslint.config.js` intentionally ignores `ui/**`, so this never fires in `npm run lint`. Surfaced only under `--no-ignore` G1 checks on this chunk. Not fixed per surgical-changes rule.
  - Approach: remove the unused `cls` parameter from the `navBtn` helper (or prefix with `_cls`) in a future cleanup chunk scoped to Sidebar.tsx.
  - Risk: low — lint-only, no functional impact.

- [ ] [origin:builder-C7:2026-06-14] [status:open] `RowAction` defined as nested function component inside `TargetsSafety` — `react/no-unstable-nested-components` may fire at G2 build:client.
  - Why: RowAction is defined inside TargetsSafety's render and passed as JSX. No hook rules violation, but eslint react rules may flag it. Not fixed per surgical-changes rule (extracting it would require passing onClick via prop, which is its current interface — extracting to module level is fine but out of scope for this chunk).
  - Approach: lift `RowAction` to module level, outside the `TargetsSafety` function, in a future cleanup chunk or at G2 if the build:client step flags it.
  - Risk: low — functional impact is zero; lint/build issue only.

- [ ] [origin:builder-C6:2026-06-14] [status:open] `withWorkspaceLock` (src/report/lock.ts) is fail-fast on contention (throws WorkspaceLockedError immediately when held by a live process), NOT a queuing mutex. C6 works around this with an in-process `withUploadQueue` promise chain that ensures only one upload enters the lock at a time. Future chunks or refactors should be aware: `withWorkspaceLock` is cross-process protection only; it does NOT serialize same-process callers.
  - Why: plan said to use `withWorkspaceLock` for M1 serialization, but the M1 test requires both concurrent uploads to succeed (200). Concurrent uploads in the same process would both fail with WorkspaceLockedError → 500 without the in-process queue layer.
  - Approach: in-process layer already added (withUploadQueue). No action needed unless cross-process real queueing is required.

- [x] [origin:builder-C6:2026-06-14] [status:resolved 2026-06-14] Pre-existing `/api/trend` vs `/api/history/trend` route mismatch (plan gap #5) — `ui/src/api.ts` calls `/api/history/trend` but `server.ts` serves `/api/trend`.
  - **RESOLVED during local UI testing:** it broke the Portfolio Overview screen (404 from `/api/history/trend`). Aligned the client `fetchTrend()` to the server's actual `/api/trend` route.
  - Why: pre-existing mismatch noted in plan gaps as out-of-scope.
  - Approach: rename route in server.ts or update client call in a dedicated cleanup chunk.

## From builder — 2026-06-14 (C4)

- [ ] [origin:builder-C4:2026-06-14] [status:open] `AUDIT_GIT_REMOTE_URL` env var added to `ResolvedEnv` as the git push remote for config writes. Currently the write service passes this to `commitConfigChange` which passes it to `git push <remoteUrl>`. In production, `ensureClone` (C3) sets up the remote as `origin` in `.git/config`; the `AUDIT_GIT_REMOTE_URL` var could be omitted by defaulting to `'origin'` and having `commitConfigChange` use the symbolic remote name. Currently both approaches work since `git push origin` and `git push <URL>` are equivalent when the URL matches. No action needed unless a conflict surfaces.

- [ ] [origin:builder-C4:2026-06-14] [status:open] `_addHostField` destructuring with `eslint-disable-next-line @typescript-eslint/no-unused-vars` in `handleConfigWrite` (server.ts) is needed to strip `addHost` from the request body before passing to `addStagingTarget`. If TypeScript's `noUnusedLocals` check fires at G2 build, the fix is to use `Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'addHost'))` instead. Surgical fix deferred per chunk scope.

## From builder — 2026-06-13

- [ ] [origin:builder-P2-3:2026-06-13] [status:open] `osv-scanner` exits 1 when vulnerabilities are found (same as gitleaks) — `defaultExecOsv` in `src/static/scanners/osv.ts` uses `execFileAsync` directly and will throw when the binary exits 1 (findings present), which the orchestrator will record as a family `failed` rather than a successful scan with findings.
  - Why: the real osv-scanner binary exits 1 to indicate vulnerabilities found, 0 for clean, 2+ for errors — identical behaviour to gitleaks. The current `defaultExecOsv` does not catch exit 1 as a normal outcome.
  - Approach: apply the same try/catch pattern used in `defaultExecGitleaks` — catch the error, check `code === 1`, return `{ stdout, exitCode: 1 }` as a non-error outcome; rethrow on code 2+. Needs to land before P6 real-binary runs.
  - Risk: medium — until fixed, real osv-scanner runs will always report as `failed` even when the scan completes successfully with findings.

## Spec Review deferred items

### audit-tool-v1 (2026-06-13)

- [x] [origin:chatgpt-spec-review-OAI-SPEC-003:2026-06-13] [status:resolved-2026-06-13] [user] RESOLVED (coordinator applied target-level default): §6.5 TrendHistory now carries a per-target `"status": "complete" | "unknown"` field, matching its own prose and the approved Trends mockup. Operator can reverse to family-level if per-scanner granularity is wanted. ORIGINAL: TrendHistory `unknown` partial-run status field — where does `unknown` live? — operator product call needed
  - Why: §6.5 `TrendHistory` (`history/trend.jsonl`) promises a visible `unknown` partial-run status on the Trends UI screen (§5.2) and a guardrail test, but the record shape only defines counts (`new`/`fixed`/`persisting`/`bySeverity`) with no field to store `unknown`. Implementers can't tell whether `unknown` is target-level, scanner-family-level, or both.
  - Approach: operator decides the shape, then the coordinator pins it in §6.5 + the Trends screen contract. Recommended conservative default: a target-level `"status": "unknown"` on the per-run target record, OR a closed `scannerFamilyStatus` map if per-family granularity should surface on the Trends screen. Left UNAPPLIED pending the operator call because it shapes visible Trends-screen rendering of partial runs.
  - Risk: medium — a partial scanner failure could otherwise render as clean remediation on the Trends screen if the field is omitted or placed wrong.

- [x] [origin:chatgpt-spec-review-OAI-SPEC-004:2026-06-13] [status:resolved-2026-06-13 operator-approved, applied to spec §5.2/§10/§11/§12] [user] UI fix-write endpoint (P8 "Send for fixing") has no HTTP/anti-CSRF contract — operator decision on the protection model
  - Why: §5.2/§5.3/§11 name a token-backed mutating localhost endpoint that spends the GitHub `issues:write` token, but never define its route, body, status codes, `Origin`/CORS posture, or CSRF protection. Binding to 127.0.0.1 does not stop a malicious site in the operator's browser from driving a cross-origin POST that spends the fix token. Left UNAPPLIED because it prescribes a new visible request/response contract the SPA must honour (the reviewer flagged operator_decision_required).
  - Approach (recommended conservative pin): require a per-process `X-Audit-CSRF` nonce minted at `audit ui` start + a same-origin `Origin: http://127.0.0.1:<port>` check on the mutating route; reject foreign/missing origin or missing/invalid nonce with 403 (and do NOT call `src/fix/github.ts`); never emit `Access-Control-Allow-Origin: *`. Acceptance: `src/ui/server.test.ts` cases per the reviewer's `acceptance_check`.
  - Risk: high — without it, any page the operator visits while `audit ui` is running could file GitHub issues on Breakout repos using the operator's fix token. NOT a §4 change (no live-engine path); a P8 implementation-contract decision.

- [x] [origin:chatgpt-spec-review-OAI-SPEC-005:2026-06-13] [status:resolved-2026-06-13 operator-approved, applied to spec §5.4/§10/§11/§12] [user] No secret/credential redaction boundary for reports, exports, fix packs, and GitHub issues — operator must set the evidence-retention policy
  - Why: findings, raw scanner output, source snippets, live response bodies/headers, SARIF/MD/HTML, fix packs, and CI artifacts are all first-class outputs, and gitleaks (§7.2) detects literal secrets. The spec requires only HTML-escaping (anti-XSS, §5.2) — it does not redact, so literal secrets, `Set-Cookie`/bearer tokens, and staging credentials get persisted and republished (including into externally-filed GitHub issues). Left UNAPPLIED because it introduces a new product capability that changes what evidence the operator sees and what is shared externally (an evidence-retention policy — reviewer flagged operator_decision_required).
  - Approach (recommended conservative default): redact gitleaks secret values, `Set-Cookie`/bearer-token values, and env-derived credentials to a stable hash/placeholder in every emitted artifact (`report.json`, Markdown, SARIF, HTML, stdout logs, remediation packs), retaining enough context for triage. Acceptance: a redaction fixture + `src/report/redaction.test.ts` (or benchmark harness) per the reviewer's `acceptance_check`.
  - Risk: high — a security tool currently re-exports the very secrets it finds into shareable artifacts and external issues.


## From builder — 2026-06-14

- [x] [origin:builder-chunk1:2026-06-14] [status:resolved 2026-06-14] Pre-existing: `/api/trend` route mismatch — duplicate of the C6 entry above; fixed by aligning `fetchTrend()` to `/api/trend`.
  - Why: Plan gap 5 explicitly flagged this as pre-existing. Noticed during Chunk 1 work but NOT fixed per surgical-changes rule.
  - Approach: confirm which path is correct (server or client) and fix the mismatch; add a route test.
  - Risk: medium — Trends view shows empty array in production.

- [ ] [origin:builder-chunk1:2026-06-14] [status:open] Pre-existing: esbuild native binary missing at `node_modules/esbuild/node_modules/@esbuild/` — vitest fails to load config in local dev environment.
  - Why: `npm ci` likely did not populate the nested `node_modules/esbuild/node_modules/@esbuild/win32-x64` directory. All vitest runs fail locally; CI (fresh `npm ci`) presumably works.
  - Approach: run `npm ci` in this workspace to fix; or investigate npm hoisting; log for next developer.
  - Risk: low (CI unaffected) / high (blocks local test execution for all developers).

## PR Review deferred items

### audit-tool-v1 — claude/lucid-albattani-kczh64 (2026-06-13) — chatgpt-pr-review (5th/external ship-gate pass)

15 findings surfaced for operator decision (1 of 16 auto-applied: generate.ts main-module guard). None breach the §4 allowlist contract. All verified against live code. Grouped by theme.

#### Live-scanner correctness / credential exposure (b1)
- [ ] [origin:chatgpt-pr-review-OAI-PR-b1-001:2026-06-13] [status:open] [user] ZAP active scans never wire session/auth into the automation YAML — unauthenticated active scan reported as success.
  - Why: `buildZapArgs` records only `s.carrier`; `defaultExecZap`/`buildZapAutomationYaml` (src/live/scanners/zap.ts) ignore all session args and emit no users/authentication/sessionManagement config. An active scan can pass while running unauthenticated, silently misstating IDOR/authenticated coverage.
  - Approach: wire ZAP automation-framework `users` + `sessionManagement` + `authentication` from the established Sessions; assert in zap.test.ts that the generated YAML carries auth material and that activeScan:true without usable sessions still throws. (Spec §16 lists ZAP auth-context as an open question — operator confirms scope.)
  - Risk: high — false sense of authenticated DAST coverage.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b1-002:2026-06-13] [status:open] [user] Nuclei bearer/cookie passed via `-H` on argv (src/live/scanners/nuclei.ts:258-261) — visible in process listings.
  - Why: authenticated Nuclei runs place the bearer token / cookie in argv, observable to other local processes; distinct from the already-fixed git-token-in-argv item.
  - Approach: hand credentials via a temp `-header-file` / config file (or stdin/env), and unlink it after `defaultExecNuclei`; assert exec args contain no sentinel token.
  - Risk: medium — local credential exposure on the runner.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b1-003:2026-06-13] [status:open] ZAP report parse failure silently becomes zero findings (src/live/scanners/zap.ts:369-371, 385-388: `catch { return { alerts: [] } }`).
  - Why: a truncated/empty/schema-incompatible ZAP report is indistinguishable from a clean scan — a silent false-negative.
  - Approach: on parse failure, reject so the orchestrator marks the family failed; add a zap.test.ts invalid-JSON case asserting rejection.
  - Risk: medium — tool failure masquerades as clean.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b1-004:2026-06-13] [status:open] ZAP temp report/YAML filenames use only `Date.now()` (src/live/scanners/zap.ts:335,341) — collision across concurrent host scans.
  - Why: `withHostBudget` runs distinct hosts concurrently; two ZAP runs in the same ms share temp paths and can overwrite/unlink each other's report/config.
  - Approach: use `fs.mkdtemp`/`crypto.randomUUID`; stub Date.now() in a test to prove unique paths.
  - Risk: medium — cross-target contamination / spurious failures (low probability).

#### CLI / orchestrator (b2)
- [ ] [origin:chatgpt-pr-review-OAI-PR-b2-001:2026-06-13] [status:open] [user] `audit run --url <off-allowlist>` exits success with no hard error (src/cli.ts:775-789).
  - Why: `run --url` filters the registry by hostname and scans `st.url`; an off-allowlist hostname yields an empty target set and a silent success, where the §4 contract promises a hard error and `scan-live --url` correctly hard-errors via preflight(). NOTE: this does NOT breach §4 — no off-allowlist request is ever sent (every scanned URL goes through preflight()). It is a behavior/UX inconsistency operators can be surprised by.
  - Approach: when `--url` is supplied, preflight it (or assert it resolves to an enabled registry entry) and hard-error on miss, matching scan-live. Operator confirms desired semantics.
  - Risk: high (contract-promise gap, not a safety breach).
- [ ] [origin:chatgpt-pr-review-OAI-PR-b2-002:2026-06-13] [status:open] `--scanner-timeout` parsed and threaded into `scanLiveTarget` but never enforced for live scanners (src/cli.ts:605 param unused in 614-680).
  - Why: static path enforces via `raceWithTimeout`; live ZAP/Nuclei/probe runs are awaited unbounded, so a hung live scanner hangs the CLI despite the documented hard timeout.
  - Approach: wrap each live runner in a timeout race honoring `scannerTimeoutMs`; mark the family failed on timeout.
  - Risk: medium — unbounded hang.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b2-003:2026-06-13] [status:open] Static `raceWithTimeout` resolves on timeout but never aborts/kills the scanner subprocess; `cleanup()` deletes the clone while it may still be running (src/static/orchestrator.ts:121-145,201,309).
  - Why: leaked subprocess + working-dir deletion under a still-running scanner violates the documented hard-timeout guarantee.
  - Approach: thread an AbortController/child-process handle into the scanner fn and kill it on timeout before cleanup.
  - Risk: medium — resource leak across targets/runs.

#### Static detection accuracy (b3)
- [ ] [origin:chatgpt-pr-review-OAI-PR-b3-001:2026-06-13] [status:open] BS-SQL-002 header promises update/delete/insert coverage but body only matches `.from()` (src/static/rules/BS-SQL-002.ts:161).
  - Why: `db.update(tenantTable)` / `db.delete(tenantTable)` / `db.insert().into(tenantTable)` are never flagged — a false-negative in a tenant-isolation backstop.
  - Approach: extend matching to update/delete/insert AST shapes (table is the direct call argument, not via `.from()`); add fixtures for each shape. Security-rule change — operator confirms intended Drizzle mutation shapes.
  - Risk: medium — unscoped tenant mutations pass as clean.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b3-002:2026-06-13] [status:open] BS-RLS-001 regex `\w+` misses quoted / schema-qualified table names (e.g. `"subscriptions"`, `public.subscriptions`).
  - Why: correctly-protected tables in quoted/schema-qualified migrations are read as missing RLS (false positive) or inconsistently recognized.
  - Approach: broaden the CREATE POLICY / ALTER TABLE captures to handle quoting and schema qualification; add migration fixtures.
  - Risk: medium — FP/FN in an RLS backstop.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b3-003:2026-06-13] [status:open] gitleaks report temp path uses only `Date.now()` (src/static/scanners/gitleaks.ts:129) — concurrent-scan collision.
  - Why: two gitleaks scans in the same ms share the report path; one can read/unlink the other's report.
  - Approach: mkdtemp/randomUUID (same hardening as ZAP/OAI-PR-b1-004).
  - Risk: medium — cross-target contamination / missed leaks (low probability).
- [ ] [origin:chatgpt-pr-review-OAI-PR-b3-004:2026-06-13] [status:open] OSV CVSS vector strings parsed by `parseFloat` → NaN → downgraded to medium (src/static/scanners/osv.ts:67-76).
  - Why: OSV severity entries often carry `CVSS:3.1/AV:N/...` vector strings, not a leading number; high/critical dependency CVEs are under-prioritized whenever `group.max_severity` is absent.
  - Approach: parse the CVSS base score from the vector (or read a numeric base-score field) before falling back to medium; add fixtures with vector-form severities. Operator confirms scoring semantics.
  - Risk: medium — critical CVEs reported as medium.

#### Report / lock (b4)
- [ ] [origin:chatgpt-pr-review-OAI-PR-b4-001:2026-06-13] [status:open] [user] Live baseline matcher uses raw URL pathname instead of normalizedUrlPath (src/report/baseline.ts) — acknowledged live findings re-alert.
  - Why: the matcher's doc says it compares `normalizedUrlPath`, but it returns the raw pathname, so a baseline for `/api/users/{id}` won't suppress `/api/users/42` even though the fingerprint layer normalizes id segments. Acknowledged risks re-alert each run.
  - Approach: normalize the live finding's URL path (reuse the fingerprint/correlate normalizer) before baseline comparison; add a baseline test with a volatile-id path.
  - Risk: medium — operator-visible: re-alerting of suppressed findings erodes trust in the baseline.
- [ ] [origin:chatgpt-pr-review-OAI-PR-b4-002:2026-06-13] [status:open] Lock create-empty-then-write window leaves a permanent un-breakable lock (src/report/lock.ts).
  - Why: `acquireLock` creates an empty file (`openSync 'wx'` + close) then writes JSON; if killed in that window, later runs read the empty file as a null record, and `canBreakLock` is only consulted for non-null records — so the lock is never stale-breakable and every future run fails with `WorkspaceLockedError(pid=0)`. Distinct from the already-fixed release-on-exit lock-leak.
  - Approach: write the record atomically (write temp + rename), or treat an empty/parse-failed lock file as breakable.
  - Risk: medium — a crash mid-acquire wedges all future runs until manual cleanup.

#### CI / benchmark (b6)
- [ ] [origin:chatgpt-pr-review-OAI-PR-b6-001:2026-06-13] [status:open] [user] CI + weekly-audit run steps inside the audit-tool container (ci.yml:13-14, weekly-audit.yml) — container image runs as non-root `USER audit` with `/bin/false` and ENTRYPOINT `node dist/cli.js`.
  - Why: the reviewer's stated mechanism (GitHub Actions prepends the ENTRYPOINT to `npm ci` etc.) is INCORRECT — GHA overrides a job container's ENTRYPOINT and runs steps via bash. The REAL risk: a job-container image with `USER audit` + `/bin/false` shell (Dockerfile:102-103) typically breaks `actions/checkout` and step execution (GHA needs a shell and generally root in the job container).
  - Approach: either run CI on the plain `ubuntu-latest` runner (no `container:`) and use the image only for scanner binaries via a step, or add `container.options: --user 0` / ensure a shell, or override the entrypoint. Operator decides the CI execution model. VERIFY by running CI once.
  - Risk: high — CI/weekly-audit may not execute as intended (must be confirmed against an actual run before relying on green CI).
- [ ] [origin:chatgpt-pr-review-OAI-PR-b6-002:2026-06-13] [status:open] `npm run benchmark` gate can pass vacuously (benchmark/run.ts main()).
  - Why: `main()` calls `runBenchmark()` with empty `scanResults`/`cleanResults`/`liveFixtureResults`; the harness only reads EXPECTED.json and computes metrics from caller-supplied arrays — it never runs the audit engine over the corpus. A fixture with empty/unreadable/malformed EXPECTED.json contributes recall=1 with zero actual findings, so the CLAUDE.md recall/precision base gate can pass without exercising detection.
  - Approach: wire the static/live engine over `benchmark/corpus` + `benchmark/live-fixture` inside `main()` and feed real ScanResults; assert corpus non-empty.
  - Risk: medium — a base gate that does not actually gate detection quality.

## Deferred from spec-conformance review — flyio-dashboard (2026-06-14)

**Captured:** 2026-06-14T00:00:00Z
**Source log:** (returned inline by spec-conformance; no log file written per harness convention)
**Spec:** `docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md`

- [x] [origin:spec-conformance:2026-06-14] [status:resolved 2026-06-14] RunAScan repo dropdown reads `config.repoTargets` but `/api/config/targets` serves the raw `targets.json` whose top-level key is `repos` — repo dropdown is always empty
  - **RESOLVED in the branch-level review pass:** `/api/config/targets` now projects the registry to the UI's `{ repoTargets, stagingTargets }` shape server-side (also drops auth/rateLimit detail). RunAScan + the pre-existing Sites/Safety screen both work; test updated. See `tasks/builds/flyio-dashboard/review-pass-log.md`.
- [ ] [origin:adversarial-reviewer-3-B:2026-06-14] [status:deferred] `history/scan-jobs.jsonl` grows unbounded; `foldJobs` reads the whole file on every `GET /api/scan-jobs`.
  - Why: no compaction/rotation/size cap. Structurally unbounded on a long-lived deployment, though benign for an internal tool at expected scan volumes.
  - Approach: rotate/compact the event log (e.g. drop events for jobs older than N days, or cap line count) — aligns with the spec §11 deferred "report retention / volume pruning" decision; tackle together.
  - Risk: low — internal tool, low scan volume; deferred per spec §11.
  - Spec section: §8 (UI changes — "two dropdowns (repo, staging target) sourced from existing `/api/config/*` endpoints") and §4.1 selection-UI note.
  - Gap: `ui/src/screens/RunAScan.tsx:67` reads `config.repoTargets`; `src/ui/server.ts:278-286` serves `config/targets.json` verbatim, whose top-level keys are `repos` + `stagingTargets` (confirmed against the on-disk file). `stagingTargets` matches; `repoTargets` does not exist on the served object, so `repos` resolves to `[]` and the repo `<select>` shows only the placeholder. The "Run scan" button can never be enabled (canSubmit requires a selected repo). The staging-target half works.
  - Suggested approach: pick one contract and align both ends — either map the served object to `{ repoTargets, stagingTargets }` server-side in the `/api/config/targets` handler, or change the UI to read `config.repos` and adjust the `TargetsConfig` type. This is a UI↔server contract divergence requiring a design choice (which side owns the field name), so it is routed rather than auto-fixed. Not a safety-contract issue — the server-side §7 registry gate on `/api/scan` is independent of this dropdown and remains intact.
  - Risk: medium — the primary on-demand-scan entry point (§1 goal "trigger scans on demand from the UI") is non-functional for the repo selector until aligned. The server-side safety gate is unaffected.

## Deferred from spec-conformance review — ui-live-config (2026-06-14)

**Captured:** 2026-06-14T00:00:00Z
**Source log:** `tasks/review-logs/spec-conformance-log-ui-live-config-2026-06-14T00-00-00Z.md`
**Spec:** `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md`

- [ ] [origin:spec-conformance:2026-06-14] [status:deferred] `configSha` is not threaded from a config write into `handleScanPost` — the §7/ImplInv-6 write-then-scan path is only half-wired
  - Spec section: §7 "Post-push SHA (MEDIUM-3 — close the propagation race)" / ImplInv-6 / §12 failure-mode row "Scan dispatched immediately after an edit".
  - Gap: the mechanism is fully built but never fed end-to-end. `dispatchScan` (src/ui/dispatch.ts) accepts `configSha` and emits `inputs.config_sha`; `on-demand-scan.yml` declares the `config_sha` input, verifies reachability from `CONFIG_BRANCH`, and checks the SHA out; `handleScanPost` correctly dispatches with `ref: resolvedEnv.configBranch ?? 'main'` (H2 fixed). BUT `handleScanPost` (src/ui/server.ts:~590-604) never passes `configSha` to `dispatchScan`, and nothing stores the last pushed SHA from a config write for a subsequent scan to read (`rg configSha src/ui/server.ts` → no match). So in production a post-edit scan dispatches with no `config_sha`, the workflow checks out the branch tip, and the branch-propagation race MEDIUM-3/ImplInv-6 set out to close is re-introduced. The C6 builder documented this as deferred (tasks/builds/ui-live-config/chunk-learnings.md lines 31, 41); it was never tracked as a backlog item. The §13 "write returns the pushed SHA and a scan dispatched right after sends ref=CONFIG_BRANCH + config_sha input" assertion is covered only at the `dispatchScan` unit level — there is no end-to-end test that a real post-write scan sends a real pushed SHA.
  - Suggested approach: decide where the immediately-following scan obtains the SHA. Options: (a) a small in-process "last pushed config SHA" cache that config-write routes set on a successful push and `handleScanPost` reads when present (simplest; matches the C6 builder's note); (b) read `HEAD` of the working clone at dispatch time so the scan always pins the current committed config; (c) accept an optional `configSha` in the `/api/scan` body and have the UI pass the SHA returned by the preceding write. Each is a design choice (lifetime/scoping of the SHA, what happens for a scan unrelated to a recent edit), so this is routed, not auto-fixed. Add an end-to-end test asserting a write→scan sequence sends `ref=CONFIG_BRANCH` + `inputs.config_sha === <pushed SHA>` once a mechanism is chosen.
  - Risk: medium — not a safety-contract regression (the scan-time allowlist gate in src/live/ is untouched and remains the sole authority; CI re-validates the committed config via preflight). The exposure is a correctness/consistency race: a scan fired in the seconds after an edit can read a slightly stale branch tip rather than the exact just-pushed config. The half-wired infrastructure means closing it later is a small, localized change.
