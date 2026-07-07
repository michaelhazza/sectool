# ADR-0014: Coordinators and audit-runner run INLINE — never dispatched via the Agent tool

**Status:** accepted
**Date:** 2026-07-07
**Domain:** framework / orchestration

> **Numbering context:** this ADR is numbered 0014 rather than next-in-sequence because consuming repos' agent files and CLAUDE.md wiring already cite ADR-0014 for this rule. The framework claims the number to keep those citations resolving; 0014 is framework-reserved (see `README.md` index footer — local ADRs still start at 0009).

## Context

The coordinator playbooks (`spec-coordinator`, `feature-coordinator`, `finalisation-coordinator`, `mockup-coordinator`) each dispatch sub-agents as core steps — architect, builder, mockup-designer, the reviewers, chatgpt-*-review. The Claude Code runtime blocks nested sub-agent dispatch: an agent running as a sub-agent has no Task/Agent tool (`No such tool available: Task. Task is not available inside subagents.`). A coordinator dispatched via the Agent tool therefore breaks at its first sub-agent dispatch — silently degrading the pipeline into a single-agent run or failing outright. Separately, `audit-runner` was observed losing operator visibility when dispatched: its TodoWrite task list (the operator's window into a long multi-area audit) is invisible outside the main session.

## Decision

We will run all four coordinators (`spec-coordinator`, `feature-coordinator`, `finalisation-coordinator`, `mockup-coordinator`) and `audit-runner` INLINE in the main Claude Code session, never via `Agent({subagent_type: ...})`. Operator entry phrases ("launch feature coordinator", "audit-runner: hotspot rls", "create mockups for X", etc.) instruct the main session to ADOPT the playbook: read `.claude/agents/<name>.md` and execute its steps directly. For the coordinators this is a hard requirement (runtime constraint); for `audit-runner` it is a visibility requirement (TodoWrite list must stay in the operator's session) — and inline execution is also what lets audit-runner dispatch its own post-audit review pass.

## Consequences

- **Positive:**
  - Coordinator pipelines actually work — every sub-agent dispatch (builder, reviewers, mockup loop) is available because the dispatcher is the main session.
  - Operator sees TodoWrite progress, gates, and pause points in real time.
  - One consistent invocation rule for every orchestration-shaped agent.
- **Negative:**
  - Coordinator orchestration tokens run on the main session's model/context; long pipelines consume main-session context (mitigated by the compact protocol and per-chunk Sonnet `builder` dispatch).
  - The rule is convention-enforced: nothing mechanically stops a session from mis-dispatching a coordinator; the failure surfaces at the first nested dispatch.
- **Neutral:**
  - Leaf agents (builder, pr-reviewer, mockup-designer, etc.) are unaffected — they never dispatch sub-agents and remain normal Agent-tool dispatches.

## Alternatives considered

- **Dispatch coordinators as sub-agents anyway, with inlined sub-steps** — rejected: collapses the specialist separation the fleet exists for (independent review context, Sonnet builder cost split) and duplicates every leaf playbook inside each coordinator.
- **Runtime support for nested dispatch** — not available; the constraint is the platform's, not the framework's. Revisit only if the runtime lifts it.
- **Coordinator-as-headless-process (`claude -p`)** — valid for cost optimisation at specific seams (see CLAUDE.md model-guidance table) but does not change the rule: the headless session is then the "main session" and still runs the playbook inline.

## When to revisit

When the Claude Code runtime allows sub-agents to dispatch further sub-agents. Until then: Permanent — re-open only on incident.

## References

- Fleet rule: consuming-repo `CLAUDE.md` § *Common invocations* ("Coordinators and `audit-runner` run INLINE...")
- Agent files: `.claude/agents/spec-coordinator.md`, `feature-coordinator.md`, `finalisation-coordinator.md`, `mockup-coordinator.md`, `audit-runner.md` (each carries an inline-execution block)
- Related ADR: `0006-no-inline-agent-overrides.md` (agent files are framework-canonical)
