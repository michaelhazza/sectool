---
description: Producer-side framework release — bump version, insert CHANGELOG entry, optional migration scaffold, commit, tag vX.Y.Z, push with confirmation. Runs in the framework repo only
---

# /release

Cut a framework release from the `claude-code-framework` repo itself. Given a bump level (`major`/`minor`/`patch`) and a one-line summary, this verifies the tree is releasable, bumps `FRAMEWORK_VERSION` + `manifest.frameworkVersion` together, inserts the CHANGELOG heading, optionally scaffolds a migration, then commits, tags `vX.Y.Z`, and pushes — with an operator confirmation before anything leaves the machine. Tagging is part of the command precisely because it kept getting skipped: release tags fell 23 versions behind the version file, and the `v*` tag push is what triggers `notify-application-on-release.yml`.

## What to do

1. **Refuse to run anywhere but the framework repo.** Producer-side check: `manifest.json` AND `.claude/FRAMEWORK_VERSION` must both exist at the repo root, and there must be NO `.claude-framework/` submodule mount (consumers have the mount and no root `manifest.json`). If the check fails, stop: "This is not the framework repo — /release is producer-side only."

2. **Gather inputs.** From `$ARGUMENTS`: bump level (`major`|`minor`|`patch`) and a one-line summary. If either is missing, ask the operator. Read the current version from `.claude/FRAMEWORK_VERSION` and compute the new one.

3. **Verify releasable state:**
   - On `main` (`git rev-parse --abbrev-ref HEAD`), clean working tree (`git status --porcelain` empty), up to date with `origin/main` (`git fetch origin main` then compare).
   - **CI-parity checks** (mirror `.github/workflows/ci.yml`):
     - JSON validity: `manifest.json`, `.claude/settings.json`, `.claude/hooks/package.json`, every `schemas/*.json` parse cleanly.
     - Version consistency: `.claude/FRAMEWORK_VERSION` == `manifest.frameworkVersion`, and `.claude/CHANGELOG.md` has a `## <current-version>` heading.
   - Any failure stops the release before any write.

4. **Bump the version pair together:** write the new version to `.claude/FRAMEWORK_VERSION` (single line) and to `manifest.json` `frameworkVersion`. These two must never diverge — `sync.js` refuses to run on a mismatched checkout.

5. **Insert the CHANGELOG entry** at the top of the version history in `.claude/CHANGELOG.md` (above the previous latest `## <version>` heading, below the format/protocol preamble):

   ```
   ## <new-version> — <today YYYY-MM-DD>

   **Highlights:** <one paragraph>

   **Added/Changed/Fixed/…:** <per the Format section of the changelog>
   ```

   The operator supplies the entry body, or, on request, draft it from `git log v<previous-version>..HEAD --oneline` (fall back to the commits since the previous version's release commit when the tag is missing — a symptom of the very lag this command fixes) and show it for approval before writing.

   **Growth-gate declaration (control C5) — mandatory for every NEW always-loaded addition.** If this release ADDS any file under `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`, or `.claude/commands/` (a new agent, skill, hook, or command — the always-loaded behavioural surface), the CHANGELOG entry MUST carry one declaration line per new file:

   ```
   > growth-gate: <path-or-name> — replaces: <what it replaces | none: why nothing existing covers it>; footprint: <N bytes | not-always-loaded>
   ```

   This is enforced mechanically at step 7 (`verify-growth-gate.mjs`). A new tier or a new always-loaded doc section is the same class of growth — declare its replacement rationale and footprint in prose even though the mechanical gate only diffs the four file classes.

6. **Migration scaffold (ask).** If the release contains structural changes a consumer must react to (file renames/moves, state-schema changes, template seeds, retired files), ask the operator whether it needs `migrations/v<new-version>.js`. If yes: scaffold from `migrations/_template.js` when present, otherwise model on the most recent `migrations/v*.js` per `migrations/README.md` § *Authoring a new migration* (idempotent, non-destructive on conflict, returns `{ status, notes }`). The `migrations/v*.js` manifest glob picks it up automatically. Reference it from the CHANGELOG entry: `Migration: v<new-version>.js — <what and why>`.

7. **Re-run the version-consistency check** from step 3 against the bumped files (including the new CHANGELOG heading). **Then run the growth gate** — `node scripts/gates/verify-growth-gate.mjs` — which diffs new behavioural files since the previous release tag and fails (exit 1) if any lacks its `> growth-gate:` CHANGELOG declaration (control C5). Fix the CHANGELOG entry before proceeding; the gate fails-open only when the previous tag is unresolvable. **Then run the description-budget gate** — `node scripts/gates/verify-description-budgets.mjs` — a BLOCKING gate (exit 1) if any agent/skill/command `description:` frontmatter exceeds its per-surface budget (agents 400B / skills 450B / commands 180B). Those descriptions load into every session's system prompt, so an over-budget one is held out of the release; trim it to a WHEN-TO-INVOKE signal (procedure belongs in the body) per `references/doc-size-budgets.md`. Then commit:

   ```bash
   git add -A
   git commit -m "v<new-version> — <one-line summary>"
   ```

8. **PAUSE — confirm before push.** Show the operator: new version, files changed, the CHANGELOG entry, whether a migration shipped, and the exact push commands. Only on approval:

   ```bash
   git push origin main
   git tag -a v<new-version> -m "<one-line summary>"
   git push origin v<new-version>
   ```

9. **Report.** Version released, tag pushed, and a reminder that the tag push dispatches `notify-application-on-release.yml`; consumers pick the release up via `/claudeupdate`.

## Rules

- **Producer-side only.** Never run in a consuming repo — the step-1 guard is mandatory, not advisory.
- **Version file, manifest, and CHANGELOG heading move as one commit.** A partial bump is a broken release; CI's version-consistency check will reject it anyway.
- **The tag is not optional.** A release without the `v<version>` tag is the historical failure mode (tags 23 versions behind): downstream notification never fires and `git log v<prev>..HEAD` drafting breaks for the next release. Commit, tag, and tag-push happen in the same confirmed step.
- **Confirm before push.** Nothing is pushed — commit, tag, or otherwise — until the operator approves the step-8 summary. Local commits are cheap to amend; pushed tags are not.
- **No release from a dirty or diverged tree.** Land pending work through the normal PR flow first; a release commit contains only the version bump, CHANGELOG entry, and optional migration.

## Arguments

`$ARGUMENTS` — `<major|minor|patch> <one-line summary>`. Example: `/release minor merge tooling + framework-init/release/doctor commands`. Missing pieces are asked for interactively.
