# Mockup review log — audit-tool-v1, Round 1

Persisted verbatim by mockup-coordinator (inline) on 2026-06-12T21:16:53Z.

```mockup-review-log
# Mockup Review — audit-tool-v1, Round 1
Reviewer: mockup-reviewer (read-only)
Scope: prototypes/audit-tool-v1/{_shared.css,index.html,run-report.html,finding-detail.html,trends.html,targets.html}
Context: spec §5.2 (screen scope), §6 (schemas), §7/§8/§9/§14; docs/frontend-design-principles.md; docs/mobile-capability-principles.md; CLAUDE.md.

## Axis 1 — Grounding (greenfield: trace to spec §5.2 + §6 schemas)
All five screens trace cleanly to the §5.2 screen table; nav items (Portfolio Overview / Findings Report / Trends / Targets & Safety) map 1:1 to four of the five screens, with finding-detail correctly a drilldown rather than a top-level nav target. Data fields trace to §6 (Finding 6.1, TargetRegistry 6.2, Allowlist 6.3, Baseline 6.4, TrendHistory 6.5, vulnClass 6.7); rule/check IDs to §7; severity trace to §8.1; correlated pair to §9; run statuses to §14. No scan-launch / "run now" affordance anywhere (read-only contract honoured). No phantom settings/account/notification surfaces. The only state-touching affordance is the copy-baseline-JSON button, explicitly permitted by §5.2. No grounding findings.

## Axis 1.5 — Cross-cutting UI safety
- Capability-check failure states: N/A (read-only renderer, no capability gating) — matches round summary.
- Coupled-field invariant: the baseline-draft block (finding-detail.html ~474) is rendered as one grouped JSON object with all §6.4 required fields together; cannot produce a partial entry. Clean.
- PII-adjacent emission: evidence/metadata blocks name no token/secret/jwt/bearer/apikey field VALUES; staging creds shown as env-var NAMES only (targets.html ~401, finding "values in GitHub Actions secrets"). Clean.

## Axis 2 — Simplicity / operator overload

[🔴] prototypes/audit-tool-v1/* (all five HTML files: index.html:6, run-report.html, finding-detail.html:266/289/357/396/402, trends.html:6/205/226, targets.html:231/483/513 and ~57 further occurrences)
Why: CLAUDE.md § User Preferences — "No em-dashes." Em-dashes (—) appear in default-visible copy across every file (page titles, page subtitles, the partial-run banner, finding titles, severity-trace text, accepted-risk titles). Counts: finding-detail 13, run-report 18, targets 15, index 10, trends 6. Use commas, colons, or rewritten sentences. This is the single gating finding for the round.

[🟡] prototypes/audit-tool-v1/run-report.html:351-360 (findings table header: Finding / Severity / Type / Target / Scan / action = 6 columns)
Why: docs/frontend-design-principles.md § Complexity budget — table-column cap is 4. The breach is defensible (the operator-requested distribution + filter + findings shape in spec §5.2, and the mobile reflow uses card layout + col-hide on Type/Target), and the round summary's "charts requested explicitly by operator" note covers the chart caps. Downgraded to advisory on that basis; flagging so the operator confirms the extra two columns earn their place rather than collapsing Type/Target into the finding sub-line.

[🟡] prototypes/audit-tool-v1/run-report.html:251-271 (vuln-type chart labels "tenant-iso", "auth", "dep-cve"; filter options expose raw enum values injection / auth-access-control / tenant-isolation / dependency-cve / misconfiguration / xss / tls at :313-323; row Type tags render raw vulnClass enums)
Why: docs/frontend-design-principles.md § operator-vocabulary / mockup-designer § Step 3a. The round summary cites a security-engineer audience and elects to keep vulnClass enums as-is, which is a legitimate persona call for this internal tool, so this is advisory not blocking. Noting it because the abbreviations in the chart ("tenant-iso", "dep-cve") are tighter than the spec's own enum spelling and read as code; if the operator wants the plain-English layer the designer applied elsewhere (Code scanning / Live scanning / Accepted risks), apply it here too for consistency.

[💭] prototypes/audit-tool-v1/index.html:243-260 (severity totals strip: 4 numeric tiles Critical/High/Medium/Low)
Why: docs/frontend-design-principles.md § Visuals as simplicity / stat-tile guidance. These four counts read as a KPI-tile row, but they are load-bearing for the Portfolio Overview primary task ("which targets have critical findings") and are echoed by the per-target cards below rather than duplicating an explorer. Acceptable; raised only so the operator is aware the strip sits at the boundary of the "row of tiles" anti-pattern.

## Axis 3 — Mobile capability (all screens Tier 2 per round summary)
- Mobile shape present on all five screens (responsive single-file, _shared.css @media 768px). Bottom-tab nav (4 items) + mobile top bar on every screen, with safe-area insets on both fixed bars (_shared.css:570, :597, :95). Good.
- No page-level horizontal overflow at 375px: grids reflow to single column (grid-2/grid-3 → 1fr at :646), charts use viewBox scaling, and the only horizontal scroll is constrained to .table-wrap / .trend-chart-wrap / .evidence-block (overflow-x:auto). Clean.
- Tables: run-report findings table uses .table-cards card reflow + col-hide below 768px (two treatments). trends run-history is 6 columns inside .table-wrap overflow-x:auto — acceptable for Tier 2/3 (scroll constrained to the table region), though not sticky-first-column; fine at this tier.
- No fixed-width modals (none used). No hover-only interactions: row clicks have onclick AND an explicit "View →" link; target cards are <a> tags; severity-trace and tooltips are permanently visible. Touch targets: nav items, buttons, filter selects, tabs all carry min-height 44px (selects 36px, acceptable as secondary). Clean.

[🟡] prototypes/audit-tool-v1/index.html:150 (mobile hamburger button: onclick="alert('Navigation available in sidebar')" — opens an alert pointing at a sidebar that is display:none on mobile)
Why: docs/mobile-capability-principles.md § Mobile navigation pattern. The bottom-tab bar already provides mobile nav, so this hamburger is a dead-end that references a hidden desktop element. Either remove the hamburger on mobile (bottom-tab is sufficient) or have it open a real "More" sheet. Non-gating because navigation is fully reachable via the bottom-tab bar; the other four screens' hamburger has no handler at all, which is the cleaner state.

## Verdict basis
Grounding clean. Mobile capability clean (one advisory dead-end hamburger). The only blocking issue is the em-dash rule, which is mechanical to fix (replace 62 occurrences with commas/colons/rewrites) and does not require rethinking any screen. No phantom surfaces, no jargon-on-high-traffic-surface escalations, no reject-reason enums, no complexity breach beyond the justified table-column count.

Blocking: 1 / Should-fix: 3 / Consider: 1
**Verdict:** NEEDS_REWORK
```
