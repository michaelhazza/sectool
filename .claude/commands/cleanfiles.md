---
description: Sweep the repo's accumulating working files — archive stale knowledge, prune dead task entries, clear merged-build clutter — audit first, apply after operator confirmation, one reviewable commit
---

# /cleanfiles

Tidy the repo's "working memory" files. These accumulate by design (KNOWLEDGE.md is append-only, todo.md collects items, every build leaves artifacts) and gradually bloat the context every session loads. This command reclaims that space WITHOUT destroying knowledge: every removal is either an archival-with-pointer or covered by git history.

## Modes

- `/cleanfiles` — audit, present the plan, apply after operator confirmation.
- `/cleanfiles audit` — audit and report only; change nothing.
- `/cleanfiles --yes` — audit and apply without the confirmation pause (operator pre-authorises).

## Hard safety rules

1. **Never delete knowledge content.** KNOWLEDGE.md / lessons entries move to a dated archive file with a one-line pointer left behind. Deletion is allowed only where git history already preserves the exact content (committed files being `git rm`'d, completed todo items).
2. **Audit before apply.** Always produce the full plan (per-target: what, how many, why) before touching anything. Default flow pauses for operator confirmation.
3. **Docs-only guard.** Before committing, verify the diff touches no product code: fail the sweep if any staged path is outside the target list below. Never touch `server/`, `client/`, `shared/`, `scripts/`, migrations, or CI workflows.
4. **One commit, on a branch.** All changes land in a single commit on `chore/cleanfiles-<YYYY-MM-DD>`; the operator merges. Never commit to main directly.
5. **Verify before reporting done.** Archived-entry count == pointer count; archive file contains every moved entry verbatim; surviving files parse cleanly (no broken headings/fences). Report a before/after table.
6. **Untracked files are report-only.** Never delete a file git does not track — list root-level clutter for the operator and move on.

## Targets

Process only the targets that exist in this repo. Retention windows are defaults; `.claude/cleanfiles.json` overrides them (see Config).

| # | Target | What gets cleaned | Process |
|---|--------|-------------------|---------|
| 1 | `KNOWLEDGE.md` | Entries superseded by a framework skill, near-duplicate entries, entries restating rules now carried by agent-facing docs | Move full entry text to `KNOWLEDGE-archive-<YYYY>-Q<N>.md`; leave one-line pointer: `superseded by framework skill <name>` (or `merged into <entry>`). Use a `tasks/knowledge-to-framework-skills-map.md`-style mapping doc if present; otherwise diff entry content against `.claude/skills/*/SKILL.md`. When in doubt, keep the entry and list it in the report for the operator's call. |
| 2 | `tasks/todo.md` | Completed/checked items; open items untouched > `todoStaleDays` (default 30) | Delete completed items (git history is the archive). Move stale open items to a `## Backlog` section with a date stamp. Dedupe near-identical items, keeping the richest. |
| 3 | `tasks/lessons.md` | Lessons absorbed into skills, KNOWLEDGE.md, or reference docs | Same archive-with-pointer treatment as KNOWLEDGE.md, into `tasks/lessons-archive-<YYYY>-Q<N>.md`. |
| 4 | `tasks/builds/<slug>/` | Build dirs whose branch/PR is merged or deleted and untouched > `buildArchiveDays` (default 30) | Move the whole dir to `tasks/builds/_archive/<slug>/`. Verify merged state via `git log`/`gh pr list` before moving; skip the slug named in `tasks/current-focus.md`. Never archive `_example/`. |
| 5 | `tasks/review-logs/` | Log files older than `reviewLogDays` (default 90) | `git rm` them — history preserves every byte. Keep `README.md`, `prompt-evolution-log.md`, and anything under `quarantined/` newer than the window. |
| 6 | `tasks/current-focus.md` | Stale pointer | If it names a branch/slug that is merged or deleted, reset the status to `none` with a one-line note of what completed. |
| 7 | `prototypes/` | Mockups for builds already archived by target 4 | Move alongside the archived build (`tasks/builds/_archive/<slug>/prototypes/`). Keep `_tokens.css` and mockups for unmerged builds. |
| 8 | `.claude/session-state/` | Per-session mode files older than `sessionStateDays` (default 7) | Delete (they are transient by contract). |
| 9 | Repo root | Untracked clutter (stray diffs, tmp scripts, one-off exports) | REPORT ONLY — list them with sizes; the operator decides. |
| 10 | `.claude/context/skill-context.md` | Un-promoted overlay entries that generalise beyond this repo | **Overlay drain (non-destructive, operator-gated).** For each `## <skill-name>` entry NOT already marked `> promoted in`, assess generalisability; propose promotion to the named skill's canonical `SKILL.md` (a framework PR). On operator acceptance: add a `> promoted in vX.Y.Z` prefix line to the overlay entry (mark, never delete — provenance) and append a row to `tasks/knowledge-to-framework-skills-map.md`, **creating that mapping file if it does not exist** (the framework does not ship it). Full protocol: `references/skill-overlay-convention.md`. |
| 11 | `references/knowledge-index.md` | Stale index (older than KNOWLEDGE.md, or line-count mismatch vs its header) | Regenerate on every sweep: `npx tsx scripts/generate-knowledge-index.ts`. Runs even in `audit` mode (the index is generated output, not content). Skip silently if the script is absent (pre-adoption repos). |
| 12 | KNOWLEDGE.md citations + staleness | Entries at the promote-to-ADR threshold; entries naming files that no longer exist; entries superseded via the supersede convention | Run `npx tsx scripts/knowledge-citations.ts` and fold its report into the sweep report: `[PROMOTE?]` entries (3+ citations) surface as promotion proposals under target 1; stale-path entries surface as archive candidates; entries named in any `Supersedes:` line of a newer entry are archived per target 1. Skip silently if the script is absent. |

## Config (optional)

`.claude/cleanfiles.json` in the consuming repo:

```json
{
  "reviewLogDays": 90,
  "todoStaleDays": 30,
  "buildArchiveDays": 30,
  "sessionStateDays": 7,
  "skip": ["tasks/review-logs/"],
  "extraReportPaths": ["exports/"]
}
```

`skip` removes a target from the sweep entirely; `extraReportPaths` adds report-only paths to target 9.

## When to run

Suggest a sweep (do not auto-run) when any threshold trips: `KNOWLEDGE.md` > 4,000 lines; `tasks/todo.md` > 200 lines; `tasks/review-logs/` > 400 files; > 20 active dirs under `tasks/builds/`. Quarterly is a sensible default cadence regardless.

## Report format

One table, before/after per target:

```
Target                    Before          After           Action
KNOWLEDGE.md              7,542 lines     3,180 lines     412 entries archived → KNOWLEDGE-archive-2026-Q3.md
tasks/todo.md             214 lines       61 lines        38 completed removed, 12 → Backlog
tasks/review-logs/        1,912 files     388 files       1,524 git rm (history retains)
tasks/builds/             23 dirs         6 dirs          17 → _archive/
repo root (report only)   3 untracked     —               pr30.diff (1.1 MB), scratch.md, out.json
```

Close with: branch name, commit sha, and the reminder that the operator merges.
