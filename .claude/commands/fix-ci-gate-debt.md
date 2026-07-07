---
description: Exhaustively audit and fix ALL CI gate debt at the root (production code, not the tests/baselines) until every PR-gating gate passes locally. A bounded audit→fix→re-audit loop. Un-gameable — acceptance is a read-only auditor script, not the model's judgement.
argument-hint: "[optional: a single gate name to scope to, else all gates]"
---

# /fix-ci-gate-debt

A dedicated **repo-health cleanup**: find every CI gate that fails (or only passes because of accumulated baseline debt) and fix the **underlying cause** — changing production code where the failure reveals a real defect — until the whole gate suite passes locally. This is NOT a feature build and NOT "make CI green by any means."

**Why this exists:** every gate that fails on the trunk blocks the next feature branch the moment it merges trunk. That tax is paid on every PR. Clear it at the source.

**The rule that makes this trustworthy:** *you do not decide when you are done — a separate read-only auditor does.* Acceptance = the auditor reports every gate GREEN (or a gate is genuinely unfixable and recorded as a justified residual). You may not declare success from your own reading of the code.

`$ARGUMENTS` — if a single gate name is given, scope the run to that gate; otherwise audit and fix ALL gates.

## The loop (this IS the job)
A bounded audit→fix→re-audit loop, capped at **5 iterations**:

1. **Audit** — run the read-only auditor (Step 0). It returns the objective list of failing gates. Exit 0 → done.
2. **Fix one batch** — classify each failing gate's root cause (Step 1), fix at the root via `builder` subagents (Step 2), fixing independent gates in parallel. Lock wins by lowering baselines (Step 3).
3. **Re-audit** — run the auditor again. PASS gates are done; still-failing gates carry forward.
4. **Repeat** up to 5 iterations total.

**Stop conditions (all hard):**
- **Green:** auditor exits 0 → write the report, open the PR, stop.
- **Cap reached with gates still red:** STOP. No 6th pass. Running out of iterations is NEVER a licence to bump a baseline / skip a test / guard-ignore-without-proof. Record each unresolved gate with its diagnosis and escalate.
- **Stuck:** the SAME gate failing the SAME way after a fix → do not retry the same approach. Try one fundamentally different fix; if it still resists, classify as a residual and escalate (stuck-detection).
- **Genuinely-unfixable external debt** (e.g. a high CVE with no upstream patch): record via the gate's sanctioned allowlist with a dated tracking note; the ONLY acceptable non-green terminal state, and only with proof there is no fix.

Success = "auditor green via legitimate root-cause fixes" OR "honest, justified residuals." Never "green by any means."

## Step 0 — Set up + take an objective baseline
1. **Require a clean worktree FIRST.** Run `git status --short`; if there are ANY uncommitted or untracked changes, STOP and ask the operator to commit, stash, or run this from a clean worktree. This command must never mix repo-health cleanup with unrelated in-flight work. Only once clean: sync the trunk (`git fetch && git checkout <default-branch> && git pull --ff-only`) and create a branch `chore/ci-gate-debt-cleanup`.
2. **Bootstrap + freeze the read-only auditor.** Run `scripts/ci-gate-debt-audit.sh`. If absent in this repo, author it per the **Audit script contract** below — then **commit it as its OWN standalone commit BEFORE any fix commit**, and do NOT edit it again for the rest of this run. The fixer must not be able to weaken its own judge mid-run; any later change to the auditor is a separate, separately-reviewed change. The auditor must enumerate gates by PARSING this repo's CI workflow file(s) and any gate manifest/shard config — never a hand-typed list — and run each gate with the SAME command + env CI uses. It must PRINT the inventory of gates it parsed (coverage proof, so a reviewer can confirm it dropped none). Output: `gate | command | violations | baseline | PASS/FAIL`, and a final all-green / N-failing line + exit code.
3. **Provision a local test DB if any gates/jobs are DB-backed** so they actually run (use the repo's integration-fixture seeder + the CI env). "DB-backed" is not an automatic skip — only record a residual if a local DB is provably impossible, with the exact reason.
4. The auditor output is the worklist. Do not work from memory.

## Step 1 — For EACH failing gate: diagnose the root cause before touching anything
Classify every failure into exactly one of:
- **Production-code defect** — the gate correctly caught a real problem (tenant-scope bypass, unvalidated input, unregistered error code, an unsafe worker registration, a vulnerable dependency, a genuinely-dead export). → **Fix the production code / dependency / wiring.** Default and common case.
- **Test defect** — the test itself is wrong (bad fixture, missing required column, wrong expectation against correct code). → Fix the test's *setup/fixture only*. You may NOT weaken/delete an assertion, `.skip`/`.only` a test, or change what it asserts. A test asserting wrong behaviour of correct code is a spec decision — surface it, do not silently flip it.
- **Static-analysis false positive** — code is provably correct but the gate's walker can't see it. → Add an inline ignore-comment with a concrete justification ONLY at the proven-safe site. Never to hide a real violation.
- **Accepted external debt** — a high-severity advisory with no upstream fix, etc. → Use the gate's sanctioned allowlist/override with a dated, tracked justification, only after confirming there is genuinely no fix.

Write each gate's classification + root cause to `tasks/ci-gate-debt/report.md` BEFORE fixing it. A fix with no recorded classification is not allowed.

## Step 2 — Fix at the root (common debt classes → correct fix)
Adapt to this repo's actual gates; common classes:
- **error-code / taxonomy gates:** register every emitted error-code literal in the repo's canonical error-code list.
- **input-validation gates:** add the repo's request-body validation pattern to every unvalidated route body.
- **tenant-scope / org-tx / scoped-db gates:** route every flagged DB op through the repo's scoped-DB / org-transaction accessor. Ignore-comment only proven false positives.
- **worker-registration gates:** use the repo's canonical worker wrapper instead of raw queue registration.
- **dependency-audit gates:** resolve advisories via `npm audit fix` / targeted bumps / `overrides`; allowlist (with reason) only advisories with no fix.
- **dead-code / unused-export / orphan gates:** GREP THE WHOLE TREE (including dynamic/string refs) to PROVE an export is dead before deleting — LLMs over-delete and a wrong deletion is expensive. If dead, remove it; if real-but-unwired, wire it or add a justified ignore; never delete on a hunch.
- **any other baseline-regressed gate:** read the gate script to learn its accepted pattern; fix each flagged site to it.

Use `builder` subagents and parallelism for independent gates. Keep lint/typecheck/build green throughout. Commit per gate (or tight gate-group) with a clear message so history is auditable and revertable.

## Step 3 — Lock the wins (baselines move DOWN only)
After genuinely REDUCING a gate's violations, lower that gate's baseline to the new count so the improvement is locked and future regressions are caught. **Raising a baseline to make a failing gate pass is forbidden — it is the primary way this task gets gamed.** Every baseline change MUST be a reduction (or unchanged) and MUST appear in the same commit as the real fix. Use a gate's `--regenerate` flow only after real fixes.

## Hard rules (non-negotiable)
- Acceptance = the auditor exits 0. Re-run it after every gate-group; never assert "fixed" without the gate's own command exiting clean.
- Never weaken, skip, `.only`, `.skip`, or delete a test to pass a gate. Test edits are limited to genuine fixture/setup bugs.
- Never raise a baseline. Never edit a gate script to lower its own bar.
- Never delete code you have not exhaustively proven unreferenced.
- Surgical only — touch what a specific gate requires; no drive-by refactors.

## Deliverable
1. Every PR-gating gate passing locally (verified by the auditor), baselines lowered to lock the wins.
2. `tasks/ci-gate-debt/report.md`: per-gate root-cause classification, before→after counts with file references, and any genuinely-deferred item with a concrete reason + follow-up.
3. Open a PR titled `chore: clear CI gate debt (repo-health)` **ONLY when the auditor exits green** — every gate PASS, with the ONLY permitted non-green entries being sanctioned allowlisted **external-debt** residuals (each with a dated justification + tracking note). Run the full local CI-parity set once more, confirm the auditor, and hand back for review. **Do NOT merge.**

**Terminal-state contract (explicit):** an unresolved *fixable* gate is NOT a residual — only sanctioned allowlisted external debt (e.g. a high CVE with no upstream patch) is a legitimate non-green exception. If the iteration cap is reached, or a gate is stuck, with ANY unresolved fixable gate, **escalate to the operator and do NOT open a "cleared" PR** — opening a green-titled PR over still-failing fixable gates is itself a way of gaming this task. In that case, hand back a diagnosis-only report and stop.

## Audit script contract (`scripts/ci-gate-debt-audit.sh`)
If absent, author it (commit it with this cleanup) to this contract:
- Enumerates gates by PARSING this repo's CI workflow file(s) and gate manifest/shard config — never a hardcoded list, so it can never silently drop a gate.
- For each gate, runs the EXACT command CI runs, with CI's env (baseline-guard flag, DB env, any strict-mode flags, an adequate Node heap).
- Prints `gate | violations | baseline | PASS/FAIL` and a final `ALL GREEN` / `N FAILING` line; exits 0 only when all green (DB-residuals allowed when a local DB is provably unavailable).
- `--write <path>` writes the inventory to a file; `--gate <name>` scopes to one gate.
- It NEVER modifies code, tests, or baselines — read-only verification. The asymmetry is the point: auditor and fixer are separate, so the fixer cannot move the goalposts.
