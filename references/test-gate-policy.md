# Test Gate Policy

> Single source of truth for the "test gates are CI-only — never run locally" rule. Referenced from `CLAUDE.md`, every agent in `.claude/agents/`, and every spec/plan in `docs/` and `tasks/builds/`.

This file replaces ~10 duplicated copies of the same rule across the agent fleet.

## Rule

**Continuous integration runs the complete test/gate suite as the final pre-merge confirmation.** No local agent or development session runs the full battery. This applies to every agent in `.claude/agents/`, every skill, every review loop iteration, and every main-session task — with exactly ONE carve-out: the finalisation G5 local CI-parity gate (see below).

## Forbidden locally

- `npm run test:gates`, `npm run test:qa`, `npm run test:unit`, the umbrella `npm test`.
- `bash scripts/run-all-unit-tests.sh`, `bash scripts/run-all-gates.sh`.
- Any individual `scripts/verify-*.sh` or `scripts/gates/*.sh` invocation.
- Any "regression sanity check", "quick re-verify everything", "confirm no regression" framing — these are dressed-up gate runs.

## Allowed locally

- `npm run lint`.
- `npm run typecheck` (or the dual-tsconfig form per `replit.md`).
- `npm run build:server` / `npm run build:client` when the change touches the build surface.
- **Targeted execution of unit tests authored for THIS change** — a single test file at a time, run via **the project's configured test runner** (check `package.json` scripts / config; e.g. `npx vitest run <path-to-test>` in a Vitest repo). Only when the repo has NO configured runner is a bare-runtime fallback (`npx tsx --test <path-to-test>`) acceptable. Confirm the new test runs and passes. Not to re-run anything else.

> **Single-file runner rule (unified 2.27.0):** this paragraph is the ONLY statement of which command runs a targeted test. Agent files reference it instead of naming a command — a repo whose quality gates reject `npx tsx` (e.g. via a verify-test-quality script) and a repo with no runner at all are both covered by the rule above.

Authoring tests and gates is encouraged. Running the full battery of them locally is not. CI handles that.

## Finalisation G5 carve-out (the ONE sanctioned local suite run — scoped by default, full on escape-hatch diffs)

`finalisation-coordinator` Step 8c (G5 local CI-parity gate) and its Step 11 fix-loop verification run CI's check suite locally. This is deliberate and is the only exception to the rule above. G5 has two modes (selected at Step 8c.2):

- **G5-scoped (default when the repo ships `scripts/g5-scoped.sh`):** full lint + typecheck, the test runner's related-files selection over the branch diff (e.g. `vitest related --run <changed files>`, per suite), and only the static gates whose trigger surface the diff touches, per the declarative path-glob mapping table pinned in the consuming repo's `scripts/g5-scoped.sh`.
- **Full G5 (mandatory escape hatch):** the entire parity set. Scoped mode refuses and falls back to full when the diff touches aggregate/global surfaces where subset runs are blind — migration directories, package manifests/lockfiles, the project's shared registry files, `*baseline*` files, the test-runner config, CI workflow files — or when a merge commit from main brought such changes into the branch.

Whichever mode runs records one line in `tasks/builds/<slug>/progress.md`: `G5 mode: scoped (<N> test files, <M> gates)` or `G5 mode: full (reason: <escape-hatch trigger>)`. The labeled CI run remains the system of record in both modes.

**Why the carve-out exists:** GitHub Actions minutes are a constrained, billed resource. The consuming repo's heavy CI jobs are gated on the `ready-to-merge` label and re-run on every push while the label is present. The carve-out inverts the cost: the suite runs locally (cheap, fast iteration) until green, the label is applied once, and the labeled CI run is a single final confirmation — target: one full CI run per ticket. Scoped mode exists because the full parity set can take an hour on a dev machine: the diff-scoped subset preserves the local-first discipline at a cost proportional to the change, while the labeled CI run still catches anything the subset could not see.

**Scope is strict.** The carve-out applies ONLY while executing the `finalisation-coordinator` playbook at Step 8c or Step 11 (CI-failure fix verification). No other agent, skill, plan, spec, review loop, or main-session task inherits it. `builder`, `feature-coordinator`, `pr-reviewer`, and every Phase 1/2 surface remain bound by "Forbidden locally" in full. A plan or spec citing this carve-out to justify a mid-build full-suite run is mis-scoped and gets auto-fixed by spec-reviewer.

## Why

- CI is the authoritative gate runner. Local runs drift. Trust the canonical surface.
- Whole-repo verifiers are slow. They burn agent time without producing new signal.
- Local runs encourage "make this gate pass" patches that hide root causes. CI's pre-merge run catches them anyway.
- Pre-production posture: gate state shifts as the codebase shifts. The CI run is the only one fresh enough to act on.

## What this means for plans and specs

- A plan's "Verification commands" section per chunk lists ONLY lint, typecheck, build:server/client (when relevant), and targeted unit tests for that chunk. No `scripts/verify-*.sh`, no `npm run test:*` umbrella commands.
- A plan does NOT include a "Phase 0 baseline gate run" or a "Programme-end full gate set" section. CI does both.
- A spec MUST NOT instruct implementers to run any forbidden command above. Spec-reviewer auto-fixes specs that do.
- A pull request that requires the operator to "run the gates locally to confirm" before merging is mis-scoped. Either CI catches it, or it's not gate-relevant.

## Pre-existing gate violations

If a plan or implementation suspects pre-existing gate violations:
1. Identify the suspected violation by static reasoning (read the code, read the gate script's grep pattern, point at the offending line).
2. If the new code clearly depends on the violating pattern, add a "Pre-existing violation to fix" item to the plan with the file, the fix, and a one-line justification.
3. CI will catch any baseline violation we missed when the PR is opened — that is the expected behaviour. Don't pre-empt CI by running gates locally.

## How to reference this file

Agent files and specs that need to enforce the rule should link here rather than embedding their own copy:

```markdown
**Test gates are CI-only.** See [`references/test-gate-policy.md`](../../references/test-gate-policy.md). The forbidden / allowed lists live there; this agent enforces them at <step or boundary>.
```

Agents may add a one-line clarification specific to their step (e.g. "step 5 re-verification is limited to reading the affected file back; never runs gates"), but should not duplicate the forbidden / allowed lists.

---

## Project-specific notes

Consuming projects can add project-specific guidance for this file between the markers below. Sync.js preserves anything you put between the markers when the framework is updated. Do NOT edit outside the markers — those changes get a .framework-new diff on the next sync.

<!-- LOCAL-OVERRIDE:start name="project-notes" -->
<!-- LOCAL-OVERRIDE:end name="project-notes" -->
