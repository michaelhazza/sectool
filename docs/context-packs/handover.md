# Handover pack

For: onboarding a new session to in-flight work, or writing a handoff document.

Status: template — anchors must be mapped at adoption.

## Sources

- `tasks/current-focus.md` — sprint-level pointer + active spec/plan/branch
- The active spec at the path named in `current-focus.md`
- The active plan at `tasks/builds/<slug>/plan.md` if working under a build slug
- `tasks/builds/<slug>/progress.md` — current chunk state, last decision, what's next
- `tasks/builds/<slug>/handoff.md` if it exists (Phase 1 → 2 or 2 → 3 handoff)
- The most recent 3 review logs in `tasks/review-logs/` matching the active slug
- `architecture.md`:
  - `{{ARCHITECTURE_ANCHOR:architecture-rules}}` (so a fresh session knows the constraints)
  - `{{ARCHITECTURE_ANCHOR:key-files-index}}` (the index)

  (`{{ARCHITECTURE_ANCHOR:<purpose>}}` tokens are placeholders — ADAPT.md Phase 3b / the adopting operator maps them to real anchors in the consuming repo's `architecture.md`.)
- `docs/decisions/` — any open ADRs in the active domain

## Skip

- Other features' specs and plans
- Audit framework
- Code-graph cache (the new session can rebuild on demand)

## Why this scope

A handover should give a new session everything to resume immediately: what the goal is, what's been decided, what's left, and what the constraints are. Nothing more. Anything else is "they can read it when they need it."

## Writing a handoff

When the operator says `write handoff` mid-session, dump:
- One-paragraph summary of what's been done in this session.
- One-paragraph summary of what's next.
- List of decisions made (with one-sentence rationale each).
- Open questions for the next session.
- Pointers to: the active spec, the plan, the progress file, the latest review log.

Save to `tasks/builds/<slug>/handoff-<YYYY-MM-DD>.md` (dated so multiple handoffs don't overwrite each other).

---

## Project-specific notes

Consuming projects can add project-specific guidance for this file between the markers below. Sync.js preserves anything you put between the markers when the framework is updated. Do NOT edit outside the markers — those changes get a .framework-new diff on the next sync.

<!-- LOCAL-OVERRIDE:start name="project-notes" -->
<!-- LOCAL-OVERRIDE:end name="project-notes" -->
