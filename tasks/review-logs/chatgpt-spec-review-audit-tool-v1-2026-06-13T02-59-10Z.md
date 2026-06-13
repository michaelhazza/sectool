# ChatGPT Spec Review Session — audit-tool-v1 — 2026-06-13T02-59-10Z

## Session Info
- Spec: docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md
- Branch: claude/lucid-albattani-kczh64
- PR: none — current branch is the repo default branch (origin/HEAD → claude/lucid-albattani-kczh64); no separate `main` base exists, so no PR diff is meaningful. The CLI reviews the spec file content directly; PR persistence is not applicable this session.
- Mode: automated
- Autonomy: attended (operator paused the pipeline for review; HUMAN_IN_LOOP forced off — operator directed "proceed and report", user-facing findings collected into report, not gated inline)
- Prior reviewers: claude-spec-review (7 findings applied), Codex spec-reviewer 2-iteration loop (28 mechanical fixes, verdict READY_FOR_BUILD). This is the third/final reviewer — task: find what the prior two missed; do NOT re-raise resolved items (6-state fix machine, §5.2 sole-outward-network wording, BS-RLS-001 symbol=table-name, externalRefs rehydration precedence, P8 fix-endpoint boundary, RunReport §6.9 / scannerFamily §6.8 / SARIF §6.10, allowlist scheme/port tightening, workspace-lock).
- §4 NON-NEGOTIABLE: staging-only allowlist contract — never propose weakening.
- Started: 2026-06-13T02-59-10Z

---

## Round 1 — 2026-06-13T02-59-10Z

**CLI:** `npx tsx scripts/chatgpt-review.ts --mode spec --file <spec>` (exit 0). Model: gpt-5.5 (per CLI default), prompt v2. **Verdict: CHANGES_REQUESTED.** 9 findings, all fresh (none re-raise the prior-resolved item set). CLI supplied no `proposed_edits` (auto_apply_eligible=false on all) — coordinator authored the spec edits directly per recommendation.

**Setup notes:** No PR — current branch is the repo default (origin/HEAD → claude/lucid-albattani-kczh64); no `main` base exists, so a PR diff is not meaningful. CLI reviews spec-file content directly, so this does not affect the review. CLI runtime deps (`ajv`, `ajv-formats`) were absent from the empty `node_modules`; installed with `npm install --no-save` (committed package.json unchanged). `OPENAI_API_KEY` present.

### Recommendations and Decisions
| Finding | Triage | Recommendation | Final Decision | Severity | Rationale |
|---|---|---|---|---|---|
| OAI-SPEC-001 RunReport/Finding lacks full `fingerprint`; only truncated `id` exposed, but SARIF + fixes.json need full sha256 | technical (risk: idempotency) | implement | auto (apply) | high | Real internal-contract gap — added `fingerprint` 64-hex field to §6.1 + pinned it as the fixes.json/SARIF/join key. High-sev but purely an internal contract (no visible behaviour); auto-applied per operator's auto-apply-technical directive, flagged in report. |
| OAI-SPEC-002 `fixes.json` rehydrate step listed as both writer and read-only (§14) | technical (risk: data_integrity) | implement | auto (apply) | medium | Direct contradiction — removed rehydrate from the writer list; pinned it as a pure read-only projection (no byte/mtime change). |
| OAI-SPEC-003 TrendHistory schema has no field for the `unknown` partial-run status the Trends screen renders | **user-facing** (risk: user_visible) | implement | **DEFERRED to operator (unapplied)** | medium | Reviewer hint = user-facing; default-to-user-facing applies. Determines how partial runs render on the Trends UI screen AND requires a product call on where `unknown` lives (target-level vs scanner-family-level). Collected for operator decision; NOT applied. |
| OAI-SPEC-004 Report ordering has no final stable tiebreaker despite stable-byte-output claim | technical (risk: none) | implement | auto (apply) | medium | Added `ruleId → full fingerprint` as the total tiebreaker in §8.1; aligned §9 dedupe from "sorted by id" → full fingerprint. |
| OAI-SPEC-005 Fixed 2h stale-lock can break a still-running legitimate long portfolio scan | technical (risk: data_integrity) | implement | auto (apply) | high | Real cross-file-corruption gap (no target cap → run can exceed 2h). Replaced wall-clock staleness with pid-liveness + 60s heartbeat; a live holder is never broken. Internal safety property; auto-applied, flagged. |
| OAI-SPEC-006 §4 allowlist never classifies IP-literal URLs (IPv4 numeric/octal/hex, bracketed IPv6) | technical-escalated (risk: security) | implement | auto (apply) | high | Touches the NON-NEGOTIABLE §4 contract but is a pure **strengthening** (reject IP literals in production), consistent with prior Codex scheme/port tightenings — never a relaxation, so it cannot draw an operator objection. Added clause (d) to §4.2 + §10 guardrail. Auto-applied, flagged prominently. |
| OAI-SPEC-007 HTML evidence-safety covers `<script>` but not non-visible DOM carriers (`<style>`/`<template>`/comments/attrs/hidden subtrees) | technical-escalated (risk: security) | implement | auto (apply) | medium | Strengthens an existing safety contract; named the full non-visible-carrier matrix in §5.2 + added §10 guardrail test. No posture change. |
| OAI-SPEC-008 Fix-request idempotency claim holds for issues but allows duplicate GitHub comments | technical (risk: idempotency) | implement | auto (apply) | medium | Pinned comment-level idempotency: deterministic `audit-fix:<fingerprint>:<reason>` marker + search-before-comment; aligned §14 retry-class wording. |
| OAI-SPEC-009 successCheck OR is carrier-agnostic — bearer target can "succeed" on cookie-only and vice versa, silently running active scans unauthenticated | technical-escalated (risk: security/input_validation) | implement | auto (apply) | medium | Correctness gap that silently degrades IDOR/access-control coverage. Made successCheck carrier-aware in §6.2 + added §10 guardrail. |

### Applied (auto-applied technical — 8 of 9)
- [auto] §6.1 + new lifecycle paragraph: added full `fingerprint` field; pinned as canonical fixes.json/SARIF/join key, `id` is display-only (OAI-SPEC-001)
- [auto] §14: removed rehydrate step from the fixes.json writer list; pinned as read-only projection (OAI-SPEC-002)
- [auto] §8.1 + §9: `ruleId → full fingerprint` total tiebreaker; dedupe sorts by full fingerprint (OAI-SPEC-004)
- [auto] §14: workspace-lock staleness → pid-liveness + 60s heartbeat, never elapsed-run-time (OAI-SPEC-005)
- [auto] §4.2 + §10 guardrail: reject IP-literal URLs in the production allowlist gate — §4 strengthening (OAI-SPEC-006)
- [auto] §5.2 + §10 guardrail: HTML evidence inert-text rule extended to all non-visible DOM carriers (OAI-SPEC-007)
- [auto] §5.3 + §14: comment-level idempotency marker + search-before-comment (OAI-SPEC-008)
- [auto] §6.2 + §10 guardrail: carrier-aware login successCheck (OAI-SPEC-009)

### Deferred to operator (user-facing — 1, UNAPPLIED)
- [user] OAI-SPEC-003 — TrendHistory `unknown` partial-run status field. Needs an operator product call (where `unknown` lives: target-level vs scanner-family-level) because it shapes how partial runs render on the Trends screen. Routed to tasks/todo.md.

### Integrity check (step 4a)
3 issues found this round (auto: 3, escalated: 0). All mechanical, all from this round's edits:
- §6.10 SARIF `auditToolFingerprintV1` / §5.3 fixes.json key / §6.9 RunReport.findings now reconciled to the new §6.1 `fingerprint` field — no longer reference a value the contract didn't expose.
- §5.2 forward reference to "§10 references it" resolved by adding the HTML-evidence-matrix guardrail to §10.
- §9 "sorted by id" / §14 "stale after 2h" (Concurrency bullet) restatements aligned to the new full-fingerprint and heartbeat contracts; no stale duplicates remain. (Recursion guard honoured — no re-run on integrity-introduced edits.)

**Top themes:** contract-key precision (truncated `id` vs full `fingerprint` leaking into idempotency/join paths), liveness-vs-wall-clock in the workspace lock, and carrier/edge-case completeness in two security predicates (allowlist IP literals, auth successCheck). All three classes were missed by claude-spec-review and the 2-round Codex loop — they are second-order consistency gaps that only surface once the §6.9/§6.10/§5.3 contracts the prior loop *added* are read against each other.

---

## Round 2 (convergence) — 2026-06-13T (automated)

**CLI:** `npx tsx scripts/chatgpt-review.ts --mode spec --file <spec>`. First call hit a transient OpenAI 520 (Cloudflare gateway, exit 1 — not a schema/parse/version error); retried after 15s → exit 0. Model: gpt-5.5 (served `gpt-5.5-2026-04-23`, model_match=true), prompt v2. **Verdict: CHANGES_REQUESTED.** 6 findings, **all fresh** — none re-raises any round-1 resolved item (full `fingerprint`, §14 rehydrate-as-read-only, report tiebreaker, pid-liveness lock, §4 IP-literal rejection, HTML carrier matrix, comment idempotency, carrier-aware successCheck) and none re-raises OAI-SPEC-003 (TrendHistory `unknown` status, now resolved in §6.5). CLI supplied no `proposed_edits` (auto_apply_eligible=false on all 6); coordinator authored spec edits per recommendation. HUMAN_IN_LOOP off (operator directed "proceed and report"); user-facing/escalated items collected unapplied for operator decision.

Posture restored from session log: Mode=automated, Autonomy=attended with operator "proceed and report". No PR (branch IS repo default; no `main` base — PR persistence n/a, as round 1).

### Recommendations and Decisions
| Finding | Triage | Recommendation | Final Decision | Severity | Rationale |
|---|---|---|---|---|---|
| OAI-SPEC-001 Baseline §6.4 suppression matches on truncated `findingId`, contradicting §6.1's full-`fingerprint`-is-canonical rule (round-1 left §6.4 keyed on the truncated id) | technical (consistency tightening; risk: security) | implement | auto (apply) | high | Pure reconciliation of a round-1 second-order gap + a security *strengthening* (removes a truncated-collision suppression path). No operator-visible copy/workflow change — the copy-baseline JSON's internal id field becomes a stable fingerprint (a §5.2 "technical-details" identifier, never a headline). Made full `fingerprint` the match key; `findingId` retained as optional echo with load-time cross-check; §10 scoped-suppression guardrail extended to the 16-hex-prefix-collision case. |
| OAI-SPEC-002 SARIF suppression `justification` must come from the archived `RunReport`, but `RunReport.findings[]` carries only `suppressed: bool` — re-emit would read mutable config, breaking §6.9 source-of-truth + §6.10 determinism | technical (consistency; risk: compliance) | implement | auto (apply) | medium | Internal-contract gap. Added report-stage-derived `suppression` field (justification+approvedBy+expiry) to §6.1 Finding + lifecycle paragraph; §6.10 now reads justification from the finding, not config; §6.9 nullability list updated. No visible-behaviour change. |
| OAI-SPEC-003 §12 P6 row claims it owns "guardrail tests §10" and is P7/P8-independent, but the §10 HTML inert-text matrix tests the P7 HTML exporter | technical (sequencing) | implement | auto (apply) | medium | Pure phasing reconciliation. Scoped P6 row to the 5 engine-available guardrails; assigned the HTML matrix to P7 `src/report/html.test.ts` as a final-ship requirement; reconciled the §10 bullet. No visible-behaviour change. |
| OAI-SPEC-004 Localhost UI "Send for fixing" (P8) write endpoint has no HTTP/anti-CSRF contract — a malicious site could drive a cross-origin POST to 127.0.0.1 and spend the GitHub `issues:write` token | **user-facing / technical-escalated** (risk: security) | implement | **COLLECTED for operator (unapplied)** | high | Real gap, but prescribing a concrete new HTTP/CSRF protocol (route shape, `X-Audit-CSRF` nonce, `Origin` checks, 403 paths) shapes a visible request/response contract the SPA must honour and the reviewer flagged `operator_decision_required_reason`. Per default-to-user-facing + operator's "never auto-apply visible-behaviour" guard: collected with a recommended conservative pin, not auto-authored. NOT a §4 change. |
| OAI-SPEC-005 No redaction boundary for discovered secrets/credentials — gitleaks hits, `Set-Cookie`, bearer tokens, secret-bearing snippets get persisted/republished into reports, SARIF/HTML/MD, fix packs, and GitHub issues (HTML-escaping prevents XSS, not secret leakage) | **user-facing / technical-escalated** (risk: security) | implement | **COLLECTED for operator (unapplied)** | high | Real, serious gap — but introduces a NEW product capability (a redaction layer) that changes what evidence the operator sees in reports and what is written to external GitHub issues (an evidence-retention policy). Reviewer flagged `operator_decision_required_reason` ("operator must approve the evidence-retention boundary"). Collected with a recommended conservative default; not auto-applied. |
| OAI-SPEC-006 §5.3 `verified-fixed` transition not fenced by scanner-family completion — a merged fix could graduate just because its fingerprint is absent from a report where the responsible family *failed* (the §6.5 partial-run masquerade, un-applied to the fix machine) | technical (consistency tightening; risk: data_integrity) | implement | auto (apply) | medium | Pure consistency tightening — extends §6.5's completed-family predicate to the §5.3 `verified-fixed` transition. Updated step 4 + the derivation block + §6.8 consumer list. No visible-behaviour change (a partial run already shows `unknown`; this just stops the fix pill from lying). |

### Applied (auto-applied technical — 4 of 6)
- [auto] §6.4 + §10: baseline suppression match key = full 64-hex `fingerprint` (not truncated `findingId`); `findingId` optional echo with `=== "f-"+fingerprint.slice(0,16)` load-time cross-check; guardrail extended to the prefix-collision case (OAI-SPEC-001)
- [auto] §6.1 (+ lifecycle paragraph) + §6.9 + §6.10: report-stage-derived `suppression` field carries the matched baseline justification onto the finding so SARIF re-emit is self-contained/deterministic from the archived RunReport (OAI-SPEC-002)
- [auto] §12 P6/P7 + §10: P6 owns only the 5 engine-available guardrails; HTML inert-text matrix → P7 `src/report/html.test.ts` as a final-ship requirement (OAI-SPEC-003)
- [auto] §5.3 step 4 + derivation block + §6.8: `verified-fixed` fenced by `(target × scannerFamily)` completion, mirroring the §6.5 partial-run rule (OAI-SPEC-006)

### Collected for operator (user-facing / escalated — 2, UNAPPLIED)
- [user] OAI-SPEC-004 — UI fix-write endpoint anti-CSRF/origin contract. Recommended conservative pin: bind P8 endpoint to a per-process `X-Audit-CSRF` nonce + same-origin `Origin: http://127.0.0.1:<port>` check, reject foreign/missing origin with 403, never emit `Access-Control-Allow-Origin: *`. Routed to tasks/todo.md.
- [user] OAI-SPEC-005 — secret/credential redaction boundary for reports/exports/fix-packs/GitHub issues. Recommended conservative default: redact gitleaks secret values, `Set-Cookie`/bearer values, and env-derived credentials to a stable hash/placeholder in every emitted artifact (report.json/MD/SARIF/HTML/stdout/fix pack), keeping enough for triage; this is an evidence-retention policy the operator should set. Routed to tasks/todo.md.

### Integrity check (step 4a)
4 issues found this round (auto: 4, escalated: 0). All mechanical, all from this round's edits:
- §10 *Scoped suppression* guardrail bullet re-keyed from `findingId` → full `fingerprint` + prefix-collision case (reconciled to the new §6.4 match key).
- §10 *HTML evidence inert-text matrix* bullet annotated with its P7 `src/report/html.test.ts` ownership (reconciled to the new §12 phasing).
- §6.9 nullability/defaults list updated to include the new optional `suppression` finding field.
- §6.8 consumer list extended to name the §5.3 `verified-fixed` fence as a third consumer of family-completion. (Recursion guard honoured — no re-run on integrity-introduced edits.) Post-integrity sanity (4c) clean: no dangling heading reference, no emptied section.

**Top themes:** the two contracts round 1 *added* (full-`fingerprint` canonicality §6.1, scanner-family completion §6.5/§6.8) had not been propagated to two places that should obey them — baseline suppression matching (§6.4) and the fix-verification transition (§5.3) — classic third-pass second-order drift, both auto-reconciled. The SARIF-justification gap (§6.9 self-containment) is the same "archived artifact must be re-emittable without live config" property as round-1's externalRefs/rehydrate work. The two genuinely NEW surfaces the prior loops never raised — UI-endpoint CSRF and secret redaction — are real, high-severity, and correctly operator-decisions (they change a visible request contract and an evidence-retention policy respectively), so they are collected, not auto-applied.

---
