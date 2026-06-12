# Debug pack

For: investigating a bug or incident — tracing behaviour through layers.

Status: scaffold (2026-05-03).

## Sources

- `architecture.md`:
  - `#project-structure`
  - `#service-layer`
  - `#agent-execution-middleware-pipeline`
  - `#three-tier-agent-model` (if the bug is in agent execution)
  - `#run-continuity-workspace-health` (if the bug is in run lifecycle / crash-resume)
  - `#row-level-security-rls-three-layer-fail-closed-data-isolation` (if the bug is tenant data leakage)
- `KNOWLEDGE.md` — full file (every gotcha is potentially relevant)
- `tasks/lessons.md`
- `tasks/review-logs/` — the most recent 5 logs for the affected domain
- The relevant spec(s) under `docs/` for the affected feature

## Skip

- Build / deploy infrastructure
- Audit framework
- Spec authoring checklist
- Frontend design principles unless the bug is in the UI

## Why this scope

A debugger needs the layer map, every gotcha that's been captured, and the most recent review history for the affected area. They don't need the build pipeline rules or the spec-authoring rubric.

## Bug-investigation protocol (universal)

1. Reproduce locally.
2. Bisect the diff if a regression — `git log` against the affected file from the last known good state.
3. Check `KNOWLEDGE.md` and `tasks/lessons.md` for the same / related problem.
4. Trace through layers using `references/project-map.md` and `references/import-graph/<dir>.json` if available.
5. Add the root cause + fix to `KNOWLEDGE.md` under category `gotcha` or `correction`.
