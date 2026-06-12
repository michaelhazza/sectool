---
description: One-shot bump of the claude-code-framework submodule across all consuming repos — sync canonical files, run pending migrations, commit, push
---

# /claudeupdate

Update every local repo that mounts `claude-code-framework` as a submodule. Bumps the submodule pointer to the latest canonical commit, deploys canonical files via `sync.js`, runs any pending framework migrations, commits the lot, and pushes — per repo, only when safe to do so.

This is the one-shot, fully-automated flow as of framework v2.9.0. Earlier versions of this command only bumped the submodule pointer and left `sync.js` + migration steps as manual per-repo follow-ups; that's no longer the case.

## What to do

1. **Determine the scan root.**
   - If `$ARGUMENTS` is provided, use it (e.g. `/claudeupdate D:/projects/`).
   - Otherwise default to the parent directory of the current working repo (the directory that contains the current session's checkout).
   - Typical layouts: Windows `c:/files/Claude/` or `c:/Files/Projects/`; Linux/macOS `~/projects/` or similar — parent-of-cwd handles both.

2. **Discover consuming repos.** Scan `<scan-root>/*` for any directory containing a `.claude-framework/` whose `origin` URL contains `claude-code-framework`. Skip directories that don't have it.

   ```bash
   for d in <scan-root>/*/; do
     if [ -d "$d.claude-framework" ]; then
       origin=$(git -C "$d.claude-framework" remote get-url origin 2>/dev/null)
       if echo "$origin" | grep -q "claude-code-framework"; then
         echo "$d"
       fi
     fi
   done
   ```

3. **For each repo discovered, gather state** before doing anything:
   - Current submodule sha (`git -C <repo>/.claude-framework rev-parse --short HEAD`)
   - Current submodule version (`cat <repo>/.claude-framework/.claude/FRAMEWORK_VERSION` — this is `FROM_VERSION`)
   - Current branch (`git -C <repo> rev-parse --abbrev-ref HEAD`)
   - Working tree clean? (`git -C <repo> status --porcelain` — empty = clean)
   - Submodule working tree clean? (`git -C <repo>/.claude-framework status --porcelain`)

4. **Fetch the latest framework tip** to know the target sha and version. Use the current session's already-mounted framework as the fetch source (every consuming repo shares the same `origin`):

   ```bash
   git -C <current-repo>/.claude-framework fetch origin main --quiet
   TARGET_SHA=$(git -C <current-repo>/.claude-framework rev-parse --short origin/main)
   TARGET_VERSION=$(git -C <current-repo>/.claude-framework show origin/main:.claude/FRAMEWORK_VERSION)
   ```

5. **Per repo, decide:**

   | State | Action |
   |---|---|
   | Already at TARGET_SHA | Skip — "already current" |
   | Branch != main | Skip — "on branch <X>, won't auto-commit" |
   | Working tree dirty | Skip — "uncommitted changes in <repo>" |
   | Submodule has uncommitted edits | Skip — "uncommitted submodule edits in <repo>" |
   | Clean, on main, behind target | Run the **one-shot update sequence** below |

6. **One-shot update sequence (safe path only).** Run from `<repo>` (the consumer root). Order matters: migrations run **before** `sync.js` so pre-existing matching local files get adopted into state before `sync.js` would otherwise write `.framework-new` siblings for them. See `migrations/README.md § Lifecycle position` for the rationale.

   ```bash
   cd <repo>

   # 6a. Bump the submodule pointer (frameworkRoot now points to TARGET_SHA)
   git submodule update --remote .claude-framework

   # 6b. Run pending migrations in semver order. Migrations operate on the
   #     post-bump submodule (framework canonical) and the consumer working tree.
   #     v2.8.0's job: auto-adopt pre-existing local files whose content matches
   #     framework, seed .claude/project-registries.json from the template.
   node .claude-framework/scripts/run-migrations.js "$PWD" "$FROM_VERSION" "$TARGET_VERSION" || {
     echo "FAILED: migration runner threw — fix root cause and re-run /claudeupdate"
     exit 1
   }

   # 6c. Deploy canonical files via sync.js. Files the migration just pre-adopted
   #     into state are now seen as 'clean' and skipped silently. Files genuinely
   #     diverging from framework get .framework-new siblings.
   node .claude-framework/sync.js

   # 6d. Detect unresolved .framework-new conflicts across the WHOLE consumer tree
   #     (excluding .git and the submodule's own .git). sync.js can write
   #     .framework-new under .claude/, scripts/, schemas/, docs/, references/, etc.
   CONFLICTS=$(find . -name '*.framework-new' -not -path './.git/*' -not -path './.claude-framework/.git/*' 2>/dev/null)
   if [ -n "$CONFLICTS" ]; then
     CONFLICT_COUNT=$(echo "$CONFLICTS" | wc -l)
     echo "PAUSE: $CONFLICT_COUNT .framework-new conflict(s) need manual merge before continuing."
     echo "$CONFLICTS"
     exit 1
   fi

   # 6e. Stage everything sync.js + migrations touched (submodule pointer + new
   #     managed files + state.json + any registry/template seeds).
   git add -A

   # 6f. Single commit covering the bump + sync + migrations.
   git commit -m "$(cat <<EOF
   chore(framework): bump claude-code-framework submodule to ${TARGET_VERSION}

   Pointer: ${OLD_SHA} -> ${TARGET_SHA}
   migrations: ran pending migrations in (${FROM_VERSION}, ${TARGET_VERSION}]
   sync.js: applied managed files

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   )"

   # 6g. Push.
   git push origin main
   ```

7. **On `.framework-new` conflict (6d trips):**
   - Do NOT auto-merge or auto-resolve.
   - Stop the one-shot for this repo and report `paused — manual merge of N .framework-new files`.
   - Surface the file list to the operator. The operator merges, deletes the `.framework-new` sibling, then re-runs `/claudeupdate` for that repo.
   - On re-run, any migration that returned `conflict` last time is retried (it is intentionally NOT recorded in `appliedMigrations` until it returns `applied` or `skipped`).

8. **On migration failure (6b throws):**
   - `sync.js` has NOT run yet — the consumer's working tree only has the bumped submodule pointer.
   - Do NOT commit or push.
   - Report `failed — migration v<X> threw <error>`. Surface the error to the operator.
   - The runner persists state after each successfully-completed migration, so re-running `/claudeupdate` resumes from the failed one (operator must fix the root cause first).

9. **Final report.** Single plain table — one row per repo. Columns: Repo, Before, After, Sync, Migrations, Outcome.

   Example:
   ```
   Repo                  Before    After     Sync          Migrations         Outcome
   automation-v1         1702ae0   d302e29   3 updated     2 applied          updated + pushed
   automation-v1-3rd     866c667   d302e29   1 customised  1 applied 1 skip   updated + pushed
   automation-v1-4th     866c667   d302e29   2 customised  -                  paused — 2 .framework-new
   automation-v1-5th     d302e29   d302e29   -             -                  already current
   automation-v1-6th     866c667   866c667   -             -                  skipped — branch feature/foo
   ```

## Rules

- **Never `--force` past dirty state.** If a repo isn't on `main` or has uncommitted work, skip and report. Don't try to be clever.
- **One commit per repo.** Submodule bump + migrations + sync.js results land in a single commit (step 6f). No batching across repos.
- **No auto-resolution of `.framework-new` conflicts.** Customised files survive only because manual review is the merge point. The one-shot pauses on conflict; the operator resolves and re-runs.
- **Migrations run BEFORE sync.js, both before commit.** Migrations get the post-bump submodule via `frameworkRoot` and can pre-populate state so `sync.js` skips files the consumer already has at framework-equivalent content. See `migrations/README.md § Lifecycle position` for the rationale.
- **Conflict-status migrations are retried on the next run.** The runner only records a migration as applied when it returns `applied` or `skipped`. A `conflict` result intentionally leaves the migration unrecorded so it re-runs after the operator merges the related `.framework-new` files.
- **Skip the current working directory** unless the operator passes it explicitly. The session's own repo is usually already in flight; if it's behind, surface it but don't auto-commit there — let the operator decide.

## Arguments

`$ARGUMENTS` — optional. Path to the directory to scan for consuming repos. Defaults to the parent of the current working repo.
