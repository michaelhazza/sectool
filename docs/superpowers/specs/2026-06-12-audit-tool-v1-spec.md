# Spec — audit-tool v1: internal security audit tool (SAST + staging-only DAST)

**Status:** reviewing
**Spec date:** 2026-06-12
**Last updated:** 2026-06-12
**Author:** claude (spec-coordinator, autonomous session; operator: michaelhazza)
**Build slug:** audit-tool-v1

## Lifecycle Declaration

| Field | Value |
|---|---|
| Capability cluster | Static Scanning, Live Scanning, Correlation & Reporting, Target Registry & Safety, Benchmark & Quality |
| Capability owner | michaelhazza |
| Lifecycle state on launch | Inception |
| Risk surface | None. |
| Review cadence | quarterly (plus the post-v1 "what classes are we not scanning for" human review from the brief) |

> Risk-surface note: the §7.1.1 vocabulary enumerates target-app surfaces that
> do not exist in this repo. The build's actual highest-stakes surface — live
> traffic to staging hosts — is governed by §4 (staging-only safety contract).

## ABCd Lifecycle Estimate

| Dimension | Sizing | Notes |
|---|---|---|
| Acquire | L | Commercial portfolio SAST+DAST (e.g. Snyk + Burp Enterprise) is expensive and still wouldn't know our RLS/scoped-helper conventions — the custom rule pack is the differentiator. |
| Build | L | Five subsystems + benchmark corpus + safety contract; the corpus (one bad + one good fixture per rule/check) is the dominant cost. |
| Carry | M | Pinned scanner versions need periodic bumps; rules need upkeep as target-app conventions evolve; weekly CI runs to babysit. |
| decommission | S | Self-contained repo + CI workflows; delete the repo and the GHCR image, revoke the read-only token. |

---

## 1. Goals

1. **One command, one report.** `audit run` scans every registered repo
   (static) and every registered staging URL (live), merges, correlates, and
   emits one prioritized remediation report (JSON + Markdown + SARIF).
2. **Portfolio-uniform static scanning** — wrapped scanners (Semgrep, gitleaks,
   osv-scanner) + a custom rule pack (ts-morph AST + Semgrep YAML) tailored to
   the Breakout Solutions stack (Express 4 / Drizzle + Postgres RLS / JWT /
   Zod / React / pg-boss / socket.io / multer / S3).
3. **Staging-only live scanning** — ZAP + Nuclei + direct TLS/header probes,
   gated by a checked-in host allowlist with no override path (§4).
4. **Measured quality** — benchmark corpus with seeded-bad and known-clean
   fixtures for every rule and live check; `npm run benchmark` exits non-zero
   below 100% recall / above 0 false positives.
5. **World-class table stakes** — stable fingerprints, SARIF, exploitability-
   aware severity, static↔live correlation, suppressions with justification +
   expiry, trend history, self-scan gate, per-rule docs.

## 2. Non-goals

- Generic SAST/DAST product. Internal use against Breakout-owned assets only.
- Scanning production — ever. No code path exists for it (§4).
- Auto-remediation, PR generation, GitHub issue creation (schema reserves room
  for issue-sync later — `Finding.externalRefs`).
- SaaS dashboard. Report files are the product.
- Replacing per-repo CI gates (boundary mapped in
  `tasks/builds/audit-tool-v1/intent.md § automation-v1 overlap map`).

## 3. Framing assumptions

- All targets (repos + staging hosts) are owned and operated by Breakout
  Solutions. Defensive, authorized, internal-only.
- Read-only against source repos. Live scanning is rate-limited, identifiable
  (`User-Agent: BreakoutSolutions-audit-tool/<version> (+security@breakoutsolutions.com)`),
  and confined to allowlisted hosts.
- Testing posture per `docs/spec-context.md`: **runtime_primary / e2e** — the
  benchmark corpus IS the quality gate; this deviates deliberately from the
  framework's static-gates-primary default and is pinned in spec-context.
- Stack decisions from the brief are final (Node 20+/TS/ESM/npm, ts-morph,
  Semgrep YAML, Zod, Vitest, pinned binaries in Dockerfile).
- Mobile capability: **N/A — pure backend/CLI, no UI surface.**

## 4. Staging-only safety contract (NON-NEGOTIABLE)

The live path is designed so that scanning a non-allowlisted host is
structurally impossible, not merely forbidden:

1. **Single chokepoint.** All live-scan target acquisition flows through
   `src/live/gate.ts → assertAllowlisted(url, allowlist)`. Scanner wrappers
   (ZAP, Nuclei, TLS/header probes) accept an `AllowedTarget` branded type that
   can ONLY be constructed by `assertAllowlisted`. No other module exports a
   constructor for it. TypeScript enforces at compile time that no scan
   function is callable with a raw URL/string.
2. **Allowlist semantics.** `config/allowed-staging-hosts.json` is a checked-in
   array of exact hostnames (no wildcards, no CIDR, no ports-only entries in
   v1). A URL is allowed iff `new URL(u).hostname` exactly matches an enabled
   entry. Anything else throws `AllowlistViolationError` **before any network
   I/O** — a hard abort, not a warning. An empty allowlist (the shipped
   default) means the live path can scan nothing.
3. **No override.** There is no CLI flag, env var, or config field that skips
   or extends the gate at runtime. Changing the allowlist requires a commit
   (PR-reviewed; CODEOWNERS: michaelhazza).
4. **Scope confinement.** ZAP context scope and Nuclei target list are set to
   exactly the allowlisted host under scan. Off-host redirects are not
   followed; discovered off-host links are recorded as
   `scope-excluded` metadata, never fetched.
5. **Rate-limited + identifiable.** Default 10 req/s/host (configurable lower
   per target, never higher than 25 — clamped in the Zod schema). The auditor
   User-Agent (above) is set on ZAP, Nuclei, and direct probes.
6. **Preflight / dry-run.** `audit scan-live --url <u> --dry-run` resolves the
   host, prints allowlist verdict + the check families that would run, and
   sends zero scan traffic. The non-dry-run path executes the same preflight
   function first; scan phases are unreachable unless preflight returned an
   `AllowedTarget`.
7. **Tested.** The benchmark suite asserts that a scan against a
   non-allowlisted host (a local server on a non-allowlisted hostname) aborts
   with `AllowlistViolationError` and that **zero** HTTP requests reached the
   server (the fixture server records hits). This test is part of the v1 exit
   conditions and may never be weakened or deleted.
8. **DNS note.** v1 gates on hostname, not resolved IP. Rebinding/IP-pinning
   hardening is a deferred item (§13) — acceptable because all targets are our
   own staging hosts and config is PR-reviewed.
9. **Allowlist provenance.** `src/config/load.ts` is the ONLY non-benchmark
   source of the allowlist, and it always reads
   `config/allowed-staging-hosts.json` (path constant, not parameterized). No
   CLI flag, env var, or config field may substitute an alternate allowlist
   file or array — parallel to §4.3's no-override rule for the gate itself.
   The sole exception is the benchmark harness: `benchmark/run.ts` may
   construct a benchmark-scoped allowlist containing only the local fixture
   host (§10), and the self-scan CI gate asserts no other module imports the
   gate with a non-`load.ts` allowlist source. [Added per claude-spec-review
   CR-002.]

## 5. Architecture (4 layers)

```
CLI (src/cli.ts: scan-source | scan-live | run | report)
 │
 ├── Layer 1 Scanner orchestration  src/static/   src/live/scanners/
 │     shell out to pinned binaries; parse native JSON output; normalize → Finding
 ├── Layer 2 Custom rule pack       src/static/rules/ (ts-morph)  rules/semgrep/*.yaml
 ├── Layer 3 Live scan engine       src/live/ (gate → preflight → probes/ZAP/Nuclei → normalize)
 └── Layer 4 Correlation + report   src/correlate/  src/report/
       fingerprint · severity · static↔live correlation · baseline · trend · JSON/MD/SARIF
```

Execution model: **inline/synchronous CLI process**. Scanner subprocesses run
concurrently per target (bounded pool, default 2 targets × N scanners), each
with a hard timeout (default 15 min/scanner, configurable). No queue, no DB —
all state is files. Reports are written atomically (write tmp + rename).

### 5.1 CLI surface

| Command | Behaviour |
|---|---|
| `audit scan-source [--repo <name>]` | Static scan of one or all registered repos → raw findings file per repo |
| `audit scan-live --url <staging-url> [--dry-run]` | Preflight (always); then passive + (if target opted in) active scan |
| `audit run [--repo <name>] [--url <staging-url>]` | scan-source + scan-live + correlate + report |
| `audit report [--format json\|md\|sarif]` | Re-emit report from the last run's findings (no scanning) |

CLI plumbing: `node:util` `parseArgs` (dependency-light per brief).

## 6. Contracts

All schemas are Zod (`src/schemas/`), each exporting a generated JSON Schema
(`npm run schemas` writes `schemas/*.schema.json`).

### 6.1 `Finding` (the shared findings format — produced by every scanner/rule, consumed by correlate/report/baseline)

```jsonc
{
  "id": "f-3f9a1c2b8d4e0a17",            // "f-" + first 16 hex of fingerprint (§6.6)
  "ruleId": "BS-SQL-001",                  // custom rule, wrapped-scanner map, or live check id
  "source": "ast",                         // "ast" | "semgrep" | "gitleaks" | "osv" | "zap" | "nuclei" | "probe"
  "surface": "static",                     // "static" | "live"
  "vulnClass": "injection",                // closed enum §6.7
  "severity": "high",                      // computed, §8 — "critical"|"high"|"medium"|"low"
  "baseSeverity": "high",                  // rule's intrinsic severity, pre-modifier
  "confidence": "confirmed",               // "confirmed" | "probable" | "tentative"
  "target": { "kind": "repo", "name": "automation-v1", "commit": "abc123…" },
  // live findings: { "kind": "staging", "host": "staging.acme.breakout.dev" }
  "location": {                            // static
    "path": "server/routes/users.ts",
    "symbol": "GET /api/users/:id",        // route or enclosing symbol — NOT line-keyed
    "startLine": 42                        // display only; excluded from fingerprint
  },
  // live location: { "url": "https://…/api/users/1", "parameter": "id", "method": "GET" }
  "evidence": { "snippet": "db.execute(sql`…${req.params.id}…`)", "cvss": null, "raw": {} },
  "reachability": "unauthenticated",       // "unauthenticated" | "authenticated" | "admin" | "unknown"
  "correlatedWith": [],                    // finding ids merged by §9
  "docs": "docs/rules/BS-SQL-001.md",
  "externalRefs": [],                      // reserved for issue-sync (post-v1)
  "firstSeen": "2026-06-12T00:00:00Z",
  "suppressed": false                      // true only when matched by a live (unexpired) baseline entry
}
```

Nullability: `evidence.cvss` null unless upstream provides one; `location`
fields are surface-specific (static vs live shapes are a discriminated union on
`target.kind`). Producer: layer 1–3 normalizers. Consumer: layer 4 + report.

### 6.2 `TargetRegistry` (`config/targets.json`)

```jsonc
{
  "repos": [{
    "name": "automation-v1",
    "gitUrl": "https://github.com/michaelhazza/automation-v1.git",
    "localPath": null,                     // optional; null → shallow clone-on-demand
    "stackTags": ["express", "drizzle-rls", "jwt", "react"],
    "publicRoutes": ["POST /api/auth/login", "GET /api/health"],  // BS-AUTH-001 allowlist
    "enabled": true
  }],
  "stagingTargets": [{
    "name": "automation-v1-staging",
    "url": "https://staging.automation.breakout.dev",
    "repo": "automation-v1",               // link for static↔live correlation (§9)
    "activeScan": false,                   // default false — passive + non-intrusive only
    "auth": { "kind": "form", "loginPath": "/api/auth/login",
              "userEnv": "AUDIT_STAGING_AUTOMATION_USER",
              "passEnv": "AUDIT_STAGING_AUTOMATION_PASS" },      // env NAMES, never values
    "rateLimitRps": 10,                    // clamped 1–25 by schema
    "enabled": false                       // shipped disabled until operator confirms
  }]
}
```

Producer: operator (PR-reviewed). Consumer: CLI + both scan engines.
Constraint: `stagingTargets[].url` host MUST also be on the allowlist —
validated at config load; violation is a config error (not a scan-time skip).
`auth.kind ∈ { "form" }` in v1 — closed set, same closure rule as `vulnClass`
(§6.7): adding a kind requires a spec amendment. [Per claude-spec-review CR-003.]

### 6.3 `Allowlist` (`config/allowed-staging-hosts.json`)

```jsonc
{ "hosts": [ { "host": "staging.automation.breakout.dev", "owner": "michaelhazza",
               "addedAt": "2026-06-12", "note": "automation-v1 staging" } ] }
```

Shipped EMPTY (`"hosts": []`). Consumer: `src/live/gate.ts` only.

### 6.4 `Baseline` (`config/baseline.json`)

```jsonc
{ "entries": [ {
    "findingId": "f-3f9a1c2b8d4e0a17",
    "justification": "test-only endpoint, removed in Q3 rewrite",   // required, non-empty
    "expiry": "2026-09-30",                                          // required ISO date
    "approvedBy": "michaelhazza"                                     // required handle
} ] }
```

Expired entries stop suppressing and the finding re-alerts at full severity
with `note: "baseline expired <date>"` in the report. Malformed entries
(missing any field) fail config load. Approval = PR review (CODEOWNERS).

### 6.5 `TrendHistory` (`history/trend.jsonl`, committed; one line per run)

```jsonc
{ "runId": "2026-06-12T03-00-00Z-7f3a", "date": "2026-06-12",
  "targets": { "automation-v1": { "new": 2, "fixed": 1, "persisting": 7,
               "bySeverity": { "critical": 0, "high": 3, "medium": 4, "low": 2 } } } }
```

Counts only — no finding bodies (full reports are CI artifacts, not committed).
Source-of-truth precedence: the run's `report.json` (artifact) is authoritative
for findings; `trend.jsonl` is derived counts; on disagreement, `report.json`
wins and the trend line is regenerated.

### 6.6 Fingerprint (stable finding identity)

```
static : sha256(ruleId | targetName | normalizedPath | symbol | normalizedSnippet)
live   : sha256(checkId | host | normalizedUrlPath | parameter | evidenceClass)
id     = "f-" + first 16 hex chars
```

- `normalizedPath`: repo-relative, posix separators.
- `symbol`: route signature (`GET /api/users/:id`) or enclosing
  function/class name — survives line drift and re-ordering.
- `normalizedSnippet`: matched code with whitespace collapsed — survives
  reformatting. Line numbers and request ordering are EXCLUDED by design.
- `normalizedUrlPath`: path with numeric/uuid segments → `{id}` so volatile
  record ids don't fork fingerprints.
- Collision handling: identical fingerprints in one run merge into one finding
  with multiple locations listed in `evidence.raw.occurrences`.

### 6.7 `vulnClass` closed enum

`injection · auth-access-control · tenant-isolation · secrets · dependency-cve ·
misconfiguration · xss · csrf · open-redirect · info-disclosure · tls ·
session-management`

Adding a value requires a spec amendment (closed-set rule, checklist §10.7).

## 7. Rule and check inventory (v1)

### 7.1 Custom static rule pack (the differentiated layer)

| ID | Engine | Base sev | What it flags |
|---|---|---|---|
| BS-RLS-001 | ts-morph | critical | Drizzle table with tenant column (`organisationId`/`subaccountId` et al.) but no RLS policy in migrations (schema↔migration join) |
| BS-SQL-001 | ts-morph | critical | `` sql`…` `` / `db.execute` interpolating request-derived values (taint walk from `req.*`/route params) |
| BS-SQL-002 | ts-morph | high | Queries on tenant tables bypassing the scoped query helpers |
| BS-AUTH-001 | ts-morph | high | Express route mounted without auth/permission middleware (per-repo `publicRoutes` allowlist) |
| BS-AUTH-002 | semgrep | medium | Auth endpoints (`/login`, `/register`, `/reset`…) without rate-limit middleware |
| BS-JWT-001 | semgrep | high | JWT config: algorithm not pinned, no expiry, or secret literal instead of env |
| BS-UPLOAD-001 | semgrep | medium | multer route without file-size limit or type filter |
| BS-XSS-001 | ts-morph | high | User-supplied HTML rendered/stored without `sanitize-html` |
| BS-CORS-001 | semgrep | high | CORS wildcard or reflected-origin in production code paths |
| BS-WS-001 | ts-morph | high | socket.io handlers registered without the auth handshake middleware |
| BS-VAL-001 | ts-morph | medium | Route handler reading `body`/`query`/`params` with no Zod parse at the boundary |

Engine choice rule: Semgrep YAML where the pattern is syntactic/local;
ts-morph where it needs cross-file analysis (schema↔migration joins,
middleware-chain walks, taint from request objects). 11 rules at v1; the pack
is expected to grow post-v1 (experiment-runner loops, per brief).

### 7.2 Wrapped static scanners

| Wrapper | Binary (pinned in Dockerfile) | Maps to vulnClass |
|---|---|---|
| `src/static/scanners/semgrep.ts` | semgrep (also runs `p/owasp-top-ten` curated subset + our YAML) | injection, misconfiguration, xss |
| `src/static/scanners/gitleaks.ts` | gitleaks | secrets |
| `src/static/scanners/osv.ts` | osv-scanner | dependency-cve |

### 7.3 Live checks

**Passive family** (always run for enabled staging targets):
TLS/cert config + protocol versions (direct probe), security headers presence
and correctness (probe), cookie flags HttpOnly/Secure/SameSite (probe),
exposed debug/admin/source-map endpoints (Nuclei templates + curated path
list), server/framework version leakage (probe + Nuclei), error-message info
disclosure (ZAP passive), known-CVE fingerprinting (Nuclei).

**Active family** (only when target has `activeScan: true`):
ZAP active scan (reflected/stored XSS, SQL/command injection probing, CSRF,
open redirect) + Nuclei fuzzing templates + auth/session weakness checks +
IDOR/access-control via authenticated crawl (two test users, cross-access
probe), using the target's `auth` config (§6.2).

Each check family gets a stable `checkId` (`LIVE-TLS-001`, `LIVE-HDR-001`,
`LIVE-COOKIE-001`, `LIVE-EXPOSE-001`, `LIVE-LEAK-001`, `ZAP-P-*`, `ZAP-A-*`,
`NUCLEI-*`, `LIVE-IDOR-001`, `LIVE-SESSION-001`) and a doc page, same as
static rules.

## 8. Severity model (exploitability-aware)

### 8.1 Modifier order (applied to `baseSeverity`)

Start from `baseSeverity` (rule/check intrinsic), then apply these modifiers
in the listed order, clamped to the `critical…low` scale:

1. **Live-confirmed:** static finding correlated with a live finding (§9) →
   +1 step, `confidence: "confirmed"`.
2. **Reachability bump:** `reachability: "unauthenticated"` → +1 step.
3. **Reachability demotion:** `reachability: "admin"` → −1 step.
4. **Floor:** `vulnClass ∈ {secrets, injection, tenant-isolation}` never drops
   below `high` regardless of demotion.

Report ordering: severity desc → confidence (confirmed > probable > tentative)
→ vulnClass criticality (tenant-isolation first) → target name. CVSS from
upstream scanners is carried in `evidence.cvss` as metadata only.

## 9. Static↔live correlation

Two findings correlate when ALL of:
1. Targets are linked (`stagingTargets[].repo` ↔ repo name).
2. Same `vulnClass`.
3. Location match: static `symbol` route signature ≈ live `normalizedUrlPath`
   + method (path-param-aware comparison, e.g. `GET /api/users/:id` ≈
   `GET /api/users/{id}`).

Correlated pairs merge into the static finding (it carries the fix location);
the live finding's id is appended to `correlatedWith`, severity recomputed
(§8.1), and the report renders one entry with both evidence blocks. Dedupe is
deterministic: process findings sorted by id so run order can't change output.

## 10. Benchmark corpus + quality gates (definition of done)

```
benchmark/
  corpus/static/<RULE-ID>/vulnerable/   seeded mini-app slice, documented vuln(s) in EXPECTED.json
  corpus/static/<RULE-ID>/clean/        the known-clean equivalent (must yield zero findings)
  live-fixture/                         purpose-built vulnerable Express app (containerized)
  live-fixture/EXPECTED.json            seeded live vulns per check family
  run.ts                                the harness behind `npm run benchmark`
```

- **Every rule AND every live check lands with both a known-bad and a
  known-good fixture. CI fails any rule/check without them** (the harness
  cross-checks rule inventory vs corpus directories).
- Live benchmark scans ONLY the local fixture container (its hostname is
  injected into a benchmark-scoped allowlist file — the shipped
  `config/allowed-staging-hosts.json` is untouched), plus the safety-contract
  abort test (§4.7).
- Purpose-built fixture app over Juice Shop: it mirrors OUR stack (Express +
  Drizzle + JWT + socket.io) so live checks exercise realistic surfaces, and
  it stays minimal/deterministic for CI. Juice Shop rejected: Angular/SQLite
  stack, slow boot, nondeterministic for recall accounting.
- Output: recall (target 100% on corpus) + precision (0 FPs on clean
  fixtures), per rule and aggregate; non-zero exit on any miss. False
  positives are bugs equal in severity to missed detections.
- New rules enter test-first: seed fixture, then write the rule.
- **Self-scan gate:** CI statically scans this repo itself and must be clean;
  `benchmark/corpus/**` and `benchmark/live-fixture/**` are excluded via the
  self-scan config (they are intentionally vulnerable by design — exclusion
  pinned here, not ad-hoc).

## 11. File inventory (lock)

| Path | Purpose |
|---|---|
| `src/cli.ts` | entry; parseArgs; subcommands §5.1 |
| `src/schemas/finding.ts`, `targets.ts`, `allowlist.ts`, `baseline.ts`, `trend.ts` | Zod contracts §6 |
| `src/schemas/generate.ts` | `npm run schemas` → `schemas/*.schema.json` |
| `src/config/load.ts` | load + validate config trio; cross-checks §6.2 constraint |
| `src/static/orchestrator.ts` | repo acquisition (localPath/clone), scanner fan-out |
| `src/static/scanners/{semgrep,gitleaks,osv}.ts` | wrappers + normalizers |
| `src/static/rules/*.ts` (7 ts-morph rules per §7.1) | custom AST rules |
| `rules/semgrep/*.yaml` (4 rules per §7.1) | custom Semgrep rules |
| `src/live/gate.ts` | `assertAllowlisted` + `AllowedTarget` brand (§4.1) |
| `src/live/preflight.ts` | dry-run + mandatory preflight |
| `src/live/scanners/{zap,nuclei}.ts`, `src/live/probes/{tls,headers,cookies,exposure}.ts` | live engine |
| `src/correlate/{fingerprint,severity,correlate}.ts` | layer 4 core |
| `src/report/{json,markdown,sarif,trend,baseline}.ts` | outputs |
| `config/{targets,allowed-staging-hosts,baseline}.json` | checked-in registries (shipped: 1 repo enabled, 0 staging enabled, empty allowlist, empty baseline) |
| `history/trend.jsonl` | committed trend lines §6.5 |
| `benchmark/**` | §10 |
| `docs/rules/<ID>.md` (one per rule/check) | id, rationale, fix guidance + code example, fixture links |
| `Dockerfile` | pinned scanner binaries (exact versions) |
| `.github/workflows/ci.yml` | lint, typecheck, test:unit, benchmark, self-scan on PR |
| `.github/workflows/weekly-audit.yml` | scheduled portfolio run in the GHCR image |
| `CODEOWNERS` | `config/*` → michaelhazza |

Tests colocate as `*.test.ts` beside each module (Vitest). No DB, no
migrations, no tenant-scoped tables → checklist §4 (RLS) N/A for this repo;
RLS appears only as the SUBJECT of rules.

## 12. Build phasing (dependency-ordered)

| Phase | Ships | Depends on |
|---|---|---|
| P1 | schemas + config loading + fingerprint + CLI skeleton (`--help`, config validation) | — |
| P2 | static orchestration: clone/localPath + 3 wrapper scanners + normalizers | P1 |
| P3 | custom rule pack (11 rules) + their corpus fixtures (test-first) | P1, P2 (semgrep runner) |
| P4 | live engine: gate + preflight/dry-run FIRST, then probes, ZAP, Nuclei wrappers + live fixture app + safety-contract test | P1 |
| P5 | correlation + severity + report (JSON/MD/SARIF) + baseline + trend | P2–P4 |
| P6 | benchmark harness + Dockerfile + CI workflows + self-scan gate + rule docs sweep | P1–P5 |

No backward references: each phase consumes only earlier phases' outputs.
The v1 exit loop (post-G2, per launch prompt) runs after P6: benchmark + gates
+ self-scan, max 10 iterations, stuck-rule = stop after 2 identical failures,
exit conditions immutable.

## 13. Deferred items

- **DNS-resolution / IP-pinning hardening on the allowlist gate.** v1 gates on exact hostname (§4.8). Reason: targets are our own PR-reviewed staging hosts; rebinding defense adds complexity v1 doesn't need.
- **GitHub issue-sync.** Schema reserves `externalRefs`. Reason: brief defers to post-v1.
- **Wildcard/CIDR allowlist entries.** Exact hostnames only in v1. Reason: keeps the gate trivially auditable.
- **Stored-XSS deep flows in live fixture.** v1 fixture seeds reflected XSS + a simple stored case; complex multi-step stored flows deferred. Reason: corpus cost; recall target applies to seeded cases.
- **Scan-record cleanup automation for staging.** v1: owner-attested cleanup per `activeScan` opt-in (grill Q8). Reason: cleanup is target-app-specific.
- **Per-rule semgrep→ts-morph migrations** where Semgrep proves too coarse. Reason: post-v1 experiment-runner loops own precision tuning.

## 14. Execution-safety contracts

- **Idempotency:** report writes are state-based — atomic tmp+rename per
  output file; re-running a scan overwrites deterministically (sorted
  findings, stable fingerprints). Trend append is key-based on `runId`
  (re-running the same runId replaces the line, no duplicates).
- **Retry classification:** scanner subprocesses are `safe` to retry (read-only
  against repos; live scans re-send traffic but only to allowlisted staging —
  acceptable by contract). Git clone is `safe` (fresh temp dir per attempt).
- **Concurrency:** single-process CLI; concurrent runs on the same workspace
  are unsupported and guarded by a `reports/.lock` file (stale after 2h);
  losing caller exits with a named error.
- **Terminal event:** every `audit run` ends with exactly one run-summary
  record (stdout + `report.json.meta.status`): `success` (all scanners ran) |
  `partial` (≥1 scanner failed/timed out — named per scanner in
  `meta.failures`, never silent) | `failed` (config invalid, allowlist
  violation, or no scanner completed). Exit codes: 0 / 2 / 1 respectively;
  findings presence does NOT affect exit code of `run` (reporting tool, not a
  gate) — `--fail-on <severity>` opts into gating (used by self-scan CI).
- **State machine (live path):** `idle → preflight → gated(allowed) → passive →
  [active] → normalize → done`, with `gated(denied) → abort` terminal.
  Forbidden: any transition into `passive`/`active` not from
  `gated(allowed)` — unrepresentable via the `AllowedTarget` brand (§4.1).
  Status set is closed; additions require spec amendment.
- No DB, no HTTP writes to external systems (checklist §10.6/§10.8 N/A — no
  unique constraints, no DB-then-HTTP flows).

## 15. Self-consistency + count reconciliation

- 11 custom rules (§7.1) = 7 ts-morph + 4 semgrep = file inventory rows (§11). ✓
- 3 wrapped static scanners (§7.2) = 3 wrapper files (§11). ✓
- 4 CLI commands (§5.1) = brief's operating model. ✓
- 3 checked-in config files (§6.2–6.4) = inventory row. ✓
- 6 build phases (§12); 2 CI workflows (§11). ✓
- Goals ↔ implementation: every §1 goal maps to §5–§10 sections; safety
  contract (§4) enforced by named mechanisms (brand type, single chokepoint,
  empty-allowlist default, abort test). Every "must" has a mechanism.

## 16. Open questions (for Phase 2)

- Exact pinned versions for the 5 binaries (resolve at P6 Dockerfile authoring; record in `KNOWLEDGE.md`).
- ZAP orchestration mode: daemon API vs `zap-baseline.py`/automation-framework YAML (builder decides at P4 behind the wrapper interface; wrapper contract in §7.3 is fixed either way).
- Whether `automation-v1` staging gets `activeScan: true` at launch (operator call — shipped `false`).

---

*Authoring rubric: `docs/spec-authoring-checklist.md` (sections 0–13 applied;
§0 N/A — greenfield; §4 RLS N/A — no DB; §13 mobile N/A — no UI). Framing per
`docs/spec-context.md` (runtime_primary, e2e benchmark as primary gate).*
