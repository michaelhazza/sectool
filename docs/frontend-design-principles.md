# Frontend Design Principles

Durable rules for any UI artifact built in this repo — mockups, components, pages, modals, empty states. This is the long-form companion to the short ruleset in [`CLAUDE.md` § Frontend Design Principles](../CLAUDE.md). Read both before generating any UI.

> **Read alongside [`mobile-capability-principles.md`](./mobile-capability-principles.md).** Mobile capability is non-negotiable for every UI artifact in this framework. The two docs apply simultaneously: this one for consumer-simple + complexity discipline, the other for mobile shape and behaviour. A design that satisfies one but not the other is not ready to ship.

---

## Why this document exists

audit-tool positions as **consumer-simple on enterprise-grade backend**. The product sells to agency operators, solo founders, and non-technical knowledge workers — the same audience that finds tools like HubSpot and Salesforce overwhelming. The backend needs to be powerful (router, cost ledger, HITL gates, cached-context infrastructure, policy engine); the frontend needs to be invisible where possible and obvious everywhere else. These two stay decoupled.

The trap this doc prevents: **treating the spec's exposed capability surface as the UI surface.** A spec that adds `bundle_utilization`, `prefix_hash`, `cache_creation_tokens`, `run_outcome = 'completed' | 'degraded' | 'failed'`, and per-tenant cache-cost rollups does not imply a bundle-utilization dashboard, a prefix-hash inspector, a cache-cost explorer, and a per-tenant financial breakdown. Backend spec → full coverage. Frontend design → strict editorial filter.

---

## Contents

- [The primary rule](#the-primary-rule)
- [Pre-design checklist](#pre-design-checklist)
- [What to ship by default](#what-to-ship-by-default)
- [Visuals as simplicity](#visuals-as-simplicity)
- [What to defer by default](#what-to-defer-by-default)
- [Complexity budget per screen](#complexity-budget-per-screen)
- [Progressive disclosure patterns](#progressive-disclosure-patterns)
- [Worked examples](#worked-examples) → see [`frontend-design-examples.md`](./frontend-design-examples.md)
- [Re-check before delivery](#re-check-before-delivery)
- [When to break these rules](#when-to-break-these-rules)

---

## The primary rule

**Start with the user's primary task, not the data model.** Before sketching any screen, component, or mockup, answer the pre-design checklist below. If you can't, stop and ask — do not design speculatively off the data model.

---

## Pre-design checklist

Work through these in order. An unchecked box is a design finding; every unchecked box means the artifact is under-specified and not ready to build.

- [ ] **Who is the primary user of this screen?** Roles: agency operator / solo founder / tenant admin / internal staff / Breakout Solutions admin. Different users tolerate different complexity ceilings. Agency operator = lowest tolerance. Internal staff = highest.
- [ ] **What single task are they here to complete?** One sentence. Example: *"Attach a document bundle to this scheduled task."* NOT *"Manage document bundles and monitor utilization and review run history."* If the answer is a list, you have multiple screens, not one.
- [ ] **What is the minimum information needed to complete that task?** List it. Example: bundle name, bundle document count, an attach button. NOT utilization-per-tier, cache-hit-rate, prefix-hash preview, attach button.
- [ ] **What would happen if I removed X?** For every candidate element (panel, metric, chart, table, sidebar card), ask this. If the answer is *"the user would still complete the primary task"*, the element is deferred.
- [ ] **Where does everything else go?** Every deferred element goes to exactly one of: (a) progressive disclosure on this screen (collapsed "Advanced" section), (b) a dedicated page the primary user rarely visits, (c) admin-only view, (d) deferred out of v1 entirely. Name the destination per element.
- [ ] **The re-check.** Imagine a non-technical operator landing on this screen for the first time. Do they know what to do within 3 seconds? If not, cut more.
- [ ] **The mobile re-check.** Imagine the same operator on a 375px phone. Does the primary task complete? Is anything clipped or unreadable? If not, the design is not ready. Apply [`mobile-capability-principles.md`](./mobile-capability-principles.md) in full.

---

## What to ship by default

- **The primary action** — prominent, obvious, one button or one drop zone.
- **The minimum state needed to complete the action** — current value inline, not in a separate panel.
- **The result of the last action taken** — inline confirmation (e.g. "attached · 2m ago"), not a history table.
- **One sidebar callout at most** — only if it's load-bearing for completing the primary task (e.g. a required field's help text).
- **Empty states with one next action** — "No bundles yet. [Create bundle]". Not a tour, not tips, not a chart of nothing.
- **Load-bearing inline visuals** — status dots, band pills, sparklines next to names, outcome badges, a single hero visualisation where *understanding trajectory IS the primary task*. These communicate state faster than text and are *encouraged*, not deferred. See [Visuals as simplicity](#visuals-as-simplicity) below.

---

## Visuals as simplicity

A common misread of this document is "cut all visuals to ship faster". That is wrong. **Visuals are how consumer-simple products communicate state.** A status dot beats a paragraph. A sparkline beats three lines of trend prose. A single hero chart on a drilldown where *understanding the trajectory* is the primary task beats five lines explaining the same number.

**The test is never "is there a visual?" — it's "is this visual load-bearing for the primary task?"**

| Ship | Don't ship |
|---|---|
| Status dots inline on list rows (band, health, run outcome) | A row of five KPI tiles at the top of every page |
| Sparklines next to a client name showing 4-week trajectory | Multi-series comparison charts nobody asked for |
| Band pills, severity pills, outcome badges | 7/30/90-day toggle charts as decoration |
| A single hero trend visualisation on a drilldown page | Trend dashboards that duplicate content visible inline below |
| Progress indicators on active flows | Observability explorers on primary user journeys |
| Micro-gauges, subtle colour accents for state | Multi-panel dashboards when the task is *operating*, not *monitoring* |

A sparkline communicating a trend in 60 pixels earns its place. A KPI tile row showing four numbers the user already sees in the list below does not. A hero chart on a page whose primary task *is* "read the trajectory" earns its place. A hero chart on a page whose primary task is "pick one and act" is decoration.

### Aesthetic quality is not negotiable

Pages must be **aesthetically beautiful**, not just functional. Plain-text lists with no visual hierarchy read as unfinished. Every surface should feel intentional: confident type hierarchy, generous whitespace, colour accents for state, small visual signals that communicate faster than words.

**Consumer-simple means *beautiful and obvious*, not *stripped and bare*.**

If a screen is entirely text, pause and ask: *is there a visual that would communicate this state faster?* Usually yes. Ship it. A list of clients without trend sparklines is harder to scan than one with. A drilldown without a health-score visualisation hides the single most important thing the operator is there to see.

The caps in the [complexity budget](#complexity-budget-per-screen) below are about **defaulting away from the dashboard-of-dashboards anti-pattern** — rows of tiles, multi-chart explorers, observability sprawl. They are *not* a mandate against visual richness. Sparklines, inline gauges, status indicators, outcome badges, and load-bearing single hero visualisations are never counted against those caps.

---

## What to defer by default

Everything below is **deferred out of v1 unless explicitly requested for a specific user workflow**. Not "maybe v2" — actively cut from the v1 artifact.

- Metric dashboards and KPI tile rows — the "four-to-seven big numbers at the top of every page" anti-pattern. Inline single-metric signals (a sparkline next to a name, a band pill, a status dot) are different — ship those freely. See [Visuals as simplicity](#visuals-as-simplicity).
- Trend-chart decks with 7/30/90-day toggles as decoration at the top of pages. A single hero trend visualisation on a drilldown where *understanding trajectory IS the primary task* is different — ship that.
- Diagnostic panels that expose internal identifiers (prefix hashes, snapshot IDs, idempotency keys, correlation IDs).
- Aggregated cost rollups, per-tenant financial breakdowns, spend-saved calculations, cost-split donuts.
- Observability explorers ("Usage Explorer", "Bundle Lens", "Model Lens", "Feature Lens").
- Ranking tables ("bundles by utilization", "tenants by spend", "features by cost").
- Run-history tables on per-entity pages — runs live in the existing run log, not on every page that has a run.
- Three-tier / four-tier comparison views (e.g. "Sonnet vs Opus vs Haiku side-by-side").
- "Cost saved vs. first run" or any other counterfactual-comparison framing.

These all represent **real backend capability** the spec legitimately covers. The capability ships. The UI surface for it does not ship until a specific user workflow needs it. If they're truly needed, they go on a dedicated admin page that the average user never opens — not inline on the primary user journey.

---

## Complexity budget per screen

Hard caps. A screen exceeding these is a design finding; cut before shipping.

| Element | Cap | Notes |
|---|---|---|
| Primary actions | 1 | Buttons that commit state. A "Save" and a "Cancel" count as one primary action (the save). |
| Panels (distinct bordered sections) | 3 | Header, primary body, one sidebar. More than that = compose multiple screens. |
| KPI tiles | 0 by default | Add only when the primary task is *monitoring* (not operating). |
| Charts | 0 by default | Same rule. A spark-line on an inline card is not a chart. |
| Table columns | 4 | Name, 1 key state column, 1 timestamp, 1 action. More columns → collapse into secondary state / progressive disclosure. |
| Sidebar cards | 1 | Only if load-bearing. A second sidebar is a design finding. |
| Hash / ID exposures | 0 by default | Internal identifiers never surface to the primary user. Admin view only. |
| Tier / model / variant comparisons | 0 | The user does not care what model runs under the hood. If they do, it's an admin concern. |

Admin-only views (accessed via an explicit toggle, hidden from the primary nav) operate under a relaxed budget: 5 panels, 2 sidebars, charts and KPIs permitted. These exist to serve Breakout Solutions internal staff and advanced tenant admins — never the default operator.

---

## Progressive disclosure patterns

When information is genuinely needed but not for the primary task, use these — in preference order:

1. **Inline badge or dot.** A coloured status dot next to a name. A "· 2m ago" trailing line. Lowest visual weight, zero clicks to see.
2. **Hover tooltip.** For informational copy that doesn't need to be scanned — "why this is disabled", "what this count means".
3. **Collapsed "Advanced" section.** A single expandable section at the bottom of the primary body. Labelled clearly. Defaults collapsed. Contains the internal-detail fields (hashes, IDs, raw config).
4. **"Details →" link to a dedicated page.** For rich diagnostic content that a user will visit deliberately. Separate URL, not inline.
5. **Admin-only page.** For content that should not surface to primary users at all. Gated behind a role check.

Pick the lowest-weight pattern that works. Do not mix three patterns on one screen.

---

## Worked examples

Three worked examples — drawn from origin-project features — live in [`frontend-design-examples.md`](./frontend-design-examples.md):

- **Cached-context infrastructure** — backend exposes 9 capabilities; UI ships 3 screens + 2 inline signals. The bulk of the deferred-by-default rule.
- **ClientPulse health monitoring** — analytical complexity in the backend does not imply analytical complexity in the UI. One drilldown, one modal, one settings page.
- **Tier-1 agent chat uplift** — backend richness (cost attribution, suggested actions, OCC versioning) maps to the smallest possible UI signals: a number, a chip row, a text field, a card.

Read for method, not content. If you're adapting this framework to a new project, replace these with worked examples from your own product.

<!-- LOCAL-OVERRIDE:start name="project-ui-patterns" -->
<!-- Replace this comment with your project-specific recurring UI patterns: row-action menus,
     badge conventions, stat-tile rules, banner behaviour, admin-control visibility, etc.
     Sync.js preserves your content here on framework updates. -->
<!-- LOCAL-OVERRIDE:end name="project-ui-patterns" -->

## Re-check before delivery

Before committing any UI artifact (mockup, PR, component), run through this quickly:

- [ ] Did I start from the user's task, not the data model?
- [ ] Is there exactly one primary action on this screen?
- [ ] Is every element load-bearing for the primary task?
- [ ] Have I deferred every monitoring / observability / diagnostic element that the task doesn't need?
- [ ] If a non-technical operator landed here, would they know what to do in 3 seconds?
- [ ] Am I under the complexity-budget caps?
- [ ] **Mobile capability:** does this work at 375px? Touch targets 44px? No page-level horizontal overflow? Mobile shell intentional? See [`mobile-capability-principles.md` § Re-check before delivery](./mobile-capability-principles.md#re-check-before-delivery-mobile) for the full mobile sub-checklist.

If any answer is "no" or "not sure", cut before shipping. Shipping a fatter UI "just in case someone wants it" is how this product loses the consumer-simple positioning.

---

## When to break these rules

Almost never. The two legitimate exceptions:

1. **Admin-only views.** Operate under the relaxed budget above. Gated behind an explicit role check, hidden from the primary nav, discoverable only via direct URL or an admin settings page. Every audit-tool user is NOT an admin.
2. **Safety-critical information-dense screens.** Payload-rendering screens where the complexity exists to prevent harm — HITL block payloads, terminal-failure review queues, dry-run diff previews. Even here, the rule is "surface only what's needed to make the decision", not "surface everything the backend knows".

Everything else obeys the rules. If you find yourself arguing for a third exception during a design, you're almost certainly rationalising a data-model-first mistake — go back to the primary task and start over.
