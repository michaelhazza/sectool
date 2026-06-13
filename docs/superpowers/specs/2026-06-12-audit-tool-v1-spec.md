# Spec — audit-tool v1: internal security audit tool (SAST + staging-only DAST)

**Status:** accepted (amended 2026-06-12: operator-directed UI addendum, §5.2 dashboard + HTML export, P7; amended 2026-06-13: operator-directed remediation workflow §5.3 + P8 and plain-language-first UI vocabulary §5.2; screen shapes approved via the mockup loop — CLEAN after 3 rounds, locked in `prototypes/audit-tool-v1/`)
**Spec date:** 2026-06-12
**Last updated:** 2026-06-13
**Author:** claude (spec-coordinator, autonomous session; operator: michaelhazza)
**Build slug:** audit-tool-v1

## Lifecycle Declaration

| Field | Value |
|---|---|
| Capability cluster | Static Scanning, Live Scanning, Correlation & Reporting, Report UI, Remediation Orchestration, Target Registry & Safety, Benchmark & Quality |
| Capability owner | michaelhazza |
| Lifecycle state on launch | Inception |
| Risk surface | Controlled live HTTP traffic to Breakout-owned staging hosts (allowlist-gated, §4); read-only access to source repos; CI artifacts containing security findings; localhost-bound dashboard serving findings data (127.0.0.1 only, §5.2); GitHub `issues:write` to Breakout-owned target repos for fix requests (fine-grained token, never code-write, §5.3). |
| Review cadence | quarterly (plus the post-v1 "what classes are we not scanning for" human review from the brief) |

> Risk-surface note: the §7.1.1 vocabulary enumerates target-app surfaces that
> do not exist in this repo, so the declaration above uses descriptive prose
> instead (operator decision, review of 2026-06-12 — "None." understated the
> governance posture for a security scanning tool). The highest-stakes
> surface — live traffic to staging hosts — is governed by §4.

## ABCd Lifecycle Estimate

| Dimension | Sizing | Notes |
|---|---|---|
| Acquire | L | Commercial portfolio SAST+DAST (e.g. Snyk + Burp Enterprise) is expensive and still wouldn't know our RLS/scoped-helper conventions — the custom rule pack is the differentiator. |
| Build | L | Six subsystems (incl. dashboard UI, §5.2) + benchmark corpus + safety contract; the corpus (one bad + one good fixture per rule/check) is the dominant cost. |
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
6. **World-class report UI** — `audit ui` serves a local-first dashboard
   (charts, trends, per-run drill-down to finding detail with evidence and fix
   guidance) over the same report files, plus a self-contained HTML report
   export for sharing CI artifacts. Localhost-bound; plain-language-first for
   a non-technical operator (§5.2). [Operator amendment 2026-06-12.]
7. **Close the loop on fixes** — every finding carries a one-click path from
   "found" to "verifiably fixed": the tool generates a remediation pack and
   files it as a fix request in the target repo, repo-local Claude Code
   implements it behind that repo's tests and PR review, and the next scan
   verifies the fix by fingerprint (§5.3). The audit tool orchestrates fixes;
   it never edits target-repo code itself. [Operator amendment 2026-06-13.]

## 2. Non-goals

- Generic SAST/DAST product. Internal use against Breakout-owned assets only.
- Scanning production — ever. No code path exists for it (§4).
- Direct code edits or PR generation by the audit tool against target repos.
  The tool stays read-only on code; remediation is orchestrated via fix-request
  issues executed by repo-local Claude Code (§5.3). [Amended 2026-06-13: the
  original blanket "no auto-remediation, no issue creation" non-goal is
  rescoped — fix-request issue creation + fix tracking are now in scope (v1
  uses `Finding.externalRefs` as designed); code-writing by this tool remains
  out of scope.]
- Hosted / multi-user SaaS dashboard. The v1 UI is a local-first, read-only
  dashboard (`audit ui`, §5.2) rendering the same file-based state; report
  files remain the canonical artifacts. [Amended 2026-06-12 — the prior
  blanket "no dashboard" non-goal was reversed by operator direction; the
  non-goal now scopes to *hosted/multi-user* only.]
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
  Semgrep YAML, Zod, Vitest, pinned binaries in Dockerfile). UI addendum
  stack: React 18 + Vite + TypeScript SPA, Recharts for charts (§5.2).
- Mobile capability: **responsive web UI, desktop-first dashboard; every
  screen usable at 375px** per `docs/mobile-capability-principles.md`.
  [Amended 2026-06-12 — was "N/A, no UI surface" before the UI addendum.]

## 4. Staging-only safety contract (NON-NEGOTIABLE)

The live path is designed so that scanning a non-allowlisted host is
structurally impossible, not merely forbidden:

1. **Single chokepoint.** All live-scan target acquisition flows through
   `src/live/gate.ts → assertAllowlisted(url, allowlist)`. Scanner wrappers
   (ZAP, Nuclei, TLS/header probes) accept an `AllowedTarget` branded type that
   can ONLY be constructed by `assertAllowlisted`. No other module exports a
   constructor for it. TypeScript enforces at compile time that no scan
   function is callable with a raw URL/string.
2. **Allowlist semantics.** `config/allowed-staging-hosts.json` is the checked-in
   `Allowlist` object of §6.3 — `{ hosts: [{ host, owner, addedAt, note }] }` —
   whose `host` values are exact hostnames (no wildcards, no CIDR, no ports-only
   entries in v1); §6.3 is the canonical schema and `LoadedAllowlist` (§4.10)
   brands a parse of exactly that shape. A URL is allowed iff ALL of: (a) `new URL(u).protocol === "https:"`
   (plaintext `http:` and every other scheme are rejected — staging is
   TLS-only); (b) `new URL(u).hostname` exactly matches an enabled entry; and
   (c) the URL targets the default https port — `new URL(u).port` is empty or
   `"443"` (a non-default port denotes a different service on the same host and
   is rejected in v1; per-entry non-default ports are a deferred item, §13); and
   (d) **the hostname is a DNS name, not an IP literal** — any URL whose
   `new URL(u).hostname` parses as an IPv4 literal (dotted-decimal AND
   Node-accepted numeric/octal/hex forms, e.g. `2130706433`, `0x7f000001`) or an
   IPv6 literal (bracketed, e.g. `[::1]`, `[::ffff:127.0.0.1]`) is rejected
   outright in the **production** gate. Allowlist `host` entries are likewise
   constrained to DNS names by the §6.3 schema (no IP-literal entries), so the
   exact-match in (b) can never match an IP literal anyway; clause (d) closes
   the parser-quirk path where a numeric/octal/hex IPv4 or bracketed IPv6 string
   could otherwise slip through string comparison. (Loopback IP literals are
   permitted ONLY via `loadBenchmarkAllowlist()` (§4.10), never the production
   loader — the benchmark allowlist is the sole IP-literal-bearing path and is
   schema-restricted to `127.0.0.1` / `localhost` / `*.localhost`.) [IP-literal
   rejection per chatgpt-spec-review OAI-SPEC-006 — a *strengthening* of the §4
   contract, never a relaxation.]
   Anything else throws `AllowlistViolationError` **before any network I/O** —
   a hard abort, not a warning. An empty allowlist (the shipped default) means
   the live path can scan nothing.
3. **No override.** There is no CLI flag, env var, or config field that skips
   or extends the gate at runtime. Changing the allowlist requires a commit
   (PR-reviewed; CODEOWNERS: michaelhazza).
4. **Scope confinement.** ZAP context scope and Nuclei target list are set to
   exactly the allowlisted host under scan. Off-host redirects are not
   followed; discovered off-host links are recorded as
   `scope-excluded` metadata, never fetched.
5. **Rate-limited + identifiable.** Default 10 req/s/host (configurable lower
   per target, never higher than 25 — clamped in the Zod schema). The limit is
   **aggregate per host across ALL live scanner families**, not per family.
   Because scanner subprocesses can run concurrently (§5), the live engine
   serializes request-generating families against any single host — no two of
   {ZAP, Nuclei, direct probes} hit the same host at once — and passes the
   per-host rate to each, so the host never observes more than `rateLimitRps`
   in aggregate. (Distinct hosts may still be scanned in parallel; the limit is
   strictly per host.) The auditor User-Agent (above) is set on ZAP, Nuclei,
   and direct probes. Acceptance: a guardrail test with two fake scanner
   families against one host asserts the combined observed request rate never
   exceeds the host limit. [Aggregate-per-host invariant pinned per external
   review HIGH-2.]
6. **Preflight / dry-run.** `audit scan-live --url <u> --dry-run` parses the
   URL and calls `assertAllowlisted()` FIRST — before any DNS resolution or
   other network operation — then prints the allowlist verdict + the check
   families that would run, and sends zero scan traffic. A denied host prints
   its deny verdict with NO DNS lookup: denial is a pure parse/string decision
   (§4.2, §4.8 gates on hostname, never a resolved IP), never a network
   round-trip. The non-dry-run path executes the same preflight function first;
   the scan phases — and the registry/DNS resolution they need — are
   unreachable unless preflight returned an `AllowedTarget`. Acceptance: a
   denied-host dry-run asserts zero DNS resolver calls and zero HTTP requests.
   [Preflight-before-DNS ordering pinned per external review HIGH-1.]
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
10. **Branded `LoadedAllowlist`.** `assertAllowlisted` accepts only a branded
    `LoadedAllowlist` type (not raw arrays), mintable solely inside
    `src/config/load.ts` via two functions: `loadAllowlist()` (production —
    fixed path per §4.9) and `loadBenchmarkAllowlist()` (fixed path
    `benchmark/allowlist.benchmark.json`, schema-restricted to loopback hosts:
    `127.0.0.1` / `localhost` / `*.localhost` only). Normal callers cannot
    hand the gate an arbitrary allowlist without going through `load.ts`, and
    the benchmark path structurally cannot allowlist a non-loopback host.
    [Per operator review, non-blocking note — strengthens §4.9.]

## 5. Architecture (6 layers)

```
CLI (src/cli.ts: scan-source | scan-live | run | report | ui | fix)
 │
 ├── Layer 1 Scanner orchestration  src/static/   src/live/scanners/
 │     shell out to pinned binaries; parse native JSON output; normalize → Finding
 ├── Layer 2 Custom rule pack       src/static/rules/ (ts-morph)  rules/semgrep/*.yaml
 ├── Layer 3 Live scan engine       src/live/ (gate → preflight → probes/ZAP/Nuclei → normalize)
 ├── Layer 4 Correlation + report   src/correlate/  src/report/
 │     fingerprint · severity · static↔live correlation · baseline · trend · JSON/MD/SARIF/HTML
 ├── Layer 5 Report dashboard UI    src/ui/ (localhost server)  ui/ (React SPA)
 │     renderer over reports/ + history/trend.jsonl + config/ + reports/fixes.json (§5.2)
 └── Layer 6 Remediation orchestration  src/fix/
       remediation pack · fix-request issue (GitHub) · status tracking · re-scan verification (§5.3)
```

Execution model: **inline/synchronous CLI process**. Scanner subprocesses run
concurrently per target (bounded pool, default 2 targets × N scanners), each
with a hard timeout (default 15 min/scanner). These two values are surfaced as
CLI flags on `run`/`scan-source`/`scan-live` — `--scanner-timeout <minutes>`
(default 15) and `--max-parallel-targets <n>` (default 2) — they are NOT config
fields and have no `config/*.json` home in v1 (operator overrides them per
invocation; CI uses the defaults). No queue, no DB — all state is files. Reports
are written atomically (write tmp + rename).
Exception: `audit ui` is a long-running localhost server process (§5.2); it
reads scan state and config read-only and cannot initiate scans. Its one
non-read action is the §5.3 "Send for fixing" fix-request issue (which also
appends to `reports/fixes.json`); it writes no scan results, no config, and no
target-repo code. The §4 safety contract is anchored on the no-live-engine-
import + `issues:write`-only properties (§5.2), not on a blanket no-write rule.

### 5.1 CLI surface

| Command | Behaviour |
|---|---|
| `audit scan-source [--repo <name>]` | Static scan of one or all registered repos → normalized findings file per repo. The file is **redaction-passed** (§5.4): native scanner output (gitleaks/Semgrep JSON, stdout, stderr) is captured and redacted at the normalizer boundary, then written — it is never persisted verbatim. |
| `audit scan-live --url <staging-url> [--dry-run]` | Preflight (always); then passive + (if target opted in) active scan. **Target resolution (registry-required in v1):** the URL's host must (a) pass the §4 allowlist gate AND (b) resolve by host to an `enabled: true` `stagingTargets[]` entry (§6.2), which supplies `activeScan`/`auth`/`repo`/`rateLimitRps`. Both must hold: a host that fails the allowlist gate is a hard `AllowlistViolationError` (§4.2); a host that passes the gate but has no enabled registry entry is a **named config error** (`UnregisteredTargetError`), not an ad-hoc scan — ad-hoc allowlist-only scanning of unregistered hosts is NOT a v1 feature (deferred, §13), so §7.3's "enabled staging targets" and `RunReport.targets[]` (§6.9) always have a registry-backed identity with repo linkage. |
| `audit run [--repo <name>] [--url <staging-url>]` | scan-source + scan-live + correlate + report |
| `audit report [--format json\|md\|sarif\|html]` | Re-emit report from the last run's findings (no scanning); `html` is the self-contained single-file export (§5.2) |
| `audit ui [--port <n>]` | Serve the local dashboard on `127.0.0.1` (default port 4173); no scan capability; sole outward action is the §5.3 fix request |
| `audit fix (<finding-ref> \| --min-severity <s>) [--dry-run]` | File fix-request issue(s) in the target repo (§5.3). `<finding-ref>` files exactly one finding; `--min-severity <s>` bulk-files every not-yet-filed finding at or above severity `s`, **excluding `suppressed: true` findings** — accepted/acknowledged risks (PR-approved baseline, §6.4) are never bulk-filed; a suppressed finding can be filed only by explicit `<finding-ref>` selection (no `--include-suppressed` in v1). `<finding-ref>` is the full 64-hex `fingerprint` OR a display id (`f-<16hex>`) that resolves to exactly one finding in the selected report — an ambiguous prefix fails with `AmbiguousFindingIdError` listing the matching full fingerprints. All filing + idempotency key by the full `fingerprint`, never the display id (§6.6). `--dry-run` prints the pack(s) without filing. There is no per-finding severity override (severity is computed, §8). |

CLI plumbing: `node:util` `parseArgs` (dependency-light per brief).

### 5.2 Report dashboard UI (operator amendment 2026-06-12)

The dashboard is a **renderer, not a controller**: it visualizes what the CLI
produced and holds no state of its own.

**Primary persona: non-technical operator (founder/CEO).** Plain English is
the PRIMARY vocabulary on every surface; technical identifiers (rule IDs,
enum values, fingerprints, scanner names) are secondary text or tooltips,
never the headline. Every screen leads with "what does this mean and what
should I do", not "what did the scanner emit". Severity reads as plain risk
language ("Fix now" / "Fix soon" / "Plan it" / "Low risk" alongside the
critical…low tokens). [Operator amendment 2026-06-13 — supersedes the earlier
engineer-audience assumption.]

- **Process + binding.** `audit ui` serves a pre-built React 18 + Vite +
  TypeScript SPA (source in `ui/`, built assets shipped with the package) from
  a dependency-light `node:http` server (`src/ui/server.ts`) bound to
  `127.0.0.1` only — never `0.0.0.0`, no remote or multi-user mode in v1
  (non-goal, §2). The server exposes read-only JSON endpoints over the same
  file state the CLI writes: `reports/` (run reports), `history/trend.jsonl`,
  and the `config/` trio.
- **Read-only on scan state and config; ONE outward action.** The UI triggers
  no scans and edits no config or code. Config changes and baseline approvals
  remain PR-reviewed (§4.3, §6.4); the finding-detail screen offers a "copy
  baseline entry JSON" affordance instead of in-app editing. The §4 safety
  contract is structurally unaffected: no UI code path imports the live
  engine. The sole outward *network* action is **"Send for fixing"** on a
  finding, which invokes the same code path as `audit fix` (§5.3) — it files a
  fix-request issue (GitHub `issues:write`); it cannot write code. The other
  UI affordances ("copy baseline entry JSON", "copy fix instructions") are
  local clipboard writes only — they reach no network and no live engine. The
  §4 contract is therefore anchored on the no-live-engine-import +
  `issues:write`-only (never `contents:write`) properties, not on action count.
  [Amended 2026-06-13; was fully read-only.]
- **Fix-request endpoint hardening (CSRF/origin, P8).** The single mutating
  route (the "Send for fixing" POST) is CSRF- and origin-protected because it
  spends the `issues:write` token. `audit ui` mints a per-process
  `X-Audit-CSRF` nonce at startup and serves it only to the same-origin SPA;
  the POST handler rejects — HTTP 403, **without** calling `src/fix/github.ts` —
  any request that is missing/has the wrong nonce, OR whose `Origin` is not
  `http://127.0.0.1:<port>`. The server never emits
  `Access-Control-Allow-Origin: *`. Loopback binding alone is NOT treated as
  sufficient: a page open in the operator's browser can still drive a
  cross-origin POST to `127.0.0.1`, so the nonce + same-origin check is the
  real guard. Acceptance: cases in `src/ui/server.test.ts`. [Operator-approved
  2026-06-13, OAI-SPEC-004.]
- **Charts:** Recharts. **Visual language:** one consistent set of severity
  color tokens (critical/high/medium/low) and run-status tokens
  (success/partial/failed) across every screen and the HTML export; partial
  runs are never visually conflated with success (§6.5 masquerade rule applies
  to pixels, not just counts).
- **HTML export.** `audit report --format html` (`src/report/html.ts`) emits a
  self-contained single-file report — inline CSS/JS/SVG charts, zero network
  dependencies — with the same visual language, so CI artifacts are shareable
  without running the dashboard. **Evidence-content safety:** all finding
  evidence (source snippets, live response bodies, headers, URLs) is
  HTML-entity-escaped and rendered as inert text — never injected as markup or
  executed. The inline `<script>` is a fixed, build-time chart renderer that
  consumes only a JSON data island (itself escaped via `</script>`-safe
  encoding); there is no `eval`, no `innerHTML` of evidence, and no
  evidence-derived script. **The inert-text rule covers every DOM carrier, not
  just `<script>`:** evidence is escaped and confined to a visible text
  container, and is NEVER emitted into a `<style>`, `<template>`, `<meta>`,
  `<link>`, HTML comment, attribute value (including `aria-*`/`data-*`/`href`/
  `src`/event-handler attributes), `<input type="hidden">`, or any
  hidden/off-viewport subtree (`display:none`, `visibility:hidden`,
  `aria-hidden`, off-screen absolute/fixed positioning). The acceptance contract
  exercises this matrix (§10 references it) so a future implementation cannot
  pass a bare `<script>`-escaping check while still leaking attacker-controlled
  evidence through a non-visible carrier that browsers or assistive tooling
  still process. This is a security tool emitting attacker-controlled
  strings, so the export must not become an XSS vector in whatever browser opens
  the artifact. [Non-visible-carrier coverage per chatgpt-spec-review OAI-SPEC-007.]
- **Mobile:** responsive, desktop-first; all screens usable at 375px (§3).

**Screens (6).** Final shapes are the **approved prototypes** in
`prototypes/audit-tool-v1/` (mockup loop returned CLEAN after 3 rounds — see
`tasks/builds/audit-tool-v1/mockup-log.md` and the round-1..3 review logs in
the same directory). The build implements these shapes in React; the
prototypes are the reference rendering and the plain-language source of truth:

| Screen | Prototype file | Renders |
|---|---|---|
| Portfolio overview | `index.html` | Latest-run status banner (success/partial/failed with named failures per §14), severity totals, per-target health cards, new/fixed/persisting deltas, trend sparkline |
| Run report | `run-report.html` | Findings table in §8.1 report order with filters (severity, vulnClass, target, surface, confidence, suppressed); severity/class/target distribution charts; run metadata |
| Finding detail | `finding-detail.html` | Plain-English problem statement first; evidence snippet(s) (collapsed by default), correlated static+live evidence pair (§9), severity computation breakdown (base + each §8.1 modifier applied), fix guidance from the rule doc (§11), fingerprint/firstSeen, baseline-draft copy affordance, **"Send for fixing" action + fix status** (§5.3) |
| Fixes | `fixes.html` | Remediation pipeline from `reports/fixes.json` (§5.3): every fix request with status (requested → in progress → awaiting review → merged, awaiting verification → verified fixed / reopened), links to the repo issue/PR, verified-fix count over time |
| Trends | `trends.html` | Time series from `trend.jsonl` (new/fixed/persisting and severity mix over time, per target), run history list, explicit `unknown` rendering for incomplete scanner-family dims (§6.5) |
| Targets & safety | `targets.html` | Read-only registry view (repos, staging targets, activeScan flags), allowlist contents incl. empty-state, baseline entries with expiry countdowns and expired re-alert state (§6.4) |

`prototypes/audit-tool-v1/mobile-preview.html` is a desktop-only design utility
(phone-frame gallery for reviewing the responsive shapes side by side), not a
product screen and not part of the build.

**Plain-language vocabulary (normative).** The build matches these operator-facing
labels in all default-visible copy; the prototypes are the reference rendering:

| Internal term | Operator-facing label |
|---|---|
| static / SAST surface | "In the code" |
| live / DAST surface | "On the live test site" |
| severity critical / high / medium / low | "Fix now" / "Fix soon" / "Plan it" / "Low risk" (technical word kept as a sub-label) |
| baseline entry / suppressed finding | "Acknowledged risk" / "accepted risk" |
| allowlist | "Approved test sites" |
| partial run | "Some checks did not finish" (plain headline; failed scanner names in the detail line) |
| rule IDs, fingerprints, scanner names (Semgrep / ZAP / Nuclei / osv-scanner / gitleaks) | secondary monospace sub-line or collapsible "Technical details" — never a headline |

Screen titles use operator language: "Portfolio Overview", "What Needs Fixing"
(Run report), "Fix Progress" (Fixes), "Progress Over Time" (Trends), "Sites and
Safety" (Targets & safety). Finding titles lead with the business consequence,
not the rule name. Raw code/evidence blocks default collapsed.

### 5.3 Remediation workflow (operator amendment 2026-06-13)

**Decision: detect here, fix there.** The audit tool orchestrates remediation
but never edits target-repo code. Actual fixes are implemented by **Claude
Code running in the target repo** (every Breakout repo carries the claude
framework), behind that repo's own tests, CI gates, and human PR review.
Rationale, pinned: (1) correct fixes need repo-local context — conventions,
scoped helpers, test suites — that a portfolio scanner doesn't have; (2) the
tool's read-only-on-code posture is a safety property worth keeping (a scanner
with push access to every repo is a single point of compromise); (3) the human
merge gate stays where the code review culture already lives, in the target
repo.

**Mechanism (the fix loop):**

1. **Remediation pack.** For any finding, `src/fix/pack.ts` renders a
   machine-readable + Markdown pack: plain-English problem statement, affected
   file/symbol/route, recommended fix pattern with code example (sourced from
   the rule doc, §11), severity + why, and **acceptance criteria** — the rule
   ID + fingerprint that must no longer fire on re-scan.
2. **Fix request.** `audit fix <finding-ref>` (or the dashboard's "Send for
   fixing" button — same code path) files the pack as a GitHub issue in the
   target repo, labelled `audit-fix`, carrying the fingerprint as a stable
   marker. The issue URL is persisted in `reports/fixes.json`
   (fingerprint-keyed) — the authoritative store. `Finding.externalRefs` is
   NOT persisted on the finding; it is repopulated on every report build by
   joining the freshly-derived finding's fingerprint to `fixes.json`, so links
   survive the next `audit run` that re-derives findings from scratch (same
   source-of-truth precedence as §6.5: scan re-derives, persisted store
   rehydrates). **Idempotent at BOTH the issue and the comment level:** filing
   is keyed on fingerprint — an open `audit-fix` issue with the same fingerprint
   marker is reused, never duplicated. When the issue already exists, the tool
   posts at most ONE marker-bearing comment per distinct re-file *reason* (e.g. a
   `reopened` transition, §5.3 step 4): each comment carries a deterministic
   `<!-- audit-fix:<fingerprint>:<reason> -->` HTML marker, and the tool
   **searches existing issue comments for that exact marker before posting** —
   if a comment with the same marker is already present, the re-file is a no-op
   (no new comment). This closes the duplicate-comment window: a retry after
   GitHub accepted a comment but before `fixes.json` was updated, or a repeated
   `audit fix`, finds the marker and skips. The external write is therefore
   genuinely idempotent (search-before-create for issues AND search-before-comment
   for comments), matching the §14 `idempotent` retry classification. [Comment
   idempotency pinned per chatgpt-spec-review OAI-SPEC-008.]
3. **Repo-local execution.** The target repo's Claude Code GitHub Action picks
   up `audit-fix` issues, implements the fix on a branch, and opens a PR
   referencing the issue. The repo's own gates + human review own merge.
   (Target-repo onboarding = installing the standard action + label; one-time,
   documented in `docs/fix-workflow.md`.)
4. **Verification.** The next `audit run` re-scans. The `verified-fixed`
   transition is **fenced by scanner-family completion, exactly as §6.5 fences
   trend `fixed`**: a `merged-awaiting-verification` request transitions to
   `verified-fixed` ONLY when the fingerprint no longer fires AND the
   `(target × scannerFamily §6.8)` that originally produced the finding ran to
   **`complete`** in this run (per `meta.scannerStatus`, §6.9). If that family
   **failed, timed out, or was skipped** (`state ∈ {failed, skipped}`) in this
   run, the absence of the fingerprint is NOT evidence of a fix — the request
   stays `merged-awaiting-verification` and waits for a run in which the
   responsible family completes. This closes the partial-run masquerade for the
   fix machine: a scanner failure can never silently graduate a fix to
   `verified-fixed`, matching §6.5's "a finding can only transition to `fixed`
   when the scanner family that previously produced it ran to completion" rule.
   If the fingerprint still fires after the PR merged (in a run where its family
   completed), the request transitions to `reopened` and the issue gets a
   comment. A fix is only ever "done" when the scanner that found it ran to
   completion and can no longer find it. [Family-completion fence on
   `verified-fixed` per chatgpt-spec-review round 2 OAI-SPEC-006.]

**Fix-request state machine** (closed set, §14 rules apply):
`requested → in-progress → awaiting-review → merged-awaiting-verification →
verified-fixed | reopened` (6 states). Derivation from GitHub issue/PR + scan
state — derived using ONLY the token's read scopes (`issues:read`,
`pull_requests:read`), no local progress flags: `requested` = `audit-fix` issue
filed (open), no PR references it and it is unassigned; `in-progress` = an
observable signal that work has started but no non-draft PR yet, defined as
EITHER: the issue is assigned, OR a **draft** PR references the issue (GitHub
`Closes #/references` link) — both surfaceable from `issues:read` +
`pull_requests:read` alone (no `contents`/metadata scope; branch enumeration is
deliberately NOT used so the fix token stays minimal-scope per the §5.3 token
scope below); `awaiting-review` = a non-draft PR referencing the issue is open
and awaiting human merge; `merged-awaiting-verification` = that PR is merged,
next scan pending; `verified-fixed` = a subsequent `audit run` no longer fires the
fingerprint **in a run where the finding's originating `(target × scannerFamily)`
completed** (§6.8 fence, step 4 — a partial run whose responsible family failed
does NOT graduate the fix); `reopened` = the fingerprint still fires after the PR
merged (in a run where that family completed).
`reopened` is **not terminal** — it re-enters the loop via the same derivation:
a new/updated non-draft PR referencing the issue moves it back to
`awaiting-review` → `merged-awaiting-verification`, and a clean re-scan reaches
`verified-fixed`. On transition to `reopened` the tool reopens the GitHub issue
with a comment (it holds `issues:write`); no enum value is added — recovery is a
re-traversal of the existing six states. `reports/fixes.json` (Zod schema `src/schemas/fix.ts`) is the local
record; its status enum is exactly these six tokens. The dashboard Fixes
screen (§5.2) and the `finding-detail.html` fix pipeline each render one pill
per state (6 states = 6 pills).

**Token scope.** `AUDIT_GITHUB_FIX_TOKEN` is a fine-grained PAT with
`issues:write` (+ `issues:read`, `pull_requests:read` for status) on
Breakout-owned repos only. The tool never holds `contents:write`. Missing
token: `audit fix` fails with a named error; the dashboard's "Send for
fixing" explains in plain English that fix-sending is not configured.

**Manual fallback.** Every remediation pack is also copyable from the
dashboard as a ready-to-paste Claude Code prompt, for repos without the
action or for ad-hoc local fixing.

### 5.4 Secret redaction boundary (output safety, operator amendment 2026-06-13)

The tool discovers secrets (gitleaks, §7.2) and reads live response bodies and
headers, so credential material MUST be redacted before ANYTHING is written to
disk, printed, or transmitted — including the per-repo raw findings file (§5.1
`scan-source`) and any intermediate artifact, not just the final report.
`src/report/redaction.ts` is a single pure-function chokepoint applied at the
**normalizer boundary and every emitter after it**: the static normalizers
(Layer 1/2), the live normalizers (Layer 3), the per-repo findings file,
`report.json`, Markdown, SARIF, the HTML export, stdout/log lines, remediation
packs (§5.3), and the body of any GitHub fix-request issue. Native scanner
output (gitleaks/Semgrep/ZAP/Nuclei JSON, stdout, stderr) is captured, redacted,
then emitted or discarded — never persisted verbatim. Despite its `src/report/`
path it is authored in **P2** (alongside the first scanner normalizer) and
consumed by every later layer (§12); it is NOT a P5-only report-layer step. It
replaces credential values — gitleaks-detected secrets,
`Authorization`/bearer tokens, `Set-Cookie` and cookie values, and registry
env-derived staging credentials — with a stable `[redacted:<8hex>]` placeholder
(the hex is a salted digest, so the same secret reads identically across
artifacts for correlation without revealing the value). Enough non-secret
context is retained for triage: file, line/route, rule id, and the structural
shape of the evidence. HTML-escaping (§5.2) is anti-XSS and is NOT a substitute
— redaction runs first, on the data, for every format, so a finding's raw
secret value never leaves the tool (and in particular is never republished into
an externally-filed GitHub issue). Acceptance: a redaction fixture + `src/report/redaction.test.ts` asserting no
known-secret fixture value appears in ANY emitted surface — the per-repo raw
findings file, stdout/logs, `report.json`, Markdown, SARIF, HTML, remediation
packs, and fix-issue bodies. Pinned as a §10 guardrail. [Operator-approved
2026-06-13, OAI-SPEC-005; normalizer-boundary ordering per external review
HIGH-3.]

## 6. Contracts

All schemas are Zod (`src/schemas/`), each exporting a generated JSON Schema
(`npm run schemas` writes `schemas/*.schema.json`).

### 6.1 `Finding` (the shared findings format — produced by every scanner/rule, consumed by correlate/report/baseline)

```jsonc
{
  "id": "f-3f9a1c2b8d4e0a17",            // "f-" + first 16 hex of fingerprint (§6.6)
  "fingerprint": "3f9a1c2b8d4e0a17…",   // FULL 64-hex sha256 (§6.6); id === "f-" + fingerprint.slice(0,16). Canonical key for fixes.json (§5.3) and SARIF auditToolFingerprintV1 (§6.10)
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
  "externalRefs": [],                      // fix-request issue URLs (§5.3); derived on report build via fingerprint join to reports/fixes.json, not persisted on the finding
  "firstSeen": "2026-06-12T00:00:00Z",
  "suppressed": false,                     // true only when matched by a live (unexpired) baseline entry
  "suppression": null,                     // report-stage-derived; when suppressed===true, the matched baseline entry's justification + approvedBy + expiry, copied onto the finding so the report is self-contained (§6.10 SARIF reads it from here, not from mutable config). null when suppressed===false
  "note": null                             // optional; set to "baseline expired <date>" on expired-baseline re-alert (§6.4), else null
}
```

Nullability: `evidence.cvss` null unless upstream provides one; `location`
fields are surface-specific (static vs live shapes are a discriminated union on
`target.kind`). Producer: layer 1–3 normalizers. Consumer: layer 4 + report.

**`fingerprint` is the canonical full key (not the truncated `id`).** Every
finding carries the FULL 64-hex sha256 `fingerprint` (§6.6) alongside the
display `id` (`id === "f-" + fingerprint.slice(0,16)`). The full `fingerprint`
is the value used as: the `reports/fixes.json` key (§5.3), the SARIF
`auditToolFingerprintV1` (§6.10), the `audit fix <finding-ref>` → fixes.json
join key, and the `audit-fix` GitHub issue marker (§5.3). The truncated `id`
is for human/UI display only and is NEVER an idempotency or join key — its
truncation makes collisions possible. `RunReport.findings[]` (§6.9) therefore
serialises the full `fingerprint` so a re-emitted `audit report --format sarif`
and `audit fix` operate from the report file alone, with no recomputation from
display fields. [Per chatgpt-spec-review OAI-SPEC-001.]

**Field lifecycle (raw scan finding vs report finding — one schema, two
stages).** `Finding` is a single Zod type used at both stages; these fields are
**report-stage-derived**, not produced by scanners: `severity` (computed §8),
`correlatedWith` (§9), `externalRefs` (joined from `fixes.json` on report build,
§5.3), `suppressed` + `suppression` (set when a live unexpired baseline entry
matches, §6.4 — `suppression` copies the matched entry's `justification`,
`approvedBy`, and `expiry` onto the finding so the **archived report alone**
satisfies the §6.10 SARIF suppression projection without re-reading mutable
`config/baseline.json`, preserving §6.9 source-of-truth + §6.10 determinism),
and `note` (set on expired-baseline re-alert §6.4). At the raw-scanner
stage these carry their empty defaults (`severity` = `baseSeverity`,
`correlatedWith` = `[]`, `externalRefs` = `[]`, `suppressed` = `false`,
`suppression` = `null`, `note` = `null`); the report
builder (`src/report/json.ts`) populates them. The schema does not split into
two types — the empty defaults make a raw finding a valid `Finding` — but
implementers must treat these four fields as derived-on-report-build, never
persisted from a scanner. This is the same source-of-truth precedence as §6.5:
scans re-derive findings; persisted stores (`fixes.json`) rehydrate the derived
references.

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
              "method": "POST",            // login request verb (default POST)
              "userField": "email",        // request field name for the username/email
              "passField": "password",     // request field name for the password
              "bodyType": "json",          // "json" | "form-urlencoded" — login request encoding
              "sessionCarrier": "cookie",  // "cookie" | "bearer" — how the authenticated session is carried on subsequent requests
              "successCheck": { "statusIn": [200, 204], "jsonHasKey": "token" }, // login "succeeded" iff status ∈ statusIn AND the session credential for THIS sessionCarrier was actually obtained — see carrier-aware rule below
              "testUsers": [               // env NAMES, never values
                { "userEnv": "AUDIT_STAGING_AUTOMATION_USER_A", "passEnv": "AUDIT_STAGING_AUTOMATION_PASS_A" },
                { "userEnv": "AUDIT_STAGING_AUTOMATION_USER_B", "passEnv": "AUDIT_STAGING_AUTOMATION_PASS_B" }
              ] },
    "rateLimitRps": 10,                    // clamped 1–25 by schema
    "enabled": false                       // shipped disabled until operator confirms
  }]
}
```

Producer: operator (PR-reviewed). Consumer: CLI + both scan engines.

**Repo acquisition contract.** When `localPath` is set the scanner reads that
working tree as-is (operator-managed checkout). When `localPath` is null the
orchestrator (`src/static/orchestrator.ts`) does a **shallow clone (`--depth 1`,
single branch)** of the repo's **default branch HEAD** into a fresh temp dir
per run, using the read-only `AUDIT_GITHUB_READ_TOKEN` (a fine-grained
`contents:read` PAT, distinct from the §5.3 fix token). The scanned commit SHA
is recorded in every finding's `target.commit` (§6.1) and in
`RunReport.targets[].commit` (§6.9), so a scheduled run is reproducible and
fingerprints (§6.6) are stable for a given commit. v1 scope: single-repo,
default-branch only — **submodules are not initialised and monorepo
sub-package selection is not supported** (the whole default-branch tree is
scanned); both are deferred (§13).

**Allowlist cross-check (enabled targets only).** An `enabled: true` staging
target's URL host MUST be on the allowlist — validated at config load;
violation is a config error (not a scan-time skip). Disabled targets MAY exist
off-allowlist (so the shipped config — one disabled sample target + empty
allowlist — is valid by design); enabling a target requires its host to
already be allowlisted. [Per operator review HIGH-1.]

**Auth schema.** `auth.kind ∈ { "form" }` in v1 — closed set, same closure
rule as `vulnClass` (§6.7): adding a kind requires a spec amendment. [Per
claude-spec-review CR-003.] A `form` auth block fully specifies the login
exchange so ZAP/Nuclei/session/IDOR crawls (§7.3) are reproducible: `method` +
`loginPath` + `bodyType` define the request; `userField`/`passField` name the
credential fields; `sessionCarrier` says whether the post-login session rides
in a cookie or a bearer token; and `successCheck` defines login success in a
**carrier-aware** way — login succeeds iff `status ∈ statusIn` AND the
credential the scanner will actually replay for `sessionCarrier` was obtained:
for `sessionCarrier: "bearer"` the response MUST contain an extractable token at
`jsonHasKey` (a `Set-Cookie` alone does NOT satisfy success — the crawler has no
bearer to send); for `sessionCarrier: "cookie"` the response MUST issue a usable
`Set-Cookie` (a JSON token alone does NOT satisfy success — cookie-based crawling
cannot authenticate from it). The carrier-agnostic OR ("`jsonHasKey` present OR a
`Set-Cookie` issued") is **rejected** because it can mark a login "succeeded"
while the scanner holds no credential for its configured carrier, silently
running an `activeScan: true` target unauthenticated and overstating
IDOR/access-control coverage. A login that does not satisfy this carrier-aware
`successCheck` counts as a login failure for the §6.2 failure-pinning rule below.
[Carrier-aware successCheck per chatgpt-spec-review OAI-SPEC-009.] CSRF tokens (if the login form issues one) are
captured from the pre-login `GET loginPath` response and replayed on the login
POST; this is the only CSRF handling in v1 (deeper anti-CSRF flows are out of
scope). `auth.testUsers` is a closed array of env-var-name pairs: when `auth` is present the schema requires ≥ 1 entry (authenticated
passive crawl); when `activeScan: true` it requires **exactly 2** entries —
the IDOR/access-control cross-access checks (§7.3) need two distinct
identities. Failure behaviour is pinned: if `activeScan: true` and required
creds are missing or login fails, that **target is marked failed** (named in
`meta.failures`) — never silently downgraded to passive — which makes the
overall multi-target run `partial` per the §14 status-aggregation rule (or
run-level `failed` when it is the only target / co-occurs with a run-global
fault). If `activeScan: false` and creds are missing/login fails, the scan runs
unauthenticated and the report records an explicit coverage gap. [Per operator
review HIGH-3.]

### 6.3 `Allowlist` (`config/allowed-staging-hosts.json`)

```jsonc
{ "hosts": [ { "host": "staging.automation.breakout.dev", "owner": "michaelhazza",
               "addedAt": "2026-06-12", "note": "automation-v1 staging" } ] }
```

Shipped EMPTY (`"hosts": []`). Consumer: `src/live/gate.ts` only.

### 6.4 `Baseline` (`config/baseline.json`)

```jsonc
{ "entries": [ {
    "fingerprint": "3f9a1c2b8d4e0a17…",                              // required — FULL 64-hex sha256 (§6.6); the canonical suppression match key
    "findingId": "f-3f9a1c2b8d4e0a17",                               // optional — display echo only (`"f-" + fingerprint.slice(0,16)`); NEVER a match key
    "ruleId": "BS-SQL-001",                                          // required — must match
    "target": { "kind": "repo", "name": "automation-v1" },           // required — kind + name (repo) or host (staging)
    "locationKey": "GET /api/users/:id",                             // optional — symbol (static) / normalizedUrlPath (live)
    "justification": "test-only endpoint, removed in Q3 rewrite",   // required, non-empty
    "expiry": "2026-09-30",                                          // required ISO date
    "approvedBy": "michaelhazza"                                     // required handle
} ] }
```

**Scoped suppression.** A baseline entry suppresses a finding only when ALL of
its fields match: the full `fingerprint` AND `ruleId` AND `target` (kind +
name/host), plus `locationKey` when present. **The match key is the full 64-hex
`fingerprint` (§6.6), NOT the truncated `findingId`** — consistent with §6.1's
canonical-key rule (the truncated `id`/`findingId` is display-only and is never
an idempotency or join key, because its truncation makes collisions possible,
and suppression is security-sensitive: a truncated-id match could silently
suppress a *different* finding that collides on the 16-hex prefix). `findingId`
is retained as an optional human-readable echo only; config-load validates that
when both are present `findingId === "f-" + fingerprint.slice(0,16)`, and an
entry carrying only a truncated `findingId` with no `fingerprint` fails config
load. A benchmark test asserts (a) an entry scoped to one target cannot suppress
the same finding on another target, and (b) two findings sharing a 16-hex `id`
prefix but differing in full `fingerprint` are suppressed independently. [Per
operator review MEDIUM-1; full-fingerprint match key reconciled to §6.1 per
chatgpt-spec-review round 2 OAI-SPEC-001.]

Expired entries stop suppressing and the finding re-alerts at full severity
with `note: "baseline expired <date>"` in the report. Malformed entries
(missing any required field) fail config load. Approval = PR review (CODEOWNERS).

### 6.5 `TrendHistory` (`history/trend.jsonl`, committed; one line per run)

```jsonc
{ "runId": "2026-06-12T03-00-00Z-7f3a", "date": "2026-06-12",
  "targets": { "automation-v1": { "status": "complete",   // "complete" | "unknown" — "unknown" on partial runs per the rule below; the Trends screen (§5.2) renders it explicitly
               "new": 2, "fixed": 1, "persisting": 7,
               "bySeverity": { "critical": 0, "high": 3, "medium": 4, "low": 2 } } } }
```

Counts only — no finding bodies (full reports are CI artifacts, not committed).
Source-of-truth precedence: the run's `report.json` (artifact) is authoritative
for findings; `trend.jsonl` is derived counts; on disagreement, `report.json`
wins and the trend line is regenerated.

**Partial-run rule (scanner failure must not masquerade as remediation).** On
a `partial` run (§14), trend accounting is computed only for (target ×
scanner-family) dimensions whose scanners ALL completed. Any target touched by
a failed/timed-out scanner records `"status": "unknown"` for that run, and
`fixed` is NEVER computed from a scanner family that did not complete — a
finding can only transition to `fixed` when the scanner family that previously
produced it ran to completion and no longer reports it. Partial reports are
still emitted for human inspection. Guardrail test pinned in §10. [Per
operator review HIGH-2.]

### 6.6 Fingerprint (stable finding identity)

```
static : sha256(ruleId | targetName | normalizedPath | symbol | normalizedSnippet)
live   : sha256(checkId | host | normalizedUrlPath | parameter | evidenceClass)
id     = "f-" + first 16 hex chars
```

- `normalizedPath`: repo-relative, posix separators.
- `symbol`: route signature (`GET /api/users/:id`) or enclosing
  function/class name — survives line drift and re-ordering. For schema-level
  rules that have neither a route nor an enclosing function (e.g. BS-RLS-001 /
  BS-SQL-002 firing on a Drizzle table declaration), `symbol` is the normalized
  table name from the `pgTable('<name>', …)` literal (e.g. `subscriptions`).
  This single value feeds both the fingerprint and `locationKey` baseline
  scoping (§6.4), so RLS-class findings fingerprint stably and are suppressible
  deterministically.
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

### 6.8 `scannerFamily` closed enum (partial-run accounting axis)

The unit of completion for partial-run accounting (§6.5, §14) is the **scanner
family** — equal to the `source` axis of §6.1:

`ast · semgrep · gitleaks · osv · zap · nuclei · probe`

Mapping: each `Finding.source` value IS its family; each `ruleId`/`checkId`
belongs to exactly one family (BS-* AST rules → `ast`; custom + curated Semgrep
YAML → `semgrep`; `LIVE-*` direct probes → `probe`; `ZAP-*` → `zap`; `NUCLEI-*`
→ `nuclei`). Family completion is tracked per (target × family): a family is
`complete` for a target iff every scanner invocation in that family for that
target exited successfully within its timeout. `fixed` is only ever computed
for `complete` families (§6.5). Closed set; adding a family requires a spec
amendment. Producer: `meta.scannerStatus` (§6.9). Consumer: trend (§6.5),
report status (§14), and the fix-request `verified-fixed` fence (§5.3 step 4 —
a merged fix graduates only when its originating family completed).

### 6.9 `RunReport` (`reports/<runId>/report.json` — the canonical run artifact)

The artifact every output (UI §5.2, trend §6.5, MD/SARIF/HTML §5.1, fix
verification §5.3) reads. It is the source of truth for findings (§6.5).

```jsonc
{
  "runId": "2026-06-12T03-00-00Z-7f3a",       // timestamp + 4-hex suffix
  "date": "2026-06-12",
  "findings": [ /* Finding[] §6.1, already correlated/severity-computed/sorted §8.1 */ ],
  "targets": [ { "kind": "repo", "name": "automation-v1", "commit": "abc123…",
                 "coverageGaps": ["unauthenticated-only: no creds for activeScan"] } ],
  "meta": {
    "status": "partial",                       // "success" | "partial" | "failed" (§14)
    "failures": [ { "target": "automation-v1-staging", "family": "zap",
                    "reason": "timeout after 900s" } ],  // [] when status=success
    "scannerStatus": [ { "target": "automation-v1", "family": "ast",
                         "state": "complete" } ],          // per (target × family §6.8)
    "startedAt": "2026-06-12T03:00:00Z", "finishedAt": "2026-06-12T03:08:11Z",
    "toolVersion": "audit-tool/1.0.0"
  }
}
```

Nullability/defaults: `meta.failures` is `[]` on a `success` run; every
(target × family) in scope appears in `meta.scannerStatus` with
`state ∈ {complete, failed, skipped}`; `coverageGaps` is `[]` when none. The
run-level fields referenced elsewhere in the spec live on this report, NOT on
`Finding`: scanner-family status → `meta.scannerStatus`; failure metadata →
`meta.failures`; per-target coverage gaps → `targets[].coverageGaps`. The
fields that DO live on a finding — `note` (expired-baseline re-alert, §6.4),
`suppression` (matched-baseline justification/approvedBy/expiry copied on report
build for the §6.10 SARIF projection, §6.1), and multiple `occurrences`
(fingerprint collision merge, §6.6) — are optional/nullable fields on `Finding`
(`note?: string`, `suppression?: { justification: string; approvedBy: string;
expiry: string } | null`, `evidence.raw.occurrences?: Location[]`).
Producer: `src/report/json.ts`. Consumer: UI, trend, SARIF/MD/HTML, fix
verification. Zod schema: `src/schemas/report.ts` (added to file inventory §11).

### 6.10 SARIF mapping (`src/report/sarif.ts`, SARIF 2.1.0)

The SARIF export is a deterministic projection of §6.9 `RunReport`, pinned so
implementations agree:

- **Run/tool.** One `runs[0]`; `tool.driver.name = "audit-tool"`,
  `version = meta.toolVersion`. Each rule/check id is a
  `tool.driver.rules[]` `reportingDescriptor` (`id` = `ruleId`/`checkId`,
  `helpUri` = the `docs/rules/<id>.md` path, `shortDescription` = the rule's
  one-line intent).
- **Result per finding.** `result.ruleId` = `Finding.ruleId`;
  `result.fingerprints = { "auditToolFingerprintV1": <full sha256> }` (the §6.6
  fingerprint, not the truncated id, so SARIF dedupe is stable across runs);
  `result.level` from severity (`critical`/`high` → `error`, `medium` →
  `warning`, `low` → `note`) with `result.rank` carrying the ordinal severity
  for tools that rank; `result.message.text` = the plain-English problem
  statement.
- **Location.** Static → `physicalLocation` (`artifactLocation.uri` =
  `location.path`, `region.startLine` = `location.startLine`) plus a
  `logicalLocation.fullyQualifiedName` = `location.symbol`; live →
  `logicalLocation` only (the `url` + `method`), since there is no source file.
- **Suppression.** `suppressed: true` findings emit a `result.suppressions[]`
  entry (`kind: "external"`, `justification` = the finding's report-stage
  `suppression.justification` field, §6.1 — read from the archived `RunReport`,
  NOT from current `config/baseline.json`, so a re-emit from an old report is
  deterministic and self-contained per §6.9); expired baselines do NOT suppress
  (the finding re-alerts, §6.4). [SARIF reads justification from the report per
  chatgpt-spec-review round 2 OAI-SPEC-002.]
- **Correlation + refs.** Live-correlated evidence (§9) is attached as
  `relatedLocations`; `externalRefs` (§5.3) map to
  `result.workItemUris`.

Producer: `src/report/sarif.ts`. Consumer: external SARIF ingestors (GitHub
code-scanning, IDEs). Determinism: results sorted by §8.1 report order so the
SARIF byte output is stable for a given report.

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
IDOR/access-control via authenticated crawl (two test users — `auth.testUsers`
exactly 2 per §6.2 — cross-access probe), using the target's `auth` config
(§6.2). Missing/failed creds on an `activeScan: true` target fail the run
(§6.2 failure pinning).

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
→ vulnClass criticality (tenant-isolation first) → target name → **`ruleId`
(asc) → full `fingerprint` (asc)** as the final, total tiebreaker. The last two
keys guarantee a *total* order even when two findings share severity,
confidence, vulnClass, and target — so JSON/Markdown/SARIF/HTML/UI/benchmark
byte output is deterministic and independent of scanner arrival order or
engine sort stability. CVSS from upstream scanners is carried in
`evidence.cvss` as metadata only. [Final tiebreaker per chatgpt-spec-review
OAI-SPEC-004.]

**Reachability inputs (how the modifier operands are set).** `reachability`
(§6.1) is set at normalization, not inferred dynamically: a static rule fires
on a route already known to be in the per-repo `publicRoutes` allowlist (§6.2)
→ `unauthenticated`; a route behind auth/permission middleware (the same chain
BS-AUTH-001 walks) → `authenticated`, and behind an admin/permission guard →
`admin`; a finding with no route context (schema-level rules, secrets, CVEs)
or where the chain can't be resolved → **`unknown`**. `unknown` is the default
and is **neutral** — it triggers neither the bump (modifier 2) nor the
demotion (modifier 3); only the explicit `unauthenticated`/`admin` values move
severity. **Confidence inputs:** live findings from an active probe that
demonstrated the issue are `confirmed`; passive-only observations are
`probable`; static-only findings are `probable` unless live-correlated
(modifier 1 promotes them to `confirmed`). A live finding is therefore NOT
unconditionally `confirmed` — passive evidence is `probable`.

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
deterministic: process findings sorted by full `fingerprint` (§6.6, not the
truncated `id`) so run order can't change output.

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
- New rules enter test-first: seed fixture, then write the rule (enforced from
  P1 by the minimal harness, §12).
- **Guardrail tests** (part of the benchmark suite, same immutability as the
  §4.7 abort test):
  - *Partial-run trend:* one scanner is forced to time out; a previously-known
    finding from that scanner family must NOT be counted `fixed`, the target's
    trend status records `unknown`, and the run reports `partial` (§6.5).
  - *Scoped suppression:* a baseline entry scoped to one target must not
    suppress the same finding on another target, and two findings sharing a
    16-hex `id` prefix but differing in full `fingerprint` are suppressed
    independently — suppression matches on the full 64-hex `fingerprint`, never
    the truncated `findingId` (§6.4). [Full-fingerprint match per OAI-SPEC-001.]
  - *Active-scan cred failure:* an `activeScan: true` target with missing
    creds must produce a `failed` run, not a passive scan (§6.2).
  - *HTML evidence inert-text matrix:* malicious evidence values containing
    `<script>`, `<style>`, `<template>`, `<meta>`, `<link>`, HTML comments,
    `aria-*`/`data-*`/event-handler attributes, `<input type="hidden">`,
    `display:none`/`visibility:hidden`/`aria-hidden`/off-viewport subtrees, and a
    literal `</script>` must appear in the HTML export ONLY as escaped text in
    the visible evidence container — never as parsed DOM or executable script
    (§5.2). [OAI-SPEC-007.] **This guardrail ships with the HTML exporter it
    tests as `src/report/html.test.ts` in P7 (§12), not in the P6 engine
    benchmark batch — it is a final-ship requirement.** [P7 ownership per
    chatgpt-spec-review round 2 OAI-SPEC-003.]
  - *Allowlist IP-literal rejection:* the production `assertAllowlisted` rejects
    IP-literal URLs before any network I/O — `https://127.0.0.1/`, a
    numeric/octal/hex IPv4 variant Node's `URL` accepts, `https://[::1]/`, and
    `https://[::ffff:127.0.0.1]/` — while only `loadBenchmarkAllowlist()` may
    permit loopback literals (§4.2). [OAI-SPEC-006.]
  - *Preflight before DNS:* a `--dry-run` against a denied host asserts that
    `assertAllowlisted()` was called and threw before any DNS resolver call or
    HTTP request occurred (zero resolver calls, zero hits). [External review
    HIGH-1, §4.6.]
  - *Aggregate per-host rate limit:* two fake scanner families pointed at one
    host assert the combined observed request rate never exceeds the host's
    `rateLimitRps`, proving the limit is aggregate-per-host, not per-family.
    [External review HIGH-2, §4.5.]
  - *Carrier-aware login success:* a `sessionCarrier: "bearer"` login that only
    sets a cookie, and a `sessionCarrier: "cookie"` login that only returns a
    JSON token, each count as a login *failure* and mark an `activeScan: true`
    target `failed` — never a silent unauthenticated active scan (§6.2).
    [OAI-SPEC-009.]
  - *Secret redaction (§5.4):* a fixture carrying known secrets (a gitleaks
    hit, a bearer token, a `Set-Cookie`) is asserted absent from EVERY emitted
    surface — the per-repo raw findings file, stdout/logs, `report.json`,
    Markdown, SARIF, HTML, remediation pack, and fix-issue body — appearing only
    as `[redacted:<8hex>]`. The redaction function + its unit test
    (`src/report/redaction.test.ts`) ship in P2 at the normalizer boundary;
    each surface's redaction-pass is asserted as that emitter lands (raw
    findings P2, report formats P5, HTML P7, fix issues P8). [OAI-SPEC-005;
    surface list reconciled with §5.4 per external review MEDIUM-2.]
  - *UI fix-endpoint CSRF/origin guard (§5.2):* `src/ui/server.test.ts` asserts
    the mutating "Send for fixing" route returns 403 (and never calls
    `src/fix/github.ts`) on a missing/wrong `X-Audit-CSRF` nonce or a foreign
    `Origin`, and that the server never emits `Access-Control-Allow-Origin: *`.
    Ships with the P8 endpoint. [OAI-SPEC-004.]
- **Self-scan gate:** CI statically scans this repo itself and must be clean;
  `benchmark/corpus/**` and `benchmark/live-fixture/**` are excluded via the
  self-scan config (they are intentionally vulnerable by design — exclusion
  pinned here, not ad-hoc).

## 11. File inventory (lock)

| Path | Purpose |
|---|---|
| `src/cli.ts` | entry; parseArgs; subcommands §5.1 |
| `src/schemas/finding.ts`, `targets.ts`, `allowlist.ts`, `baseline.ts`, `trend.ts`, `report.ts` | Zod contracts §6 (`report.ts` = `RunReport` §6.9) |
| `src/schemas/generate.ts` | `npm run schemas` → `schemas/*.schema.json` |
| `src/config/load.ts` | load + validate config trio; cross-checks §6.2 constraint |
| `src/static/orchestrator.ts` | repo acquisition (localPath/clone), scanner fan-out |
| `src/static/scanners/{semgrep,gitleaks,osv}.ts` | wrappers + normalizers |
| `src/static/rules/*.ts` (7 ts-morph rules per §7.1) | custom AST rules |
| `rules/semgrep/*.yaml` (4 rules per §7.1) | custom Semgrep rules |
| `src/live/gate.ts` | `assertAllowlisted` + `AllowedTarget` brand (§4.1) |
| `src/live/preflight.ts` | dry-run + mandatory preflight |
| `src/live/ratelimit.ts` | aggregate per-host token-bucket limiter (§4.5) — serializes request-generating families per host |
| `src/live/auth.ts` | scripted `form` login + carrier-aware session success check (§6.2, §7.3) |
| `src/live/scanners/{zap,nuclei}.ts`, `src/live/probes/{tls,headers,cookies,exposure}.ts` | live engine |
| `src/correlate/{fingerprint,severity,correlate}.ts` | layer 4 core |
| `src/report/{json,markdown,sarif,html,trend,baseline,redaction}.ts` | outputs (`html.ts` = self-contained export, §5.2); `redaction.ts` = single secret-redaction chokepoint applied by all emitters (§5.4) |
| `src/report/lock.ts` | workspace lock: pid-liveness + 60s heartbeat (§14) — break only on a proven-dead holder, never elapsed time |
| `src/ui/server.ts` | `audit ui` localhost server: static assets + read-only JSON endpoints + per-process CSRF nonce mint (P7); the single §5.3 fix-request action endpoint, CSRF/origin-gated (§5.2), is wired in P8 (depends on `src/fix/*`) |
| `ui/**` | React 18 + Vite SPA — 6 screens per §5.2, plain-language-first |
| `src/fix/{pack,github,status}.ts` | remediation packs, fix-request issue filing (idempotent by fingerprint), status derivation (§5.3) |
| `src/schemas/fix.ts` | Zod schema for `reports/fixes.json` (§5.3 state machine) |
| `docs/fix-workflow.md` | target-repo onboarding for the Claude Code fix action (§5.3) |
| `config/{targets,allowed-staging-hosts,baseline}.json` | checked-in registries (shipped: 1 repo enabled, 0 staging enabled, empty allowlist, empty baseline) |
| `history/trend.jsonl` | committed trend lines §6.5 |
| `benchmark/**` | §10 |
| `docs/rules/<ID>.md` (one per stable check id) | id, rationale, fix guidance + code example, fixture links. Granularity = one doc per stable id: the 11 custom rules (§7.1), the 3 wrapped scanners' families, and each enumerated live `checkId` family from §7.3 (`LIVE-TLS-001`, `LIVE-HDR-001`, …, and one doc per wildcard family `ZAP-P-*` / `ZAP-A-*` / `NUCLEI-*` covering that family — NOT one per individual upstream template) |
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
| P1 | schemas + config loading + fingerprint + CLI skeleton (`--help`, config validation) + **minimal benchmark harness** (corpus walker, EXPECTED.json comparison, recall/precision accounting, non-zero exit) — so P3+ rules land test-first against a working harness | — |
| P2 | static orchestration: clone/localPath + 3 wrapper scanners + normalizers + **secret-redaction chokepoint (`src/report/redaction.ts`) applied at the normalizer boundary so the per-repo raw findings file is redaction-passed (§5.4)** | P1 |
| P3 | custom rule pack (11 rules) + their corpus fixtures (test-first, enforced by the P1 harness) | P1, P2 (semgrep runner) |
| P4 | live engine: gate + preflight/dry-run FIRST, then probes, ZAP, Nuclei wrappers + live fixture app + safety-contract test | P1 |
| P5 | correlation + severity + report (JSON/MD/SARIF) + baseline + trend (every report emitter applies the §5.4 redaction chokepoint authored in P2; live response material from P4 is redacted at its normalizer too) | P2–P4 |
| P6 | benchmark completion (live-fixture integration, **engine-available §10 guardrail tests only** — partial-run trend, scoped suppression, active-scan cred failure, allowlist IP-literal rejection, preflight-before-DNS, aggregate per-host rate limiting, carrier-aware login success; the §10 *HTML evidence inert-text matrix* guardrail is NOT a P6 deliverable because it targets the P7 HTML exporter — see P7) + Dockerfile + CI workflows + self-scan gate + rule docs sweep | P1–P5 |
| P7 | report dashboard UI (`audit ui` server + 6-screen SPA per §5.2, shapes from the approved mockups) + HTML report export. **`src/report/html.test.ts` owns the §10 HTML evidence inert-text matrix guardrail** (it ships with the exporter it tests; required before final v1 ship). All 6 screens render in P7 from P5 data contracts; the Fixes screen and the finding-detail fix pipeline render **read-only** (Fixes shows an empty/"no fix requests yet" state until `fixes.json` exists; the "Send for fixing" button renders **disabled** with a "fix-sending wired in P8" affordance). No `src/fix/*` dependency in P7. | P5 (report.json / trend.jsonl as data contracts) |
| P8 | remediation orchestration: packs, `audit fix`, GitHub issue integration, fixes.json status tracking, re-scan verification, **and wiring the P7 Fixes screen + finding-detail to live data (enables the "Send for fixing" action endpoint in `src/ui/server.ts`, CSRF/origin-gated per §5.2)**, `docs/fix-workflow.md` | P5 (findings/fingerprints), P7 (UI shell) |

No backward references: each phase consumes only earlier phases' outputs.
(P7 was added by the 2026-06-12 UI addendum and P8 by the 2026-06-13
remediation addendum; both depend only on earlier phases' outputs.)

**Two distinct gates — do not conflate them:**

1. **P6 core-quality exit loop** (the "v1 exit loop", post-G2 per launch
   prompt). Runs after P6 over the scan engine: benchmark (100% recall / 0 FP)
   + base gates + self-scan, max 10 iterations, stuck-rule = stop after 2
   identical failures, exit conditions immutable. This loop validates the
   detection core and may run while P7/P8 are still in flight — it does NOT
   itself depend on P7/P8.
2. **Final v1 ship gate.** v1 does not SHIP until the P6 core-quality loop is
   green AND P7 AND P8 are complete: remediation is a v1 goal (§1.7), so the
   ship gate additionally requires P8's gates — `audit fix` idempotency, the
   fix-request state-machine derivation (§5.3), and the §10 guardrail tests —
   plus `docs/fix-workflow.md`, on the same footing as P7's 6 UI screens.

The P6 loop is the quality gate on the engine; the ship gate is the quality
loop green plus the P7+P8 deliverables landed.

## 13. Deferred items

- **DNS-resolution / IP-pinning hardening on the allowlist gate.** v1 gates on exact hostname (§4.8). Reason: targets are our own PR-reviewed staging hosts; rebinding defense adds complexity v1 doesn't need.
- ~~GitHub issue-sync~~ **Promoted into v1 scope** by the 2026-06-13 remediation amendment (§5.3) — `externalRefs` now carries fix-request issue URLs.
- **Direct code-patch PRs from the audit tool** (even for mechanical fix classes). Reason: §5.3's detect-here-fix-there decision; revisit only if the issue-based loop proves too slow in practice.
- **Submodule init + monorepo sub-package selection for static scans.** v1 shallow-clones the default-branch tree only (§6.2). Reason: target repos are single-package at v1; added when a monorepo or submodule-bearing target is registered.
- **Ad-hoc allowlist-only live scanning of unregistered hosts.** v1 requires every `scan-live --url` host to resolve to an enabled `stagingTargets[]` entry (§5.1). Reason: keeps every scanned live target registry-backed (repo linkage, coverage-gap representation, trend keys all defined); ad-hoc scanning would need synthetic unnamed-target semantics not worth v1's complexity.
- **Wildcard/CIDR allowlist entries.** Exact hostnames only in v1. Reason: keeps the gate trivially auditable.
- **Per-entry non-default ports / non-https schemes in the allowlist gate.** v1 requires https + default port 443 (§4.2). Reason: staging is TLS-only and a non-default port denotes a different service; per-entry port pinning is added only if a real staging target needs it.
- **Stored-XSS deep flows in live fixture.** v1 fixture seeds reflected XSS + a simple stored case; complex multi-step stored flows deferred. Reason: corpus cost; recall target applies to seeded cases.
- **Scan-record cleanup automation for staging.** v1: owner-attested cleanup per `activeScan` opt-in (grill Q8). Reason: cleanup is target-app-specific.
- **Per-rule semgrep→ts-morph migrations** where Semgrep proves too coarse. Reason: post-v1 experiment-runner loops own precision tuning.
- **UI write actions (config/baseline editing) + scan launching from the dashboard.** The v1 UI's only non-read action is the §5.3 "Send for fixing" fix-request issue; it does not edit config/baseline and cannot launch scans (§5.2). Reason: baseline approval stays PR-reviewed (§6.4); scan invocation stays CLI/CI; keeps the §4 safety contract trivially auditable (no UI→live-engine path).
- **Hosted / multi-user dashboard with authn.** Reason: localhost single-operator covers v1; hosting findings data is a new risk surface needing its own spec.

## 14. Execution-safety contracts

- **Workspace lock (`reports/.lock`).** A single advisory lock file at
  `reports/.lock` serialises every writer of the shared file state: `audit run`
  (report + trend writes), `audit fix`, and the dashboard "Send for fixing"
  endpoint. Acquisition: create-exclusive (`wx`); on contention the losing
  caller exits immediately with a named `WorkspaceLockedError` (it does not
  block-wait). The lock records the holder's pid, ISO start time, and a
  `heartbeatAt` ISO timestamp that the holder **refreshes at least every 60s**
  for the lifetime of the run (a long portfolio scan rewrites the lock's
  `heartbeatAt` in place via the same atomic tmp+rename). **Staleness is decided
  by liveness, not by total run duration** — a legitimate full-portfolio `audit
  run` may exceed any fixed wall-clock and must NOT be breakable while alive
  (there is no cap on registered targets). A held lock may be broken by the next
  caller ONLY when the holder is provably gone, established in order:
  (1) the recorded pid is not a live process (`process.kill(pid, 0)` throws
  `ESRCH`) → break immediately; (2) the pid cannot be verified (e.g. recorded on
  another host) AND `heartbeatAt` is older than the stale threshold (default 5×
  the 60s heartbeat interval = 5min) → break. A live pid with a fresh heartbeat
  is NEVER broken regardless of elapsed run time. The old "older than 2h ⇒ stale"
  rule is replaced by this heartbeat+pid-liveness contract. [Per
  chatgpt-spec-review OAI-SPEC-005 — fixed wall-clock staleness could break a
  still-running legitimate scan.] All atomic writes below happen while the caller
  holds this lock; read-only consumers (`audit ui`, `audit report`) do NOT take
  it (they tolerate a concurrent atomic rename by re-reading on parse failure).
- **Idempotency:** report writes are state-based — atomic tmp+rename per
  output file; re-running a scan overwrites deterministically (sorted
  findings, stable fingerprints). Trend append is key-based on `runId`
  (re-running the same runId replaces the line, no duplicates).
- **`reports/fixes.json` writes:** the same atomic tmp+rename discipline as
  report outputs, serialised by the `reports/.lock` defined above. There are
  exactly TWO writers — `audit fix` and the dashboard "Send for fixing"
  endpoint (same code path) — each doing read-modify-write under the lock:
  load → upsert the fingerprint-keyed entry → atomic rename. Keyed on
  fingerprint, so two writers targeting the same finding converge (last-writer
  wins on the status field, which is itself derived from GitHub state and so
  idempotent). The report-build rehydrate step (`audit run`, §5.3) is **NOT a
  writer**: it only READS `fixes.json` to populate the report's derived
  `externalRefs` (a pure projection — it never mutates `fixes.json`, never
  changes its bytes or mtime), and it still runs inside `audit run`'s held lock,
  so it never races a concurrent status write. Conflict/precedence: `fixes.json` is authoritative
  for issue URLs; GitHub-derived status is recomputed on read, so a stale local
  status is self-healing on the next derivation.
- **Retry classification:** scanner subprocesses are `safe` to retry (read-only
  against repos; live scans re-send traffic but only to allowlisted staging —
  acceptable by contract). Git clone is `safe` (fresh temp dir per attempt).
- **Concurrency:** single-process CLI; concurrent runs on the same workspace
  are unsupported and guarded by the `reports/.lock` workspace lock defined at
  the top of this section (create-exclusive, broken only on pid-liveness +
  stale-heartbeat per that contract — never on elapsed run time alone, losing
  caller exits with `WorkspaceLockedError`).
- **Terminal event:** every `audit run` ends with exactly one run-summary
  record (stdout + `report.json.meta.status`): `success` (all scanners ran) |
  `partial` (≥1 scanner failed/timed out — named per scanner in
  `meta.failures`, never silent; trend `fixed` accounting suppressed for
  incomplete scanner families per §6.5) | `failed`. **Status aggregation
  (multi-target):** the run is `failed` ONLY for run-global faults that prevent
  meaningful output — config invalid, allowlist violation, or no scanner
  completed across all targets. A fault scoped to ONE target among several —
  including an `activeScan: true` target's missing/failed creds (§6.2) — makes
  THAT target's contribution `failed` (named in `meta.failures` with the target,
  and its `meta.scannerStatus` families marked `failed`) and the OVERALL run
  `partial`, so the other targets' findings still report. The §6.2 phrase "the
  target's run is failed" is this per-target failure; it escalates to a run-level
  `failed` only when it is the sole/only target or co-occurs with a run-global
  fault. Exit codes: 0 / 2 / 1 respectively;
  findings presence does NOT affect exit code of `run` (reporting tool, not a
  gate) — `--fail-on <severity>` opts into gating (used by self-scan CI).
- **State machine (live path):** `idle → preflight → gated(allowed) → passive →
  [active] → normalize → done`, with `gated(denied) → abort` terminal.
  Forbidden: any transition into `passive`/`active` not from
  `gated(allowed)` — unrepresentable via the `AllowedTarget` brand (§4.1).
  Status set is closed; additions require spec amendment.
- **Fix-request writes (§5.3):** the ONLY HTTP writes to an external system
  are GitHub issue create/comment calls, idempotent by fingerprint marker at
  BOTH levels — search-before-create for the issue (reuses the open `audit-fix`
  issue) AND search-before-comment for comments (each comment carries a
  deterministic `audit-fix:<fingerprint>:<reason>` marker; a re-file finds the
  marker and posts nothing, so retries never produce duplicate comments, §5.3
  step 2). Retry classification: `idempotent`. No other HTTP writes exist; no DB
  (checklist §10.6 N/A — no unique constraints).

## 15. Self-consistency + count reconciliation

- 11 custom rules (§7.1) = 7 ts-morph + 4 semgrep = file inventory rows (§11). ✓
- 3 wrapped static scanners (§7.2) = 3 wrapper files (§11). ✓
- 6 CLI commands (§5.1) = brief's 4 + `ui` (2026-06-12 addendum) + `fix` (2026-06-13 addendum). ✓
- 3 checked-in config files (§6.2–6.4) = inventory row. ✓
- 6 Zod contract schemas (§6) = `finding`, `targets`, `allowlist`, `baseline`, `trend`, `report` (`report.ts` = `RunReport` §6.9) = inventory row (§11); `fix.ts` (§5.3) is the 7th schema file, listed separately. ✓
- 7 scanner families (§6.8) = the 7 `Finding.source` values (§6.1: ast/semgrep/gitleaks/osv/zap/nuclei/probe). ✓
- 8 build phases (§12); 2 CI workflows (§11). ✓
- 6 UI screens (§5.2) = approved prototypes (`prototypes/audit-tool-v1/`, mockup loop CLEAN) = mockup scope (`tasks/builds/audit-tool-v1/mockup-log.md`); 4 report formats (json/md/sarif/html). ✓
- Fix-request state machine (§5.3) closed set = 6 tokens (`requested`, `in-progress`, `awaiting-review`, `merged-awaiting-verification`, `verified-fixed`, `reopened`) = Fixes screen statuses (§5.2) = `fixes.html` / `finding-detail.html` rendered pills = `src/schemas/fix.ts` enum. ✓
- Goals ↔ implementation: every §1 goal maps to §5–§10 sections; safety
  contract (§4) enforced by named mechanisms (brand type, single chokepoint,
  empty-allowlist default, abort test). Every "must" has a mechanism.

## 16. Open questions (for Phase 2)

- Exact pinned versions for the 5 binaries (resolve at P6 Dockerfile authoring; record in the repo's existing `KNOWLEDGE.md` — a standing framework file per `CLAUDE.md`, not a new spec deliverable, so it is intentionally absent from the §11 file inventory).
- ZAP orchestration mode: daemon API vs `zap-baseline.py`/automation-framework YAML (builder decides at P4 behind the wrapper interface; wrapper contract in §7.3 is fixed either way).
- Whether `automation-v1` staging gets `activeScan: true` at launch (operator call — shipped `false`).

---

*Authoring rubric: `docs/spec-authoring-checklist.md` (sections 0–13 applied;
§0 N/A — greenfield; §4 RLS N/A — no DB; §13 mobile applies as of the
2026-06-12 UI addendum — responsive desktop-first dashboard, §3/§5.2). Framing
per `docs/spec-context.md` (runtime_primary, e2e benchmark as primary gate).*
