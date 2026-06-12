# Claude Spec Review — audit-tool v1 (SAST + staging-only DAST)

**Artifact:** docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md
**Reviewer:** claude-spec-review.v1
**Timestamp:** 2026-06-12T11:05:00Z (coordinator-persisted)
**Round:** 1 of 3 (no PRIOR_ROUNDS)
**source_artifact_sha:** 8e9401069d7f2491e9cae7e38419767827d0e6b0f317a004c3bcc2524679ea61
**project_context_version:** pc-audit-tool-2026-06-12-r1

## Files NOT read
- `architecture.md` — DOES NOT EXIST (fresh repo). Noted per launch instruction; does not block the verdict. The spec is self-contained on architecture (§5) and the checklist's RLS/architecture sections are correctly marked N/A (no DB).
- `docs/capabilities.md`, `docs/mobile-capability-principles.md` — not read; not verdict-changing (capabilities register confirmed empty by intent.md; mobile correctly N/A — pure backend/CLI).

## Findings

| ID | Sev | Type | Scope | Title |
|----|-----|------|-------|-------|
| CR-001 | medium | other | local | Dangling cross-reference to §8.1 — the severity-recompute order subsection is never numbered |
| CR-002 | medium | security | architectural | Safety contract: the `allowlist` passed to `assertAllowlisted` is an unpinned parameter — no module is named as the sole authority for the production allowlist path |
| CR-003 | low | input_validation | local | `stagingTargets[].auth.kind` has no closed enum despite gating the active-scan login path |

## Detail

### CR-001 — Dangling §8.1 reference (medium, local)
§9 states "severity recomputed (§8.1)" (twice: §8 modifier #1 cross-ref and §9 merge paragraph), but §8 ("Severity model") has no subsection numbered §8.1 — the ordered-modifier list is unnumbered prose under §8. A context-free executor implementing correlation (P5) cannot resolve "§8.1" to a concrete rule set. The content exists (the four ordered modifiers in §8); only the anchor is missing. Fix: either number the modifier list §8.1 or change the two references to "(§8)".

### CR-002 — Allowlist source authority not pinned (medium, architectural, SAFETY)
§4.1 makes the brand-type chokepoint airtight at the *call* boundary: only `assertAllowlisted(url, allowlist)` can mint an `AllowedTarget`. But the second argument, `allowlist`, is a free parameter. §10 relies on this: the benchmark "injects fixture hostname into a benchmark-scoped allowlist file … the shipped `config/allowed-staging-hosts.json` is untouched." That means the gate trusts whatever allowlist array its caller hands it. The spec never names the single module/function responsible for loading the production allowlist, nor states the invariant that every non-benchmark CLI entrypoint MUST source the allowlist from `config/allowed-staging-hosts.json` and from nowhere else. Without that pin, the "structurally impossible to scan a non-allowlisted host" guarantee (§4 preamble) holds only for the host check, not for the *allowlist provenance* — a future caller (or a flag that points `--allowlist` at another file) would satisfy the type system while defeating the contract. This is the exact hole class the framing flags as highest-value (assumption 3). Fix: add a §4 clause naming the sole production allowlist-load path (e.g. `src/config/load.ts` is the only non-benchmark source; benchmark allowlist injection is permitted ONLY from `benchmark/run.ts`), and state that no CLI flag/env can substitute an allowlist file. This is operator-facing (it constrains the CLI surface), hence not auto-applyable.

### CR-003 — `auth.kind` not a closed enum (low, local)
§6.2 shows `auth: { "kind": "form", … }`. The active-scan login path (§7.3, authenticated crawl with two test users) is load-bearing for IDOR/session checks, and `vulnClass` (§6.7) is explicitly a closed set requiring a spec amendment — but `auth.kind` is shown with a single value and no enumeration or closure rule. A defensible default exists (`"form"` only in v1), so this is low, not a blocker. Fix: state the closed set (e.g. `"form"` only in v1; others require amendment) in §6.2.

## Integrity check
PROJECT_CONTEXT present with Stage + Framing assumptions; Architecture/Guidelines correctly N/A (no DB, confirmed by spec-context.md and §11). Fail-closed rule not triggered. Round 1 of 3, no PRIOR_ROUNDS. Testing posture (runtime_primary/e2e, benchmark as primary gate) is by-design per docs/spec-context.md and was NOT flagged. Heavy runtime-test plan, missing monitoring/alerting/feature-flags, and tech-stack choices were NOT flagged (framing assumptions 2, 4, 5). Counts reconciled (11 custom rules = 7 ts-morph + 4 semgrep; 3 wrapped scanners; 4 CLI commands; 6 phases; 2 workflows) — all consistent with §11/§15. Phase graph (§12) checked: no backward references. State machine (§14) closed and pinned. Idempotency/retry/terminal-event/concurrency all declared (§14). Deferred Items present (§13). Frontmatter, Lifecycle Declaration, ABCd all present.

## Summary
3 findings: 0 blocking, 2 medium, 1 low. The spec is unusually clean — contracts have worked examples, fingerprints/source-of-truth precedence are pinned, the safety contract is mechanized. CR-002 is the only finding touching the non-negotiable safety surface and is a provenance gap, not a weakening. None block the build; all three are section-level clarifications.

## Verdict
CHANGES_REQUESTED (no blocking findings; medium-severity clarifications recommended before build, chiefly CR-002 closing the allowlist-provenance gap in the safety contract).
