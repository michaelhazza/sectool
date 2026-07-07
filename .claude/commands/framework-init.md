---
description: Bootstrap the claude-code-framework into a repo that does not yet mount it — add the submodule, pick a profile, seed adoption state, run sync --adopt, verify, single commit
---

# /framework-init

First-time adoption of `claude-code-framework` in a fresh consumer repo. Adds the submodule at `.claude-framework/`, gathers the profile choice and substitution values from the operator, seeds `.claude/.framework-state.json`, deploys via `sync.js --adopt`, health-checks with `validate-setup`, and lands the whole adoption in one commit. This is the fast path for the common case; `ADAPT.md` (in the framework repo root) remains the manual fallback for advanced adaptation — verification-command customisation, `architecture.md` anchor wiring (Phase 3b), CLAUDE.md integration, and the full phase-by-phase walkthrough.

## What to do

1. **Confirm prerequisites.** Verify: you are at the target repo's root (`git rev-parse --show-toplevel` matches cwd), the working tree is clean (`git status --porcelain` empty), and `.claude-framework/` does not already exist. If it exists, stop — this repo is already a consumer; suggest `/claudeupdate` instead.

2. **Add the submodule.**

   ```bash
   git submodule add <framework-url> .claude-framework
   git submodule update --init .claude-framework
   ```

   `<framework-url>` — the canonical framework remote. Derive it from a sibling consumer repo if one exists (`git -C <sibling>/.claude-framework remote get-url origin`); otherwise ask the operator.

3. **PAUSE — profile choice.** Ask the operator which agent profile to adopt (per `README.md` § profiles):
   - **MINIMAL (4)** — `triage-agent`, `pr-reviewer`, `architect`, `spec-reviewer`. Solo dev, self-review baseline.
   - **STANDARD (10)** — MINIMAL + the three coordinators, `spec-conformance`, `builder`, `hotfix`. Default for most projects.
   - **FULL (28)** — everything. Large projects with capacity for the overhead.

   If the operator is unsure, recommend STANDARD.

4. **PAUSE — substitution values.** Ask the operator for the 3 values (plus the optional 4th):
   - `PROJECT_NAME` — short, human-readable (e.g. `Acme Platform`)
   - `PROJECT_DESCRIPTION` — one short clause (e.g. `a customer billing platform`)
   - `STACK_DESCRIPTION` — stack-name level, not version-pinned (e.g. `Node + Express + Drizzle ORM (PostgreSQL) + React`)
   - `COMPANY_NAME` — optional; omit the key if the operator has none

5. **Seed `.claude/.framework-state.json`** (see `ADAPT.md` § 11 for the canonical shape):

   ```json
   {
     "frameworkVersion": "0.0.0",
     "adoptedAt": "<current ISO timestamp>",
     "adoptedFromCommit": null,
     "profile": "<MINIMAL|STANDARD|FULL>",
     "substitutions": { "PROJECT_NAME": "…", "PROJECT_DESCRIPTION": "…", "STACK_DESCRIPTION": "…" },
     "lastSubstitutionHash": "",
     "files": {},
     "syncIgnore": []
   }
   ```

   `frameworkVersion: "0.0.0"` tells sync everything needs cataloguing. For MINIMAL/STANDARD, populate `syncIgnore` with the `.claude/agents/<name>.md` path of every agent OUTSIDE the chosen profile — without those entries, the next sync re-deploys the pruned agents.

6. **Run adoption sync** from the repo root:

   ```bash
   node .claude-framework/sync.js --adopt
   ```

   Show the operator the per-file output. `--adopt` catalogues pre-existing matching files rather than conflicting on them; genuinely divergent pre-existing files still get `.framework-new` siblings — resolve those (suggest `/claudemerge`) before continuing.

7. **Verify.** Run the `validate-setup` agent (read `.claude/agents/validate-setup.md` and execute it) for the framework health report: agent fleet integrity, hook wiring, cross-references, version consistency. Also grep for leftover placeholders: `grep -rE '\{\{(PROJECT_NAME|PROJECT_DESCRIPTION|STACK_DESCRIPTION|COMPANY_NAME)\}\}' .claude/ docs/ references/` — zero hits expected. Surface any findings; fix mechanical ones (missing `syncIgnore` entry, unsubstituted placeholder) before committing.

8. **PAUSE — pre-commit review.** Show the operator `git status` + a summary of what adoption added (submodule, state file, deployed file count per category). On approval, land it as a single commit:

   ```bash
   git add -A
   git commit -m "chore(framework): adopt claude-code-framework v<version> (<profile> profile)"
   ```

9. **Point at the manual follow-ups.** Adoption is functional but generic. Tell the operator what `ADAPT.md` covers when they want more: verification-command customisation (§ 8 / Phase 3), `architecture.md` anchor wiring for context packs (§ 8 Phase 3b), CLAUDE.md integration (§ 9 / Phase 4), and the profile reference (§ 12).

## Rules

- **Three pause points, always:** profile choice (step 3), substitution values (step 4), pre-commit review (step 8). Never guess these; never commit unreviewed.
- **Refuse a dirty tree.** Adoption must be the only change in its commit — a mixed commit makes the adoption impossible to review or revert cleanly.
- **Refuse an existing `.claude-framework/` mount.** Re-initialising an existing consumer corrupts its adoption state; that repo needs `/claudeupdate`, not `/framework-init`.
- **`syncIgnore` before first sync, not after.** Pruned-profile agents must be ignored from the start; otherwise the very first version bump re-deploys them.
- **One commit.** Submodule + state file + deployed files land together. No pushing unless the operator asks.

## Arguments

`$ARGUMENTS` — optional. The framework remote URL to use for `git submodule add`. If omitted, derive it from a sibling consumer or ask the operator.
