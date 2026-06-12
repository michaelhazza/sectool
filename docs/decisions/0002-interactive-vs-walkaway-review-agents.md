# ADR-0002: Interactive vs walk-away review agent classification

**Status:** accepted
**Date:** 2026-04-22
**Domain:** review fleet
**Supersedes:** —
**Superseded by:** —

## Context

Review agents have two operating models, and confusing them produces both unsafe and annoying behaviour:

- **Interactive agents** (`chatgpt-pr-review`, `chatgpt-spec-review`) — the user is present for every round, pasting ChatGPT-web responses back into the session.
- **Walk-away agents** (`spec-reviewer`, `dual-reviewer`, `spec-conformance`) — run autonomously, possibly overnight, without operator attention.

A "half-autonomous hybrid" — auto-deferring some findings while waiting for user input on others — is both **unsafe** (silently losing user decisions when the user isn't watching) and **annoying** (blocking an unattended run mid-session).

## Decision

Classify every review agent at design time as **interactive** or **walk-away**, and enforce that classification consistently through every decision step.

**Interactive agents:**
- Never auto-defer architectural findings. Print a structured decision block (Finding / Impact / Recommendation / Reply with) to screen.
- Hold pending architectural items in a `pending_architectural_items` register until the user responds.
- Surface every directional decision to the user. Trust the operator's presence.

**Walk-away agents:**
- Operate fully autonomously using framing assumptions as decision criteria (see `docs/spec-context.md`).
- Route all deferred items to `tasks/todo.md` without blocking.
- Never pause for user input mid-loop. The whole point is "run it overnight, read the verdict in the morning."

Apply a **size filter** before surfacing architectural findings on interactive agents: ≤30 LOC, single file, no contract break → implement directly and log "architectural signal but small fix — implementing." Without this, routine improvements that touch a service boundary would require user input every round, making the interactive loop tedious. The threshold is conservative — when in doubt, surface rather than implement.

## Consequences

- **Positive:**
  - The operator never has to "wait at the screen" for a walk-away agent.
  - The operator never returns to find an interactive agent silently auto-deferred decisions they would have answered.
  - Each new review agent's design starts with a clear question: "is this presence-required or unattended?"
- **Negative:**
  - Walk-away agents must commit to framing assumptions (in `docs/spec-context.md`) — when the framing drifts, the agent makes wrong calls until the operator updates the assumptions.
  - Interactive agents need a UI affordance (the structured decision block) that other agents don't.
- **Neutral:**
  - Existing pure-read review agents (`pr-reviewer`) sit at the boundary — read-only, neither pattern applies. Treat them as "synchronous to the operator" — they print, the operator decides.

## Alternatives considered

- **One pattern fits all** (always print decisions, always wait). Rejected: walk-away runs become useless because the operator has to be present.
- **One pattern fits all** (always auto-defer). Rejected: interactive runs feel detached because the operator can't influence the loop.
- **Per-finding mode switch** (each finding decides whether to wait). Rejected: too easy to misclassify; the design-time gate is more reliable.

## When to revisit

- If a new review agent doesn't fit either bucket, the binary classification is too narrow. Re-evaluate.
- If the size filter (30 LOC / single file) regularly misses important architectural changes, tighten it.
- If `docs/spec-context.md` framing drifts faster than the staleness check catches, walk-away agents lose calibration — investigate the staleness cap.

## References

- KNOWLEDGE.md entries:
  - `### 2026-04-22 Decision — Interactive review agents must surface decisions to screen; walk-away agents auto-defer`
  - `### 2026-04-22 Pattern — Architectural checkpoint needs a size filter to avoid over-blocking interactive agents`
  - `### 2026-04-22 Pattern — Pending decision registers prevent architectural decisions from being lost across rounds`
- Agent: `.claude/agents/chatgpt-pr-review.md`
- Agent: `.claude/agents/chatgpt-spec-review.md`
- Agent: `.claude/agents/spec-reviewer.md`
- Related ADR: `0001-mixed-mode-review-agents.md`
