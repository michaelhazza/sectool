# Agent context — project-specific operating notes for the agent fleet

This file is the **only** place to add project-specific behaviour for a framework agent. It is the fleet-wide analogue of `CLAUDE.md`: every framework agent under `.claude/agents/` reads this file at the start of every run and treats the `##` section matching its own name as **binding project context**.

**Contract (ADR-0006):**

- Agent `.md` files are framework-canonical and are **never edited per-repo** — no inline `LOCAL-OVERRIDE` blocks, no out-of-marker drift. Project notes go here instead.
- Add a `## <agent-name>` section **only** for an agent you actually need to customise. Agents with no project notes need no section.
- The heading MUST exactly match the agent's name — its `name:` frontmatter field, which equals the filename stem (e.g. `## architect` for `architect.md`).
- Keep sections tight. If one section grows long (a CI command table, a large allowlist), move the detail to a `references/<topic>.md` file and leave a 2-line pointer here.
- This file is `adopt-only`: the framework deploys it once, then never overwrites it. It is yours to maintain.

Distinct from the reviewer `PROJECT_CONTEXT` system (`context/` at the framework root, injected into reviewers) — that adapts review prompts; this carries agent operating notes. They cross-reference but do not merge.

---

## Worked example

The format is a level-2 heading whose text is a real agent name, then prose / bullets / tables as needed. The example below uses a **non-agent placeholder name** and is wrapped in an HTML comment, so it can never be read as binding project context — delete it or replace it with your real `## <agent-name>` sections.

<!--
## example-agent-name

**Some project rule.** Describe a project-specific behaviour for this agent. If the detail is long (a CI command table, a large allowlist), move it to a `references/<topic>.md` file and leave a short pointer here instead of inlining it.
-->

---

<!--
Valid agent names (must match a file in .claude/agents/). Add a `## <name>` section only when you customise that agent:

adversarial-reviewer · architect · audit-runner · bug-fixer · builder ·
chatgpt-plan-review · chatgpt-pr-review · chatgpt-spec-review · claude-plan-review ·
claude-spec-review · codebase-explainer · context-pack-loader · cross-repo-scout ·
dual-reviewer · experiment-runner · feature-coordinator · finalisation-coordinator ·
hotfix · incident-commander · mockup-coordinator · mockup-designer · mockup-reviewer ·
pr-reviewer · spec-conformance · spec-coordinator · spec-reviewer ·
triage-agent · validate-setup
-->
