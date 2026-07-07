---
name: frontend-design-check
description: Use BEFORE any visual, layout, or UX change to user-facing UI outside the mockup pipeline — a quick fix, a new form, a page tweak, table controls, nav changes, or a new screen. Routes you to the canonical design docs (frontend-design-principles, design-language) that the mockup pipeline enforces automatically and direct UI edits bypass. Sibling: invoke frontend-correctness alongside when the same change touches component state, async data flow, or permission gating.
---

# Frontend design check

Direct UI edits bypass the mockup pipeline's enforced design review. Before writing UI:

1. **Read `docs/frontend-design-principles.md`** (the five hard rules) and, if the project defines one, its design-language doc (visual tokens, type, spacing, component recipes). Those docs are canonical; this skill is only the trigger.
2. **Ground in the existing UI first.** Read the pages/components the change extends before drafting. Default is extend-don't-replace: a new top-level page or nav entry for functionality with an existing analogue is wrong-shape until justified.
3. **Reuse established primitives.** Table sort/filter controls, buttons, selects come from the codebase's component library — browser-default controls inside styled surfaces read as broken. 100+ item collections need searchable tables, not card grids.

The five hard rules, one line each (full rationale in the doc):

1. Start from the user's primary task, not the data model.
2. Default to hidden — dashboards, KPIs, IDs, cost views stay out unless a workflow requires them.
3. One primary action per screen.
4. Inline state beats dashboards (status dot > utilization chart).
5. Re-check: would a non-technical operator complete the task without feeling overwhelmed? If not, cut.

Also check the mobile shape: no page-level horizontal overflow at 375px, no hover-only interactions, no fixed-width modals wider than the smallest target viewport.

For engineering pitfalls in the same change (modal state, async races, permission gating), use the `frontend-correctness` skill.
