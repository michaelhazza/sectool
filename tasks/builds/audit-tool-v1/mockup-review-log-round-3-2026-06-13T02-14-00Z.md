# Mockup Review — audit-tool-v1 Round 3
Reviewer: mockup-reviewer (read-only)
Scope: index.html, run-report.html, finding-detail.html, fixes.html (NEW), trends.html, targets.html, mobile-preview.html (NEW), _shared.css
Spec: docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md (§5.2, §5.3, §6.x, §8.1)
Grounding basis: operator-directed greenfield — grounded against spec data contracts, not existing components (confirmed: no client/src/pages exists; Round 1/2 greenfield declaration stands).

## Axis 1 — Grounding (against spec data contracts)

[🟡 fixes.html:572,629,684,749] Sample data invents four rule IDs that are NOT in the spec §7.1 closed rule inventory: `BS-AUTH-003`, `BS-AUDIT-001`, `BS-INFO-002`, `BS-VALID-002`. The spec §7.1 inventory is a closed set (BS-RLS-001, BS-SQL-001, BS-SQL-002, BS-AUTH-001, BS-AUTH-002, BS-JWT-001, BS-UPLOAD-001, BS-XSS-001, BS-CORS-001, BS-WS-001, BS-VAL-001); §6.7 marks adding a value as requiring a spec amendment. `BS-VALID-002` is additionally a near-miss for the real `BS-VAL-001`, which risks the implementer treating the mockup as the source of the identifier. Secondary monospace sub-lines (not headlines), so Should-fix. Recommend re-keying to real inventory IDs.
  Why: docs/frontend-design-principles.md "Vocabulary matches the codebase" / mockup-reviewer Axis 1; spec §6.7 closed-enum rule.

[💭 fixes.html merged state] The "Merged: scan confirming" plain-English label maps to spec §5.3 canonical state `merged-awaiting-verification`. Correct for the operator; confirm implementer maps it back to the canonical state. No mockup change needed.
  Why: spec §5.3 fix-request state machine (closed set); §15 self-consistency.

Grounding otherwise CLEAN: all 6 dashboard screens map to §5.2 screen table; fix workflow files an issue and never implies the tool writes code; all 5 state-machine states + reopened present; §8.1 severity trace faithful incl. tenant-isolation floor; allowlist empty-default + cross-check match §4.2/§6.2; env-var-names-only rule honoured.

## Axis 1.5 — Cross-cutting UI safety
[CLEAN] Missing AUDIT_GITHUB_FIX_TOKEN capability-failure state drawn in finding-detail.html and fixes.html with plain explanation + "Copy fix instructions" manual fallback.
[CLEAN] No PII-adjacent emitted field names; token shown as env-var NAME only, never a value.
[CLEAN] Baseline-entry copy affordance renders all §6.4 fields as one grouped block — no partial entry possible.

## Axis 2 — Simplicity / operator overload (judged hard against a non-technical founder)
Plain-language overhaul genuinely met, not cosmetic: severity → Fix now/Fix soon/Plan it/Low risk; consequence-first titles; "In the code / On the live test site"; "Approved test sites"; "Acknowledged risks"; rule IDs + fingerprints in monospace sub-lines or collapsibles; no scanner-name headlines; no em-dashes (Grep clean). Residual nits:

[🟡 finding-detail.html:507,526] Code-evidence block and correlated static+live evidence pair default `<details open>`, exposing raw Drizzle/SQL/HTTP snippets before any scroll — contradicts the demote-internals ask. The severity trace correctly defaults closed (line 563); apply the same to these two.
  Why: frontend-design-principles "Progressive disclosure" / "Default-collapsed disclosures"; operator Round-3 ask #1.

[🟡 run-report.html:214-305] Three distribution charts above the findings table on the primary "what do I fix" screen. Complexity budget defaults charts to 0 unless the screen's task is monitoring; this screen's task is act-on-most-urgent. mockup-log Round 1 cites an operator request for charts — so this needs an operator call, not an automatic rework. Largest remaining overload on the highest-traffic screen.
  Why: frontend-design-principles "Complexity budget per screen" / "Visuals as simplicity".

[💭 run-report.html:186-211 + fixes.html:412-429] run-meta-strip (6 stats) + fixes summary (4 tiles) exceed the 2-stat soft guidance but pass the "would the operator act on this?" test (contextual run/pipeline counts). Noted for drift watch.

[💭 finding-detail.html:691-692] Fingerprint `f-3f9a1c2b8d4e0a17` visible by default in sidebar metadata rather than behind the Technical-details disclosure. Low weight; move for consistency.
  Why: frontend-design-principles "Hash / ID exposures: 0 by default".

## Axis 3 — Mobile capability (Tier 2; honoured)
Mobile shape on all 6 functional screens (responsive, 5-tab bottom nav + safe-area insets). mobile-preview.html renders the 6 real screens via live iframes at native 375px (not placeholders). No page-level horizontal overflow at 375px (overflow constrained to table-wrap / trend-chart-wrap / fix-pipeline-track / evidence-block regions). grid collapses at 768px. No fixed-width modals. Hover states are enhancements; rows have onclick tap equivalents.

[🟡 mobile-preview.html gallery] iframes have pointer-events disabled + aria-hidden + 64% scale, so the operator cannot scroll/interact inside a frame — proves above-the-fold shape only. Acceptable as a desktop designer utility (declared desktop-only) but does NOT by itself discharge the operator's "confirm every screen works on a phone" request. Real confirmation = opening each screen at 375px / via bezel links.
  Why: docs/mobile-capability-principles.md "mobile shape must be validated, not just depicted".

[🟡 run-report.html row "View" buttons] `min-height:36px` (secondary minimum) on the primary row action of a Tier-2 high-traffic list. Whole-row onclick gives a 44px+ tap target so the action is reachable, but the explicit button should reach 44px on touch.
  Why: docs/mobile-capability-principles.md "Touch target requirements" (primary 44px).

[🟡 fixes.html:262-272 + :444-450] Filter tabs `min-height:32px`, below the 36px secondary minimum, on a primary-ish control.
  Why: docs/mobile-capability-principles.md "Touch target requirements".

[💭 finding-detail.html send panel] "Send for fixing" primary button `min-height:48px` — exemplary. Safe-area handled. Good.

Mobile otherwise CLEAN.

## Summary
All three operator asks substantively satisfied: (1) plain-language overhaul real and consistent; (2) fix workflow complete (Send-for-fixing + missing-token state, full §5.3 state machine incl. reopened, 5-tab nav, "detect here fix there" never implies tool edits code); (3) mobile shapes genuine, gallery renders real screens. No blocking findings.

Blocking: 0 / Should-fix: 6 / Consider: 4
**Verdict: CLEAN**

---

## Caller disposition (feature/main session, 2026-06-13)
Applied in-place after CLEAN verdict (mechanical, reviewer-recommended, directly serve operator asks):
- Re-keyed the four invented rule IDs in fixes.html to the real §7.1 inventory.
- Collapsed the two `<details open>` evidence blocks in finding-detail.html to closed-by-default.
- Moved the fingerprint into the Technical-details disclosure.
- Raised touch targets: fixes.html filter tabs 32px→44px; run-report.html row View buttons 36px→44px.
Deferred to operator decision:
- Charts on run-report.html (operator previously requested charts; keep vs move to trends is a product call).
- mobile-preview gallery confirmation-scope clarification (surfaced to operator in the round summary).
