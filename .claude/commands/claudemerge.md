---
description: Three-way merge of pending .framework-new conflicts in a consuming repo — auto-applies clean merges, surfaces genuine conflicts for manual resolution, then hands back to /claudeupdate
---

# /claudemerge

Resolve the `.framework-new` conflicts that pause `/claudeupdate`. Runs `scripts/framework-merge.js`, which reconstructs the BASE (the framework version the repo last applied, from `.framework-state.json`'s `lastAppliedFrameworkCommit` + the submodule's git history) and runs `git merge-file` per conflict: LOCAL (the customised file) vs BASE vs INCOMING (the `.framework-new` content). Clean merges are written to the target and the `.framework-new` sibling deleted; anything with overlapping edits is left completely untouched and reported for manual resolution.

## What to do

1. **Confirm the repo.** Run from the consumer repo root (the repo that mounts `.claude-framework`). If `$ARGUMENTS` names a different consumer repo path, operate on that instead.

2. **Run the helper** from the submodule — it ships with the framework, so it needs no sync into the consumer:

   ```bash
   node .claude-framework/scripts/framework-merge.js "$PWD"
   ```

   (If the consumer has a manifest-managed copy at `scripts/framework-merge.js`, that works identically — the submodule path is primary because it exists in every consumer regardless of sync state.)

3. **Report per-file results** to the operator from the helper's summary table:
   - `merged` — local customisations and framework changes combined cleanly; target updated, `.framework-new` deleted.
   - `manual` — overlapping edits (or no usable base: missing state entry, base commit gone, file not manifest-managed). Nothing was touched.
   - `skipped` — substituted file (`substituteAt` is not `never`); base reconstruction is unreliable through the placeholder substitution, so it is always a manual merge.

4. **For each `manual`/`skipped` file, show the operator the conflict.** Read the target file and its `.framework-new` sibling, present a focused diff of the divergent sections, and let the operator decide line-by-line. Apply the operator's resolution to the target, then delete the `.framework-new` sibling.

5. **Hand back to the update flow.** Once no `.framework-new` files remain, instruct the operator to re-run `/claudeupdate` (or run `node .claude-framework/sync.js` directly). The maintenance pass rebaselines every merged file's hash into `.framework-state.json` — without it, sync keeps reporting "merged without resync".

## Rules

- **Never auto-resolve files the helper marks `manual` or `skipped`.** The helper only auto-applies conflict-free three-way merges; everything else is an operator decision. Do not "helpfully" pick a side.
- **Show, don't summarise, real conflicts.** The operator needs to see the actual divergent lines (local vs framework) before deciding, not a paraphrase.
- **The helper never destroys local content.** Clean merges land via atomic tmp+rename; conflicted files are byte-for-byte untouched. If anything looks wrong post-merge, `git diff` shows exactly what changed and `git checkout -- <file>` reverts it.
- **Always finish with the sync re-run.** A merged file without a rebaselined state hash will be re-flagged as customised on the next update.

## Arguments

`$ARGUMENTS` — optional. Path to the consumer repo root to merge. Defaults to the current working repo.
