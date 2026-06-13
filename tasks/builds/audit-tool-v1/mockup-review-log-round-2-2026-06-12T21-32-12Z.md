# Mockup review log — audit-tool-v1, Round 2

Persisted verbatim by mockup-coordinator (inline) on 2026-06-12T21:32:12Z.

```mockup-review-log
# Mockup Review — audit-tool-v1 — Round 2 (re-review after rework)
Reviewer: mockup-reviewer
Date: 2026-06-12
Scope: prototypes/audit-tool-v1/{_shared.css,index.html,run-report.html,finding-detail.html,trends.html,targets.html}
Context loaded: docs/frontend-design-principles.md, docs/mobile-capability-principles.md, CLAUDE.md, spec 2026-06-12-audit-tool-v1-spec.md (§5.2/§6/§8.1/§9/§14), mockup-log.md Round 1 + Round 2.

## Round 1 finding verification (all four resolved)

[RESOLVED 🔴 em-dashes] Verified by Grep for `—` across the whole prototype directory: 0 matches in any HTML file or _shared.css. Designer claim confirmed. CLAUDE.md § User Preferences ("No em-dashes") now satisfied.

[RESOLVED 🟡 table column cap] run-report.html:346-352 table header is now Finding / Severity / Scan / (action) = 4 columns, within the frontend-design-principles.md § Complexity budget cap of 4. Type and Target moved to the `finding-rule` sub-line (e.g. run-report.html:359 "BS-RLS-001 · automation-v1 · Tenant isolation"), visible at all widths. Confirmed.

[RESOLVED 🟡 chart/filter jargon] run-report.html:238-265 bar labels are now "Injection / Access control / Tenant isolation / Vuln. dependencies / Exposed secrets / Other" with raw enum in `title` attributes; filter options (run-report.html:308-318) are plain-English text with spec enum strings in `value` attributes. mockup-designer.md § Step 3a operator-vocabulary rule satisfied for these surfaces.

[RESOLVED 🟡 dead-end hamburger] Grep confirms `.mobile-menu-btn` appears only as an unused CSS class declaration in _shared.css:578; no HTML file renders a hamburger button or `onclick="alert(...)"` dead-end. All five screens navigate via the bottom-tab nav only. mobile-capability-principles.md § Mobile navigation pattern satisfied (4-item bottom-tab, no dead-end).

## Regression + fresh-eyes checks

### Axis 1 — Grounding (CLEAN)
Greenfield is operator-directed (spec §5.2 amendment 2026-06-12) and re-confirmed in the Round 2 summary; src/ has no pages to extend, so the "extend don't invent" default is legitimately waived. No phantom nav: all four nav targets (Portfolio Overview, Findings Report, Trends, Targets & Safety) map 1:1 to the five spec §5.2 screens (finding-detail is a drilldown reached from Findings Report, correctly not a top-level nav item). No write actions, no scan-launch affordance anywhere; the only action is copy-baseline-JSON (finding-detail.html:486), which spec §5.2 explicitly sanctions as read-only. Vocabulary matches spec: rule/check IDs (BS-RLS-001, ZAP-A-101, LIVE-TLS-001), run statuses, vulnClass enums all faithful.

### Axis 1.5 — Cross-cutting UI safety (CLEAN)
Coupled-field invariant: the baseline-entry copy block (finding-detail.html:474-485) presents findingId + ruleId + target + locationKey + justification + expiry + approvedBy as one grouped JSON template, honouring the §6.4 all-fields-match suppression invariant; cannot produce a partial entry from the UI. No analytics/telemetry surface names PII-adjacent props; env-var NAMES only are shown (targets.html:396-397), never values, matching spec §6.2. No capability-check failure-state requirement (read-only renderer, no permission gates).

### Axis 2 — Simplicity / operator overload (CLEAN)
Spec §8.1 severity-floor copy reads in plain English ("tenant-isolation findings can never be rated below High", finding-detail.html:379). Charts are load-bearing for the monitoring task on run-report and trends (operator-requested, justified in the round summary) and are not counted against the chart cap per frontend-design-principles.md § Visuals as simplicity. One primary action per screen. Partial-run banner (index.html:220) is visually distinct from success (2px amber border + warning icon + named failed scanners), satisfying §6.5 masquerade rule applied to pixels.

### Axis 3 — Mobile capability (CLEAN)
Mobile shape present on all five screens (single responsive file each). Bottom-tab nav + safe-area insets present (_shared.css:597 `env(safe-area-inset-bottom)`, :570 `env(safe-area-inset-top)`). grid-2/grid-3/detail-layout/correlated-pair/meta-grid all reflow to single column at ≤768px. run-report findings table uses `.table-cards` card reflow below 768px. No fixed-width modals. No hover-only interactions: row hovers carry `onclick` tap equivalents (run-report.html:357); the §8.1-floor and "admin path" facts are permanently-visible inline text, not hover tooltips. Touch targets: nav items, View buttons, copy buttons, target tabs all min-height 44px. No page-level horizontal overflow at 375px; all overflow (evidence blocks, trend charts, run-history table) is constrained to `overflow-x:auto` regions.

## Findings

🟡 Should-fix

[🟡 trends.html:418-524 (run history table)] The 6-column run-history table (Run / Status / New / Fixed / Persisting / Total) is a plain `<table>` inside `.table-wrap` with `overflow-x:auto` and NO sticky-first-column and NO `.table-cards` reflow, unlike the run-report findings table which got card reflow. mobile-capability-principles.md § Tables on phones requires tables wider than 4 columns to pick one of three treatments; this table picks treatment 2 (horizontal scroll inside the region) but omits the sticky-first-column part of that treatment, so at 375px the "Run" identifier column scrolls away with the rest. For Tier 2 this is acceptable-but-weak (the overflow is region-constrained, not page-level, so not blocking). Recommend either making the first cell `position:sticky;left:0` or applying `.table-cards` reflow as the findings table already does for consistency.

[🟡 _shared.css:578-587 (dead CSS)] `.mobile-menu-btn` remains in the shared stylesheet though no screen renders it. Not a rendered-UI finding, but dead nav-affordance CSS invites a future re-introduction of the dead-end hamburger the Round 1 review removed. Recommend deleting the rule, or adding a comment that it is intentionally retained. Cosmetic; not gating.

💭 Consider

[💭 finding-detail.html:425,462 (ID exposure)] Finding ID `f-3f9a1c2b8d4e0a17` and correlated ID `f-7a2d9e1b4c5f0e88` surface in the metadata sidebar. frontend-design-principles.md § Complexity budget sets Hash/ID exposures to "0 by default", but this is a power-user finding-detail drilldown and the findingId is load-bearing for the §6.4 copy-baseline workflow (the JSON template requires it). Legitimate under the doc's admin/power-user relaxation; flagged only so the operator is aware the exposure is deliberate. No change required.

[💭 run-report.html:263 ("Other" bar)] The "Other" vuln-type bar (count 15) aggregates misconfiguration/xss/tls/etc. and is the second-largest bar, which slightly undersells the per-class breakdown the chart exists to show. Consider splitting the top one or two of those classes out. Taste only.

[💭 index.html:147 / all screens (emoji glyphs)] Lock/warning/wrench emoji (🔐 ⚠️ 🔧 📋 ⚡) are used as UI icons. They render inconsistently across platforms and at small sizes on some Android WebViews. Consider inline SVG for the load-bearing ones (the partial-run ⚠️ especially). Future-proofing only.

Blocking: 0 / Should-fix: 2 / Consider: 3
**Verdict:** CLEAN
```
