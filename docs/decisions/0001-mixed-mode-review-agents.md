# ADR-0001: Mixed-mode review agents (auto-fix mechanical, route directional)

**Status:** accepted
**Date:** 2026-04-22
**Domain:** review fleet
**Supersedes:** —
**Superseded by:** —

## Context

The main dev session was repeatedly claiming spec-driven chunks were complete while missing spec-named files, exports, columns, or error codes. Pure code-review (`pr-reviewer`) catches these but only when the reviewer happens to spot them — and the main session re-opens every log and copies the same mechanical scaffolds the reviewer already saw, wasting roundtrips.

Pure auto-fix would be unsafe: an agent that "helpfully" extends an implementation past what the spec said creates scope creep that's hard to roll back.

## Decision

We adopt a **mixed-mode review pattern** for `spec-conformance` and `spec-reviewer`:

1. **Mechanical fixes auto-apply.** When the spec explicitly names the missing item (path, export name, column, field, error code), the agent applies the surgical fix in-session.
2. **Directional findings route to `tasks/todo.md`.** Anything else — missing validation, missing edge-case behaviour, "maybe also X?" — gets logged for the human to decide.
3. **Fail-closed classification.** The classifier asks "am I 100% sure this is mechanical?" — anything short of 100% is DIRECTIONAL. False positives mean an extra item in the backlog; false negatives mean the agent silently writes code the human didn't approve.
4. **Mandatory scoping before checklist extraction.** If scope is ambiguous (no chunk named, no `progress.md` done-markers, no caller confirmation), the agent stops and asks. Verifying a partial implementation against the full spec produces false MECHANICAL_GAP findings that make the agent try to scaffold not-yet-built items.

Both the fix path and the route path require an "I'm certain this is the right bucket" gate; when uncertain, route to human — never default to fixing.

## Consequences

- **Positive:**
  - Agents close the silent-failure class (missed spec items) without spawning a fix-and-re-review loop.
  - The "100% sure or route" gate gives the operator a reliable backlog of every directional finding rather than a mix of fixed-and-forgotten + flagged.
  - The pattern generalises: any future review agent that fixes-and-routes can adopt the same shape.
- **Negative:**
  - More items land in `tasks/todo.md` than under a "fix more aggressively" approach. Triage load grows.
  - The "scoping mandatory" step blocks the agent when the operator forgot to provide a chunk name — feels like a stall on the first run.
- **Neutral:**
  - Adds a new agent (`spec-conformance`) to the fleet alongside `pr-reviewer`. Operators must remember to run spec-conformance BEFORE pr-reviewer for spec-driven tasks.

## Alternatives considered

- **Pure-review** (read-only, no auto-fix). Rejected: the main session would re-open every log and replicate the agent's mechanical scaffolds — pure roundtrip waste for items the spec already named.
- **Pure auto-fix** (apply every finding, no routing). Rejected: scope creep risk is too high; agent silently writes code the spec didn't authorise.
- **Optimistic auto-fix with rollback** (fix first, surface for review, undo if rejected). Rejected: rollback is messy in mid-session, and the operator's signal-to-noise ratio drops if every PR review opens with "agent did these 12 things, please confirm none are wrong."

## When to revisit

- If the spec-conformance backlog in `tasks/todo.md` consistently has < 5% directional findings (most are mechanical), the classifier may be over-routing and could be relaxed.
- If the operator complains regularly about scope creep from auto-applied mechanical fixes, the gate is too loose — tighten "100% sure" criteria.
- If a future review agent fits the fix-and-route shape but for a different domain (e.g. a doc-sync agent), check this ADR before designing the classification gate.

## References

- KNOWLEDGE.md entry: `### 2026-04-22 Decision — Mixed-mode review agents (auto-fix mechanical, route directional) are a new fleet pattern`
- Agent: `.claude/agents/spec-conformance.md`
- Agent: `.claude/agents/spec-reviewer.md`
- Related ADR: `0002-interactive-vs-walkaway-review-agents.md`
