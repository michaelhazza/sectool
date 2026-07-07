---
description: Read-only framework health report — inventory vs README claims, dangling cross-references, unmanaged files in managed directories, orphaned .framework-new, consumer version drift. Zero writes
---

# /framework-doctor

Diagnostic sweep over the framework repo or a consuming repo (auto-detected). Catches the drift that accumulates silently between releases: README counts that no longer match the fleet, agents citing files that were renamed away, files sitting untracked in manifest-managed directories, and half-finished merges. Strictly read-only: no file writes, no state changes, no commits — findings are reported for the operator to route (fix now, `tasks/todo.md`, or next release).

## What to do

1. **Detect the repo kind.** Framework repo: `manifest.json` + `.claude/FRAMEWORK_VERSION` at root, no `.claude-framework/` mount. Consumer: `.claude-framework/` mount present (its `manifest.json` is the manifest to use). Neither → stop and say so. All checks run in both kinds unless marked; paths resolve against the repo root, manifest globs against the framework root (the repo itself, or the submodule).

2. **Check 1 — Inventory vs README claims.** Regenerate the inventory from disk: for each of `.claude/agents/*.md` (excluding `_retired/`), `.claude/skills/*/SKILL.md`, and `.claude/commands/*.md`, parse the frontmatter (`description`, plus `model`/`tools` where present) and count per kind. Diff against what `README.md` claims — the fleet table/list, the profile counts (MINIMAL/STANDARD/FULL), and any "N agents / N skills / N commands" statements. Report one row per discrepancy: kind, on-disk value, README claim, location of the claim.

3. **Check 2 — Dangling cross-references.** Grep agent, skill, and command bodies for repo-path citations (`.claude/...`, `docs/...`, `references/...`, `scripts/...`, `schemas/...`, `migrations/...`) and verify each cited file exists. Classify:
   - `dangling` — cited unconditionally, missing on disk.
   - `conditional-ok` — cited with an "if present" / "when the project ships" / "if it exists" qualifier, missing on disk. Listed for awareness, not a failure.

   One row per citation: citing file, cited path, classification.

4. **Check 3 — Unmanaged files in managed directories.** For every directory that any manifest `managedFiles` glob points into (e.g. `.claude/agents/`, `.claude/commands/`, `.claude/hooks/`, `schemas/`, `migrations/`), list on-disk files matched by NO manifest glob and not covered by `doNotTouch`, state `syncIgnore`, or a `_retired/` path. In the framework repo these are files that will silently not ship; in a consumer they are project-local additions (fine, but worth seeing). One row per file: path, directory's manifest globs, likely disposition.

5. **Check 4 — Orphaned `.framework-new`.** Find every `*.framework-new` outside `.git/` and `.claude-framework/`. For each: does the base target still exist, and is the target still manifest-managed? A `.framework-new` whose target left the manifest is pure orphan (safe to delete manually); one with a live target is an unresolved merge — point at `/claudemerge`.

6. **Check 5 — Version drift (consumer only).** Compare: `.claude/.framework-state.json` `frameworkVersion`, the submodule checkout's `.claude/FRAMEWORK_VERSION`, and the submodule remote tip (`git -C .claude-framework fetch origin main --quiet` then `origin/main`'s version). Report current vs mounted vs available, plus `appliedMigrations` count vs migrations shipped. Behind the tip → suggest `/claudeupdate`; state vs mounted mismatch → suggest `node .claude-framework/sync.js --doctor` for the per-file state diagnosis.

7. **Report.** One table per check, in order, each with a one-line verdict (`OK` or `N findings`). Close with a single summary line: `framework-doctor: N checks, M findings, 0 writes`.

## Rules

- **Zero writes.** No fixes, no state updates, no commits — not even "obviously safe" ones. This command diagnoses; the operator (or a follow-up command) treats.
- **Fetching is the only network touch, and only in a consumer** (check 5's `git fetch` of the submodule remote). Skip it gracefully when offline and mark the tip column `unreachable`.
- **"If present" citations are not findings.** Conditional references are a framework convention (consumers legitimately lack optional files); report them as `conditional-ok`, never as failures.
- **Don't double-report.** A file already listed in state `syncIgnore` or under `_retired/` is intentional — exclude it from checks 1 and 3.
- **Every finding names its evidence** (file + line or path), so the operator can act without re-deriving the search.

## Arguments

`$ARGUMENTS` — optional. Path to the repo to examine. Defaults to the current working repo.
