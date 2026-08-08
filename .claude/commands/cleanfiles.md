---
description: "Sweep the repo's accumulating working files: audit first, apply only after operator confirmation, one reviewable commit."
---

# /cleanfiles

Tidy the repo's "working memory" files. These accumulate by design (KNOWLEDGE.md is append-only, todo.md collects items, every build leaves artifacts) and gradually bloat the context every session loads. This command reclaims that space WITHOUT destroying knowledge: every removal is either an archival-with-pointer or covered by git history.

## Modes

- `/cleanfiles` — audit, present the plan, apply after operator confirmation.
- `/cleanfiles audit` — audit and report only; change nothing.
- `/cleanfiles --yes` — audit and apply without the confirmation pause (operator pre-authorises).

**Audit-mode purity (read-only contract).** `/cleanfiles audit` REPORTS and writes nothing. Every target that would otherwise write is downgraded to a report: target 11 uses the generator's `--dry-run` path (no index regeneration, since that rewrites the header timestamp); the queue-staleness target (13) never touches `Last reviewed`, which changes only in an operator-approved FULL sweep; no archive, deletion, or `git rm` runs. This purity is what lets `/cleanfiles audit` be scheduled unattended (see "Wire the clock" below): a scheduled read-only audit must never leave a diff behind. Apply mode (`/cleanfiles` after confirmation, or `/cleanfiles --yes`) performs the writes.

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
| 11 | `references/knowledge-index.md` | Stale index (older than KNOWLEDGE.md, or line-count mismatch vs its header) | **Apply mode:** regenerate `npx tsx scripts/generate-knowledge-index.ts`. **Audit mode:** run the report-only path `npx tsx scripts/generate-knowledge-index.ts --dry-run` and REPORT staleness only; never write the index (a regeneration rewrites the header timestamp, so "regenerate in audit mode" was itself a write that broke the mode's contract). Skip silently if the script is absent (pre-adoption repos). |
| 12 | KNOWLEDGE.md citations + staleness | Entries at the promote-to-ADR threshold; entries naming files that no longer exist; entries superseded via the supersede convention | Run `npx tsx scripts/knowledge-citations.ts` and fold its report into the sweep report: `[PROMOTE?]` entries (3+ citations) surface as promotion proposals under target 1; stale-path entries surface as archive candidates; entries named in any `Supersedes:` line of a newer entry are archived per target 1. Skip silently if the script is absent. |
| 13 | `tasks/framework-upstream-queue.md` | Open rows (`Status` = `queued` or `pr-opened`) whose `Last reviewed` date is older than 180 days | REPORT each stale row (its `FUQ-<n>` ID, candidate, and age in days) in BOTH audit and apply modes. This target NEVER writes the file, in any mode: `Last reviewed` is updated only by an operator-approved FULL sweep, so a read-only staleness report cannot reset the 180-day clock. Closed rows (`promoted`/`rejected`) are ignored. Skip silently if the file is absent (pre-adoption repos). |
| 14 | Per-session context-load telemetry (control C6) | The most recent build's logs (`tasks/builds/<slug>/progress.md`, review logs) carrying a `context-load:` line that reports `full architecture.md` instead of named sliced sections | REPORT ONLY, in BOTH modes (never writes). Grep the most-recently-updated build's logs for `context-load:` lines; any hit naming `full architecture.md` is a per-session-budget regression — a context pack fell back to whole-file loading. Surface each hit (build slug, file, line) as "investigate: pack fell back to full architecture.md". Rationale + target (~25K tokens/session): `references/doc-size-budgets.md § Per-session load target`. Skip silently if no build logs exist. |
| 15 | Doc-size budget violations (control C1 enforcement) | `node scripts/gates/verify-doc-size.mjs` output | AUDIT mode: run the gate, list every [action-needed] violation verbatim in the report with its prescribed fix. APPLY mode: for each operator-approved violation, execute the gate's own fix string (archive moves to tasks/todo-archive/<quarter>.md, tasks/archive/, or KNOWLEDGE-archive-<Q>.md; never edit entry content — archival moves only, per the append-only policy). [grace] rows are reported but only actioned at the quarterly sweep. |

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

## Wire the clock

`/cleanfiles` does not run itself; it is only ever run when something invokes it. The durable, operator-owned trigger for the read-only monthly health check is a **Windows Desktop scheduled task** (operator decision D2): `/loop` is session-scoped and expires, and cloud Routines run from a fresh clone and cannot see the local untracked clutter target 9 reports. This section is the deployment spec; the operator creates the task and owns it.

**What it runs.** The native headless entrypoint is `claude -p "/cleanfiles audit"`. The scheduled task runs it through the shipped wrapper:

```
node scripts/cleanfiles-audit-headless.mjs
```

**Why a wrapper (capability-probe decision).** A pre-deployment probe confirmed headless Claude runs unattended (the CLI supports non-interactive `-p` mode and inherits the operator's existing login), but the Windows Task Scheduler "Start a program" action cannot express, in the task definition alone: a DATED external-log redirection, a per-run timeout, and reliable exit-code propagation. The wrapper supplies exactly those three (and pins the working directory), so it ships as the robust default. On a host where the scheduler can express all four natively, the native `claude -p "/cleanfiles audit"` invocation is equivalent and the wrapper is optional.

**Task definition.**

| Field | Value |
|-------|-------|
| Program/script | `node` (or the absolute path to Node) |
| Arguments | `scripts/cleanfiles-audit-headless.mjs` |
| Start in | the consumer repo root (also settable via `CLEANFILES_AUDIT_REPO`) |
| Repository / branch | the consumer repo, `main` |
| Cadence | monthly (a full sweep is run by the operator at least quarterly) |
| Run mode | "Run whether the user is logged on or not" (unattended) |

**Output sink (external, dated).** The wrapper writes a dated log to an operator-owned directory OUTSIDE the checkout: `%LOCALAPPDATA%\ClaudeCodeFramework\cleanfiles-audit\audit-YYYY-MM-DD.log` (override with `CLEANFILES_AUDIT_LOGDIR`). The log is the run record; it is never written inside the repository.

**Two invariants, kept distinct.**

- **REPOSITORY PURITY.** A scheduled audit changes nothing in the repository: HEAD is unchanged and the working tree is byte-identical before and after the run. This is what "Audit-mode purity" above guarantees, and it is why the audit can be scheduled unattended at all. A repo-internal log file would itself violate the purity the audit exists to prove, which is precisely why the log sink is external.
- **EXTERNAL OPERATIONAL OUTPUT.** The dated log IS created, but outside the repository. "Wrote a log" and "left the repository unchanged" are both true at once and must not be conflated.

**Failure behaviour.** A non-zero wrapper exit (the child's code verbatim, `124` on the per-run timeout, `127` on a spawn failure) is the task's failure signal: pair it with the scheduler's on-failure action (an email or alert), and the dated log carries the detail. A green run exits `0` and leaves only the external log behind.

**Disable / transfer.** Disable or delete the scheduled task to stop the clock; export the task XML (`schtasks /query /xml`) to transfer it to another machine, where the same wrapper runs unchanged (invocability via `node`, no POSIX executable bit needed on Windows). Moving the clock to a different repo is a matter of repointing `Start in` / `CLEANFILES_AUDIT_REPO`.

**First run is operator-verified.** After deployment the operator triggers the task once via the scheduler's run-now on the exact deployed task definition (a separate manual shell invocation does not count): the run must execute under the deployed task's own identity, working directory, command, and output sink. That observed run is the clock's acceptance evidence.
