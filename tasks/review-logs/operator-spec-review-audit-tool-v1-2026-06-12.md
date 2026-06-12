# Operator directional spec review — audit-tool-v1

**Artifact:** docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md
**Reviewer:** operator (michaelhazza), gate check before Phase 2
**Date:** 2026-06-12
**Verdict:** CHANGES_REQUESTED — do not proceed to Phase 2 until HIGH 1–3 patched; build-ready after.

## Findings and dispositions (all applied 2026-06-12)

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| HIGH-1 | high | Shipped config invalid: allowlist cross-check vs disabled sample target + empty allowlist | Applied — §6.2: cross-check scoped to `enabled: true` targets; disabled targets may exist off-allowlist; enabling requires prior allowlisting. |
| HIGH-2 | high | Partial runs corrupt trend: failed scanner's missing findings counted as `fixed` | Applied — §6.5 partial-run rule: trend computed only for completed (target × scanner-family) dims; `unknown` status; `fixed` never computed from incomplete families. Guardrail test added to §10; §14 cross-ref. |
| HIGH-3 | high | IDOR needs two test users; auth schema had one credential pair | Applied — §6.2 `auth.testUsers` array: ≥1 entry with auth, exactly 2 when `activeScan: true`; missing/failed creds on active targets → run `failed`, never silent passive downgrade. §7.3 + §14 cross-refs; intent grill Q7 amended. |
| MEDIUM-1 | medium | Baseline suppression keyed only on truncated `findingId` | Applied — §6.4 scoped suppression: findingId + ruleId + target (+ optional locationKey), all-fields-match; cross-target suppression test added to §10. |
| MEDIUM-2 | medium | "Risk surface: None." inaccurate for a security scanner | Applied — Lifecycle Declaration + intent.md § Risk Surface now descriptive (staging traffic / repo read access / findings artifacts). |
| MEDIUM-3 | medium | P3 test-first unenforceable before P6 harness | Applied — minimal benchmark harness moved into P1; P6 owns live-fixture integration, guardrail tests, Dockerfile, CI, self-scan, docs sweep. |
| NOTE-1 | non-blocking | Add branded `LoadedAllowlist` so arbitrary arrays can't reach `assertAllowlisted` | Applied — §4.10: brand mintable only in `src/config/load.ts`; benchmark loader schema-restricted to loopback hosts. |

Spec frontmatter advanced `reviewing → accepted` per the review's "build-ready
after fixes" gate outcome. Full review text preserved in the session transcript;
this log is the durable record.
