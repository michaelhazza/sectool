# Frontend Design Principles — Origin-Project Worked Examples

Worked examples extracted from `frontend-design-principles.md` 2026-05-03. They illustrate how the principles apply to specific origin-project features. Read them for the **method** (how to apply the rules to a real backend spec), not for the **content** (most projects won't have these features).

Linked from `frontend-design-principles.md` via:

> Worked examples — see [`frontend-design-examples.md`](./frontend-design-examples.md). Three examples drawn from the origin project: cached-context infrastructure, ClientPulse health monitoring, tier-1 agent chat uplift.

If you're adapting this framework to a new project, you have two options:
1. **Delete this file** if origin-project examples are irrelevant. The principles in `frontend-design-principles.md` stand alone.
2. **Replace the examples** with worked examples from your own product. Use the same shape: backend capability surface → what to ship → what to defer → why.

---

## Worked example — cached-context infrastructure

The cached-context spec exposes these backend capabilities: reference document CRUD, document bundle CRUD, bundle resolution snapshots, prefix-hash identity, cache read/write attribution, three-way run-outcome classification, bundle utilization per model tier, per-tenant cache-cost rollups, HITL budget-breach block payload.

### What the v1 UI should ship

The primary user task is **attach documents to automations**. That's the whole feature from the user's POV. Everything else is invisible infrastructure.

- **Documents page** — a simple list of uploaded reference documents (name, size, updated). One primary action: upload. Standard primitive.
- **Bundle creation** — name + add documents. One primary action: save. Standard primitive.
- **Bundle attachment control** — reused inline on agent / task / scheduled-task config pages. One drop-down or multi-select. One primary action: attach. Shows currently attached bundles as chips with a remove (x).
- **One inline signal on the bundle list row** — a dot/label: `healthy` / `near cap` / `at cap`. Drives user attention to trim when needed. No tier-by-tier breakdown visible by default.
- **One inline signal on the task / scheduled-task row** — last run outcome (`completed` / `degraded` / `failed`) as a dot. Runs live in the existing run log.

That's it. Three new screens (documents, bundle detail, bundle attachment control) + two inline signals on existing pages. No new dashboards, no new explorers, no charts, no tiles.

### What the v1 UI should NOT ship

- Bundle utilization dashboard with green/amber/red radial rings per tier.
- Scheduled-task detail with 7-day run-calendar, detailed run table, sidebar bundle utilization.
- Run-detail page exposing prefix hashes, components JSON, snapshot integrity checks, cache-read-vs-write tokens, cost-saved counterfactual.
- Usage Explorer with per-bundle hit-rate trend lines, cost-split donut, bundle ranking, per-tenant breakdown.
- Any comparison view of Sonnet vs Opus vs Haiku.
- Any exposure of `prefix_hash`, `bundleSnapshotId`, `idempotencyKey`, or other internal identifiers to the primary user.

All of these represent real backend signals that can and should be computed. They surface (if at all) on an admin-only observability page gated behind an explicit role, never on the primary user journey. Most will be deferred out of v1 entirely — **shipping them is optional; the feature works without them**.

### The mockups in `_archive/prototypes/cached-context/`

The five mockups in [`_archive/prototypes/cached-context/`](../_archive/prototypes/cached-context/) were generated before this doc existed. They violate rules 1, 2, 3, 4 — most of them represent "what the backend could surface if we exposed every column", not "what the user needs to complete the task".

- **`mockup-budget-breach-block.html`** — valid. Renders the `HitlBudgetBlockPayload` shape the spec commits to (§4.5). Safety-critical screen that legitimately has to surface WHY a run is blocked. Keep.
- **`mockup-pack-utilization.html`** — reduce to a single inline badge on the bundle list row. The tier-by-tier radial dashboard is the anti-pattern. (Historical filename; this mockup was deleted in the UX revision.)
- **`mockup-scheduled-task-with-pack.html`** — replace with an inline attachment control on the existing scheduled-task config page. Run-history lives in the run log, not here.
- **`mockup-run-detail-cached.html`** — delete from v1. Runs open the existing run-detail page. Prefix-hash / cache attribution surfaces there as a collapsed "Advanced" section, not as its own screen.
- **`mockup-usage-explorer-packs.html`** — delete from v1. The observability story is a valid admin concern but not a v1 deliverable.

Build the replacement v1 mockup set focused on the attach workflow before implementation begins.

---

## Worked example — ClientPulse health monitoring

The ClientPulse backend computes eight signals per subaccount, a composite health score, a churn band (healthy / watch / at-risk), churn assessments, intervention proposals, and a configuration model with 14 sensitive paths. The operator's task is: **assess a client's health and decide whether to intervene**. That is one task — not "monitor signals," not "configure the scoring model," not "review interventions and analytics."

### What the v1 UI should ship

- **Dashboard row** — one band pill (`healthy` / `watch` / `at-risk`) inline next to the client name. A count of high-risk clients at the top of the list as a single integer — not a KPI tile, not a chart. One action: click a high-risk row to drill down.
- **Drilldown page** — the minimum surface for "assess and decide": header (name, band, last-assessed timestamp), signal panel (eight signals as compact rows with current value and trend direction), 90-day band-transition table (when the band changed and why), intervention history with outcome badges (applied / no change / not measured). One contextual action: "Open Configuration Assistant" to adjust scoring weights.
- **Intervention proposal modal** — complex form contained in a modal: template picker with recommendation badge, merge-field editor, approval flow. Not inline on the drilldown page. The operator confirms before anything is proposed.
- **Settings page** — ten blocks, each scoped to one aspect of the configuration model. Each block shows where its value came from (org default / overridden / manually set) with a reset-to-default button. An operator changing one signal's weight sees only that signal's block — not a monolithic JSON editor for the entire config.

That's it: one drilldown, one modal, one settings page with per-block scope, two inline signals on the dashboard row. No new top-level nav items, no analytics explorer.

### What the v1 UI should NOT ship

- Health-score analytics dashboard — trend charts for score over time, per-signal weight breakdowns, cohort comparison views.
- Per-client 7/30/90-day churn risk trend deck.
- Signal correlation explorer ("which signals predict which bands").
- Intervention success-rate dashboard (outcome data renders as badges on existing history rows, not a reporting surface).
- A monolithic configuration form exposing the full 14-signal config object — the per-block settings pattern avoids this.
- Any exposure of internal IDs (organisation_id, subaccount_id, assessment_id) on the drilldown page.

All of these are real backend outputs the system computes. They belong on an admin or analytics surface reached via explicit navigation — not on the primary operator journey.

### The re-check

A non-technical operator opening the drilldown for a high-risk client sees: the band, the signals driving it, and one button to adjust. They know what to do in under three seconds. The settings page is ten labelled blocks — each block is a self-contained decision, not a raw config dump. The intervention modal contains the complexity without letting it sprawl.

**The principle this illustrates:** analytical complexity in the backend does not imply analytical complexity in the UI. The richer the data model, the stronger the editorial filter needs to be. The operator's task is always the entry point — not the schema.

---

## Worked example — tier-1 agent chat uplift

The PR #244 backend ships: per-message cost columns, a suggested-actions JSONB field on messages, a per-conversation thread context table, and a blocked-run / OAuth-resume infrastructure. Each of those is a substantial backend capability. The question is what surfaces in the UI.

### What the v1 UI should ship

- **Cost pill** — one small inline token/cost pill in the chat thread. Single number. No charts, no per-model breakdown, no trend line. The operator sees "~$0.04" next to the conversation header and moves on.
- **Suggested action chips** — a row of one-tap chips below each assistant message. No more than 3 chips per message, each a single short label ("Run report", "Send summary"). Chips dispatch the action immediately — no confirmation modal unless the action is irreversible. No chip history, no chip analytics.
- **Thread context panel** — a collapsible right pane with three plain text fields (task, approach, decisions). One primary action: save. No versioning UI, no diff view, no per-field history. The panel is open by default on first visit; operators who don't need it collapse it once.
- **Inline integration card** — when a run pauses for a missing OAuth connection, one card appears inline in the conversation. It names the integration, shows a "Connect" button that opens a popup, and collapses to a one-line stub once the connection succeeds. No redirect, no settings page link, no status dashboard. The agent continues automatically — the operator sees "Connected, continuing…" and the conversation resumes.

### What the v1 UI should NOT ship

- A per-conversation cost dashboard or trend chart.
- Cost breakdown by model, skill, or run — that lives on the run-detail page, not in chat.
- A chip analytics panel showing which chips were clicked and how often.
- A thread context version history or diff viewer — operators edit in place.
- A "Connections required" status page or integration health tile inside the chat — the inline card is the entire surface.
- Any exposure of `blockSequence`, `resumeToken`, `threadContextVersion`, or other internal identifiers to the operator.

### The principle this illustrates

Backend richness (cost attribution per message, suggested-action dispatch, OCC versioning on thread context, cryptographic resume tokens) does not imply UI richness. Every new backend capability in this PR maps to the smallest possible UI signal: a number, a chip row, a text field, a card. The depth is in the execution path, not the screen.

---
