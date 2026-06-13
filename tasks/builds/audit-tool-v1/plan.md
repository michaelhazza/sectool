# Implementation Plan — audit-tool-v1 (Major, greenfield)

**Spec (LOCKED):** `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md`
**Handoff:** `tasks/builds/audit-tool-v1/handoff.md`
**Prototypes (locked screen shapes):** `prototypes/audit-tool-v1/` (index, run-report, finding-detail, fixes, trends, targets; `mobile-preview.html` is a design utility, NOT a build target)
**Conventions:** `CLAUDE.md` (Node 20/TS/ESM/npm; Zod; Vitest; eslint; §4 safety contract NON-NEGOTIABLE)

This plan **sequences** the spec; it does not design. Every architecture decision is the spec's. Chunks map 1:1 onto the §11 file inventory and the §12 P1–P8 phasing. Where the spec is authoritative on a contract, this plan points at the section rather than restating it.

## Contents

- Model-collapse check
- Primitives-reuse search
- Architecture notes
- Conventions for every chunk
- Phase P1 — Schemas, config, fingerprint, CLI skeleton, minimal benchmark harness
- Phase P2 — Static orchestration + wrapped scanners + normalizers + redaction chokepoint
- Phase P3 — Custom rule pack (11 rules, test-first)
- Phase P4 — Live engine: gate → preflight → probes/ZAP/Nuclei + live fixture + safety test
- Phase P5 — Correlation + severity + report (JSON/MD/SARIF) + baseline + trend
- Phase P6 — Benchmark completion + engine guardrails + Dockerfile + CI + self-scan + rule docs
- Phase P7 — Report dashboard UI + HTML export
- Phase P8 — Remediation orchestration + wire Fixes screen + CSRF/origin-gated fix endpoint
- End-of-construction (G2)
- Adversarial-reviewer MANDATORY chunks
- Dependency summary (forward-only)
- Plan-gaps and ambiguities

---

## Model-collapse check

1. *Does this decompose into ingest → extract → transform → render?* Superficially yes (scan → normalize → correlate → report), but the steps are not model-shaped.
2. *Could a frontier multimodal call do each step?* No. The core value is **deterministic detection** measured against a 100% recall / 0 false-positive benchmark gate (§10), produced by **version-pinned scanner subprocesses** (Semgrep, gitleaks, osv-scanner, ZAP, Nuclei) and a **ts-morph AST rule pack** doing cross-file taint/schema-join analysis. None of that is replaceable by a single structured-output model call.
3. *Collapse the pipeline into one model call?* **Rejected.** Determinism, auditability, and the structurally-enforced staging-only safety contract (§4 — a compile-time branded type that makes off-allowlist scanning unrepresentable) are the entire point. An LLM call cannot be the §4.7 abort-test subject, cannot be version-pinned for reproducible recall accounting, and cannot give the SARIF/fingerprint stability the spec requires. The work here is orchestration + deterministic analysis + a hard safety boundary, not perception. Multi-component is correct; the components are subprocess wrappers and pure functions, not pipeline-for-pipeline's-sake.

---

## Primitives-reuse search

Greenfield repo (`src/` holds only the `index.ts`/`index.test.ts` scaffold; no prior services, schemas, or routes). There are no existing primitives to extend. The spec already performed the reuse analysis and pinned its decisions — notably:
- Fix tracking reuses `Finding.externalRefs` (derived-on-build) + a single authoritative `reports/fixes.json`, rather than a new persisted field or store (§5.3, §2 amendment).
- The redaction chokepoint is **one** pure-function module (`src/report/redaction.ts`) reused by every emitter, not per-emitter logic (§5.4).
- The allowlist gate is **one** chokepoint (`src/live/gate.ts`) with a single branded type, not per-scanner checks (§4.1).

No new primitive is invented by this plan beyond the §11-locked set. Nothing to relitigate.

---

## Architecture notes (sequencing-level only — the spec made the decisions)

- **Execution model:** inline/synchronous CLI process; all state is files; atomic tmp+rename writes under a `reports/.lock` advisory lock (§5, §14). No queue, no DB. `audit ui` is the one long-running process and is read-only on scan state (§5.2).
- **Safety boundary is a type, not a check:** `AllowedTarget` is a branded type constructible ONLY by `assertAllowlisted`; scanner wrappers accept only that type, so TypeScript makes an off-allowlist scan a compile error (§4.1). The plan treats every chunk that touches `src/live/gate.ts`, `src/live/preflight.ts`, `src/config/load.ts`, or any live scanner as **adversarial-reviewer MANDATORY** (handoff requirement).
- **Two-stage Finding:** one Zod type, raw-scan stage vs report stage; `severity`/`correlatedWith`/`externalRefs`/`suppressed`/`suppression`/`note` are derived on report build, never persisted by a scanner (§6.1). The plan keeps producers (normalizers, P2/P4) and the deriver (`src/report/json.ts`, P5) in separate chunks so the boundary stays clean.
- **Fingerprint discipline:** full 64-hex is the only join/idempotency/suppression key; `f-<16hex>` is display-only (§6.1, §6.4, §6.6). Every chunk that keys on a finding (baseline match, fixes.json, SARIF, `audit fix`) must use the full fingerprint — flagged per-chunk.
- **Redaction is a P2 deliverable, not P5:** authored at the normalizer boundary so even the per-repo raw findings file is redaction-passed; every later emitter re-applies it (§5.4, §12 P2). The plan lands `redaction.ts` + its test in P2 and asserts each new surface as it lands.
- **Test-first:** the minimal benchmark harness lands in P1 (Chunk P1-5) so all P3 rules and later checks are authored fixture-first against a working recall/precision accounting harness (§10, §12).
- **No pattern applied for its own sake.** Wrappers are adapters (external scanner JSON → internal `Finding`); the gate is a single-chokepoint + branded-type pair; everything else is small pure functions. No inheritance hierarchies, no premature abstraction.

---

## Conventions for every chunk

- **G1 (per-chunk, local):** scoped lint only — `npx eslint <files this chunk touched>` — plus **targeted execution of unit tests this chunk authored** for pure functions with no DB/network/filesystem side effects (single Vitest file, e.g. `npx vitest run src/correlate/fingerprint.test.ts`). Authoring tests is required where the chunk says so; running the broader suite is not. **Note:** `eslint.config.js` uses `recommendedTypeChecked` + `projectService`, so scoped lint is **type-aware** — a chunk's imports must resolve at its own commit point, and the P1-4 CLI stubs must be typed no-op stubs (not imports of not-yet-built modules) so G1 lint passes [claude-plan-review PR-003].
- **G2 (once, end of construction, coordinator-owned — NOT per chunk):** `npm run lint`, `npm run typecheck`, `npm run build` against integrated branch state.
- Tests colocate as `*.test.ts` beside each module (§11).
- **Adversarial-reviewer MANDATORY** chunks are flagged with **[ADV]**. These touch the §4 safety contract or a §10 security guardrail and must go to the adversarial-reviewer at review time (handoff requirement).
- Schemas are Zod; each schema chunk also wires its JSON-Schema generation into `src/schemas/generate.ts` (§6, §11).

> **Executor note (verbatim, required):** Test gates and whole-repo verification scripts (`npm run test:gates`, `npm run test:qa`, `npm run test:unit`, `npm test`, `scripts/verify-*.sh`, `scripts/gates/*.sh`, `scripts/run-all-*.sh`) are CI-only. They do NOT run during local execution of this plan, in any chunk, in any form. Targeted execution of unit tests authored within this plan is allowed; running the broader suite is not.

> The `.github/workflows/ci.yml` benchmark + self-scan + base-gate run (P6, Chunk P6-5) is the **CI gate definition**, authored as a deliverable — it is not a local run step. The P6 core-quality exit loop and the final v1 ship gate (§12) are coordinator/CI-owned, not chunk steps.

---

# Phase P1 — Schemas, config, fingerprint, CLI skeleton, minimal benchmark harness

*Depends on: nothing. Foundation for everything.*

### P1-1 — Zod schema set (the 7 contracts) + JSON-Schema generation
- **Phase:** P1
- **Files:** `src/schemas/finding.ts`, `src/schemas/targets.ts`, `src/schemas/allowlist.ts`, `src/schemas/baseline.ts`, `src/schemas/trend.ts`, `src/schemas/report.ts`, `src/schemas/fix.ts`, `src/schemas/generate.ts`; tests `src/schemas/*.test.ts`; **also edits** `package.json` (+ the lockfile) to add the `benchmark`/`schemas` scripts, the `bin` entry, and the pinned `tsx` devDependency (per the depends-on note + plan-gap 1) [chatgpt-plan-review OAI-PLAN-004]
- **Implements:** §6.1 `Finding` (two-stage, discriminated union on `target.kind`; full `fingerprint` field present), §6.2 `TargetRegistry` (`auth.kind` closed set `{form}`; `rateLimitRps` clamped 1–25; `testUsers` exactly-2 when `activeScan:true`, ≥1 when `auth` present; carrier-aware `successCheck` shape), §6.3 `Allowlist` (DNS-name-only `host`, no wildcard/CIDR/port), §6.4 `Baseline` (full-fingerprint required; `findingId` optional echo; `findingId===f-+fingerprint.slice(0,16)` cross-check), §6.5 `TrendHistory`, §6.7 `vulnClass` closed enum, §6.8 `scannerFamily` closed enum, §6.9 `RunReport`, §5.3/§6 `fix.ts` (closed 6-state status enum)
- **Module shape.** *Public:* the seven exported Zod schemas + inferred TS types; `generateSchemas()` writing `schemas/*.schema.json`. *Hidden:* refinement helpers (clamp, carrier-aware-success refinement, findingId↔fingerprint cross-check refinement, IP-literal-rejection refinement on allowlist host).
- **Error handling:** schema parse failures surface as Zod errors; the closed-enum and refinement violations carry clear messages. (Config-load wiring is P1-2.)
- **Test-first/G1 acceptance:** colocated unit tests for each schema asserting: `rateLimitRps` clamp; `testUsers` arity by `activeScan`; carrier-aware `successCheck` (bearer requires `jsonHasKey`, cookie requires Set-Cookie semantics expressed in schema shape); allowlist rejects wildcard/CIDR/port/IP-literal `host` entries; baseline rejects truncated-`findingId`-only entries and mismatched `findingId`/`fingerprint`; `fix.ts` status enum is exactly the 6 tokens. `npx eslint` on touched files + `npx vitest run` on the schema test files.
- **Depends on:** none. (Scaffolding: `tsconfig.json`/`tsconfig.build.json`/`eslint.config.js` already exist in the repo — EXTEND, never recreate (preserve the strict posture: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). This chunk adds the `benchmark`/`schemas` npm scripts + a `bin` entry and pins the TS runner (`tsx`) per plan-gap 1; the `vitest.config.ts` benchmark-include extension lands in P1-5 [claude-plan-review PR-002].)

### P1-2 — Config loader + cross-checks (allowlist provenance + branded LoadedAllowlist) **[ADV]**
- **Phase:** P1
- **Files:** `src/config/load.ts`; test `src/config/load.test.ts`; shipped config `config/targets.json`, `config/allowed-staging-hosts.json` (empty `hosts:[]`), `config/baseline.json` (empty `entries:[]`)
- **Implements:** §4.9 (`load.ts` is the ONLY non-benchmark allowlist source; fixed path constant, no flag/env/field substitution), §4.10 (branded `LoadedAllowlist`; `loadAllowlist()` production fixed-path + `loadBenchmarkAllowlist()` fixed benchmark path restricted to `127.0.0.1`/`localhost`/`*.localhost`), §6.2 enabled-target allowlist cross-check (config error, not scan-time skip), §6.2 disabled-targets-may-be-off-allowlist
- **Module shape.** *Public:* `loadAllowlist(): LoadedAllowlist`, `loadBenchmarkAllowlist(): LoadedAllowlist`, `loadTargets()`, `loadBaseline()`. *Hidden:* the `LoadedAllowlist` brand constructor (un-exported — mintable only inside this module), the fixed path constants, the enabled-target cross-check, the loopback-only schema restriction on the benchmark loader.
- **Error handling:** malformed config / missing required baseline field / enabled-target-host-not-allowlisted → named config error before any scan; surfaces as a `failed` run-global fault (§14).
- **Test-first/G1 acceptance:** tests assert: enabled staging target whose host is NOT allowlisted fails load; disabled off-allowlist target loads fine; benchmark loader refuses a non-loopback host; production loader path is constant (no override param). Ships the empty shipped config (1 repo enabled, 0 staging enabled, empty allowlist, empty baseline) per §6.2/§11. `npx eslint` + targeted vitest.
- **Depends on:** P1-1.
- **[ADV]** — allowlist provenance + branded-type chokepoint are safety-contract surface.

### P1-3 — Fingerprint module (canonical identity)
- **Phase:** P1
- **Files:** `src/correlate/fingerprint.ts`; test `src/correlate/fingerprint.test.ts`
- **Implements:** §6.6 — static `sha256(ruleId|targetName|normalizedPath|symbol|normalizedSnippet)`, live `sha256(checkId|host|normalizedUrlPath|parameter|evidenceClass)`; `id = "f-"+first16hex`; normalizers for path (posix, repo-relative), symbol (route sig / enclosing symbol / pgTable name for schema rules), snippet (whitespace-collapsed), URL path (numeric/uuid → `{id}`); line numbers/ordering EXCLUDED
- **Module shape.** *Public:* `fingerprint(input): string` (full 64-hex), `displayId(fp): string`, the path/symbol/snippet/url normalizers. *Hidden:* the sha256 wiring and the per-segment normalization rules.
- **Error handling:** pure function; invalid input is a type error at the boundary, not a runtime branch.
- **Test-first/G1 acceptance:** vectors asserting stability across line drift / reformatting / numeric-segment variation; `id === "f-"+fp.slice(0,16)`; BS-RLS-001 schema-rule symbol = normalized pgTable name. Pure functions → run the test file locally. `npx eslint` + targeted vitest.
- **Depends on:** P1-1.

### P1-4 — CLI skeleton (`--help`, config validation, arg parsing)
- **Phase:** P1
- **Files:** `src/cli.ts`; test `src/cli.test.ts`; wire `package.json` `bin`/scripts as needed (see plan-gaps)
- **Implements:** §5.1 command table surface (`scan-source`, `scan-live`, `run`, `report`, `ui`, `fix`) using `node:util` `parseArgs`; the shared flags `--scanner-timeout` (default 15) and `--max-parallel-targets` (default 2) on `run`/`scan-source`/`scan-live` (§5 — CLI flags, NOT config); `--fail-on <severity>` on `run` (§14); `--dry-run` where defined. In P1 the subcommands parse + validate config + print help; scan bodies are stubs that later phases fill.
- **Module shape.** *Public:* `main(argv)` dispatch; per-subcommand arg shape. *Hidden:* the parseArgs option tables, help text, the stub dispatch into not-yet-built engines.
- **Error handling:** unknown command / bad flag → usage error, non-zero exit; config-invalid → `failed`/exit 1 (§14). Exit codes 0/2/1 reserved per §14 (wired fully in P5).
- **Test-first/G1 acceptance:** `--help` lists 6 commands; arg parsing of the shared flags + defaults; config-validation path returns the named config error. `npx eslint` + targeted vitest on the parser.
- **Depends on:** P1-1, P1-2.

### P1-5 — Minimal benchmark harness (corpus walker, EXPECTED.json compare, recall/precision, non-zero exit)
- **Phase:** P1
- **Files:** `benchmark/run.ts`; `benchmark/allowlist.benchmark.json` (loopback-only, consumed by P4); a minimal `benchmark/corpus/` skeleton + one EXPECTED.json shape doc; test `benchmark/run.test.ts`; **extend `vitest.config.ts`** to add `benchmark/**/*.test.ts` to the `test.include` globs
- **Implements:** §10 harness core — corpus directory walker (`corpus/static/<RULE-ID>/{vulnerable,clean}/`), EXPECTED.json comparison, per-rule + aggregate recall/precision accounting, **rule-inventory ↔ corpus-directory cross-check** (CI fails any rule/check lacking both fixtures), non-zero exit on any miss or any rule without fixtures. This is the test-first substrate for P3+.
- **Module shape.** *Public:* `runBenchmark(): BenchmarkResult` + the `npm run benchmark` entry; the EXPECTED.json contract. *Hidden:* directory walking, the recall/precision arithmetic, the inventory cross-check.
- **Error handling:** missing fixture pair → non-zero exit with the offending rule id; recall < 100% or FP > 0 → non-zero exit listing misses.
- **Test-first/G1 acceptance:** unit tests over the accounting math (seeded synthetic EXPECTED vs actual) asserting recall/precision and the non-zero-exit conditions, using a tiny in-test corpus fixture. **MUST extend `vitest.config.ts` `test.include` (currently `src/**`+`tests/**` only) to collect `benchmark/**/*.test.ts`** — without it the harness test, the §4.7 abort test (P4-7), and the §10 guardrail batch (P6) collect zero tests under `vitest run` [claude-plan-review PR-001, blocking]. `npx eslint` + targeted vitest. (Live-fixture integration + the engine-available guardrail batch land in P6.)
- **Depends on:** P1-1 (Finding shape).

---

# Phase P2 — Static orchestration + wrapped scanners + normalizers + redaction chokepoint

*Depends on: P1.*

### P2-1 — Secret-redaction chokepoint (authored here, consumed by every later emitter) **[ADV]**
- **Phase:** P2
- **Files:** `src/report/redaction.ts`; test `src/report/redaction.test.ts`; a redaction fixture under `benchmark/` (known secret values)
- **Implements:** §5.4 — single pure-function chokepoint replacing credential material (gitleaks-detected secrets, `Authorization`/bearer, `Set-Cookie`/cookie values, registry-env-derived staging creds) with stable salted `[redacted:<8hex>]` placeholders (same secret → same placeholder across artifacts for correlation); retains non-secret triage context (file, line/route, rule id, structural shape). Authored in P2 even though its path is `src/report/`.
- **Module shape.** *Public:* `redact(value|object): redacted` + `redactString`. *Hidden:* the salted-digest derivation, the credential-pattern matchers, the placeholder format.
- **Error handling:** pure; never throws on input — redaction is fail-safe (when unsure, redact).
- **Test-first/G1 acceptance:** the §10 **secret-redaction guardrail** test asserting no known-secret fixture value survives `redact()`, only `[redacted:<8hex>]`, and the same secret reads identically twice. (Per-surface assertions land as each emitter lands: raw findings here in P2-2/P2-3, report formats P5, HTML P7, fix issues P8.) `npx eslint` + targeted vitest.
- **Depends on:** P1-1.
- **[ADV]** — output-safety security guardrail (§10).

### P2-2 — Static orchestrator: repo acquisition + scanner fan-out
- **Phase:** P2
- **Files:** `src/static/orchestrator.ts`; test `src/static/orchestrator.test.ts`
- **Implements:** §6.2 repo acquisition contract — `localPath` working-tree read as-is, else shallow clone (`--depth 1`, single branch, default-branch HEAD) into a fresh temp dir per run using read-only `AUDIT_GITHUB_READ_TOKEN`; record scanned commit SHA into `target.commit`; v1 single-repo/default-branch only (no submodule init, no monorepo sub-package). §5 bounded scanner pool (default 2 targets × N scanners; `--scanner-timeout`/`--max-parallel-targets` honoured); §14 retry classification (clone + scanners `safe`).
- **Module shape.** *Public:* `scanRepos(targets, opts): Finding[]` (raw-stage) per-repo + the per-(target×family) status feeding `meta.scannerStatus`. *Hidden:* temp-dir clone machinery, the bounded pool, per-scanner timeout enforcement, family-completion tracking.
- **Error handling:** per-scanner failure/timeout → that (target×family) marked `failed`/`skipped` (§6.8) → contributes to `partial` (§14); clone failure of a target fails that target, not the run (multi-target).
- **Test-first/G1 acceptance:** unit tests over the pool/timeout/family-status accounting with fake scanner functions (pure orchestration logic; no real git/network in the unit test — clone is exercised in P6 integration). `npx eslint` + targeted vitest.
- **Depends on:** P1-1, P1-2, P1-4.

### P2-3 — Wrapped static scanners + normalizers (semgrep, gitleaks, osv) — redaction-passed
- **Phase:** P2
- **Files:** `src/static/scanners/semgrep.ts`, `src/static/scanners/gitleaks.ts`, `src/static/scanners/osv.ts`; tests `src/static/scanners/*.test.ts`; per-repo findings output path (redaction-passed)
- **Implements:** §7.2 wrappers (semgrep also runs `p/owasp-top-ten` curated subset + our YAML), §6.1 normalization to `Finding` (raw stage: `severity=baseSeverity`, derived fields at empty defaults), §6.8 family mapping (`source` IS family), §5.1 scan-source **redaction-passed** per-repo findings file — native scanner JSON/stdout/stderr captured, redacted via P2-1, then written; **never persisted verbatim** (§5.4).
- **Module shape.** *Public:* `runSemgrep(target): Finding[]`, `runGitleaks(...)`, `runOsv(...)` (adapter contract: shell out → parse native JSON → normalize → redact). *Hidden:* the subprocess invocation, the native-output parsing, the vulnClass mapping table, the redaction call at the normalizer boundary.
- **Error handling:** non-zero scanner exit / parse failure → family `failed` for that target (§6.8, §14); never swallow into `success`.
- **Test-first/G1 acceptance:** normalizer unit tests over **captured fixture scanner JSON** (no live binary in unit tests) asserting correct `Finding` shape, correct family, and that gitleaks-detected secret values are `[redacted]` in the emitted finding (redaction-pass assertion for the raw-findings surface, §10). `npx eslint` + targeted vitest. (Real-binary execution is the P6 benchmark/Docker step.)
- **Depends on:** P1-1, P1-3, P2-1, P2-2.

---

# Phase P3 — Custom rule pack (11 rules, test-first against the P1 harness)

*Depends on: P1, P2 (semgrep runner for the 4 YAML rules). Every rule lands fixture-first: seed `vulnerable/` + `clean/` + EXPECTED.json, then write the rule (§10).*

> Split into rule-cluster chunks (not one-rule-per-chunk and not all-eleven-at-once) so each chunk is a single builder pass that ships rules + their fixtures + their docs together. Clusters are grouped by engine and analysis kind so a builder holds one mental model per chunk.

### P3-1 — ts-morph rule engine harness + AST rules: injection/SQL cluster
- **Phase:** P3
- **Files:** `src/static/rules/` shared AST-walk harness + `BS-SQL-001.ts`, `BS-SQL-002.ts`, `BS-RLS-001.ts`; corpus `benchmark/corpus/static/BS-SQL-001|BS-SQL-002|BS-RLS-001/{vulnerable,clean}/` + EXPECTED.json; `docs/rules/BS-SQL-001.md|BS-SQL-002.md|BS-RLS-001.md`; tests colocated
- **Implements:** §7.1 — BS-SQL-001 (taint walk from `req.*`/route params into `` sql`…` ``/`db.execute`), BS-SQL-002 (queries on tenant tables bypassing scoped helpers), BS-RLS-001 (Drizzle tenant-column table with no RLS policy in migrations — schema↔migration join). §6.6 schema-rule `symbol` = normalized pgTable name. §8.1 reachability set at normalization.
- **Module shape.** *Public:* each rule exports `run(project): Finding[]`; the shared `src/static/rules/` harness exposes the ts-morph `Project` + traversal utilities. *Hidden:* the taint-propagation walk, the schema↔migration join, the scoped-helper detection.
- **Error handling:** a rule that throws on a malformed source → that rule contributes nothing and is logged; benchmark recall catches silent misses.
- **Test-first/G1 acceptance:** fixtures seeded BEFORE the rules; `vulnerable/` yields the EXPECTED finding (recall), `clean/` yields zero (precision). Run these rule test files locally. `npx eslint` + targeted vitest.
- **Depends on:** P1-3, P1-5, P2-2.

### P3-2 — ts-morph AST rules: auth/route/middleware-chain cluster
- **Phase:** P3
- **Files:** `src/static/rules/BS-AUTH-001.ts`, `BS-WS-001.ts`, `BS-VAL-001.ts`, `BS-XSS-001.ts`; corpus dirs + EXPECTED.json for each; `docs/rules/<ID>.md` for each; tests colocated
- **Implements:** §7.1 — BS-AUTH-001 (Express route without auth/permission middleware, per-repo `publicRoutes` allowlist — also the chain BS reachability uses, §8.1), BS-WS-001 (socket.io handler without auth handshake middleware), BS-VAL-001 (handler reading body/query/params with no Zod parse at boundary), BS-XSS-001 (user-supplied HTML rendered/stored without `sanitize-html`). §8.1 reachability operands set here (publicRoutes→`unauthenticated`, behind-auth→`authenticated`, admin guard→`admin`, else `unknown`).
- **Module shape.** *Public:* each rule `run(project, repoConfig): Finding[]`. *Hidden:* the middleware-chain walk, the publicRoutes cross-reference, the reachability classification.
- **Error handling:** as P3-1.
- **Test-first/G1 acceptance:** fixtures first; recall on `vulnerable/`, zero on `clean/`; a BS-AUTH-001 fixture exercising the `publicRoutes` allowlist (a public route does NOT fire). `npx eslint` + targeted vitest.
- **Depends on:** P3-1 (shared rules harness), P1-3, P1-5.

### P3-3 — Custom Semgrep YAML rules cluster
- **Phase:** P3
- **Files:** `rules/semgrep/BS-AUTH-002.yaml`, `BS-JWT-001.yaml`, `BS-UPLOAD-001.yaml`, `BS-CORS-001.yaml`; corpus dirs + EXPECTED.json for each; `docs/rules/<ID>.md` for each; a small test asserting the YAML loads + maps to the right family/vulnClass
- **Implements:** §7.1 semgrep rules — BS-AUTH-002 (auth endpoints without rate-limit middleware), BS-JWT-001 (JWT algorithm not pinned / no expiry / secret literal), BS-UPLOAD-001 (multer route without size limit or type filter), BS-CORS-001 (CORS wildcard / reflected-origin). Run via the P2-3 semgrep wrapper (`source: semgrep` → family `semgrep`).
- **Module shape.** *Public:* the four YAML rule files consumed by the semgrep wrapper. *Hidden:* the pattern internals.
- **Error handling:** a malformed YAML rule fails the semgrep run → family `failed`; benchmark catches it.
- **Test-first/G1 acceptance:** fixtures first; the P1 harness (run against captured semgrep output in unit context, real binary in P6) asserts recall on `vulnerable/` + zero on `clean/`. `npx eslint` on touched TS (the YAML is validated by the semgrep run, not eslint) + targeted vitest.
- **Depends on:** P2-3 (semgrep wrapper), P1-5.

---

# Phase P4 — Live engine: gate → preflight → probes/ZAP/Nuclei + live fixture + safety test

*Depends on: P1. **Build order inside the phase is law: gate first, preflight second, then probes/scanners — no scan code is reachable except through an `AllowedTarget`.** Every chunk here is **[ADV]**.*

### P4-1 — Allowlist gate: `assertAllowlisted` + `AllowedTarget` brand **[ADV]**
- **Phase:** P4
- **Files:** `src/live/gate.ts`; test `src/live/gate.test.ts`
- **Implements:** §4.1 single chokepoint + branded `AllowedTarget` (constructible ONLY here; no other module exports a constructor); §4.2 allow-iff: https-only AND exact enabled-host match AND default-port (empty/443) AND **DNS-name-not-IP-literal** (reject dotted-decimal + numeric/octal/hex IPv4 like `2130706433`/`0x7f000001` + bracketed IPv6 `[::1]`/`[::ffff:127.0.0.1]`); accepts only a branded `LoadedAllowlist` (§4.10); empty allowlist → scans nothing; `AllowlistViolationError` thrown **before any network I/O**; §4.3 no override path.
- **Module shape.** *Public:* `assertAllowlisted(url, allowlist: LoadedAllowlist): AllowedTarget` and the `AllowedTarget` type (no constructor exported). *Hidden:* the IP-literal parser matrix, the protocol/port/host checks, the brand mint.
- **Error handling:** any failing clause → `AllowlistViolationError` (named), thrown before DNS/HTTP. Pure parse/string decision — no network.
- **Test-first/G1 acceptance:** the §10 **allowlist IP-literal rejection** guardrail (`https://127.0.0.1/`, numeric/octal/hex IPv4, `https://[::1]/`, `https://[::ffff:127.0.0.1]/` all rejected by the production gate; loopback permitted ONLY via `loadBenchmarkAllowlist`); http rejected; non-443 port rejected; non-allowlisted host rejected; empty allowlist rejects everything. Pure → run locally. `npx eslint` + targeted vitest.
- **Depends on:** P1-1, P1-2.
- **[ADV]** — the core safety chokepoint. Immutable per §4.7.

### P4-2 — Preflight / dry-run (preflight-before-DNS ordering) **[ADV]**
- **Phase:** P4
- **Files:** `src/live/preflight.ts`; test `src/live/preflight.test.ts`
- **Implements:** §4.6 — `scan-live --dry-run` parses URL + calls `assertAllowlisted()` FIRST (before any DNS resolution or other network op), prints allowlist verdict + the check families that would run, sends zero traffic; denied host prints deny verdict with NO DNS lookup; the non-dry-run path runs the same preflight first and the scan phases / registry-DNS resolution are unreachable unless preflight returned an `AllowedTarget`. §5.1 registry-required resolution: host must also resolve to an `enabled:true` `stagingTargets[]` entry → else named `UnregisteredTargetError` (allowlist pass but no registry entry); allowlist fail is the §4.2 hard abort.
- **Module shape.** *Public:* `preflight(url): { target: AllowedTarget, registryEntry }` (or throws); `dryRun(url)`. *Hidden:* the ordering guarantee (gate before any resolver), the registry lookup, the verdict formatting.
- **Error handling:** allowlist fail → `AllowlistViolationError` (no DNS); gate pass + no enabled registry entry → `UnregisteredTargetError`.
- **Test-first/G1 acceptance:** the §10 **preflight-before-DNS** guardrail — a `--dry-run` against a denied host asserts `assertAllowlisted()` was called and threw before any DNS resolver call (zero resolver calls) and zero HTTP requests (inject a spy resolver). `npx eslint` + targeted vitest.
- **Depends on:** P4-1, P1-2.
- **[ADV]** — preflight ordering is a pinned safety invariant (HIGH-1).

### P4-3 — Per-host rate limiter + live engine serializer (aggregate-per-host) **[ADV]**
- **Phase:** P4
- **Files:** `src/live/ratelimit.ts` (*new file under the `src/live/` umbrella; see plan-gap 2*); test colocated
- **Implements:** §4.5 — default 10 req/s/host (schema-clamped ≤25), limit is **aggregate per host across ALL scanner families**; the live engine **serializes request-generating families against any single host** (no two of {ZAP, Nuclei, probes} hit one host at once) and passes the per-host rate to each; distinct hosts may run in parallel; auditor `User-Agent` set on all families.
- **Module shape.** *Public:* `withHostBudget(host, rate, fn)` / a per-host serialized scheduler the scanner wrappers acquire before issuing requests. *Hidden:* the token-bucket / serialization primitive, the per-host mutex.
- **Error handling:** budget exhaustion blocks (serializes), never drops a scan silently.
- **Test-first/G1 acceptance:** the §10 **aggregate per-host rate limit** guardrail — two fake scanner families pointed at one host assert combined observed rate never exceeds the host limit; two distinct hosts proceed in parallel. `npx eslint` + targeted vitest.
- **Depends on:** P4-1, P4-2 (the limiter functionally needs only the `AllowedTarget` brand from P4-1, but ordering it after preflight keeps the gate→preflight→ratelimit build order linear and matches the dependency summary) [claude-plan-review PR-004].
- **[ADV]** — pinned aggregate-per-host invariant (HIGH-2).

### P4-4 — Direct probes (TLS, headers, cookies, exposure) **[ADV]**
- **Phase:** P4
- **Files:** `src/live/probes/tls.ts`, `headers.ts`, `cookies.ts`, `exposure.ts`; tests colocated; live normalizer applying redaction (§5.4) at the live normalizer boundary
- **Implements:** §7.3 passive probe family — TLS/cert + protocol versions, security-header presence/correctness, cookie HttpOnly/Secure/SameSite, exposed debug/admin/source-map endpoints (curated path list; Nuclei portion in P4-6). `checkId`s `LIVE-TLS-001`/`LIVE-HDR-001`/`LIVE-COOKIE-001`/`LIVE-EXPOSE-001`/`LIVE-LEAK-001` (`source: probe`). Every probe accepts an `AllowedTarget` only (§4.1) and acquires the P4-3 host budget. Live response bodies/headers redacted via P2-1 at the normalizer (§5.4). Off-host redirects NOT followed; off-host links recorded as `scope-excluded` (§4.4).
- **Module shape.** *Public:* each probe `run(target: AllowedTarget): Finding[]`. *Hidden:* the raw HTTP, the header/cookie/TLS inspection, the redaction at normalize, the scope-confinement.
- **Error handling:** probe failure → `probe` family `failed` for that target (§6.8, §14); never silent.
- **Test-first/G1 acceptance:** probe normalizer unit tests over **captured fixture responses** asserting correct `Finding`/`checkId`/family and that `Set-Cookie`/`Authorization` material is redacted in the emitted finding (redaction-pass assertion for the live surface). `npx eslint` + targeted vitest. (Real probing against the live fixture is P6.)
- **Depends on:** P4-1, P4-2, P4-3, P2-1, P1-3.
- **[ADV]** — live network surface; redaction + scope confinement.

### P4-5 — Auth/login exchange (carrier-aware successCheck) **[ADV]**
- **Phase:** P4
- **Files:** `src/live/auth.ts` (*new file under `src/live/`; see plan-gap 2*); test colocated
- **Implements:** §6.2 form-login exchange — `method`+`loginPath`+`bodyType` build the request, `userField`/`passField` name creds (from env-var **names**, never values), `sessionCarrier` (cookie|bearer) selects credential extraction, **carrier-aware `successCheck`**: bearer requires an extractable token at `jsonHasKey` (Set-Cookie alone ≠ success); cookie requires a usable `Set-Cookie` (JSON token alone ≠ success); the carrier-agnostic OR is rejected. Pre-login CSRF token captured from `GET loginPath` and replayed (only CSRF handling in v1). §6.2 failure pinning: `activeScan:true` + missing creds / login failure → target `failed` (named in `meta.failures`), never silent downgrade; `activeScan:false` + failure → unauthenticated scan + explicit coverage gap.
- **Module shape.** *Public:* `establishSession(target, authConfig): Session | LoginFailure`. *Hidden:* the request builder, the carrier-aware success evaluation, the CSRF capture/replay, the env-name→value resolution.
- **Error handling:** login failure on active target → typed failure feeding §6.2 pinning; creds-from-env missing → same.
- **Test-first/G1 acceptance:** the §10 **carrier-aware login success** guardrail — a `bearer` login that only sets a cookie, and a `cookie` login that only returns a JSON token, each count as login *failure* and mark an `activeScan:true` target `failed`. `npx eslint` + targeted vitest.
- **Depends on:** P4-1, P4-3, P1-2.
- **[ADV]** — overstated-coverage / silent-unauthenticated-scan risk.

### P4-6 — ZAP + Nuclei wrappers (scope-confined) **[ADV]**
- **Phase:** P4
- **Files:** `src/live/scanners/zap.ts`, `src/live/scanners/nuclei.ts`; tests colocated; live normalizers (redaction-passed)
- **Implements:** §7.3 passive (ZAP passive error-message disclosure; Nuclei exposed-endpoint / version-leak / known-CVE templates) + active (ZAP active scan reflected/stored XSS, SQLi/cmd-injection, CSRF, open redirect; Nuclei fuzzing; auth/session + IDOR/access-control via authenticated two-user crawl using P4-5 session) ONLY when `activeScan:true`. §4.4 scope confinement: ZAP context scope + Nuclei target list = exactly the allowlisted host; off-host redirects not followed. `checkId`s `ZAP-P-*`/`ZAP-A-*`/`NUCLEI-*`/`LIVE-IDOR-001`/`LIVE-SESSION-001` (families `zap`/`nuclei`). Accept `AllowedTarget` only; acquire P4-3 host budget; redact at normalize. ZAP orchestration mode (daemon vs automation-framework YAML) is the builder's call behind the wrapper interface (§16 open question — wrapper contract fixed either way).
- **Module shape.** *Public:* `runZap(target, session?, opts): Finding[]`, `runNuclei(...)`. *Hidden:* the orchestration mode, scope/context setup, template/policy selection, IDOR cross-access logic, redaction at normalize.
- **Error handling:** scanner failure/timeout → that family `failed` for the target (§6.8, §14); active-scan with no session (per P4-5 failure) → target `failed`, not a silent passive run.
- **Test-first/G1 acceptance:** normalizer unit tests over captured ZAP/Nuclei JSON asserting `Finding`/`checkId`/family + redaction; scope-confinement unit assertion (off-host link → `scope-excluded`, never a target). `npx eslint` + targeted vitest. (Real scanners against the live fixture are P6.)
- **Depends on:** P4-1..P4-5, P2-1, P1-3.
- **[ADV]** — live active-scan surface; scope confinement.

### P4-7 — Live fixture app + benchmark allowlist wiring + §4.7 immutable safety-abort test **[ADV]**
- **Phase:** P4
- **Files:** `benchmark/live-fixture/` (purpose-built vulnerable Express+Drizzle+JWT+socket.io app, containerized), `benchmark/live-fixture/EXPECTED.json`; the §4.7 abort test (in the benchmark suite); uses `benchmark/allowlist.benchmark.json` from P1-5
- **Implements:** §10 live fixture (mirrors our stack; minimal/deterministic; reflected XSS + simple stored case per §13); §4.7 immutable safety test — a scan against a NON-allowlisted host (local server on a non-allowlisted hostname) aborts with `AllowlistViolationError` and **zero** HTTP requests reach the server (fixture server records hits). **This test may never be weakened or deleted** (§4.7 exit condition).
- **Module shape.** *Public:* the fixture app + EXPECTED.json + the abort test. *Hidden:* the seeded vulnerabilities, the hit-recording server.
- **Error handling:** n/a (test/fixture asset).
- **Test-first/G1 acceptance:** the §4.7 abort test passes (zero hits on a non-allowlisted host); the fixture boots deterministically. `npx eslint` on any TS + targeted vitest on the abort test. (Full live-fixture recall integration is P6.)
- **Depends on:** P4-1, P4-2, P1-5.
- **[ADV]** — owns the immutable §4.7 abort test.

---

# Phase P5 — Correlation + severity + report (JSON/MD/SARIF) + baseline + trend

*Depends on: P2–P4. Every report emitter applies the P2-1 redaction chokepoint. This is where derived Finding fields get populated.*

### P5-1 — Severity model (exploitability-aware modifier chain)
- **Phase:** P5
- **Files:** `src/correlate/severity.ts`; test colocated
- **Implements:** §8.1 — start from `baseSeverity`, apply in order: live-confirmed (+1 step, `confidence:confirmed`), reachability bump (`unauthenticated` +1), reachability demotion (`admin` −1), floor (`{secrets,injection,tenant-isolation}` never below `high`); clamp to critical…low. `unknown` reachability is neutral. Confidence inputs (active-demonstrated→confirmed, passive→probable, static→probable unless live-correlated).
- **Module shape.** *Public:* `computeSeverity(finding, correlation): {severity, confidence}`. *Hidden:* the ordered modifier application + clamp + floor.
- **Error handling:** pure; total function over the closed severity scale.
- **Test-first/G1 acceptance:** unit vectors for each modifier + the floor + the neutral-`unknown` rule + clamp boundaries. Pure → run locally. `npx eslint` + targeted vitest.
- **Depends on:** P1-1.

### P5-2 — Static↔live correlation
- **Phase:** P5
- **Files:** `src/correlate/correlate.ts`; test colocated
- **Implements:** §9 — correlate iff linked targets (`stagingTargets[].repo` ↔ repo name) AND same `vulnClass` AND location match (static `symbol` route sig ≈ live `normalizedUrlPath`+method, path-param-aware); merge into the static finding (carries fix location), append live id to `correlatedWith`, recompute severity (calls P5-1). **Deterministic dedupe: process findings sorted by full `fingerprint`** (not display id) so run order can't change output.
- **Module shape.** *Public:* `correlate(findings): Finding[]`. *Hidden:* the path-param-aware location matcher, the merge, the fingerprint-sorted iteration.
- **Error handling:** pure.
- **Test-first/G1 acceptance:** unit tests for a correlating pair (merged, `correlatedWith` populated, severity bumped) and a non-correlating pair (different vulnClass / unlinked target); determinism under shuffled input. `npx eslint` + targeted vitest.
- **Depends on:** P5-1, P1-3.

### P5-3 — Baseline suppression + expiry (scoped, full-fingerprint match)
- **Phase:** P5
- **Files:** `src/report/baseline.ts`; test colocated
- **Implements:** §6.4 — suppress iff ALL match: full `fingerprint` AND `ruleId` AND `target` (kind+name/host), plus `locationKey` when present; **match key is the full 64-hex fingerprint, never the truncated id**; expired entry stops suppressing → finding re-alerts at full severity with `note:"baseline expired <date>"`; sets `suppressed` + copies matched entry's `justification`/`approvedBy`/`expiry` into `suppression` (for the §6.10 SARIF projection from the archived report).
- **Module shape.** *Public:* `applyBaseline(findings, baseline): Finding[]`. *Hidden:* the full-fingerprint scoped match, the expiry check, the suppression-field copy.
- **Error handling:** pure (malformed baseline already rejected at config load, P1-2).
- **Test-first/G1 acceptance:** the §10 **scoped suppression** guardrail — (a) an entry scoped to one target does not suppress the same finding on another target; (b) two findings sharing a 16-hex id prefix but differing in full fingerprint are suppressed independently; plus an expired-entry re-alert with the `note`. `npx eslint` + targeted vitest.
- **Depends on:** P1-1, P1-3.

### P5-4 — Report builder: `report.json` (derives Finding fields, sorts, joins fixes.json) + ordering + workspace-lock helper
- **Phase:** P5
- **Files:** `src/report/json.ts`; **the `reports/.lock` workspace-lock helper (`src/report/lock.ts` + `src/report/lock.test.ts`) — hoisted here from P5-6 so the canonical lock primitive exists at its FIRST consumer's commit point** [chatgpt-plan-review OAI-PLAN-001]; test colocated
- **Implements:** §6.9 `RunReport` assembly — populates the report-stage-derived fields (`severity` via P5-1, `correlatedWith` via P5-2, `suppressed`/`suppression`/`note` via P5-3, `externalRefs` via fingerprint join to `reports/fixes.json` — read-only, a pure projection, never mutates fixes.json §14); §8.1 **report ordering** (severity desc → confidence → vulnClass criticality → target → ruleId asc → full fingerprint asc — total order); §6.9 `meta` (status, failures, scannerStatus, timing, toolVersion); §6.6 fingerprint-collision merge into `evidence.raw.occurrences`; §14 atomic tmp+rename under `reports/.lock`; redaction-pass via P2-1 on the emitted report.
- **Module shape.** *Public:* `buildReport(rawFindings, scannerStatus, fixesJson, baseline): RunReport` + the atomic write. *Hidden:* the derive-then-sort pipeline, the fixes.json join, the occurrence merge, the lock+rename.
- **Error handling:** lock contention → `WorkspaceLockedError` (§14); the full `src/report/lock.ts` impl (pid-liveness + 60s heartbeat, §14) is authored in THIS chunk so the report writer reuses the canonical primitive rather than forward-referencing P5-6 [chatgpt-plan-review OAI-PLAN-001]; partial run → `meta.status:'partial'` with named `meta.failures` (§14).
- **State-based idempotency note:** report writes are state-based (atomic tmp+rename, deterministic re-derive). The `externalRefs` join is a **pure read** of `fixes.json` — `buildReport` is NOT a fixes.json writer; it must never mutate its bytes/mtime (§14). Verify in the test that a build leaves `fixes.json` byte-identical.
- **Test-first/G1 acceptance:** unit tests for the total-order tiebreaker (two findings identical except ruleId/fingerprint sort deterministically), derived-field population, and that `externalRefs` is a join (not persisted) with `fixes.json` unchanged. Redaction-pass assertion on report.json (§10 surface). `npx eslint` + targeted vitest.
- **Depends on:** P5-1, P5-2, P5-3, P2-1, P1-1.

### P5-5 — Markdown + SARIF emitters (redaction-passed, deterministic)
- **Phase:** P5
- **Files:** `src/report/markdown.ts`, `src/report/sarif.ts`; tests colocated
- **Implements:** §5.1 Markdown report; §6.10 SARIF 2.1.0 deterministic projection of `RunReport` — `tool.driver` + per-rule `reportingDescriptor` (helpUri = docs path), `result.fingerprints.auditToolFingerprintV1` = **full** sha256, `result.level`/`rank` from severity, message = plain-English statement, static→physicalLocation+logicalLocation / live→logicalLocation, `result.suppressions[]` reading justification from the finding's report-stage `suppression` field (NOT live config), correlation→`relatedLocations`, `externalRefs`→`workItemUris`; results sorted by §8.1 order (stable bytes). Both apply P2-1 redaction.
- **Module shape.** *Public:* `toMarkdown(report)`, `toSarif(report)`. *Hidden:* the SARIF mapping table, the suppression projection, the deterministic ordering reuse.
- **Error handling:** pure projections over a valid `RunReport`.
- **Test-first/G1 acceptance:** SARIF unit tests asserting full-fingerprint in `auditToolFingerprintV1`, level mapping, suppression read-from-report, deterministic byte order; redaction-pass assertions on both surfaces (§10). `npx eslint` + targeted vitest.
- **Depends on:** P5-4, P2-1.

### P5-6 — Trend writer + workspace lock + `audit report` re-emit + run wiring
- **Phase:** P5
- **Files:** `src/report/trend.ts`; **reuses** the `reports/.lock` workspace-lock helper `src/report/lock.ts` (now authored in P5-4, not created here — see plan-gap 2) [chatgpt-plan-review OAI-PLAN-001]; `history/trend.jsonl`; wire `audit run` / `audit report` in `src/cli.ts`
- **Implements:** §6.5 trend (one JSONL line/run, counts only; **partial-run rule** — `status:"unknown"` for any target touched by a non-complete family; `fixed` NEVER computed from an incomplete family; `report.json` authoritative, trend regenerated on disagreement); §14 workspace lock (`reports/.lock`, create-exclusive `wx`, pid+heartbeat liveness staleness — refresh ≥ every 60s, break only on dead pid or stale heartbeat, never on elapsed time; `WorkspaceLockedError` on contention; read-only consumers don't take it); §14 trend append key-based on `runId` (replace, no dup); §5.1 `audit report --format json|md|sarif|html` re-emit from last run (html stub until P7); §14 exit codes 0/2/1 + `--fail-on`.
- **Module shape.** *Public:* `writeTrend(report)`, `withWorkspaceLock(fn)`, the wired `run`/`report` **and `scan-source`/`scan-live`** CLI bodies. *Hidden:* the partial-run dimension accounting, the pid/heartbeat staleness logic, the atomic JSONL replace.
- **CLI-composition note (the `audit run` integration point) [chatgpt-plan-review OAI-PLAN-002]:** this chunk replaces the P1-4 scan-body stubs with real wiring. `audit run` = scan-source + scan-live + correlate + report (§5.1), so it composes the static orchestrator (P2-2/P2-3 → `scanRepos`), the live engine via preflight (P4-2; non-dry-run path drives P4-4/P4-5/P4-6 only through an `AllowedTarget`), correlation (P5-2), and the report builder (P5-4). `scan-source` wires P2-2/P2-3 standalone; `scan-live --dry-run` wires P4-2's preflight only (zero scanners); non-dry-run `scan-live` wires the live engine. Acceptance adds: `src/cli.test.ts` asserts `scan-source` invokes `scanRepos`, `scan-live --dry-run` invokes preflight WITHOUT scanners, non-dry-run `scan-live` reaches the live engine only via an `AllowedTarget`, `audit run` feeds scanner outputs into `buildReport`, and no scan-body stub survives in `src/cli.ts`. **The composition of the P4-4/P4-5/P4-6 live wrappers into one live-scan invocation lives in `src/live/` (no new §11 module is invented by this plan — see OAI-PLAN-002 operator note in plan-gaps).**
- **State-based idempotency note:** the lock break path is the state-verification case — a held lock's "exists" is not "valid". Break ONLY when the holder is provably gone (dead pid via `process.kill(pid,0)`→ESRCH, or unverifiable pid AND stale heartbeat). A live pid with fresh heartbeat is NEVER broken regardless of elapsed time (§14). Test all three outcomes.
- **Error handling:** lock contention → `WorkspaceLockedError` (exit immediately, no block-wait); stale-but-alive holder never broken.
- **Test-first/G1 acceptance:** the §10 **partial-run trend** guardrail — a forced scanner timeout means a previously-known finding from that family is NOT counted `fixed`, the target records `unknown`, and the run reports `partial`; plus lock staleness unit tests (dead pid → break; live pid fresh heartbeat → never break; stale heartbeat + unverifiable pid → break). `npx eslint` + targeted vitest.
- **Depends on:** P5-4, P5-5, P1-4, **P2-2, P2-3 (static orchestrator for `scan-source`/`audit run`), P4-2 (preflight for `scan-live`), P4-4, P4-5, P4-6 (live engine for non-dry-run `scan-live`/`audit run`), P5-2 (correlation)** [chatgpt-plan-review OAI-PLAN-002 — `audit run` cannot compose scan-source+scan-live+correlate+report without these edges].

---

# Phase P6 — Benchmark completion + engine guardrails + Dockerfile + CI + self-scan + rule docs

*Depends on: P1–P5. Authors the CI gate definitions and the live-fixture integration. The §10 HTML inert-text guardrail is NOT here — it ships in P7 with the exporter it tests.*

### P6-1 — Benchmark completion: live-fixture integration + full corpus recall/precision run
- **Phase:** P6
- **Files:** extend `benchmark/run.ts`; complete `benchmark/corpus/**` coverage cross-check; `benchmark/live-fixture` integration into the harness; `npm run benchmark` wiring
- **Implements:** §10 — full recall (100% target) / precision (0 FP) accounting per rule + aggregate over the real corpus and the live fixture (scanned ONLY via the benchmark-scoped allowlist, shipped config untouched); rule-inventory ↔ corpus cross-check now covers all 11 rules + 3 wrapped families + each live `checkId` family; non-zero exit on any miss/missing-fixture.
- **Module shape.** *Public:* the completed `npm run benchmark`. *Hidden:* live-fixture boot/teardown, the real-binary invocation path.
- **Error handling:** any miss/FP/missing-fixture → non-zero exit naming the rule.
- **Test-first/G1 acceptance:** this chunk authors the benchmark; its own acceptance is the harness's accounting unit tests (already in P1-5) plus a smoke unit test of the live-fixture integration wiring. The full benchmark RUN is the P6 core-quality exit loop (coordinator/CI-owned), not a chunk step. `npx eslint` on touched TS.
- **Depends on:** P3-1..P3-3, P4-7, P5-6.

### P6-2 — Engine-available §10 guardrail test consolidation **[ADV]**
- **Phase:** P6
- **Files:** the guardrail tests that depend on the integrated engine, colocated with their modules (most already authored in their owning chunks — this chunk ensures all engine-available guardrails are present and wired into the benchmark suite): partial-run trend (P5-6), scoped suppression (P5-3), active-scan cred failure (P4-5/P4-6), allowlist IP-literal rejection (P4-1), preflight-before-DNS (P4-2), aggregate per-host rate limit (P4-3), carrier-aware login (P4-5), secret redaction across surfaces (P2-1 + per-surface), §4.7 abort (P4-7)
- **Implements:** §10 guardrail batch (engine-available only — explicitly **excludes** the HTML inert-text matrix, which is P7). **active-scan cred failure** guardrail: an `activeScan:true` target with missing creds produces a `failed` run, not a passive scan (§6.2). The **secret-redaction across-all-surfaces** assertion is completed here for the surfaces that now exist (raw findings, report.json, MD, SARIF); HTML + fix-issue surfaces are asserted in P7/P8.
- **Module shape.** *Public:* the guardrail test suite membership. *Hidden:* n/a (tests).
- **Error handling:** n/a.
- **Test-first/G1 acceptance:** each guardrail authored in its owning chunk runs locally as a single file; this chunk confirms the active-scan-cred-failure guardrail and the cross-surface redaction assertion. `npx eslint` + targeted vitest on the consolidated guardrail files.
- **Depends on:** P2-1, P4-1..P4-7, P5-3, P5-6.
- **[ADV]** — the consolidated set IS the safety/security guardrail surface.

### P6-3 — Rule docs sweep (one doc per stable id)
- **Phase:** P6
- **Files:** `docs/rules/<ID>.md` for every stable id not already written in P3 — the 3 wrapped-scanner families (semgrep/gitleaks/osv) and each live `checkId` family (`LIVE-TLS-001`, `LIVE-HDR-001`, `LIVE-COOKIE-001`, `LIVE-EXPOSE-001`, `LIVE-LEAK-001`, `ZAP-P-*`, `ZAP-A-*`, `NUCLEI-*`, `LIVE-IDOR-001`, `LIVE-SESSION-001`)
- **Implements:** §11 docs granularity — id, rationale, fix guidance + code example (sourced into remediation packs §5.3), fixture links; one doc per family (NOT per upstream template). The 11 custom-rule docs already landed with their rules in P3.
- **Module shape.** *Public:* the doc set (consumed by SARIF helpUri + remediation packs). *Hidden:* n/a.
- **Error handling:** n/a (docs).
- **Test-first/G1 acceptance:** a small test (or the benchmark cross-check) asserting every stable id has a `docs/rules/<id>.md` — closes the SARIF helpUri / pack-source gap. `npx eslint` on any TS.
- **Depends on:** P3-1..P3-3, P4-4, P4-6.

### P6-4 — Dockerfile (pinned scanner binaries)
- **Phase:** P6
- **Files:** `Dockerfile`
- **Implements:** §11 — pinned exact versions of Semgrep, gitleaks, osv-scanner, OWASP ZAP, Nuclei (versions resolved at this chunk per §16 open question; record chosen versions in `KNOWLEDGE.md` per handoff — not a spec deliverable file).
- **Module shape.** *Public:* the GHCR image the weekly run + CI use. *Hidden:* base image + install pinning.
- **Error handling:** n/a (build asset).
- **Test-first/G1 acceptance:** image builds; binaries resolve at pinned versions. (Build verification is a Docker build, not a unit test.)
- **Depends on:** P2-3, P4-4, P4-6 (knows which binaries are shelled).

### P6-5 — CI workflows + self-scan gate + CODEOWNERS + package.json scripts **[ADV]**
- **Phase:** P6
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/weekly-audit.yml`, `CODEOWNERS`; self-scan config (exclusions for `benchmark/corpus/**` + `benchmark/live-fixture/**`); `package.json` script additions (`benchmark`, `schemas` — see plan-gap 1)
- **Implements:** §10 self-scan gate (CI statically scans THIS repo, must be clean; intentionally-vulnerable benchmark dirs excluded via pinned self-scan config); §11 ci.yml (lint, typecheck, test:unit, benchmark, self-scan on PR) + weekly-audit.yml (scheduled portfolio run in the GHCR image); `CODEOWNERS` (`config/*` → michaelhazza, per §4.3/§6.4 PR-review requirement). This is the **CI gate definition** — authored as a deliverable, not a local run.
- **Module shape.** *Public:* the CI gate + the GHCR scheduled run. *Hidden:* workflow wiring.
- **Error handling:** n/a (CI config).
- **Test-first/G1 acceptance:** the self-scan config correctly excludes the benchmark dirs (a unit/static assertion that the exclusion globs are present). The CI run itself is CI-owned. `npx eslint` on any TS.
- **Depends on:** P6-1..P6-4.
- **[ADV]** — self-scan + CODEOWNERS on `config/*` are part of the safety posture (no-override = PR-reviewed config).

---

# Phase P7 — Report dashboard UI + HTML export (read-only; Fixes/Send-for-fixing disabled until P8)

*Depends on: P5 (report.json / trend.jsonl as the data contracts). NO `src/fix/*` dependency. All 6 screens render; Fixes + finding-detail fix pipeline render read-only/disabled.*

### P7-1 — `audit ui` server: static assets + read-only JSON endpoints + CSRF nonce mint **[ADV]**
- **Phase:** P7
- **Files:** `src/ui/server.ts`; test `src/ui/server.test.ts`
- **Implements:** §5.2 — dependency-light `node:http` server bound to `127.0.0.1` ONLY (never `0.0.0.0`), default port 4173, `--port` flag; serves the pre-built SPA + read-only JSON endpoints over `reports/`, `history/trend.jsonl`, `config/` trio, `reports/fixes.json`; **per-process `X-Audit-CSRF` nonce minted at startup**, served only to same-origin SPA (the mutating route itself is wired in P8 — this chunk lands the nonce mint + the read endpoints + the no-`Access-Control-Allow-Origin:*` rule); read-only consumers don't take `reports/.lock` (re-read on parse failure, §14).
- **Module shape.** *Public:* the server start + its read-only routes + the nonce endpoint. *Hidden:* the file readers, the nonce mint, the same-origin gate scaffolding.
- **Error handling:** never binds `0.0.0.0`; never emits `Access-Control-Allow-Origin: *`; missing report files → empty-state JSON, not a 500.
- **Test-first/G1 acceptance:** server binds `127.0.0.1` only; read endpoints return file state; nonce minted per process; the server never emits `Access-Control-Allow-Origin: *`. (The full CSRF/origin 403 guardrail ships with the mutating route in P8.) `npx eslint` + targeted vitest.
- **Depends on:** P5-6.
- **[ADV]** — the server is the host of the one mutating route; loopback-binding + no-wildcard-CORS are safety properties even before P8 wires the POST.

### P7-2 — React SPA shell + shared visual language + 6 screens (data-bound, read-only)
- **Phase:** P7
- **Files:** `ui/**` (Vite + React 18 + TS SPA): shared severity/run-status color tokens + plain-language vocabulary layer, routing, and the 6 screens — Portfolio overview (`index.html` shape), Run report (`run-report.html`), Finding detail (`finding-detail.html`), Fixes (`fixes.html`), Trends (`trends.html`), Targets & safety (`targets.html`); built assets shipped with the package
- **Implements:** §5.2 screens rendering from the P5 data contracts, shapes from the **approved prototypes** in `prototypes/audit-tool-v1/`; plain-language-first vocabulary (the normative term table — "In the code"/"On the live test site"/"Fix now"/etc.); consistent severity + run-status tokens; partial runs never visually conflated with success; `unknown` rendered explicitly on Trends; **Fixes screen renders empty/"no fix requests yet" state** and **finding-detail "Send for fixing" button renders DISABLED with a "fix-sending wired in P8" affordance** (no `src/fix/*` dep); "copy baseline entry JSON" + "copy fix instructions" are local clipboard writes only.
- **Module shape.** *Public:* the 6 built screens consuming the read-only JSON endpoints. *Hidden:* the component tree, the vocabulary mapping, the chart wiring (Recharts).
- **Error handling:** loading / empty / error states per screen; disabled Send-for-fixing with explanatory affordance.
- **Test-first/G1 acceptance:** per `docs/spec-context.md` framing, frontend component tests are `none_for_now` — acceptance is shape-match to the locked prototypes + plain-language vocabulary presence, verified by the pr-reviewer/mockup reference at review time, plus `npx eslint` on `ui/**`. (No new Vitest suite required for SPA components; G2 build covers the Vite build.) See plan-gap 6.
- **Depends on:** P7-1.
- **UX:** loading/empty/error states required on every screen; permissions are single-operator localhost (no auth in v1, §5.2); no real-time transport — the dashboard re-reads file state on navigation/refresh (renderer-not-controller, §5.2); responsive desktop-first, every screen usable at 375px (§3).

### P7-3 — HTML export + inert-text guardrail **[ADV]**
- **Phase:** P7
- **Files:** `src/report/html.ts`; test `src/report/html.test.ts`; **wire `audit report --format html` in `src/cli.ts`** (replacing the P5-6 html stub with the real exporter; extend `src/cli.test.ts`) [chatgpt-plan-review OAI-PLAN-004]
- **Implements:** §5.2 self-contained single-file HTML export (inline CSS/JS/SVG, zero network deps, same visual language); **evidence-content safety** — all finding evidence HTML-entity-escaped + rendered as inert text in a visible container only; the inline `<script>` is a fixed build-time chart renderer over an escaped JSON data island (`</script>`-safe), no `eval`/`innerHTML`-of-evidence/evidence-derived script; redaction (P2-1) runs FIRST on the data (anti-XSS escaping is not a substitute, §5.4).
- **Module shape.** *Public:* `toHtml(report): string` + the wired `--format html`. *Hidden:* the escaping, the data-island encoding, the fixed chart renderer.
- **Error handling:** pure projection; never emits unescaped evidence into any carrier.
- **Test-first/G1 acceptance:** the §10 **HTML evidence inert-text matrix** guardrail (`src/report/html.test.ts`) — malicious evidence containing `<script>`, `<style>`, `<template>`, `<meta>`, `<link>`, HTML comments, `aria-*`/`data-*`/event-handler attributes, `<input type="hidden">`, hidden/off-viewport subtrees, and a literal `</script>` appears ONLY as escaped text in the visible container, never as parsed DOM/executable script; plus the redaction-pass assertion on the HTML surface (§10). **This guardrail is a final-ship requirement and ships with this exporter.** `npx eslint` + targeted vitest.
- **Depends on:** P5-4, P2-1, **P5-6** (consumes the `audit report --format html` stub P5-6 lands; this chunk replaces it with the real exporter) [chatgpt-plan-review OAI-PLAN-004].
- **[ADV]** — XSS-vector security guardrail; the tool emits attacker-controlled strings.

---

# Phase P8 — Remediation orchestration + wire Fixes screen + CSRF/origin-gated fix endpoint

*Depends on: P5 (findings/fingerprints), P6-3 (rule-docs sweep — packs source fix examples from `docs/rules/<id>.md`, including the wrapped-scanner and live-check family docs that land in P6-3, not just the P3 custom-rule docs), P7 (UI shell). Closes the detect-here-fix-there loop.* [P6-3 dependency surfaced per claude-plan-review PR-005.]

### P8-1 — Remediation pack renderer
- **Phase:** P8
- **Files:** `src/fix/pack.ts`; test colocated
- **Implements:** §5.3 step 1 — machine-readable + Markdown pack: plain-English problem statement, affected file/symbol/route, recommended fix pattern + code example (sourced from `docs/rules/<id>.md`), severity + why, **acceptance criteria** (ruleId + fingerprint that must no longer fire on re-scan); also the copyable ready-to-paste Claude Code prompt (manual fallback, §5.3). Pack body is **redaction-passed** via P2-1 (§5.4 — no secret republished into an issue).
- **Module shape.** *Public:* `renderPack(finding, ruleDoc): { json, markdown, prompt }`. *Hidden:* the rule-doc sourcing, the acceptance-criteria assembly, the redaction call.
- **Error handling:** pure over a valid finding + rule doc.
- **Test-first/G1 acceptance:** unit test asserting pack carries the full fingerprint as the acceptance marker + a redaction-pass assertion on the pack surface (§10). `npx eslint` + targeted vitest.
- **Depends on:** P5-4, P6-3 (rule docs), P2-1.

### P8-2 — GitHub fix-request integration (idempotent at issue + comment level) **[ADV]**
- **Phase:** P8
- **Files:** `src/fix/github.ts`; test colocated
- **Implements:** §5.3 step 2 + §14 — file the pack as a GitHub issue labelled `audit-fix` carrying the fingerprint marker; **search-before-create** (open `audit-fix` issue with same fingerprint marker reused, never duplicated) AND **search-before-comment** (each comment carries deterministic `<!-- audit-fix:<fingerprint>:<reason> -->`; search existing comments for the exact marker before posting → no-op if present); idempotency keyed on **full fingerprint** at both levels (§14 retry classification `idempotent`); token `AUDIT_GITHUB_FIX_TOKEN` fine-grained `issues:write`(+`issues:read`,`pull_requests:read`), **never** `contents:write`; missing token → named error.
- **Module shape.** *Public:* `fileFixRequest(finding, pack): { issueUrl }`, `commentOnIssue(issue, reason, marker)`. *Hidden:* the search-before-create/comment logic, the marker format, the token-scope guard.
- **Error handling:** missing token → named error (`audit fix` fails; UI explains in plain English); GitHub API failure → typed error, no partial fixes.json write (write only on confirmed issue).
- **State-based idempotency content check:** when the issue already exists, the code verifies the existing `audit-fix` issue carries the **matching fingerprint marker** before treating it as the canonical issue (not "an issue exists" alone). A search match on the exact marker is the content verification; a label-only/no-marker match is NOT treated as the canonical issue (it files a new one). This closes the duplicate-comment retry window described in §5.3 step 2: a retry after GitHub accepted a comment but before `fixes.json` updated finds the marker and skips.
- **Test-first/G1 acceptance:** idempotency unit tests (mocked GitHub API) — re-filing the same fingerprint reuses the open marker-bearing issue (no dup); re-commenting the same `<fingerprint>:<reason>` marker is a no-op; a label-only issue without the marker is NOT reused. `npx eslint` + targeted vitest.
- **Depends on:** P8-1.
- **[ADV]** — the only external HTTP write; idempotency + minimal-scope token are security-relevant.

### P8-3 — Fix-status derivation (6-state machine) + fixes.json writer **[ADV]**
- **Phase:** P8
- **Files:** `src/fix/status.ts`; `reports/fixes.json` writer; test colocated
- **Implements:** §5.3 step 4 + state machine — derive status from GitHub issue/PR + scan state using ONLY read scopes (`issues:read`,`pull_requests:read`): `requested`→`in-progress`(assigned OR draft PR references issue)→`awaiting-review`(non-draft PR open)→`merged-awaiting-verification`(PR merged)→`verified-fixed`|`reopened`; **`verified-fixed` fenced by scanner-family completion** (graduates only when the originating `(target×scannerFamily)` ran to `complete` this run per `meta.scannerStatus` — a failed/skipped family does NOT graduate, mirrors §6.5); `reopened` non-terminal (re-enters via re-derivation), reopens the issue + comments (via P8-2); §14 fixes.json atomic tmp+rename under `reports/.lock`, fingerprint-keyed read-modify-write, exactly two writers (`audit fix` + Send-for-fixing), last-writer-wins on the GitHub-derived status; closed 6-token enum (`src/schemas/fix.ts`).
- **Module shape.** *Public:* `deriveStatus(issue, pr, scanState): FixStatus`, `upsertFix(fingerprint, entry)`. *Hidden:* the family-completion fence, the read-scope-only derivation, the atomic upsert under lock.
- **Error handling:** lock contention → `WorkspaceLockedError`; partial-run family-not-complete → request stays `merged-awaiting-verification` (no false `verified-fixed`).
- **State machine closure:** the 6-token set is closed (adding a token = spec amendment); `reopened` is non-terminal and recovers via re-traversal (no new token). Forbidden: any transition to `verified-fixed` whose originating family did not run to `complete` in the verifying run — that is the partial-run-masquerade guard for the fix machine.
- **Test-first/G1 acceptance:** state-machine unit tests for each transition incl. the **family-completion fence** (a partial run whose responsible family failed does NOT graduate to `verified-fixed`); `reopened` re-entry; full-fingerprint keying; last-writer-wins convergence. `npx eslint` + targeted vitest.
- **Depends on:** P8-2, P5-4 (scannerStatus/findings), P1-1 (`fix.ts` schema).
- **[ADV]** — the family-completion fence is the partial-run-masquerade guard for the fix machine (§5.3 step 4 / §6.5 parity).

### P8-4 — `audit fix` CLI wiring (single + bulk, suppressed-excluded, ref resolution)
- **Phase:** P8
- **Files:** wire `audit fix` in `src/cli.ts`; test colocated
- **Implements:** §5.1 `audit fix (<finding-ref> | --min-severity <s>) [--dry-run]` — `<finding-ref>` resolves full 64-hex fingerprint OR a display id (`f-<16hex>`) to exactly one finding in the selected report; ambiguous prefix → `AmbiguousFindingIdError` listing matching full fingerprints; `--min-severity` bulk-files every not-yet-filed finding ≥ s **excluding `suppressed:true`** (no `--include-suppressed` in v1; a suppressed finding files only by explicit ref); all filing + idempotency by **full fingerprint** (§6.6); `--dry-run` prints pack(s) without filing; no per-finding severity override.
- **Module shape.** *Public:* the `audit fix` CLI body. *Hidden:* the ref-resolution (full-fp vs display-id-prefix), the suppressed-exclusion filter, the not-yet-filed filter.
- **Error handling:** ambiguous display-id → `AmbiguousFindingIdError`; missing token → named error (from P8-2).
- **Test-first/G1 acceptance:** ref-resolution unit tests (full fp resolves; unambiguous display id resolves; ambiguous prefix throws listing full fingerprints); `--min-severity` excludes suppressed. `npx eslint` + targeted vitest.
- **Depends on:** P8-1, P8-2, P8-3.

### P8-5 — Wire UI: Send-for-fixing endpoint (CSRF/origin-gated) + live Fixes screen **[ADV]**
- **Phase:** P8
- **Files:** add the mutating route to `src/ui/server.ts`; extend `src/ui/server.test.ts`; enable the Fixes screen + finding-detail fix pipeline in `ui/**` (live data, button enabled)
- **Implements:** §5.2 fix-endpoint hardening — the single mutating "Send for fixing" POST invokes the same code path as `audit fix` (P8-4); CSRF/origin-gated: rejects HTTP 403 **without calling `src/fix/github.ts`** on missing/wrong `X-Audit-CSRF` nonce OR an `Origin` not `http://127.0.0.1:<port>`; never emits `Access-Control-Allow-Origin: *`; writes under `reports/.lock` (§14, second writer of fixes.json); Fixes screen + finding-detail now render the live 6-state pipeline from `reports/fixes.json` (button enabled), `externalRefs` shown via the report-build join.
- **Module shape.** *Public:* the POST route + the now-live Fixes UI. *Hidden:* the nonce check, the origin check, the 403-before-github short-circuit, the lock-held write.
- **Error handling:** missing/wrong nonce or foreign origin → 403 **before** any GitHub call; missing token → plain-English "fix-sending not configured" (§5.3).
- **Test-first/G1 acceptance:** the §10 **UI fix-endpoint CSRF/origin** guardrail (`src/ui/server.test.ts`) — 403 (and `src/fix/github.ts` NOT called) on missing/wrong nonce or foreign origin; server never emits `Access-Control-Allow-Origin: *`; plus the fix-issue-body **redaction-pass** assertion (final §10 redaction surface). `npx eslint` + targeted vitest.
- **Depends on:** P8-4, P7-1, P7-2.
- **[ADV]** — the one mutating UI route spending the `issues:write` token; CSRF/origin is the real guard, loopback alone is insufficient.

### P8-6 — Fix-workflow onboarding doc
- **Phase:** P8
- **Files:** `docs/fix-workflow.md`
- **Implements:** §5.3 step 3 — target-repo onboarding (install the standard Claude Code action + `audit-fix` label; one-time), and the manual-fallback paste path.
- **Module shape.** *Public:* the doc. *Hidden:* n/a.
- **Test-first/G1 acceptance:** doc completeness reviewed at PR; `npx eslint` n/a.
- **Depends on:** P8-2 (the label/marker contract the doc describes).

---

## End-of-construction (G2 — coordinator-owned, run ONCE on integrated branch state)

`npm run lint` · `npm run typecheck` · `npm run build`. NOT per-chunk. After G2, the **P6 core-quality exit loop** (benchmark 100% recall / 0 FP + base gates + self-scan, max 10 iterations, stuck-rule stop after 2 identical failures, immutable exit conditions) runs over the engine (may overlap P7/P8). The **final v1 ship gate** = P6 loop green AND P7 (6 screens + HTML inert-text guardrail) AND P8 (idempotency, state-machine derivation, §10 guardrails, `docs/fix-workflow.md`) complete (§12). All of this is CI/coordinator-owned, never a local chunk step.

---

## Adversarial-reviewer MANDATORY chunks (safety contract / security guardrails)

Per the handoff (adversarial-reviewer MANDATORY on the live-scan safety surface), these chunks go to the adversarial-reviewer at review time:

- **P1-2** config loader / allowlist provenance + branded `LoadedAllowlist`
- **P2-1** secret-redaction chokepoint
- **P4-1** `assertAllowlisted` + `AllowedTarget` brand (the core chokepoint; §4.7 immutable)
- **P4-2** preflight-before-DNS
- **P4-3** aggregate-per-host rate limiter
- **P4-4** direct probes (live network + redaction + scope confinement)
- **P4-5** carrier-aware login (silent-unauthenticated-scan risk)
- **P4-6** ZAP/Nuclei wrappers (active-scan + scope confinement)
- **P4-7** live fixture + §4.7 immutable abort test
- **P6-2** engine guardrail consolidation (safety/security guardrails)
- **P6-5** self-scan gate + CODEOWNERS on `config/*`
- **P7-1** `audit ui` server (loopback binding, no-wildcard-CORS)
- **P7-3** HTML inert-text export (XSS vector)
- **P8-2** GitHub fix-request (only external HTTP write; minimal-scope token + idempotency)
- **P8-3** fix-status derivation (family-completion fence)
- **P8-5** Send-for-fixing CSRF/origin endpoint

---

## Dependency summary (forward-only)

```
P1-1 → P1-2,P1-3,P1-4,P1-5
P1-2 → P2-2, P4-1, P4-2, P4-5
P2-1 → P2-3, P4-4, P4-6, P5-4, P5-5, P7-3, P8-1
P2-2 → P2-3, P3-1
P2-3 → P3-3
P3-1 → P3-2
P4-1 → P4-2 → P4-3 → P4-4/P4-5/P4-6 → P4-7   (gate→preflight→ratelimit→scanners→fixture)
P5-1 → P5-2 → P5-4 → P5-5 → P5-6
P5-3 → P5-4
P2-2,P2-3,P4-2,P4-4,P4-5,P4-6,P5-2 → P5-6   (audit run = scan-source+scan-live+correlate+report; OAI-PLAN-002)
P3-*,P4-7,P5-6 → P6-1 ; P6-1..P6-4 → P6-5
P5-6 → P7-1 → P7-2 ; P5-4,P5-6 → P7-3   (P7-3 replaces the P5-6 html stub; OAI-PLAN-004)
P5-4,P6-3 → P8-1 → P8-2 → P8-3 → P8-4 → P8-5 ; P8-2 → P8-6
P7-1,P7-2 → P8-5
```

---

## Plan-gaps and ambiguities (flag for the builder / coordinator)

The spec is unusually complete. These are the only items a builder could block on — none change scope or architecture:

1. **`package.json` scripts not yet present.** CLAUDE.md and the spec reference `npm run benchmark` and `npm run schemas`, but `package.json` currently has only `lint`/`typecheck`/`test:unit`/`build`. **Resolution:** add `"benchmark"` and `"schemas"` scripts plus a `bin` entry for the `audit` CLI. Land the `schemas` script in P1-1 and the `benchmark` script in P1-5/P6-5. No `tsx` in devDependencies yet — either add it (run TS directly) or run built JS. **Flag:** confirm the runner choice (tsx vs prebuilt) at P1.

2. **Three engine modules are implied by pinned invariants but not literally named as filenames in §11.** The §11 row `src/live/scanners/{zap,nuclei}.ts, src/live/probes/{...}.ts` names the scanners/probes but not a rate-limit or auth module, and `src/report/{...}.ts` names the emitters but not a lock helper. The plan proposes: `src/live/ratelimit.ts` (P4-3, §4.5 aggregate-per-host serializer), `src/live/auth.ts` (P4-5, §6.2 carrier-aware login), and `src/report/lock.ts` (P5-6, §14 workspace lock). These implement pinned spec invariants so they are **in-scope**, but they need a one-line file-inventory amendment to keep §11 the source of truth. **Flag:** coordinator confirms the exact paths. (Inlining each into every consumer would duplicate a safety-critical invariant across files — worse; a single module is correct.)

3. **ZAP orchestration mode (§16 open question) is a P4-6 builder decision.** Daemon API vs `zap-baseline.py`/automation-framework YAML. The wrapper contract (§7.3) is fixed either way, so this does not block P4-6 — the builder picks one and records it in `KNOWLEDGE.md`. **No plan impact.**

4. **Pinned scanner versions (§16 open question) resolved at P6-4.** Exact versions for the 5 binaries are deferred to Dockerfile authoring and recorded in `KNOWLEDGE.md` (not a spec file). P6-4 owns this. **No plan impact** beyond noting P6-4 cannot complete until versions are chosen.

5. **`automation-v1` staging `activeScan` flag (§16) is operator-set, shipped `false`.** The shipped `config/targets.json` (P1-2) ships the sample staging target disabled with `activeScan:false`. No builder decision; operator call post-build. **No plan impact.**

6. **SPA component testing posture.** `docs/spec-context.md` framing is `frontend_tests: none_for_now`. P7-2 therefore authors NO Vitest component suite for the SPA — acceptance is shape-match to the locked prototypes + the plain-language vocabulary, verified at review. The server (`src/ui/server.test.ts`) and the HTML export (`src/report/html.test.ts`) DO carry tests (backend/pure surfaces owning §10 guardrails). **Flag:** if the coordinator wants SPA smoke tests, that is a framing deviation to call out explicitly — the plan follows the pinned `none_for_now` posture.

7. **Config scaffolding already exists — extend, don't create** (corrected per claude-plan-review PR-002). `tsconfig.json`, `tsconfig.build.json`, and `eslint.config.js` are already present with a strict posture; the P1 builder must EXTEND them additively, never recreate — recreating risks relaxing `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`, which §6.1's optional-field design (`note?`/`suppression?`/`occurrences?`) depends on. The genuine P1 gaps are in `package.json`: no `tsx` runner pinned, and no `benchmark`/`schemas` scripts or `bin` entry (plan-gap 1), plus the `vitest.config.ts` benchmark-include extension (PR-001, folded into P1-5). **Resolution:** fold these additive edits into P1-1; pin the runner to `tsx`.

8. **Live-engine composition module — operator confirmation (chatgpt-plan-review OAI-PLAN-002, USER-FACING).** The plan now pins the `audit run`/`scan-live` CLI-body wiring (with its missing engine dependency edges) into P5-6, and composes the P4-4/P4-5/P4-6 live wrappers within `src/live/`. OpenAI proposed a *new* `src/live/orchestrator.ts` module + a dedicated integration chunk. §11 does NOT name such a module (Layer-3 composition is implied to live in `src/live/`), so adding it is a §11-inventory amendment — **operator call at the plan-gate.** Two options: (a) keep the composition inline in P5-6's CLI bodies + the existing `src/live/` modules (no §11 change — the applied edit assumes this); or (b) introduce `src/live/orchestrator.ts` as a named §11 module with its own chunk (cleaner separation, but a spec-inventory amendment on a LOCKED spec). The dependency-edge fix has been applied either way; only the module-extraction question is open.

9. **Canonical stable-ID inventory for the corpus cross-check (chatgpt-plan-review OAI-PLAN-003, USER-FACING — likely NO-OP).** OpenAI (reviewing the plan without the spec) flagged that no chunk creates a canonical rule/check-ID inventory file and that ZAP/Nuclei IDs are left as wildcards (`ZAP-P-*`/`ZAP-A-*`/`NUCLEI-*`). Against the LOCKED spec this is largely a non-issue: §11 *deliberately* pins doc/ID granularity as one-doc-per-family for the wildcard scanners ("NOT one per individual upstream template"), and the cross-check's canonical ID set is the union of the 11 named rules + 3 wrapped families + the enumerated live `checkId`s + the 3 wildcard families. **Operator decision:** optionally have P1-5/P6-1 name where that canonical ID list literally lives (e.g. a small exported constant the cross-check and the docs-completeness test both import) to remove the "different builders mint incompatible IDs" ambiguity — a clarity hardening, NOT a spec change. Not applied (would touch the locked granularity decision if done wrong).

10. **Reviewer-auditable acceptance for judgement-heavy chunks (chatgpt-plan-review OAI-PLAN-005, USER-FACING).** P7-2 (`frontend_tests: none_for_now`, plan-gap 6) and P8-6 (doc reviewed at PR) rely on reviewer judgement rather than a grepable artefact. OpenAI proposed concrete artefacts: a `docs/ui-prototype-mapping.md` (one row per locked prototype screen) + a grepable `ui/src/vocabulary.ts` normative-term export for P7-2, and a heading/checklist contract for `docs/fix-workflow.md` (P8-6). These are reasonable hardenings but P7-2's no-component-test posture is the spec-context-pinned framing (plan-gap 6) — adding test/acceptance scope is exactly the "framing deviation to call out explicitly." **Operator decision at the plan-gate:** accept the pinned `none_for_now` posture as-is, or adopt the lightweight grepable acceptance artefacts (no spec change; pure acceptance enrichment). Not applied.
