# Intent — audit-tool-v1

**Scope class:** Major
**Date:** 2026-06-12
**Source:** operator launch prompt (brief embedded verbatim in session; key constraints reproduced below)

## Problem Statement

Breakout Solutions runs a portfolio of TypeScript/Express/Drizzle/Postgres apps
(multi-tenant with RLS) plus their staging deployments. Security review today
is per-repo and uneven: the flagship repo (`automation-v1`) has ~25 CI gate
scripts, while other repos have none. There is no portfolio-wide view, no
uniform scanning of staging deployments, and no single prioritized remediation
report. Vulnerability classes specific to our stack — tenant-isolation gaps,
unscoped raw SQL, routes missing auth middleware — are exactly the ones generic
scanners miss.

## Desired Outcome

A CLI tool ("audit-tool", this repo) that (1) statically scans every registered
source repo using wrapped scanners (Semgrep, gitleaks, osv-scanner) plus a
custom rule pack (ts-morph AST + Semgrep YAML) tailored to our stack; (2)
dynamically scans allowlisted **staging** URLs (OWASP ZAP, Nuclei, TLS/header
inspection) under a non-negotiable staging-only safety contract; (3) merges and
correlates everything into one prioritized report (JSON/Markdown/SARIF) with
stable fingerprints, baselines with expiry, and trend history. Quality bar: a
benchmark corpus with 100% recall on seeded vulnerabilities and 0 false
positives on clean fixtures, enforced in CI via `npm run benchmark`.

## Non-Goals

- Not a generic SAST/DAST product — internal use against our own assets only.
- No scanning of production, ever. Live scanning targets staging only (safety contract).
- No auto-remediation, no PR generation, no GitHub issue creation in v1 (schema designed so issue-sync can be added later).
- No SaaS dashboard; report files are the product.
- Does not replace per-repo CI gates in target repos (see Duplication / Strategy Check).

## Affected Capability Area

Static Scanning, Live Scanning, Correlation & Reporting, Target Registry & Safety, Benchmark & Quality

## User / Operator Impact

Operators (Breakout Solutions engineers) get one command (`audit run`) and one
prioritized remediation report covering every registered repo and staging URL —
including targets with no per-repo gates. Findings carry severity, fix
guidance, and rule docs. Baselines need justification + expiry, so accepted
risk stays visible. No end-user-facing surface.

## Risk Surface

Controlled live HTTP traffic to Breakout-owned staging hosts (allowlist-gated,
spec §4); read-only access to source repos; CI artifacts containing security
findings.

(Amended per operator review 2026-06-12 — was "None.". The §7.1.1 vocabulary
enumerates target-app surfaces, none of which exist in this repo; the operator
ruled that descriptive prose beats an understated "None." for a security
scanning tool. Kept verbatim-identical to the spec's Lifecycle Declaration.)

## Assumptions

- All target repos and staging URLs are owned and operated by Breakout Solutions; this is authorized, defensive, internal-only tooling.
- Target apps share the documented stack profile (Express 4, Drizzle + Postgres RLS, JWT auth, Zod, React 18, pg-boss, socket.io, multer, S3).
- External scanner binaries (Semgrep, gitleaks, osv-scanner, ZAP, Nuclei) are acceptable dependencies, version-pinned in a Dockerfile runner image.
- The tool is read-only against source repos; live scans are rate-limited and identifiable via User-Agent.
- Tech stack for the tool is decided (Node 20+/TS/ESM, ts-morph, Zod, Vitest) and not up for relitigation.
- CI is GitHub Actions, scheduled weekly, static + live against staging targets only.

## Open Questions

All eight launch-prompt questions are resolved in `## Grill-me Q&A` below
(autonomous session — recommended answers adopted; operator review requested
via handoff). Residual operator inputs:

- Actual first-pass repo list + staging URLs + allowlist hosts (registry ships with schema + `automation-v1` example; operator populates real entries before first portfolio run).
- Read-only clone credentials for CI (`AUDIT_GIT_TOKEN` secret) and staging test-user credentials (per-target env-var names) need to be provisioned in GitHub Actions secrets.

## Duplication / Strategy Check

| Output | Value |
|---|---|
| Duplication assessment | clear |
| Strategic fit | clear |
| Recommendation | proceed |

Basis: `docs/capabilities.md` register is empty (first build in a fresh repo);
no in-flight builds under `tasks/builds/*/` besides this one; cross-repo-scout
skipped silently (`.claude/project-registries.json` absent — no `sibling_repos`
declared). All five affected clusters are at Inception.

### automation-v1 overlap map (boundary definition, per brief)

The flagship target repo `automation-v1` runs per-repo CI gates that partially
overlap audit-tool's static surface. Explicit boundary:

| automation-v1 gate | Overlapping audit-tool capability | Boundary |
|---|---|---|
| `verify:rls` | RLS-coverage AST rule (Drizzle schema + migrations join) | Per-repo gate blocks that repo's PRs at merge time; audit-tool scans the whole portfolio (incl. repos with NO gates) on a weekly cadence and aggregates. Same flaw class, different scope + cadence. Neither replaces the other. |
| `verify-npm-audit-high.sh` | osv-scanner dependency-CVE scan | Per-repo gate is npm-audit (advisories, direct focus); audit-tool uses osv-scanner (OSV database, transitive, uniform across all repos) and feeds the portfolio report + trend history. |
| `scripts/audit/scan-claude-config.ts` | gitleaks secrets scan | Per-repo gate is scoped to Claude-config files; gitleaks covers the full tree of every registered repo. |
| ~25 `scripts/gates/*` | Custom rule pack (various) | Gates are repo-local merge blockers; audit-tool is the portfolio-wide uniform sweep + prioritized report. audit-tool does NOT gate target-repo PRs in v1. |

Rule: audit-tool never blocks a target repo's CI; it reports portfolio-wide.
A finding both a per-repo gate and audit-tool catch is expected redundancy
(defense in depth), not duplication to eliminate.

## Grill-me Q&A

> Mode: autonomous (walkaway session — operator pre-authorized execution via
> launch prompt and is not available for interactive Q&A). Each round records
> the recommended answer, which was adopted as the decision. Every decision is
> flagged in `handoff.md § Decisions made in Phase 1` for operator review;
> reversing any of them before Phase 2 is cheap.

**1. Where do the registries + allowlist live, and what's the first-pass target list?**
Recommended: `config/targets.json` (repos + staging URLs) and `config/allowed-staging-hosts.json` (the live-scan gate), both checked in at repo root `config/`, both Zod-validated with generated JSON Schema. Seed with `automation-v1` (clone-on-demand) as the only enabled repo and an empty staging allowlist — an empty allowlist means the live path can scan nothing until the operator adds hosts, which is the safe default.
Decision: adopted.

**2. Severity model?**
Recommended: simple `critical | high | medium | low` as the prioritization key, computed from rule base severity + exploitability modifiers (live-confirmed correlation raises; unauthenticated-route raises; admin-only-route lowers one step, never below the floor for secrets/injection classes). CVSS vectors/scores from upstream scanners (osv-scanner, Nuclei) are preserved as evidence metadata, not the ranking key. Rationale: 4-level is what remediation triage actually uses; CVSS-derived ranking would be false precision over heterogeneous sources.
Decision: adopted.

**3. Report destination?**
Recommended: both, split by weight. Full reports (JSON/MD/SARIF) are CI artifacts and local `reports/` output (gitignored) — they contain exploit-adjacent detail and shouldn't accrete in git history. The trend history (`history/trend.jsonl`: per-run counts new/fixed/persisting per target, no finding bodies) is committed by the weekly CI job. SARIF additionally uploads to GitHub code scanning for repos where that's enabled.
Decision: adopted.

**4. Baseline/suppression approval?**
Recommended: baseline entries live in `config/baseline.json`; every entry requires `justification`, `expiry` (ISO date), and `approvedBy` (GitHub handle). Approval mechanism = PR review on changes to that file (CODEOWNERS assigns it to the security owner — michaelhazza). Expired entries re-alert at full severity. The tool validates the three fields and rejects a baseline file with missing/expired-malformed entries.
Decision: adopted.

**5. Clone-on-demand vs sibling checkouts?**
Recommended: both — registry entry takes optional `localPath`; when absent, shallow-clone (read-only, depth 1, pinned to default branch HEAD; commit SHA recorded in the report) into a cache dir. CI always clones on demand with a read-only token. Local dev can point at sibling checkouts for speed.
Decision: adopted.

**6. CI: pinned Docker image or per-run installs?**
Recommended: the pinned runner image (Dockerfile already mandated as the install story). Build + push to GHCR on Dockerfile change; the weekly scan workflow runs inside it. Per-run installs would re-introduce the version drift the Dockerfile exists to kill.
Decision: adopted.

**7. Authenticated live scanning — how does the tool get a test-user session?**
Recommended: per-target auth config in the registry names env vars (e.g. `authEnvUser: "AUDIT_STAGING_ACME_USER"`) — never literal credentials in config. Values come from GitHub Actions secrets (CI) or the local env. The live engine performs a scripted login to obtain a session for ZAP's authenticated crawl. If creds are absent, the scan runs unauthenticated and the report marks an explicit coverage gap (not a silent skip).
Decision: adopted.

**8. Staging data + active-scan mutation policy?**
Recommended: assume staging holds synthetic/representative data (assert, don't verify — owner attests per target). Active scanning inherently writes (form submissions, injection probes), so each target entry carries `activeScan: true | false`, defaulting to **false** (passive + non-intrusive Nuclei only). Enabling active scan is an explicit per-target opt-in by the target's owner, who also owns post-scan cleanup (staging reset). The tool tags all traffic with the auditor User-Agent so staging logs can identify and purge scan-generated records.
Decision: adopted.

> Soft checkpoint after 8 rounds: all launch-prompt branches resolved; no open
> branches. Terminating per autonomous policy (no operator present to continue).

## Post-grill amendments (operator review, 2026-06-12)

Operator directional review of the spec refined two grill decisions:

- **Q7 (authenticated scanning):** unauthenticated-fallback-with-coverage-gap
  now applies only to `activeScan: false` targets. For `activeScan: true`
  targets, missing creds or failed login **fail the run** — active checks
  (IDOR needs exactly 2 test users) must never silently degrade to passive.
- **Risk Surface:** changed from "None." to descriptive prose (see § Risk
  Surface above).
