# Skill context — project-specific addenda for framework skills

This file is the **only** place to add project-specific failure modes, anti-patterns, and corrections for a framework skill. It is the skill-side analogue of `.claude/context/agent-context.md`: every shipped `SKILL.md` carries a pointer line telling the agent to read the `## <skill-name>` section here (if present) before applying that skill in this repo.

**Contract (mirrors ADR-0006):**

- Skill `SKILL.md` files are framework-canonical and `mode: sync` — they are **overwritten on every framework update**. Never edit a `SKILL.md` to add repo-specific notes; the next sync would clobber them. Repo-specific notes go here instead.
- Add a `## <skill-name>` section **only** for a skill you actually need to annotate. Skills with no project notes need no section.
- The heading MUST exactly match the skill's directory name (its `name:` frontmatter field, e.g. `## postgres-migrations` for `.claude/skills/postgres-migrations/SKILL.md`).
- Keep entries tight and dated. Each entry records a real repo-specific failure the skill should have caught, the anti-pattern that produced it, and the correction.
- This file is `adopt-only`: the framework deploys it once, then never overwrites it. It is yours to maintain.

### Write protocol (summary)

Full protocol: [`references/skill-overlay-convention.md`](../../references/skill-overlay-convention.md).

1. **KNOWLEDGE.md stays the master append-only log.** Every lesson lands there first, unchanged.
2. **Same-day mirror.** When a lesson is procedural AND clearly skill-shaped (it changes how a specific skill is applied), ALSO append it that day to the matching `## <skill-name>` section here, dated, with a back-reference to the KNOWLEDGE.md date.
3. **Quarterly drain.** During the `/cleanfiles` sweep, overlay entries that generalise beyond this repo are promoted upstream into the canonical skill (a framework PR). Promoted entries are **marked, not deleted** — the entry gets a `> promoted in vX.Y.Z` prefix and stays for provenance.

### Entry shape

Each entry under a `## <skill-name>` section:

```
### YYYY-MM-DD — <one-line failure title>
- **Failure mode:** what went wrong that the skill did not prevent.
- **Anti-pattern:** the specific shape to stop doing.
- **Correction:** the rule to apply instead.
- **KNOWLEDGE ref:** <date of the canonical KNOWLEDGE.md entry>.
```

---

### Worked example

The example below uses a **real skill name** but is wrapped in an HTML comment, so it can never be read as binding project context — delete it or replace it with your real `## <skill-name>` sections.

<!--
## postgres-migrations

### 2026-07-09 — CHECK constraint added without NOT VALID broke a large-table deploy
- **Failure mode:** a migration added a CHECK constraint on a 40M-row table with a plain `ADD CONSTRAINT`, taking an ACCESS EXCLUSIVE lock for the full validation scan.
- **Anti-pattern:** `ADD CONSTRAINT ... CHECK (...)` on a hot large table in one statement.
- **Correction:** `ADD CONSTRAINT ... CHECK (...) NOT VALID`, then `VALIDATE CONSTRAINT` in a separate transaction.
- **KNOWLEDGE ref:** 2026-07-09.
-->
