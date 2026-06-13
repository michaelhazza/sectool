# Capabilities — Asset Register

Capability clusters for audit-tool. Read by `spec-coordinator` Step 3a
(duplication / strategy check). Schema per the governance spec §7.4: one row
per capability; lifecycle states: Inception | Growth | Mature | Declining |
Sunset Candidate | Sunset.

## Clusters

`Static Scanning` · `Live Scanning` · `Correlation & Reporting` · `Report UI` · `Remediation Orchestration` · `Target Registry & Safety` · `Benchmark & Quality`

## Register

| Name | Cluster | Description | Lifecycle state | Owner |
|---|---|---|---|---|
| Static source scanning | Static Scanning | Scans registered source repositories for security issues — secrets, dependency CVEs, and code-pattern weaknesses (auth, RLS/tenant isolation, SQL, XSS, upload, websocket) — and emits normalized, redaction-passed findings per repo. | Inception | michaelhazza |
| Live staging scanning | Live Scanning | Runs passive and (where a target opts in) active checks against allowlisted staging hosts only, covering common runtime exposures and authenticated coverage. Every live target is gated by the safety allowlist before any request is sent. | Inception | michaelhazza |
| Correlation & reporting | Correlation & Reporting | Merges static and live findings into one deduplicated, severity-prioritized remediation report with stable fingerprints, baselines, and trend history across runs; exports JSON, Markdown, SARIF, and HTML. | Inception | michaelhazza |
| Report dashboard | Report UI | A local, read-only web dashboard for browsing a run's findings, targets, fixes, and trends; serves on loopback only and performs no scanning. | Inception | michaelhazza |
| Remediation orchestration | Remediation Orchestration | Packages a finding into a remediation request and files it to the linked repository as a GitHub issue, through a token-scoped, origin-checked local endpoint. | Inception | michaelhazza |
| Target registry & safety | Target Registry & Safety | The checked-in registry of repos and staging hosts plus the non-negotiable allowlist gate that confines live scanning to approved hosts with no override path. | Inception | michaelhazza |
| Benchmark & quality | Benchmark & Quality | A recall/precision benchmark over a checked-in corpus that gates merges on detection quality. | Inception | michaelhazza |

> This repo was bootstrapped 2026-06-12. The audit-tool v1 build is the first
> entry; its capabilities are seeded here from the spec's Lifecycle Declaration
> (`docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md` §Lifecycle
> Declaration: clusters, owner michaelhazza, state Inception). Registered by the
> chatgpt-pr-review ship-gate (2026-06-13).
