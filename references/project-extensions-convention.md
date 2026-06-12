# Project Extensions Convention

Status: Introduced in v2.6.1 as the stable convention for project-specific overlays on canonical agent prompts.

## Why

Canonical framework agents (`architect`, `pr-reviewer`, `audit-runner`, etc.) ship as project-agnostic templates with `{{PROJECT_NAME}}` substitution slots. They are intentionally narrow: they encode workflow discipline (TodoWrite hygiene, finding-format, three-pass model, etc.) but NOT project-specific architecture rules.

Every adopting project has its own:
- Layer rules (route → service → storage; or routes-can-also-use-db for admin surfaces; or RLS-enforced)
- Scoping invariants (`userId` / `organisationId` / `tenantId` / org-tier-driven)
- Encryption boundaries (which files, which columns, which helpers)
- Schema discipline (single file vs directory; migration tooling; idempotency rules)
- Permission model (RBAC role hierarchy; feature flags; two-tier orgs; subaccounts)
- Hotspots (the subsystems most worth auditing in this codebase)

These belong in the project's own documentation, not in canonical agent files. v2.6.0 leaked some of these into canonical agent templates (e.g. `architect.md`'s "Architecture Constraints" section, `pr-reviewer.md`'s "Specific Things to Check" section, `audit-runner.md`'s hardcoded hotspots). v2.6.1 strips that contamination and replaces it with this convention.

## Pattern

Each canonical agent that benefits from project-specific overlay reads an optional extension file:

```
.claude/agents/extensions/<agent-slug>.md
```

For example:
- `.claude/agents/extensions/architect.md` — project-specific architecture constraints + path bindings
- `.claude/agents/extensions/pr-reviewer.md` — project-specific blocking / should-fix / consider checks
- `.claude/agents/extensions/audit-runner.md` — project-specific hotspot inventory + critical-finding categories

The canonical agent's "Context Loading" or equivalent section instructs the agent to load the extension file IF PRESENT and apply its content on top of the canonical guidance. Missing extension files are not an error — the agent runs with canonical-only behaviour, which is project-agnostic but safe.

## Directive shape

Canonical agents with extension-loading support include a short "Project Extensions" section near the top:

```markdown
## Project Extensions

If `.claude/agents/extensions/<agent-slug>.md` exists, treat its content as project-specific extensions to this agent's behaviour. Load it during context loading and apply its content on top of the canonical guidance below.
```

And add the file to the Context Loading list (typically as the last numbered item before "the specific task / files provided"):

```markdown
N. `.claude/agents/extensions/<agent-slug>.md` — project-specific extensions to this agent's behaviour, if present. Skip if missing.
```

## Authoring a project extension file

The extension file is a plain Markdown file. There's no required schema — write what the canonical agent needs to know to do its job in this codebase. Suggested sections (use what applies):

1. **Project-specific architecture constraints** — non-negotiable rules the canonical agent will treat as blocking issues.
2. **Path bindings** — what the canonical's framework-default paths (`server/db/schema/`, `server/jobs/`, `architecture.md`, etc.) map to in this project.
3. **Project-specific check categories** — additional Blocking / Should-fix / Consider items beyond canonical (for `pr-reviewer`).
4. **Project-specific hotspots** — for `audit-runner`, the named subsystems with paths and traps.
5. **Conflict resolution** — when canonical and project-extension disagree, which wins, and how to flag the conflict upstream.

## Adoption guidance

When `sync.js --adopt` runs against a project that has extension files in place:
- The extension files at `.claude/agents/extensions/<agent>.md` are NOT managed by the framework. They live under the project's ownership.
- Canonical agent files at `.claude/agents/<agent>.md` ARE managed by the framework. If the project has customized them (added a Project Extensions directive, stripped a wrong-project section), sync marks them `customisedLocally: true` and writes `.framework-new` alongside on upgrade.
- After framework upgrade, the project should merge canonical updates into its (already customised) agent files, preserving the directive and any project-specific edits.

## Long-term direction

Once the convention is stable and adoption tooling supports it, future framework versions can ship canonical agents that ALWAYS include the Project Extensions directive (so projects don't need to customise the canonical at all — the extension file is the only project-managed surface). At that point `customisedLocally: true` would no longer be needed for the directive line itself.

This v2.6.1 PR introduces the convention. Subsequent versions can build on it (e.g. add a `PROJECT_CONTEXT.md` cross-agent convention for substitution values that should not require canonical edits).

## See also

- `manifest.json` for the file management contract
- `SYNC.md` for the upgrade procedure
- `ADAPT.md § Phase 2` for placeholder substitution rules
