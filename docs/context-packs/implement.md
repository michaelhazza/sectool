# Implement pack

For: building from a spec or plan — chunk-by-chunk implementation.

Status: template — anchors must be mapped at adoption.

## Sources

> **Anchor placeholders:** `{{ARCHITECTURE_ANCHOR:<purpose>}}` tokens below are placeholders. ADAPT.md Phase 3b (or the adopting operator) must map each one to a real heading anchor in the consuming repo's `architecture.md`. Until mapped, fall back to loading the full referenced files.

- `architecture.md`:
  - `{{ARCHITECTURE_ANCHOR:project-structure}}`
  - `{{ARCHITECTURE_ANCHOR:route-conventions}}`
  - `{{ARCHITECTURE_ANCHOR:service-layer}}`
  - `{{ARCHITECTURE_ANCHOR:migrations}}`
  - `{{ARCHITECTURE_ANCHOR:shared-infrastructure}}`
  - `{{ARCHITECTURE_ANCHOR:architecture-rules}}`
- `DEVELOPMENT_GUIDELINES.md`:
  - § 2 Tier boundaries
  - § 3 Schema layer rules
  - § 6 Migration discipline
  - § 7 Testing posture
  - § 8 Development discipline
- `docs/spec-authoring-checklist.md` § Appendix
- `references/test-gate-policy.md`
- The active spec at the path provided in the chunk invocation
- The active plan at `tasks/builds/<slug>/plan.md`
- `tasks/builds/<slug>/progress.md` for current state

## Skip

- Code review specifics (covered by review pack)
- Audit framework
- Frontend design unless the chunk is UI

## Why this scope

A builder needs the file layout, the contracts the chunk must satisfy, and the testing posture. They don't need the review checklist or threat model — those run AFTER implementation.

---

## Project-specific notes

Consuming projects can add project-specific guidance for this file between the markers below. Sync.js preserves anything you put between the markers when the framework is updated. Do NOT edit outside the markers — those changes get a .framework-new diff on the next sync.

<!-- LOCAL-OVERRIDE:start name="project-notes" -->
<!-- LOCAL-OVERRIDE:end name="project-notes" -->
