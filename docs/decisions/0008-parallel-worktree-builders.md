# ADR-0008: Parallel Worktree Builders for Independent Chunks

**Status:** accepted
**Date:** 2026-06-19
**Domain:** build-orchestration
**Supersedes:** _(none)_
**Superseded by:** _(none)_

## Context

The `feature-coordinator` Step 6 build loop dispatches `builder` sub-agents one at a time in plan order. For plans whose chunks are provably independent (disjoint `declared_files`, no shared `exclusive_resources`, no `depends_on` edge), this sequential dispatch wastes wall-clock time: three independent chunks that could each run in 5 minutes instead take 15 minutes end-to-end.

Spec `tasks/builds/parallel-worktree-builders/spec.md` identified two enabling primitives: (1) `isolation: "worktree"` — each builder runs in its own git worktree, so concurrent filesystem writes never collide on the feature branch; (2) concurrent `builder` Agent dispatch — the coordinator issues multiple builder calls in a single message when a wave contains more than one chunk. The spec also required that wave computation be a deterministic, unit-tested pure function rather than prose heuristic, and that the strict-sequential default be preserved byte-identically (acceptance criterion A8).

ADR-0014 constrains the design: the coordinator must run inline in the main session (top-level `Agent` access) so it can dispatch sub-agents. It must never itself be dispatched as a sub-agent.

## Decision

We will build provably-independent plan chunks concurrently, each in its own git worktree, and integrate them back to the feature branch serially in stable chunk-id order.

Independence is proven by two deterministic pure modules: `scripts/build-scheduler/computeWaves.ts` (wave scheduler) and `scripts/build-scheduler/validatePlanMetadata.ts` (plan-metadata validator). The coordinator never re-derives wave logic in prose. Architect emits `declared_files`, `depends_on`, and `exclusive_resources` per chunk; the modules compute the schedule.

The default mode is strict-sequential (concurrency=1), engaged by the absence of the opt-in phrase `launch feature coordinator parallel`. In strict-sequential mode the new machinery (parsePlanMetadata, validatePlanMetadata, computeWaves, the worktree probe, the independence gate, wave-audit writes) does not execute at all. A8 holds by non-execution, not by behavioural coincidence.

When parallel mode is engaged, the coordinator integrates worktree diffs back to the feature branch using `git apply --3way` (diff-apply), NOT `git merge`. Builders never commit, so there is no worktree branch to merge. The merge-back is a serialised transaction in ascending chunk-id order with a clean-branch precondition before each integration and a post-commit clean-state assertion after.

## Consequences

- **Positive:**
  - Wall-clock time on large builds is cut proportionally to the size of the largest parallel wave. A plan with a wave of 3 independent chunks at cap=3 reduces that wave from 3x sequential to approximately 1x.
  - Wave computation is unit-tested (`computeWaves.test.ts`, `validatePlanMetadata.test.ts`) and reproducible across resumes (stable chunk-id sort, A5).
  - Commit history is linear and one-commit-per-chunk in stable chunk-id order, identical in shape to today's sequential output.
- **Negative:**
  - Under-declared `declared_files` is the primary risk: if an architect omits a file two chunks share, the independence claim is wrong and the merge-back will conflict or (worse) silently corrupt the feature branch. Four-layer defence mitigates this (see Safety argument).
  - Web sessions degrade to strict-sequential (worktree unavailable). No build fails; only the speed benefit is lost.
  - Coordinator complexity increases: wave scheduling, worktree provisioning/teardown, the independence gate, serialised merge-back, crash-safety resume, and the INDEPENDENCE_VIOLATION quarantine protocol are all new responsibilities.
- **Neutral:**
  - The opt-in rollout phrase (`launch feature coordinator parallel`) means existing workflows are unaffected until a maintainer or operator deliberately engages the feature. The "first 3 builds opt-in then default-on" transition is a one-line maintainer change to the coordinator default, not an automated counter.

## Safety argument

Independence is proven, never assumed, through four layers of defence in depth:

1. **Plan-time (architect):** emits `declared_files`, `depends_on`, `exclusive_resources` conservatively. The conservative-default stance (when in doubt, add a `depends_on` edge) is codified in `architect.md`.
2. **Plan-review-time:** `claude-plan-review` and `chatgpt-plan-review` hunt for under-declared `declared_files` relative to `spec_sections`.
3. **Dispatch-time (independence gate):** before dispatching a multi-chunk wave the coordinator re-verifies pairwise `declared_files` intersection AND pairwise `exclusive_resources` collision. Any overlap pulls the offending chunk into a later sequential slot.
4. **Merge-back-time:** the integration primitive is `git apply --3way`. A conflict disproves the independence claim. On conflict: hard cleanup (`git reset --hard HEAD && git clean -fd`, verify porcelain empty), fall back to sequential re-application, log `INDEPENDENCE_VIOLATION`. Never force-apply.

File-path disjointness is proven on canonicalised, case-folded paths (Windows-safe: `src\Foo.ts` and `./src/foo.ts` are the same file). `parsePlanMetadata` is the single normalisation point; `computeWaves` and the independence gate consume already-normalised paths.

A crash between `git apply` and the commit is recovered by treating any dirty feature branch on resume as an interrupted merge-back: `git reset --hard HEAD && git clean -fd`, then per-chunk resume detection re-dispatches the affected chunk. The commit-integrity chain and linear history are preserved.

Once any independence claim is falsified at merge-back (INDEPENDENCE_VIOLATION), the wave's remaining unintegrated sibling worktrees are quarantined: discarded and re-run sequentially in ascending chunk-id order against the updated feature branch. Already-integrated commits are kept. Stale sibling worktrees are never applied after independence has been disproved.

## Alternatives considered

- **`git merge` of a worktree branch** — rejected. Builders never commit (coordinator-owned invariant), so there is no worktree branch to merge. `git apply --3way` is the correct primitive for transferring uncommitted changes.
- **First-finished-first-merged order** — rejected. Non-deterministic on resume; produces non-reproducible commit history. Ascending chunk-id order is stable across crashes and resumes.
- **A wave loop that always runs at cap=1 (if/else branch)** — rejected. An `if cap==1` branch inside the new wave loop would be a new code path that "happens to behave the same" as today. A8 requires byte-identical sequential behaviour by non-execution of the new path, not by a new path that mimics the old. The design gates off the new machinery entirely in strict-sequential mode.
- **Wave logic encoded in `feature-coordinator.md` prose** — rejected. Prose cannot be unit-tested. Spec §5 explicitly requires wave computation to be a pure, unit-tested function so output is reproducible and inspectable. `computeWaves.ts` is the correct home.

## When to revisit

- If under-declaration of `declared_files` repeatedly slips past plan-review and the dispatch gate to merge-back, producing recurring INDEPENDENCE_VIOLATION events. That pattern would indicate the four-layer defence is insufficient and a stronger pre-dispatch verification (e.g. static analysis of chunk scope) is warranted.
- If the `isolation: "worktree"` primitive is removed or renamed in the Claude Code runtime, breaking the worktree probe and making the fallback permanent.

## References

- Spec: `tasks/builds/parallel-worktree-builders/spec.md`
- Related ADR: `docs/decisions/0014-coordinator-runs-inline.md` (ADR-0014 — coordinator must stay inline; referenced in Safety argument)
- Plan: `tasks/builds/parallel-worktree-builders/plan.md`
