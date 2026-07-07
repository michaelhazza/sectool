# ADR-0006: Agent files are framework-canonical — no inline per-repo overrides

**Status:** accepted
**Date:** 2026-06-17
**Domain:** framework / agent authoring
**Supersedes:** —
**Superseded by:** —

## Context

Agent definitions under `.claude/agents/*.md` are framework-canonical: they sync from this framework to every consuming repo via `sync.js`. To let a repo add project-specific operating notes to an agent, the framework offered the inline `LOCAL-OVERRIDE` block mechanism (ADR-era `references/local-override-convention.md`): a named HTML-comment slot inside the agent file that `sync.js` preserves across updates.

In practice this concentrated repo-specific content INSIDE framework-canonical files. By v2.19.0 one consuming repo (the framework's origin project) carried `LOCAL-OVERRIDE` content in 14 of 15 agents — including a 67-line `project-notes` block in `finalisation-coordinator.md` naming that repo's exact CI jobs, DB role, gate shards, and escape-hatch paths. Consequences: (1) the canonical agent file is no longer a clean framework artifact, so a reviewer cannot tell framework prose from repo prose at a glance; (2) any out-of-marker drift triggers a `.framework-new` manual merge on every sync; (3) there is no single place to see all of a repo's agent customisations — they are scattered across 14 files; (4) the override content has nowhere to live that reads like "a CLAUDE.md for the agent fleet."

## Decision

**Agent `.md` files under `.claude/agents/` are framework-canonical and MUST NOT be edited per-repo.** No inline `LOCAL-OVERRIDE` blocks in agents, no out-of-marker drift. ALL project-specific operating notes for an agent live in the consuming repo's **`.claude/context/agent-context.md`**, under a `## <agent-name>` section. Every framework agent reads that file at the start of every run and treats its own section as binding project context. A repo that needs to change how an agent behaves edits the context file, never the agent.

Mechanism:

1. **One global context file per repo** — `.claude/context/agent-context.md`, one `## <agent-name>` heading per agent that has project notes. Agents read the whole file and treat their own section as binding. A very long section may link out to a `references/<topic>.md` file to keep the global file navigable (e.g. `finalisation-coordinator`'s G5 CI-parity command table lives in `references/g5-ci-parity-commands.md`).
2. **Framework ships a template** at `.claude/context/agent-context.md` (manifest `mode: adopt-only`), deployed once and never clobbered after a repo populates it.
3. **Every framework agent carries one uniform read-instruction** as the first body line after its frontmatter: read `.claude/context/agent-context.md` first, treat the matching `##` section as binding. Identical wording across agents, so it is greppable and enforceable.
4. **The inline `LOCAL-OVERRIDE` mechanism is deprecated for agent files.** It remains available for non-agent managed files (docs, references) where a small in-file slot still makes sense.

This is the fleet-wide analogue of a `CLAUDE.md`: one file the whole agent fleet reads, owned by the repo, never overwritten by a framework sync.

## Consequences

- **Positive:**
  - Agent files stay clean framework copies — a `sync.js` update applies with no `.framework-new` merge for agents.
  - One navigable place (`.claude/context/agent-context.md`) shows every project-specific agent behaviour.
  - The read-instruction is uniform and greppable, so an enforcement gate (`validate-setup`) can fail the build if any agent reintroduces a `LOCAL-OVERRIDE` block or omits the read-instruction.
  - Repo-specific CI/infra detail (G5 command tables, etc.) lives in repo-owned files, not framework-canonical ones.
- **Negative:**
  - One indirection: to know how an agent behaves in a repo you read two files (the agent + its context section) instead of one.
  - Existing consumers must migrate their `LOCAL-OVERRIDE` content to `agent-context.md` once (a one-time per-repo migration).
- **Neutral:**
  - The framework's existing top-level `context/` directory (reviewer `PROJECT_CONTEXT` injection) is a DISTINCT concept from `.claude/context/agent-context.md` (fleet-wide agent operating notes). They cross-reference but do not merge.

## Alternatives considered

- **Keep inline `LOCAL-OVERRIDE` for agents.** Rejected — concentrates repo content in framework-canonical files, scatters customisation across 14+ files, and forces a `.framework-new` merge on out-of-marker drift.
- **One context file per agent (`.claude/context/<agent>.md`).** Rejected — a sprawl of small files; harder to see the whole fleet's customisation at once; the operator's stated intent was "one file all agents read, like a framework CLAUDE.md."
- **Substitution variables only.** Rejected — substitutions handle mechanical values (`{{PROJECT_NAME}}`), not multi-paragraph operating notes like a G5 CI-parity table.

## When to revisit

- If a single `agent-context.md` grows unnavigable even with link-outs, reconsider a per-agent-file split.
- If a consuming repo needs an agent behaviour that genuinely cannot be expressed as project context (a structural change to the agent's control flow), that is a signal the framework agent itself should change — open a framework PR, do not re-introduce inline overrides.

## References

- Brief: `tasks/framework-agent-context-migration-BRIEF.md` (consuming repo)
- Deprecated mechanism: `references/local-override-convention.md`
- Reviewer PROJECT_CONTEXT (distinct concept): `context/README.md`
- Enforcement: `.claude/agents/validate-setup.md`
- Template: `.claude/context/agent-context.md` (manifest `adopt-only`)
