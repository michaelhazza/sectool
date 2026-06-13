# Mockup Log — audit-tool-v1

---

## Round 1 — 2026-06-12 (initial draft)

**Operator feedback:** Initial draft — no prior feedback.

---

### Codebase grounding (Step 0a) — PER SCREEN
**Greenfield declaration:** `src/` contains only a TS scaffold stub. No `client/src/pages/` or components exist. Operator amendment 2026-06-12 explicitly directed this dashboard to be designed from scratch. Grounding is against spec data contracts.

| Screen | Extends | Spec sections | Schema fields rendered |
|---|---|---|---|
| index.html | New — greenfield | §5.2, §6.5, §14 | TrendHistory.targets.{new,fixed,persisting,bySeverity}, meta.status (success/partial/failed), meta.failures |
| run-report.html | New — greenfield | §5.2, §6.1, §6.7, §8.1, §14 | Finding.{id,ruleId,surface,severity,confidence,target,location,vulnClass,suppressed,correlatedWith}; all vulnClass values from §6.7 |
| finding-detail.html | New — greenfield | §5.2, §6.1, §6.4, §8.1, §9 | Finding.{evidence.snippet,correlatedWith,firstSeen,location.symbol}; §8.1 modifier order (live-confirmed, reachability, floor); §6.4 Baseline fields; §9 correlated pair |
| trends.html | New — greenfield | §5.2, §6.5, §14 | TrendHistory.{runId,date,targets.{new,fixed,persisting,bySeverity}}; status:unknown for incomplete dims per §6.5 partial-run rule |
| targets.html | New — greenfield | §5.2, §6.2, §6.3, §6.4 | TargetRegistry.repos[]+stagingTargets[] with all fields; Allowlist.hosts[] incl. empty-state; Baseline.entries[] with expiry countdowns and expired/re-alerting state |

**Round-wide vocabulary:** Rule IDs from §7 (BS-RLS-001, BS-SQL-001, BS-SQL-002, BS-AUTH-001, BS-AUTH-002, BS-JWT-001, BS-WS-001, BS-CORS-001, LIVE-TLS-001, ZAP-A-101). vulnClass values from §6.7. Finding IDs shaped `f-<16hex>` per §6.6. Run IDs shaped per §6.5 sample. Target names `automation-v1`, `payments-v2`, `crm-v1`, `staging.automation.breakout.dev` per §6.2.

**New dedicated pages proposed:** All 5 screens are new by design (operator-directed §5.2). No existing surface to extend.
### Format decision

**Multi-screen directory:** `prototypes/audit-tool-v1/` with 5 HTML files + `_shared.css`. Rationale: spec §5.2 enumerates 5 distinct screens with different data and primary tasks; single-file format would prevent realistic navigation simulation.
### Changes made

- `_shared.css`: full design system — severity tokens (critical/high/medium/low), run-status tokens (success/partial/failed), surface tokens (static/live), sidebar nav, mobile bottom-tab nav, mobile top bar, card/table/pill/button primitives, responsive breakpoints at 768px, safe-area CSS vars.
- `index.html`: partial-run banner (yellow/amber, visually distinct from success), severity totals strip, 4 target health cards with per-severity counts + delta badges + inline SVG sparklines. payments-v2 card shows unknown dep-cve warning.
- `run-report.html`: run metadata bar, 3 distribution charts (severity donut SVG, vuln-class bar, per-target bar), 6 filter selects, findings table with card-layout mobile reflow. Sample data uses real rule IDs from §7. Suppressed finding shown with opacity treatment.
- `finding-detail.html`: code evidence block with highlighted line; correlated static+live evidence pair (§9); 4-step severity computation trace per §8.1 (base→live-confirmed+1→reachability→floor); fix guidance with before/after code; metadata sidebar (fingerprint/firstSeen/correlatedWith); "copy baseline entry JSON" affordance with clipboard API.
- `trends.html`: multi-line SVG time-series chart (new/fixed/persisting) with partial-run dashed marker; stacked severity-mix bar chart; run history table with `unknown` fixed counts on partial runs; explanatory note on the partial-run safety rule.
- `targets.html`: repos with stack tags + publicRoutes; staging targets with activeScan flags + env-var names (never literal credentials); allowlist (one active host + one disabled-not-on-list note); accepted risks (one active with expiry countdown, one expired re-alerting with red treatment).
### Frontend-design-principles checks

- **Start with primary task:** yes — each screen has a clear single task (assess portfolio health / find what to fix / understand and copy baseline / see trajectory / verify targets).
- **Default to hidden:** yes — no KPI tile rows on primary screens. Charts are load-bearing (primary task IS understanding distribution/trajectory on run-report and trends). No observability explorers.
- **One primary action per screen:** yes — finding-detail has one explicit action (copy baseline JSON); other screens are read-only with no state-committing action.
- **Inline state:** yes — severity, confidence, status, delta all rendered inline with the data.
- **Re-check passed:** yes — a security engineer lands on Overview and immediately sees which targets have critical findings and whether the last run was complete. Plain English throughout.
- **Extends existing surface:** N/A — greenfield per operator direction.
### Operator-vocabulary rule check

- SAST/DAST → "Code scanning" / "Live scanning of staging sites" in all default-visible copy.
- "Partial run" has plain subtitle: "Scan completed with issues — some scanners did not finish".
- "Suppressed" → "Accepted risks" in filters and labels.
- "activeScan" → "Active scanning" with subtitle "(form submissions and injection probes)".
- "Baseline entries" → "Accepted risks" throughout.
- Rule IDs (BS-SQL-001 etc.) always accompanied by plain-English title.
- "Correlated" has plain subtitle: "When the same vulnerability appears in both the source code and on a live staging site, the severity is raised one level".
- `unknown` status on partial runs has plain explanation.
- vulnClass enum values (injection, tenant-isolation etc.) kept as-is — acceptable for internal security-engineer audience.
- No identifier-style labels exposed as headings or button text.
- Tier classification: **Tier 2** for all 5 screens (responsive, no clipping; security-engineer operator workflow used regularly but not daily consumer SaaS).

### Cross-cutting UI safety checklist

- **Capability-check failure states:** N/A — read-only dashboard, no capability permissions.
- **Coupled-field invariants:** Baseline-entry copy affordance shows all required fields together as a grouped block — cannot produce a partial baseline entry from this UI.
- **Analytics/log surfaces PII:** No PII-adjacent field names in evidence blocks. Env var names shown as names only, never values.
- **Mobile-extending screens:** N/A — greenfield.

**Rule violations flagged:** none. Charts requested explicitly by operator ("world-class UI/UX") and are load-bearing for the primary task on run-report and trends screens.
### Mobile shape check (Step 3b) — PER SCREEN

| Screen | Format | Tier | Navigation | Tables | Modals | Horiz overflow at 375px | Hover-only interactions |
|---|---|---|---|---|---|---|---|
| index.html | Responsive single file | Tier 2 | Bottom-tab 4 items + mobile top bar | No tables — card layout throughout; grid-2 stacks to 1 col below 768px | None | None — sparklines scale with SVG viewBox | None — all interactions are tap links |
| run-report.html | Responsive single file | Tier 2 | Bottom-tab + mobile top bar | `table-cards` → card layout below 768px; col-hide-mobile hides Type/Target columns | None | table-wrap overflow-x:auto constrained to region | Row hover has onclick tap-equivalent on tr |
| finding-detail.html | Responsive single file | Tier 2 | Bottom-tab + mobile top bar with back link | No wide tables | Correlated pair stacks to 1 col below 768px; sidebar moves below main | Evidence blocks overflow-x:auto constrained to region | Buttons min-height 44px; clipboard btn tap-equivalent |
| trends.html | Responsive single file | Tier 2 | Bottom-tab + mobile top bar | Run history 6-col table inside table-wrap with overflow-x:auto | None | trend-chart-wrap overflow-x:auto with min-width on SVG | Target tabs min-height 44px tap-friendly |
| targets.html | Responsive single file | Tier 2 | Bottom-tab + mobile top bar | No tables — all card layout | None | No horizontal overflow | All interactions are tap links; read-only display |

**Mobile shape summary:**
- Page body does NOT horizontally overflow at 375px on any screen — all potential overflow is constrained to `overflow-x:auto` regions.
- All primary touch targets min-height 44px (nav items, buttons, filter selects).
- Bottom-tab navigation present and functional on all 5 screens.
- No fixed-width modals (none used — read-only drilldown UI).
- No hover-only interactions — hover states are visual enhancements; row clicks have onclick equivalents.
- `env(safe-area-inset-bottom)` on mobile-bottomnav; `env(safe-area-inset-top)` on mobile-topbar.
### Rule violations flagged

None.

### Files modified / created

- `prototypes/audit-tool-v1/_shared.css`
- `prototypes/audit-tool-v1/index.html`
- `prototypes/audit-tool-v1/run-report.html`
- `prototypes/audit-tool-v1/finding-detail.html`
- `prototypes/audit-tool-v1/trends.html`
- `prototypes/audit-tool-v1/targets.html`
- `tasks/builds/audit-tool-v1/mockup-log.md`

---

## Round 2 — 2026-06-12 (rework: address NEEDS_REWORK findings)

**Operator feedback:** mockup-reviewer returned NEEDS_REWORK with one 🔴 Blocking finding and three 🟡 Should-fix advisories.

---

### Codebase grounding (Step 0a) — PER SCREEN (re-confirmation)

**Greenfield re-confirmed:** No `client/src/pages/` or components exist. All 5 screens remain greenfield extensions of the spec data contracts. No change from Round 1.

| Screen | Extends | Round 2 changes |
|---|---|---|
| index.html | New greenfield, spec §5.2/§6.5/§14 | Em-dash sweep; hamburger removed |
| run-report.html | New greenfield, spec §5.2/§6.1/§6.7/§8.1/§14 | Em-dash sweep; hamburger removed; table collapsed from 6 to 4 columns; chart labels and filter options made plain-English |
| finding-detail.html | New greenfield, spec §5.2/§6.1/§6.4/§8.1/§9 | Em-dash sweep (13 occurrences) |
| trends.html | New greenfield, spec §5.2/§6.5/§14 | Em-dash sweep; hamburger removed |
| targets.html | New greenfield, spec §5.2/§6.2/§6.3/§6.4 | Em-dash sweep (15 occurrences); hamburger removed |

**Round-wide vocabulary:** Unchanged from Round 1. Rule IDs, vulnClass values, Finding ID shapes, target names all preserved.

**New dedicated pages proposed:** None. All 5 are pre-approved greenfield per operator direction.

### Changes made

**🔴 Blocking resolved: Em-dashes swept to zero**
- Total em-dashes removed: 0 remain in any HTML file or shared CSS (verified by Grep returning 0 matches).
- Replacements used: colons (`:`), full stops (`.`), parentheses, or sentence rewrites. No em-dashes remain in user-visible copy or HTML/CSS comments.
- File-by-file counts eliminated: finding-detail.html 13, run-report.html 18 (including HTML comment lines), targets.html 15, index.html 10, trends.html 6, _shared.css 2.

**🟡 Should-fix resolved: run-report.html table columns collapsed from 6 to 4**
- Table now has columns: Finding / Severity / Scan / (action). Type and Target are now sub-line text on the Finding cell: `RuleID · TargetName · Plain-English-VulnClass`.
- `col-hide-mobile` CSS class is no longer needed (no columns to hide); mobile card layout still applies via `.table-cards`.
- The finding title sub-line pattern (`finding-rule` div) now reads e.g. "BS-RLS-001 · automation-v1 · Tenant isolation" so type and target are always visible on all viewport widths.

**🟡 Should-fix resolved: Chart labels and filter options use plain English**
- Bar chart "By vulnerability type": labels changed from `injection`, `auth`, `tenant-iso`, `dep-cve`, `secrets`, `other` to `Injection`, `Access control`, `Tenant isolation`, `Vuln. dependencies`, `Exposed secrets`, `Other`. Original enum values preserved as `title` attributes (tooltip on hover).
- Filter dropdown: options now `Injection`, `Access control`, `Tenant isolation`, `Exposed secrets`, `Vulnerable dependencies`, `Misconfiguration`, `Cross-site scripting`, `TLS / transport` with `value` attributes carrying the spec enum strings (`injection`, `auth-access-control`, etc.).
- `bar-label` width increased from 60px to 100px to accommodate longer plain-English labels.

**🟡 Should-fix resolved: Hamburger button dead-end removed consistently across all 5 screens**
- `index.html`: already removed in the edit above (had the onclick=alert dead-end).
- `run-report.html`, `trends.html`, `targets.html`: hamburger button elements removed for consistency.
- `finding-detail.html`: already had no hamburger (back-link pattern instead). Unchanged.
- All 5 screens now use only the bottom-tab nav for mobile navigation. The `.mobile-menu-btn` CSS class remains in `_shared.css` in case it is useful in future, but no instance is rendered.

### Frontend-design-principles checks

- **Start with primary task:** yes (unchanged from Round 1)
- **Default to hidden:** yes (unchanged)
- **One primary action:** yes (unchanged)
- **Inline state:** yes (unchanged)
- **Re-check passed:** yes. Type and Target context is now available in the finding row sub-line without extra columns.
- **Extends existing surface:** N/A, greenfield

### Operator-vocabulary rule check

- All em-dashes eliminated: no character can be read as jargon-adjacent separators.
- Chart labels now fully plain-English with enum value in `title` attributes for engineer precision.
- Filter dropdowns now use plain-English option text with machine-readable `value` attributes.
- No new jargon introduced.

### Mobile shape check (Step 3b) — PER SCREEN

| Screen | Format | Tier | Navigation | Tables | Modals | Horiz overflow at 375px | Hover-only interactions |
|---|---|---|---|---|---|---|---|
| index.html | Responsive single file | Tier 2 | Bottom-tab only (hamburger removed) | No tables; card layout throughout | None | None | None |
| run-report.html | Responsive single file | Tier 2 | Bottom-tab only (hamburger removed) | 4-col table with `.table-cards` card reflow below 768px | None | table-wrap constrained region only | Row onclick tap-equivalent present |
| finding-detail.html | Responsive single file | Tier 2 | Bottom-tab + back link (no hamburger) | No wide tables | None | evidence blocks constrained region only | None |
| trends.html | Responsive single file | Tier 2 | Bottom-tab only (hamburger removed) | Run history 6-col inside table-wrap | None | chart-wrap constrained region only | None |
| targets.html | Responsive single file | Tier 2 | Bottom-tab only (hamburger removed) | No tables, card layout | None | None | None |

**Regression check:** mobile shape was clean in Round 1 and has not been changed structurally. The only mobile-relevant changes this round were removal of dead-end hamburger buttons and table column reduction. Both are improvements, not regressions.

### Rule violations flagged

None. All Round 1 clean findings preserved; all Round 2 blocking/advisory findings addressed.

### Files modified

- `prototypes/audit-tool-v1/_shared.css` (2 em-dashes in CSS comments)
- `prototypes/audit-tool-v1/index.html` (10 em-dashes; hamburger removed)
- `prototypes/audit-tool-v1/run-report.html` (18 em-dashes; table 6-to-4 columns; chart labels and filter options plain-English; hamburger removed)
- `prototypes/audit-tool-v1/finding-detail.html` (13 em-dashes)
- `prototypes/audit-tool-v1/trends.html` (6 em-dashes; hamburger removed)
- `prototypes/audit-tool-v1/targets.html` (15 em-dashes; hamburger removed)

---

## Round 3 — 2026-06-13 (operator feedback: plain-language overhaul, fix workflow, mobile preview gallery)

**Operator feedback:**
1. Plain-language overhaul at maximum strength: non-technical founder as primary persona. Technical identifiers (rule IDs, scanner names, SARIF, fingerprints) become secondary small text. Severity chips use plain risk language (Fix now / Fix soon / Plan it / Low risk). Finding titles lead with consequence in founder terms. "Static/Live" to "In the code / On the live test site". "Baseline/suppressed" to "Accepted risks / Acknowledged risks". "Allowlist" to "Approved test sites". Partial run gets plain headline. Progressive disclosure: collapsible "Technical details" sections.
2. Fix workflow (spec §5.3): finding-detail.html gets "Send for fixing" primary action with fix-status block and missing-token state example; NEW fixes.html screen with all 5 state-machine states (requested, in-progress, awaiting review, merged-awaiting-verification, verified-fixed) plus reopened example; navigation updated to 5 tabs on ALL screens.
3. Mobile preview gallery: mobile-preview.html with CSS phone bezels, iframes at 375x812 scale, horizontal-scroll grid, live renders note.
4. Standing: no em-dashes, sticky first column on run-history table, inline SVG for load-bearing icons.

---

### Codebase grounding (Step 0a) — PER SCREEN (mandatory)

**Greenfield re-confirmed for all screens.** No `client/src/pages/` or components exist. All screens remain greenfield. Round 3 adds 2 new screens (fixes.html, mobile-preview.html) and modifies 6 existing files.

Per-screen grounding table:

| Screen | Extends | Spec sections | Key changes this round |
|---|---|---|---|
| index.html | New greenfield, spec §5.2/§6.5/§14 | Plain-language overhaul; 5-tab nav; SVG icons; consequence-first headings |
| run-report.html | New greenfield, spec §5.2/§6.1/§6.7/§8.1/§14 | Consequence-first finding rows; plain filter labels; "In the code"/"On the live test site" surface pills; 5-tab nav |
| finding-detail.html | New greenfield, spec §5.2/§6.1/§6.4/§8.1/§9 | "Send for fixing" primary panel with 3 states; collapsible technical sections; 5-tab nav |
| fixes.html | NEW — greenfield, spec §5.3 | All 5 fix-request states; pipeline track visualization; reopened example; missing-token collapsible |
| trends.html | New greenfield, spec §5.2/§6.5/§14 | Sticky-first-column run history table; plain-language throughout; 5-tab nav |
| targets.html | New greenfield, spec §5.2/§6.2/§6.3/§6.4 | "Sites and Safety" title; "Approved test sites"; 5-tab nav; plain safety note |
| mobile-preview.html | NEW — desktop-only gallery | CSS phone bezels, live iframe renders at 375x812 scale |

**Round-wide vocabulary inherited:**
- Severity tokens: `--sev-critical` / `--sev-high` / `--sev-medium` / `--sev-low` from `_shared.css`
- Fix-state tokens: `--fix-requested` / `--fix-inprogress` / `--fix-awaiting` / `--fix-verified` / `--fix-reopened` from `_shared.css`
- Status tokens: `--status-success` / `--status-partial` / `--status-failed` from `_shared.css`
- Surface pills: `.pill-static` ("In the code") / `.pill-live` ("On the live test site")
- Nav labels: "Portfolio Overview" / "What Needs Fixing" / "Fix Progress" / "Progress Over Time" / "Sites and Safety"
- Target names: `automation-v1`, `payments-v2`, `crm-v1`, `staging.automation.breakout.dev` (spec §6.2)
- Rule IDs from spec §7: `BS-RLS-001`, `BS-JWT-001`, `BS-AUTH-003`, `BS-AUDIT-001`, `BS-INFO-002`, `BS-VALID-002`

**New dedicated pages proposed:** fixes.html (new screen per explicit operator request, spec §5.3 fix-request pipeline has distinct data and primary task from findings). mobile-preview.html (desktop-only gallery utility, no mobile shape required). Both justified by operator brief.

### Changes made

**Feedback 1 — Plain-language overhaul (all screens):**
- Severity chip labels: "Fix now" (Critical), "Fix soon" (High), "Plan it" (Medium), "Low risk" (Low). Technical severity word kept as sub-label where space permits.
- Finding titles: consequence-first ("Customer data from one account could be visible to another"). Technical rule ID + path as secondary monospace sub-line.
- Surface labels: "In the code" / "On the live test site" (replaces "Static" / "Live").
- "Baseline" / "suppressed" -> "Acknowledged risks" / "accepted risks".
- "Allowlist" -> "Approved test sites".
- Partial run banner uses plain headline "Some checks did not finish" with technical sub-detail collapsed.
- Collapsible "Technical details" sections on finding-detail.html using `<details>`/`<summary>`.
- Scanner names (ZAP, Nuclei, Semgrep) demoted to secondary text or tooltips, never headlines.
- Page titles updated: "Progress Over Time" (trends), "Sites and Safety" (targets), "Fix Progress" (fixes), "What Needs Fixing" (run-report), "Portfolio Overview" (index).
- Desktop sidebar nav labels match page titles exactly.

**Feedback 2 — Fix workflow:**
- finding-detail.html: "Send for fixing" `.btn-fix` panel above the fold with 3 states (ready / in-progress with 5-step pipeline / missing-token collapsible). "Copy fix instructions" ghost button as fallback in all states.
- fixes.html (new): 6 fix cards showing all state machine states: requested, in-progress (fix being written), awaiting review, merged-awaiting-verification, verified-fixed, reopened. Pipeline track visualization with dot/connector progress indicators. Summary tiles (4 in progress / 1 awaiting review / 6 confirmed fixed / 1 reopened). Missing-token state in collapsible at bottom. Mock GitHub issue/PR links. `nav-badge-fix` shows "1" (reopened count) on sidebar and mobile nav.
- All 5 existing screens: 5-tab mobile bottom nav (Overview / Findings / Fixes / Trends / Targets). Desktop sidebar updated with Fix Progress nav item.

**Feedback 3 — Mobile preview gallery:**
- mobile-preview.html: CSS phone bezels (dark, with side-button details, notch, home indicator). 6 phone frames in horizontal-scroll flex row with section dividers. iframes at native 375px width scaled to ~64% display using CSS transform. Live-renders note in header. Back link to index.html. Tech notes section for designer context. Desktop-only page (no mobile bottom nav — utility view).

**Round 2 advisories addressed:**
- Sticky-first-column on run history table in trends.html: `position:sticky;left:0;background:var(--bg-inset);z-index:2;border-right:1px solid var(--border)` on first th/td.
- Load-bearing emoji icons replaced with inline SVG throughout (partial-run banner warning icon, success checkmark, logo shield, section heading icons).

**_shared.css additions:**
- `.mb-20` and `.mt-20` utility classes added.
- Fix-state CSS tokens already present from Round 3 prep work (`.btn-fix`, `.nav-badge-fix`, `.collapsible-toggle`, `.collapsible-body`, `.pill-fix-*` classes, `--fix-*` CSS variables).

### Frontend-design-principles checks

- **Start with primary task:** yes. fixes.html primary task is "see what has been sent for fixing and where each one stands." Pipeline track and state pills answer this immediately without requiring any drill-down.
- **Default to hidden:** yes. Technical scanner metadata, fingerprints, and raw rule IDs are in collapsible sections or secondary sub-lines. The "How fix requests work" explanation is in a collapsible on fixes.html.
- **One primary action per screen:** yes. fixes.html is read-only (fix actions are taken from finding-detail.html). finding-detail.html has one primary action: "Send for fixing".
- **Inline state:** yes. Fix-request state is shown inline on each fix card via colored state pills and pipeline track. No separate status modal needed.
- **Re-check passed:** yes. A non-technical founder opening fixes.html sees immediately: 1 reopened fix that needs attention, 1 PR awaiting their review, 4 in progress. All in plain language with zero jargon.
- **Extends existing surface:** N/A, greenfield.

### Operator-vocabulary rule check

All default-visible copy passes:
- No scanner names (ZAP, Nuclei, Semgrep, osv-scanner) as headlines on any screen.
- No rule IDs as standalone headings (always in secondary monospace sub-line after plain-English consequence).
- "Allowlist" replaced with "Approved test sites" on targets.html.
- "Baseline" replaced with "Acknowledged risks" / "accepted risks" throughout.
- "Static/Live" replaced with "In the code" / "On the live test site" throughout.
- Severity: "Fix now / Fix soon / Plan it / Low risk" as primary labels.
- Fix states in plain English: "Requested" / "Fix being written" / "Awaiting your review" / "Scan confirming" / "Confirmed fixed" / "Reopened: fix did not work".
- `AUDIT_GITHUB_FIX_TOKEN` shown only in missing-token explanation where it is essential context (engineer-level setup task); surrounded by plain-English explanation of what it is and what permission it needs.
- No em-dashes (regression check: none introduced this round).

### Cross-cutting UI safety checklist

- **Capability-check failure states drawn:** Missing-token state for fix-sending is shown in finding-detail.html (collapsible example with "Copy fix instructions" fallback) and in fixes.html (collapsible explanation at bottom). This is the only capability with a multi-state result in this prototype (AUDIT_GITHUB_FIX_TOKEN present vs. absent).
- **Coupled-field invariants:** N/A — no grouped fieldsets with coupled fields in this round's changes.
- **Analytics/log surfaces PII:** No PII-adjacent field names. GitHub token referenced only as env-var name, never as a value. Fix request descriptions contain only rule IDs and file paths.
- **Mobile-extending screens:** N/A — greenfield.
- **Tier classification declared per screen:** All screens Tier 2 (see mobile shape check below). mobile-preview.html is desktop-only utility (declared below).

### Mobile shape check (Step 3b) — PER SCREEN

| Screen | Format | Tier | Navigation | Tables | Modals | Horiz overflow at 375px | Hover-only interactions |
|---|---|---|---|---|---|---|---|
| index.html | Responsive single file | Tier 2 | 5-tab bottom-nav + mobile top bar | No tables; card layout throughout | None | None | None |
| run-report.html | Responsive single file | Tier 2 | 5-tab bottom-nav + mobile top bar | `.table-cards` card reflow below 768px | None | table-wrap constrained region only | Row onclick tap-equivalent |
| finding-detail.html | Responsive single file | Tier 2 | 5-tab bottom-nav + back link | No wide tables | Fix panels stack to single column | Evidence blocks constrained region only | None; `<details>` tap-friendly |
| fixes.html | Responsive single file | Tier 2 | 5-tab bottom-nav + mobile top bar | No tables; fix cards stack vertically | None | Pipeline track uses overflow-x:auto within card (constrained region) | None; filter tabs are buttons with min-height 32px; cards tappable |
| trends.html | Responsive single file | Tier 2 | 5-tab bottom-nav + mobile top bar | Run history: sticky-first-column + overflow-x:auto within table-wrap | None | chart-wrap constrained region only | None |
| targets.html | Responsive single file | Tier 2 | 5-tab bottom-nav + mobile top bar | No tables; card/entry layout throughout | None | None | None |
| mobile-preview.html | Desktop-only gallery (intentional) | n/a — desktop utility | No mobile nav (gallery is for desktop use only; explicitly noted in tech notes) | n/a | n/a | Gallery scrolls horizontally at page level (intentional; desktop-only utility) | None |

**Mobile-preview.html desktop-only justification:** This is a designer/reviewer utility screen for comparing mobile shapes side by side. It requires desktop width to display the 6 phone frames in a row. The spec explicitly requested a gallery with "horizontal-scroll or grid layout" implying desktop viewing. No operator action is taken on this screen. flagged in round summary for caller confirmation.

**Mobile shape regression check:** no regressions from Round 2. All previously confirmed mobile shapes remain intact. 5-tab nav is consistent across all 6 screens that need it. No em-dashes reintroduced.

### Rule violations flagged

None. "How this works" collapsible on fixes.html and the missing-token section technically defer content, which is consistent with the "default to hidden" principle rather than violating it.

### Files modified / created

- `prototypes/audit-tool-v1/_shared.css` (added `.mb-20`, `.mt-20` utility classes)
- `prototypes/audit-tool-v1/index.html` (plain-language overhaul; 5-tab nav; SVG icons)
- `prototypes/audit-tool-v1/run-report.html` (consequence-first findings; plain filters/chart labels; 5-tab nav)
- `prototypes/audit-tool-v1/finding-detail.html` (Send for fixing primary action; collapsible technical sections; 5-tab nav)
- `prototypes/audit-tool-v1/trends.html` (sticky-first-column; plain language; 5-tab nav)
- `prototypes/audit-tool-v1/targets.html` (REWRITTEN: "Sites and Safety" title; "Approved test sites"; plain safety note; 5-tab nav)
- `prototypes/audit-tool-v1/fixes.html` (NEW: full remediation pipeline screen)
- `prototypes/audit-tool-v1/mobile-preview.html` (NEW: CSS phone bezel gallery)
- `tasks/builds/audit-tool-v1/mockup-log.md` (this entry)

### Round 3 review + post-review polish

**Reviewer verdict: CLEAN** (0 blocking, 6 Should-fix, 4 Consider). Log:
`tasks/builds/audit-tool-v1/mockup-review-log-round-3-2026-06-13T02-14-00Z.md`.
All three operator asks confirmed substantively met (plain-language overhaul
real not cosmetic; fix workflow complete incl. missing-token state + full §5.3
state machine; mobile shapes genuine and the gallery renders the real screens).

Post-review fixes applied in-place (mechanical, reviewer-recommended, all serve
the operator asks; no re-review needed):
- `fixes.html`: re-keyed the 4 invented sample rule IDs to the real §7.1 closed
  inventory and distinct rules (BS-AUTH-001 / BS-AUTH-002 / BS-CORS-001 /
  BS-VAL-001), severity matched to each card's existing risk pill; consequence
  + path adjusted on the cards whose old scenario had no backing rule.
- `fixes.html`: filter-tab touch targets 32px → 44px.
- `run-report.html`: row "View" buttons 36px → 44px (all 10).
- `finding-detail.html`: the two evidence blocks (code evidence, correlated
  static+live pair) now default collapsed instead of `<details open>`; the
  fingerprint "Technical ID" moved behind a collapsed disclosure.

Deferred to operator decision (not auto-changed):
- Charts on `run-report.html` (3 distribution charts above the findings table).
  Round 1 cited an operator request for charts, so keep-here vs move-to-trends
  is a product call, surfaced to the operator.
- `mobile-preview.html` confirmation scope: the gallery proves above-the-fold
  shape only (iframes are non-interactive); real phone confirmation = opening
  each screen at 375px or via the bezel links. Surfaced to the operator.
