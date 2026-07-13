# Skill overlay convention

The single source of truth for the local skill-overlay mechanism: the `.claude/context/skill-context.md` overlay, the greppable pointer line every `SKILL.md` carries, and the KNOWLEDGE → overlay → canonical-skill drain.

## Why this exists

Skills (`.claude/skills/<name>/SKILL.md`) are `mode: sync` — the framework overwrites them on every update. A repo therefore cannot add its own failure modes or corrections *inside* a `SKILL.md`; the next sync would clobber them. The overlay gives each skill a per-repo sidecar the framework never touches, and a defined path for the durable, generalisable lessons to flow back upstream so quality compounds across every consuming repo.

Two overlays exist, one per subject class, same ADR-0006 mechanism:

| Overlay | Subject | Deploy mode |
|---|---|---|
| `.claude/context/agent-context.md` | agent operating notes | adopt-only |
| `.claude/context/skill-context.md` | skill failure modes / corrections | adopt-only |

## Canonical pointer line (pinned)

Every shipped `SKILL.md` carries exactly one pointer line, inserted immediately after the frontmatter. The wording is pinned here so the validator and the skills never drift:

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## <skill-name>` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

`<skill-name>` is the skill's own directory name. The **stable substring** the validator greps for is the literal path `.claude/context/skill-context.md`. `scripts/validate-framework.js` fails (exit 1) when any `.claude/skills/*/SKILL.md` body lacks that substring — this is the enforceable gate. `/framework-doctor` Check 6 is the broader consumer-side advisory view (a consumer's synced skills always carry the pointer, but consumer-authored local skills may not).

## Write protocol

1. **KNOWLEDGE.md remains the master append-only log.** Every lesson lands there first, unchanged. The overlay never replaces KNOWLEDGE.md.
2. **Same-day mirror.** When a lesson is procedural AND clearly skill-shaped (it would change how a specific skill is applied), ALSO append it that day to the matching `## <skill-name>` section of `.claude/context/skill-context.md`. The KNOWLEDGE.md entry stays canonical; the overlay entry is a scoped copy, dated, with a back-reference to the KNOWLEDGE.md date. See the entry shape in the overlay template header.
3. **Quarterly drain (promotion).** During the `/cleanfiles` quarterly sweep, overlay entries that generalise beyond the repo are promoted upstream into the canonical skill (a framework PR that edits the skill's `SKILL.md`). Promoted entries are **marked, not deleted**: the overlay entry gets a `> promoted in vX.Y.Z` prefix line and stays for provenance. This keeps the overlay auditable and prevents re-proposing the same promotion next quarter.
4. **Mapping doc.** `/cleanfiles` consults and maintains `tasks/knowledge-to-framework-skills-map.md` (format below), recording overlay-entry → canonical-skill promotions.

## `/cleanfiles` drain (mechanism)

`/cleanfiles` has an overlay-drain target in its sweep table. On each run it:

1. Scans `.claude/context/skill-context.md` sections; for each entry NOT already marked `> promoted in`, assesses generalisability (does the lesson hold beyond this repo?).
2. Proposes a promotion to the named skill — operator-confirmed, framework-PR-bound. Non-destructive; audit-first like the rest of `/cleanfiles`.
3. On acceptance: adds the `> promoted in vX.Y.Z` marker to the overlay entry and appends a row to `tasks/knowledge-to-framework-skills-map.md`, **creating that mapping file if it does not yet exist** — the framework does not ship it.

## Mapping doc format (`tasks/knowledge-to-framework-skills-map.md`)

Consumer-created by `/cleanfiles` on the first promotion; NOT shipped by the framework (it ships mechanism, not data, consistent with `doNotTouch: tasks/**`). One row per promotion:

```markdown
# KNOWLEDGE → framework-skill promotion map

| Date | Skill | Overlay entry (title) | Promoted in | Framework PR |
|------|-------|-----------------------|-------------|--------------|
| 2026-07-09 | postgres-migrations | CHECK constraint without NOT VALID | v2.34.0 | #123 |
```

## framework-doctor overlay checks

- **Check 6 — Overlay section validity.** Every `## <name>` section in `skill-context.md` must name an existing `.claude/skills/<name>/SKILL.md`. A section naming no existing skill is a finding.
- **Check 7 — Stale un-promoted overlay entries.** A dated entry with no `> promoted in` marker older than one quarter is an awareness finding (a compounding leak — a durable lesson that never made it upstream).

Both are agent-mediated, Node-based (Windows-safe), read-only — same posture as Checks 1–5.

## Deployment

- Overlay template: `.claude/context/skill-context.md`, manifest `mode: adopt-only` — seeded once, consumer-owns-after.
- This convention doc: `references/skill-overlay-convention.md`, manifest `mode: sync`, registered in `docs/doc-sync.md`.
- The mapping doc is neither shipped nor tracked by the manifest; its format is documented here.
