# Spec Review Log — claude-spec-review (first pass)

**Artifact:** `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md`
**Date:** 2026-06-13
**Verdict:** CHANGES_REQUESTED (3 blocking, 4 advisory) — all in the 2026-06-12/06-13 amendment surfaces; §4 staging-only safety contract reviewed and found intact (no UI→live-engine path, `issues:write`-only token, abort test immutable).

## Findings + disposition (all applied by coordinator)

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| CSR-001 | blocking | Fix-state machine mismatch: §5.3 = 5 states, §5.2 prose + both prototypes = 6 (distinct `awaiting-review`). | **APPLIED** — expanded §5.3 to the authoritative 6-state machine with GitHub-state derivation per state. Conforms spec *up* to the operator-approved mockup. Operator-flagged (product semantics). |
| CSR-002 | blocking | "Sole outward action" wording false — prototype also has local clipboard copies; weakens a safety claim. | **APPLIED** — reworded §5.2 to "sole outward *network* action"; clipboard copies named as local-only; §4 anchor moved to no-live-engine-import + `issues:write`-only properties. |
| CSR-003 | blocking | `symbol`/`locationKey` undefined for schema-level findings (BS-RLS-001 has no route/function) — breaks fingerprint stability + baseline suppression for the flagship rule class. | **APPLIED** — §6.6 now defines `symbol` = normalized table name for schema-level rules; reconciled prototype sample (`createSubscriptionsTable` → `subscriptions`). |
| CSR-004 | advisory | `externalRefs` survival across re-scan unstated; precedence vs `fixes.json` undefined. | **APPLIED** — §5.3 step 2 + §6.1 comment: `fixes.json` (fingerprint-keyed) authoritative; `externalRefs` derived on report build via fingerprint join, mirroring §6.5. |
| CSR-005 | advisory | §15 self-consistency rubber-stamped the CSR-001 mismatch. | **APPLIED** — §15 line re-derived against the 6-token canonical set across §5.3/§5.2/prototypes/`fix.ts`. |
| CSR-006 | advisory | §11 implies fix-request endpoint in P7; it depends on P8 (`src/fix/*`). | **APPLIED** — §11 `src/ui/server.ts` row marks read-only endpoints P7, fix-request endpoint P8. |
| CSR-007 | advisory | Duplicate locator for CSR-001 (§5.2 Fixes row). | **APPLIED** — covered by the CSR-001 atomic update; §5.2 already carried 6 states. |

## Operator-flagged decisions (made autonomously, conform spec to approved mockups)
- **6-state fix machine** (CSR-001): chose to expand to 6 rather than collapse to 5, because the operator already saw and approved the 6-step pipeline in `fixes.html`/`finding-detail.html`. Reversible if the operator prefers 5.
- **Schema-symbol = table name** (CSR-003): deterministic and AST-derivable; preferred over the synthesized `createSubscriptionsTable`.
