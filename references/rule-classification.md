# Rule-classification ledger

Generated 2026-07-10T11:43:22.783Z by the Fable Framework Batch (WS2, F4). Classifies every behavioural directive in the framework corpus against `GOAL.md` (see `GOAL.md § Rule lifecycle` for the taxonomy and lifecycle rules).

## Contract

- **Unit:** one row per markdown heading in each behavioural file, keyed by a resolvable anchor `file#heading-slug` (ordinal suffix `-N` when a heading text repeats). A heading whose content carries multiple directives with DIFFERENT classifications carries the dominant class with the minority called out in the notes column — the honest residual on top of this compaction is covered by the decision-gate spot-check. Hooks (JS, no headings) carry one file-level row; the anchor is the file path.
- **Slug algorithm** (the coverage checker implements the same): lowercase, strip non-alphanumerics except spaces/hyphens, collapse spaces to hyphens.
- **Coverage:** enforced by `scripts/check-rule-ledger.js` — pass 1: every behavioural managed file (manifest categories agent/skill/command/hook, globs expanded) has ≥1 row; pass 2: every heading maps to a row or a no-rules marker, and every anchor resolves at HEAD.
- **Classes:** `durable-invariant` (permanent; amend via decision gate/PR) · `process-contract` (renegotiate when the process changes) · `model-workaround` (names its capability assumption + sunset trigger; re-evaluated per model upgrade via the eval suite) · `residue` (delete; git history carries it).
- Two files (`bug-fixer.md`, `regression-scribe.md`) are classified at file-level default this pass and flagged as spot-check candidates in their notes.

## Summary

| class | rows |
|---|---|
| durable-invariant | 113 |
| process-contract | 566 |
| model-workaround | 67 |
| residue | 0 |
| no-rules markers | 64 |

Residue found this pass is handled as kill-list items (decision gate DG-2) rather than ledger rows — see the batch's decision-list.md; the ledger is re-tagged at P3 for approved kills.

## agents

| anchor | rule | class | notes (assumption + sunset for model-workarounds) |
|---|---|---|---|
| `.claude/agents/adversarial-reviewer.md#trigger` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#failure-mode-posture` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#input` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#context-loading` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#threat-model-checklist` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#stride-sweep` | directives under this heading | model-workaround | forced per-category output; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/adversarial-reviewer.md#trust-boundary-callout` | directives under this heading | durable-invariant | security floor: unenforced crossed boundary is itself a finding |
| `.claude/agents/adversarial-reviewer.md#finding-labels` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#final-output-envelope` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#verdict-line-format-mandatory` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#non-goals` | directives under this heading | process-contract |  |
| `.claude/agents/adversarial-reviewer.md#rules` | directives under this heading | process-contract | top-10 findings cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/adversarial-reviewer.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/architect.md#project-extensions` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#execution-order-strict` | directives under this heading | model-workaround | assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/architect.md#minimum-todowrite-skeleton-step-1` | directives under this heading | model-workaround | assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/architect.md#context-files` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#when-you-are-invoked` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#pre-plan-model-collapse-check` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#todowrite-hygiene-during-execution` | directives under this heading | model-workaround | assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/architect.md#output` | — | no-rules | |
| `.claude/agents/architect.md#1-architecture-notes` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#2-stepwise-implementation-plan` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#cross-repo-prior-art-for-each-approach-added-in-v2130` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#3-per-chunk-detail` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#4-build-parallelism` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#5-ux-considerations-when-applicable` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#project-specific-architecture-constraints` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#test-gates-are-ci-only-never-put-them-in-a-plan` | directives under this heading | process-contract | policy pointer is PC; the verbatim forbidden-list + anti-hedging armor is MW (assumption: subagents read hedges as permission; sunset: eval) |
| `.claude/agents/architect.md#what-this-means-for-the-plan-document` | directives under this heading | model-workaround | verbatim-disclaimer requirement; assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/architect.md#pre-existing-violations-handle-without-running-gates` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#scope` | directives under this heading | process-contract |  |
| `.claude/agents/architect.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/audit-runner.md#important-inline-execution-only` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#project-extensions` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#context-loading` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#inputs-how-you-are-invoked` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#parallel-mode` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#pre-flight-checks` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#branch-naming-and-slug-normalization-m1` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#invariants` | — | no-rules | |
| `.claude/agents/audit-runner.md#read-only-by-default-pass-1-i1` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#no-parallel-area-pass-2-i3` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#pass-2-hard-allow-list-f2-e3-e5` | directives under this heading | model-workaround | blast-radius caps (<=30 LOC, <=3 files); assumption: model misjudges fix safety; sunset: raise caps on eval/metrics evidence |
| `.claude/agents/audit-runner.md#no-speculative-fix-invariant-e4` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#finding-state-invariant-e2` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#schema-and-migration-routing-f5` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#commit-and-rollback-discipline-f1-i4-e1` | directives under this heading | process-contract | commit-before-verify is PC; no-retry-twice is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/audit-runner.md#pipeline` | — | no-rules | |
| `.claude/agents/audit-runner.md#a-reconnaissance-branch-setup` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#b-pass-1-findings-only` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#b5-findings-gate-stop` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#c-pass-2-high-confidence-fixes-per-area` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#d-pass-3-routing` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#e-post-audit-review-pass-spec-conformance` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#f-post-audit-review-pass-pr-reviewer` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#g-knowledgemd-update` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#h-audit-completion-criteria-gate` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#i-final-handoff` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#audit-log-format` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#caps-escalation` | directives under this heading | model-workaround | assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md |
| `.claude/agents/audit-runner.md#test-gates-are-ci-only-never-put-them-in-a-remediation-plan` | directives under this heading | process-contract |  |
| `.claude/agents/audit-runner.md#rules` | directives under this heading | process-contract | rule-wins-over-judgment clause is MW (assumption: tactical judgment unreliable vs written rules; sunset: per model upgrade) |
| `.claude/agents/audit-runner.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/bug-fixer.md#modes` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#mode-flag` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#context-loading` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#defaults` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#base-branch-resolution` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#linked-pr-detection` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#execution-fix-mode` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-0-parse-trigger-phrase` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#experiment-eligible-label-recommendation` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-1-todowrite-skeleton` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-2-issue-actionability-check` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-2a-resolve-pr-base-branch` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-3-label-and-assign` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-4-create-the-fix-branch` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-5-reproduce-root-cause` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-5b-escalation-path-non-surgical-bugs-only` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-6-surgical-fix` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-7-targeted-checks` | directives under this heading | process-contract | 2-attempt cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/bug-fixer.md#step-8-commit-push-open-pr` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-8b-stop` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#execution-finalise-mode` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-8c-parse-trigger-phrase` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-9-todowrite-skeleton` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-10-locate-the-pr` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-11-re-run-targeted-checks` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-11a-verify-pr-base-matches-resolved-base` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-12-squash-merge` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-13-label-and-comment` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#step-14-clear-session-review-mode` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#final-output-each-run` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#fix-mode` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#finalise-mode` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#failure-paths` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate; never-auto-finalise gate and 2-attempt check cap noted |
| `.claude/agents/bug-fixer.md#rules` | directives under this heading | durable-invariant | spot-check upgrade (P3, 2026-07-10): never --no-verify / never --admin on merge / tags never merge targets are integrity floors; remaining rules PC |
| `.claude/agents/builder.md#context-loading-step-0` | directives under this heading | process-contract |  |
| `.claude/agents/builder.md#step-1-todowrite-list` | directives under this heading | model-workaround | assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/builder.md#step-2-plan-gap-pre-check` | directives under this heading | process-contract |  |
| `.claude/agents/builder.md#step-3-implementation` | directives under this heading | process-contract |  |
| `.claude/agents/builder.md#minimal-change-checks-apply-while-writing` | directives under this heading | process-contract |  |
| `.claude/agents/builder.md#migration-carve-out-apply-before-writing-any-db-migration` | directives under this heading | model-workaround | forced skill pre-read; assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite |
| `.claude/agents/builder.md#skill-pre-read-apply-before-writing-in-a-covered-area` | directives under this heading | model-workaround | assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite |
| `.claude/agents/builder.md#ci-gate-pre-flight-apply-while-writing-these-gates-are-ci-only-not-in-g1` | directives under this heading | model-workaround | assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite |
| `.claude/agents/builder.md#step-4-g1-gate-scoped-lint-targeted-tests-only` | directives under this heading | process-contract | scoped-command list is PC; 3-attempt cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/builder.md#step-5-return-summary` | directives under this heading | process-contract |  |
| `.claude/agents/builder.md#hard-rules` | directives under this heading | durable-invariant | never --no-verify / never amend / never commit are integrity floors |
| `.claude/agents/builder.md#worktree-awareness-61` | directives under this heading | process-contract |  |
| `.claude/agents/builder.md#project-specific-notes` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-plan-review.md#before-doing-anything` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-plan-review.md#mode-detection` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-plan-review.md#on-start` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-plan-review.md#per-round-loop` | directives under this heading | process-contract | 5-round cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md); risk_domain carve-out is DI (security floor) |
| `.claude/agents/chatgpt-plan-review.md#termination` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-plan-review.md#log-format` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-plan-review.md#hard-rules` | directives under this heading | durable-invariant | risk_domain carve-out never auto-applied — security floor |
| `.claude/agents/chatgpt-plan-review.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/chatgpt-pr-review.md#configuration` | directives under this heading | process-contract | fail-safe to coordinator-invoked is DI (premature merge unrecoverable) |
| `.claude/agents/chatgpt-pr-review.md#diff-file-discipline-manual-parallel-mandatory-no-exceptions` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-pr-review.md#before-doing-anything-else-read` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-pr-review.md#on-start` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-pr-review.md#per-round-loop` | directives under this heading | process-contract | cap MW; verify-against-live-file guard is MW (assumption: model confuses diff vs live state, measured ~30% FP; sunset: eval); duplicate auto-apply is PC |
| `.claude/agents/chatgpt-pr-review.md#finalization` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-pr-review.md#todowrite-contract-mandatory` | directives under this heading | model-workaround | historically bundled+skipped steps; assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/chatgpt-pr-review.md#log-format` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-pr-review.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-spec-review.md#configuration` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-spec-review.md#before-doing-anything-else-read` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-spec-review.md#on-start` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-spec-review.md#per-round-loop` | directives under this heading | process-contract | cap MW; default-to-user-facing on ambiguity is DI (protects product-owner authority) |
| `.claude/agents/chatgpt-spec-review.md#finalization` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-spec-review.md#log-format` | directives under this heading | process-contract |  |
| `.claude/agents/chatgpt-spec-review.md#rules` | directives under this heading | durable-invariant | default-to-user-facing + spec-only edit boundary are durable |
| `.claude/agents/claude-plan-review.md#context-loading` | directives under this heading | process-contract | risk-weighted sampling PC; fable Gate-2 tagging mandate is MW (assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability) |
| `.claude/agents/claude-plan-review.md#framing-assumptions` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#hunt-targets` | — | no-rules | |
| `.claude/agents/claude-plan-review.md#dag-sequencing-false-dependencies` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#chunk-isolation-and-sizing` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#under-declared-declaredfiles` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#cross-chunk-invariant-safety` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#worker-lock-transaction-posture-per-chunk` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#rls-tenant-isolation-in-migrations` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#idempotency-within-chunks` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#step-level-clarity-for-the-builder` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#success-criterion-verifiability` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#spec-plan-deltas-load-bearing` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#architectural-escalation-hidden-in-a-small-chunk` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#doc-sync-gaps` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#review-posture-per-plan` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#finding-triage` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#process` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#rubric-pass-run-on-every-plan` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#output` | directives under this heading | process-contract |  |
| `.claude/agents/claude-plan-review.md#rules` | directives under this heading | process-contract | lifetime cap 3 is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/claude-spec-review.md#context-loading` | directives under this heading | process-contract | fable Gate-2 tagging mandate is MW (assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability) |
| `.claude/agents/claude-spec-review.md#framing-assumptions` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#hunt-targets` | — | no-rules | |
| `.claude/agents/claude-spec-review.md#missing-thresholds-numeric-gaps` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#incomplete-state-models` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#idempotency-determinism` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#phase-sequencing` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#rls-tenant-isolation-posture-new-tenant-scoped-path` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#source-of-truth-precedence` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#schema-data-model-gaps` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#enforcement-posture-inconsistency` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#observability-posture` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#cross-doc-consistency` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#internal-contradictions-forward-references` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#implementation-readiness` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#doc-sync-impact` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#finding-triage` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#process` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#rubric-pass-run-on-every-spec` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#output` | directives under this heading | process-contract |  |
| `.claude/agents/claude-spec-review.md#rules` | directives under this heading | process-contract | lifetime cap 3 is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/codebase-explainer.md#when-invoked` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-1-todowrite-skeleton` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-2-read-framing-inputs` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-3-decide-structure` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-4-write-the-tour` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-5-worked-example-how-a-request-flows` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-6-where-to-make-a-change-by-domain` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-7-where-to-not-make-a-change` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-8-where-to-read-next` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-9-update-mode` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#step-10-output-and-finish` | directives under this heading | process-contract |  |
| `.claude/agents/codebase-explainer.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#when-invoked` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#step-1-read-the-pack-file` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#step-2-load-named-sections` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#step-3-honour-the-skip-list` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#step-4-confirm-and-proceed` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#fallback` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#when-packs-are-out-of-sync-with-architecturemd` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#auto-trigger-from-current-focus` | directives under this heading | process-contract |  |
| `.claude/agents/context-pack-loader.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#cross-repo-scout` | — | no-rules | |
| `.claude/agents/cross-repo-scout.md#1-caller-contract-inputs` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#2-output-contract-6-envelope` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#3-configuration` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#4-search-algorithm` | — | no-rules | |
| `.claude/agents/cross-repo-scout.md#local-mode-when-mode-github` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#github-mode-when-mode-local-and-local-was-skipped-or-mode-github` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#after-collecting-all-hits` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#5-scoring-rubric-contract-2-delegated-to-rankandtrim` | directives under this heading | process-contract |  |
| `.claude/agents/cross-repo-scout.md#6-caller-surfaces` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#setup` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#main-loop-max-3-iterations` | directives under this heading | model-workaround | assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md |
| `.claude/agents/dual-reviewer.md#step-1-run-codex-review` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#step-2-parse-and-adjudicate` | directives under this heading | model-workaround | mandatory file-read before accept/reject; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/dual-reviewer.md#step-3-implement-accepted-changes` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#step-4-check-termination` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#output` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#auto-commit-and-push-on-finish` | directives under this heading | process-contract |  |
| `.claude/agents/dual-reviewer.md#rules` | directives under this heading | durable-invariant | never force-push / never --amend / never --no-verify; CI-only test gates |
| `.claude/agents/dual-reviewer.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/experiment-runner.md#experiment-runner` | directives under this heading | process-contract |  |
| `.claude/agents/experiment-runner.md#1-caller-contract-inputs` | directives under this heading | process-contract |  |
| `.claude/agents/experiment-runner.md#2-output` | directives under this heading | process-contract |  |
| `.claude/agents/experiment-runner.md#3-loop-contract` | directives under this heading | process-contract |  |
| `.claude/agents/experiment-runner.md#4-consecutive-counter-rules` | directives under this heading | model-workaround | assumption: model persists on non-converging strategies; sunset: per model upgrade via eval |
| `.claude/agents/experiment-runner.md#5-recommendation-surfaces` | directives under this heading | process-contract |  |
| `.claude/agents/experiment-runner.md#6-tsv-row-append-appenditerationrowslug-row` | directives under this heading | process-contract |  |
| `.claude/agents/experiment-runner.md#7-example-invocation` | — | no-rules | |
| `.claude/agents/experiment-runner.md#worked-example-endpoint-p95-profiling` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#invocation` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#context-loading-step-0` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-1-top-level-todowrite-list` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-2-branch-sync-s1-freshness-check` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-3-architect` | directives under this heading | process-contract | plan-revision cap 3 is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/feature-coordinator.md#step-3a-claude-plan-review` | directives under this heading | process-contract | D5 cap enforcement is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/feature-coordinator.md#step-3b-apply-surfaced-findings-persist-log` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-4-chatgpt-plan-review` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-5-plan-gate` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-6-per-chunk-loop` | — | no-rules | |
| `.claude/agents/feature-coordinator.md#overview` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#inner-routine-process-one-chunk` | — | no-rules | |
| `.claude/agents/feature-coordinator.md#resume-detection` | directives under this heading | model-workaround | re-verify commits/typecheck before trusting recorded state; assumption: sub-agent/reviewer self-reports are unreliable; sunset: re-evaluate via F11 harness-metrics evidence |
| `.claude/agents/feature-coordinator.md#environment-snapshot-check-for-resume` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#builder-invocation` | directives under this heading | process-contract | inline-write prohibition is a cost/architecture contract (token-heavy work on the cheaper tier) |
| `.claude/agents/feature-coordinator.md#g1-per-chunk-scoped-lint-builder-also-runs-targeted-pure-function-tests-where-applicable` | directives under this heading | model-workaround | coordinator backup lint re-run duplicates builder G1; assumption: sub-agent/reviewer self-reports are unreliable; sunset: re-evaluate via F11 harness-metrics evidence; 3-attempt cap per iteration-caps |
| `.claude/agents/feature-coordinator.md#plan-gap-handling` | directives under this heading | process-contract | 2-round cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/feature-coordinator.md#commit-integrity-invariant` | directives under this heading | durable-invariant | declared-files integrity chain; never git add -A — repo-integrity floor |
| `.claude/agents/feature-coordinator.md#chunk-learnings-write-before-the-chunk-commit-step-4-above` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#chunk-completion-progress-write-environment-snapshot` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-2-determine-mode-and-execute` | — | no-rules | |
| `.claude/agents/feature-coordinator.md#step-2a-effective-concurrency` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-2b-strict-sequential-mode-the-default` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-2c-parallel-mode-opt-in-phrase-present` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-2d-serialised-merge-back-transaction` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-3-audit-trail-parallel-mode-only` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-4-rollout-gate` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-5-adr-0014-callout` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-7-g2-integrated-state-gate` | directives under this heading | process-contract | 3-attempt cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/feature-coordinator.md#post-g2-spec-validity-checkpoint` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-8-branch-level-review-pass` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#81-spec-conformance` | directives under this heading | process-contract | 2-round cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/feature-coordinator.md#82-adversarial-reviewer-conditional` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#83-pr-reviewer` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#84-fix-loop-with-g3` | directives under this heading | process-contract | 3-round cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/feature-coordinator.md#85-dual-reviewer` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-9-doc-sync-gate` | directives under this heading | process-contract | build-rows-from-registry-at-runtime is MW (assumption: memorised templates drift; sunset: per model upgrade) |
| `.claude/agents/feature-coordinator.md#step-10-handoff-write-phase-2-completion-invariant` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-11-current-focusmd-update` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#step-12-end-of-phase-prompt` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#failure-and-escalation-paths` | — | no-rules | |
| `.claude/agents/feature-coordinator.md#1-architect-plan-revision-rounds-exceed-3` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#2-plan-gate-abort` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#3-per-chunk-plan-gap-rounds-exceed-2` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#4-g1g2g3-exceed-3-fix-attempts` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#5-spec-conformance-nonconformant-after-2-rounds` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#6-pr-reviewer-fix-loop-exceeds-3-rounds` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#7-dual-reviewer-codex-unavailable` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#8-doc-sync-gate-missing-verdict` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#abort-invariant` | directives under this heading | process-contract |  |
| `.claude/agents/feature-coordinator.md#abort-write-order` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#invocation` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#trigger-phrases-verbal-cues` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#full-finalisation-guarantee-mandatory-no-step-is-optional` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#context-loading-step-0` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-1-top-level-todowrite-list` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-2-branch-sync-s2` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#auto-resolve-known-shape-conflicts` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-3-g4-regression-guard` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-4-pr-existence-check` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-5-chatgpt-pr-review` | directives under this heading | model-workaround | verify sub-agent merge/label claims with gh pr view; assumption: sub-agent/reviewer self-reports are unreliable; sunset: re-evaluate via F11 harness-metrics evidence |
| `.claude/agents/finalisation-coordinator.md#step-6-full-doc-sync-sweep` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-7-knowledgemd-pattern-extraction` | directives under this heading | process-contract | supersede convention (WS3) — append-only memory contract |
| `.claude/agents/finalisation-coordinator.md#step-7a-compound-learning-feedback` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#behaviour` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#error-handling` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-8-taskstodomd-cleanup` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-8b-post-review-branch-re-sync-s3` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-8c-g5-local-ci-parity-gate-mandatory-pre-label` | directives under this heading | process-contract | sanctioned CI-parity exception; 10-iteration cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/finalisation-coordinator.md#step-9-current-focusmd-mergeready-deferred-write` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-10-write-phase-3-artefacts-commit-push-then-apply-ready-to-merge-label` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-11-ci-monitoring-iterative-fix-loop` | directives under this heading | process-contract | 5-iteration cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/finalisation-coordinator.md#label-pull-discipline-first-action-on-red-before-any-diagnosis` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#guardrails-mandatory-applied-before-every-iteration` | directives under this heading | model-workaround | AF2 diff cap + AF3 category allowlist bound auto-fix trust (assumption: sub-agent/reviewer self-reports are unreliable; sunset: re-evaluate via F11 harness-metrics evidence); AF1 never-modify-tests-to-chase-green is DI |
| `.claude/agents/finalisation-coordinator.md#iteration-steps-only-run-if-all-four-guardrails-pass` | directives under this heading | model-workaround | read-the-log-not-guess + stuck-detection; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/finalisation-coordinator.md#step-12-auto-merge-post-ci-green` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#121-update-current-focusmd-on-the-feature-branch-post-merge-state` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#122-pull-the-label-then-commit-push-the-post-merge-prep` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#123-run-the-merge` | directives under this heading | process-contract | --admin authority under DG-5 review this batch |
| `.claude/agents/finalisation-coordinator.md#124-capture-squash-commit-sha-patch-main` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-125-release-note-block-advisory-non-blocking` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#step-13-end-of-phase-prompt-merged` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#131-ceo-level-summary-print-first-before-the-technical-block` | directives under this heading | process-contract | read-sources-not-memory clause is MW (assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability) |
| `.claude/agents/finalisation-coordinator.md#132-technical-end-of-phase-block-print-second-for-engineer-reference` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#133-outstanding-ci-gate-debt-flag-print-last-only-if-any-gatecheck-was-failing` | directives under this heading | process-contract |  |
| `.claude/agents/finalisation-coordinator.md#failure-and-escalation-paths` | — | no-rules | |
| `.claude/agents/finalisation-coordinator.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/hotfix.md#when-to-invoke` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#execution` | — | no-rules | |
| `.claude/agents/hotfix.md#step-1-todowrite-skeleton` | directives under this heading | model-workaround | assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/hotfix.md#step-2-confirm-scope` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-3-reproduce` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-4-identify-root-cause` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-5-apply-minimum-fix` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-6-author-or-update-one-targeted-test` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-7-run-targeted-checks-only` | directives under this heading | process-contract | 2-attempt cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/hotfix.md#step-8-pr-reviewer` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-9-knowledgemd-entry` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#step-10-summary-commit-draft` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#failure-paths` | directives under this heading | process-contract |  |
| `.claude/agents/hotfix.md#rules` | directives under this heading | durable-invariant | pr-reviewer mandatory (quality floor); never --no-verify; no wargame (speed path, WS6) |
| `.claude/agents/hotfix.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/incident-commander.md#when-to-invoke` | directives under this heading | process-contract |  |
| `.claude/agents/incident-commander.md#step-1-todowrite-skeleton` | directives under this heading | model-workaround | assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/incident-commander.md#step-2-sev-classification` | directives under this heading | process-contract |  |
| `.claude/agents/incident-commander.md#step-3-scribe-role` | directives under this heading | process-contract |  |
| `.claude/agents/incident-commander.md#step-4-hotfix-handoff` | directives under this heading | process-contract |  |
| `.claude/agents/incident-commander.md#step-5-post-mortem` | directives under this heading | process-contract | fable-mode pre-read mandate is MW (assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite) |
| `.claude/agents/incident-commander.md#non-goals` | directives under this heading | process-contract |  |
| `.claude/agents/incident-commander.md#test-gate-reference` | — | no-rules | |
| `.claude/agents/incident-commander.md#hard-rules` | directives under this heading | durable-invariant | append-only timeline; never --no-verify — audit-integrity floor |
| `.claude/agents/mockup-coordinator.md#inline-only` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#when-to-use-this-playbook` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-1-todowrite-list` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-2-confirm-scope-with-operator` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-3-round-1-mockup-designer` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-4-round-1-mockup-reviewer` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-5-round-loop-until-clean` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-5a-mandatory-visual-polish-round-default-on` | directives under this heading | process-contract | 3-round same-finding escalation is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/mockup-coordinator.md#step-6-present-to-operator` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-7-operator-response` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#step-8-exit` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#hard-rules` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#caller-contract-for-spec-coordinator` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-coordinator.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/mockup-designer.md#context-loading-step-0-every-round` | directives under this heading | model-workaround | re-read canonical docs every round; assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/agents/mockup-designer.md#step-0a-codebase-grounding-pass-every-round` | directives under this heading | model-workaround | the grounding practice is durable; the forced per-screen enumeration + round rejection is the workaround (assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability) |
| `.claude/agents/mockup-designer.md#step-1-todowrite-list` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-2-format-decision-round-1-only` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-3-implementation` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-3a-cross-cutting-ui-safety-checklist` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#styling-convention-token-sheet-design-language-every-round` | directives under this heading | process-contract | every-round design-language re-read is MW (assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite) |
| `.claude/agents/mockup-designer.md#polish-round-scope-discipline` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-3b-operator-vocabulary-rule-no-engineer-jargon` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-3b-mobile-shape-mandate-every-round` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-3c-behaviour-manifest-every-round` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-4-round-summary` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#step-5-return-to-caller` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#hard-rules` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-designer.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/mockup-reviewer.md#context-loading` | directives under this heading | model-workaround | verify designer grounding claims by Reading files; assumption: sub-agent/reviewer self-reports are unreliable; sunset: re-evaluate via F11 harness-metrics evidence |
| `.claude/agents/mockup-reviewer.md#review-axes` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-1-grounding` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-15-cross-cutting-ui-safety` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-2-simplicity-operator-overload` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-3-mobile-capability` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-35-accessibility-baseline` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-4-behaviour-completeness` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#axis-5-visual-craft` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#review-output` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#blocking-must-be-fixed-before-showing-to-the-operator` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#should-fix-strong-recommendation-but-not-strictly-blocking` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#consider-taste-future-proofing` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#finding-format` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#verdict-line` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#persistence` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#iteration-cap` | directives under this heading | model-workaround | assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md |
| `.claude/agents/mockup-reviewer.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/mockup-reviewer.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/pr-reviewer.md#caller-input-contract` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#context-loading` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#baked-in-framing-assumptions` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#review-output` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#blocking-must-be-fixed-before-merge` | directives under this heading | durable-invariant | tenant/RLS/auth/idempotency blocking classes — security floor |
| `.claude/agents/pr-reviewer.md#should-fix-non-blocking-but-expected-to-be-addressed-in-pr-unless-explicitly-deferred` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#consider-taste-future-proofing-nice-to-have` | — | no-rules | |
| `.claude/agents/pr-reviewer.md#process-multi-pass-discipline` | directives under this heading | model-workaround | evidence-or-drop passes; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/pr-reviewer.md#structural-review-heuristics` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#mechanical-auto-fix` | directives under this heading | durable-invariant | security carve-out (risk_domain set) never auto-fixed — durable; apply-then-verify mechanics are PC |
| `.claude/agents/pr-reviewer.md#files-not-read` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#duplicate-round-policy` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#diff-completeness-hunts-project-agnostic` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#specific-things-to-check` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#final-output-envelope` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#1-markdown-log-optional-operator-facing` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#2-canonical-json-block-mandatory-last-content` | directives under this heading | process-contract |  |
| `.claude/agents/pr-reviewer.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/regression-scribe.md#consumer-configurable-defaults` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#invocation-contract` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#step-1-read-marker-context-downgrade-check` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#step-2-author-the-regression-test` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#step-3-author-the-post-mortem` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#step-4-open-the-review-gated-pr` | directives under this heading | durable-invariant | spot-check upgrade (P3, 2026-07-10): never rewrite history under an open PR; human-owned PR detection stops the bot — repo-integrity floor |
| `.claude/agents/regression-scribe.md#parse-failure-version-mismatch-behaviour` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#marker-read-back-contract` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#deterministic-naming` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#label-ownership-this-agent` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#downgrade-path-post-mortem-only` | directives under this heading | process-contract | file classified at file-level default (not per-directive extracted this pass) — spot-check candidate |
| `.claude/agents/regression-scribe.md#rules` | directives under this heading | durable-invariant | spot-check upgrade (P3, 2026-07-10): never merges, review-gated PR only — floor; remaining rules PC |
| `.claude/agents/spec-conformance.md#execution-model-in-session-playbook-not-a-sub-agent` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#contents` | — | no-rules | |
| `.claude/agents/spec-conformance.md#context-loading` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#setup-auto-detect-inputs` | — | no-rules | |
| `.claude/agents/spec-conformance.md#step-a-detect-the-spec-path` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#step-b-detect-the-set-of-changed-files` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#step-c-scope-the-check` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#verification-pass` | — | no-rules | |
| `.claude/agents/spec-conformance.md#step-0-emit-a-per-subcomponent-todowrite-list-mandatory` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#step-1-extract-the-conformance-checklist-from-the-spec` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#step-2-verify-each-requirement-against-the-changed-code-set` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#classification-criteria` | — | no-rules | |
| `.claude/agents/spec-conformance.md#step-3-the-most-important-step` | directives under this heading | model-workaround | 100%-sure-or-directional heuristic; assumption: overconfident mechanical classification; sunset: F11 auto-fix success-rate evidence |
| `.claude/agents/spec-conformance.md#mechanicalgap-you-auto-fix-only-if-all-true` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#directionalgap-you-route-to-taskstodomd-if-any-true` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#ambiguous-treat-as-directional` | directives under this heading | model-workaround | same assumption/sunset as Step 3 |
| `.claude/agents/spec-conformance.md#apply-fixes-and-re-verify` | — | no-rules | |
| `.claude/agents/spec-conformance.md#step-4-apply-fixes` | — | no-rules | |
| `.claude/agents/spec-conformance.md#4a-mechanical-fixes` | directives under this heading | model-workaround | read-back-20-lines after every edit; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/spec-conformance.md#4b-directional-gaps-route-to-taskstodomd` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#4c-log-every-decision` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#step-5-re-verification-pass-on-applied-fixes` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#final-output-envelope` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#auto-commit-and-push-on-finish` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/spec-conformance.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/spec-coordinator.md#invocation` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#context-loading-step-0` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-1-top-level-todowrite-list` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-2-branch-sync-s0-freshness-check` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-3-intent-intake-and-ui-touch-detection` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#intentmd-schema-standard-significant-major-only` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-3a-duplication-strategy-check` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#inputs-read-at-step-3a` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#sources-to-consult-mechanical-greps` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#decision-criteria` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#multi-cluster-and-mixed-lifecycle-tie-break-rules` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#recording-location` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#gate-behaviour` | directives under this heading | process-contract | 3-revise cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/spec-coordinator.md#error-handling-edge-cases` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#cross-repo-prior-art-added-in-v2130` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-3b-grill-me-qa-standard-only` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#invocation-2` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#recording` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#termination-and-soft-checkpoint` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#skip-conditions` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-4-build-slug-derivation-directory-creation` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-5-mockup-loop-conditional` | directives under this heading | process-contract | soft 3-round cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/spec-coordinator.md#step-6-spec-authoring` | directives under this heading | process-contract | fable-mode invocation mandate is MW (assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite) |
| `.claude/agents/spec-coordinator.md#lifecycle-declaration-template` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#abcd-lifecycle-estimate-template` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-6a-claude-spec-review` | directives under this heading | process-contract | D5 cap is MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `.claude/agents/spec-coordinator.md#step-6b-apply-surfaced-findings-persist-log` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-7-spec-reviewer` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-8-chatgpt-spec-review` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-9-handoff-write` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-10-current-focusmd-update` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#step-11-end-of-phase-prompt` | directives under this heading | process-contract |  |
| `.claude/agents/spec-coordinator.md#failure-and-escalation-paths` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#configuration` | directives under this heading | model-workaround | MAX_ITERATIONS 5; assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md |
| `.claude/agents/spec-reviewer.md#baked-in-framing-assumptions` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#setup` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#pre-loop-context-check-runs-once-before-iteration-1` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-a-load-the-spec-context-file` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#staleness-gate-mandatory` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-b-cross-reference-spec-against-context` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-c-confirm-the-scope-of-the-review` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#main-loop-max-maxiterations` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-1-run-codex-against-the-spec` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-2-extract-findings-from-codex-output` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-3-read-the-relevant-spec-sections-for-each-finding` | directives under this heading | model-workaround | mandatory read before classification; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/spec-reviewer.md#step-4-rubric-review-what-mechanical-problems-to-look-for` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-5-classify-every-finding` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#bucket-1-mechanical` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#bucket-2-directional` | directives under this heading | model-workaround | hardcoded signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence on spec-review FP rates |
| `.claude/agents/spec-reviewer.md#bucket-3-ambiguous` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#classification-output-format` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-7-autonomous-decision-for-directional-and-ambiguous-findings` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-6-adjudicate-and-implement-mechanical-findings` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#adjudicate` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#implement` | directives under this heading | model-workaround | read-back-20-lines; assumption: the model asserts or classifies without verifying against the artifact; sunset: re-evaluate when eval evidence shows verification-free reliability |
| `.claude/agents/spec-reviewer.md#log-every-decision` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#count-the-iterations-findings` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-8-per-iteration-summary` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-8b-auto-commit-and-push-this-iteration` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#step-9-stopping-heuristic` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#final-output-after-the-loop-exits` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#auto-commit-and-push-the-final-report` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/spec-reviewer.md#project-specific-notes` | — | no-rules | |
| `.claude/agents/triage-agent.md#context-loading` | directives under this heading | process-contract |  |
| `.claude/agents/triage-agent.md#two-modes-of-operation` | — | no-rules | |
| `.claude/agents/triage-agent.md#mode-1-capture` | directives under this heading | process-contract |  |
| `.claude/agents/triage-agent.md#experiment-eligible-tag` | directives under this heading | process-contract |  |
| `.claude/agents/triage-agent.md#mode-2-triage` | directives under this heading | process-contract |  |
| `.claude/agents/triage-agent.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#when-to-invoke` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-1-todowrite-skeleton` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-2-inventory` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-3-agent-referenced-files` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-3a-agent-canonical-rule-adr-0006` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-4-context-pack-anchors` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-5-adr-index-integrity` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-6-frameworkversion-matches-changelog` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-7-doc-sync-coverage` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-8-hooks-registered` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#step-9-findings-report` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#rules` | directives under this heading | process-contract |  |
| `.claude/agents/validate-setup.md#project-specific-notes` | — | no-rules | |

## skills

| anchor | rule | class | notes (assumption + sunset for model-workarounds) |
|---|---|---|---|
| `.claude/skills/ci-gate-integrity/SKILL.md#ci-gate-integrity` | directives under this heading | durable-invariant |  |
| `.claude/skills/ci-gate-integrity/SKILL.md#prove-the-gate-can-fail` | directives under this heading | durable-invariant |  |
| `.claude/skills/ci-gate-integrity/SKILL.md#grepregex-gate-pitfalls` | directives under this heading | durable-invariant |  |
| `.claude/skills/ci-gate-integrity/SKILL.md#diff-based-gates` | directives under this heading | durable-invariant |  |
| `.claude/skills/ci-gate-integrity/SKILL.md#baselines-and-consolidation` | directives under this heading | durable-invariant |  |
| `.claude/skills/ci-gate-integrity/SKILL.md#actionsrunner-specifics-github-actions` | directives under this heading | durable-invariant |  |
| `.claude/skills/ci-gate-integrity/SKILL.md#metrics-and-detector-gates` | directives under this heading | durable-invariant |  |
| `.claude/skills/dependency-upgrades/SKILL.md#install-scripts-and-supply-chain` | directives under this heading | durable-invariant | security floor: install scripts are arbitrary code execution |
| `.claude/skills/deprecation/SKILL.md#deprecation-producer-side` | — | no-rules | |
| `.claude/skills/deprecation/SKILL.md#the-deprecation-decision` | directives under this heading | process-contract |  |
| `.claude/skills/deprecation/SKILL.md#advisory-vs-compulsory` | directives under this heading | process-contract |  |
| `.claude/skills/deprecation/SKILL.md#migration-mechanics` | directives under this heading | process-contract |  |
| `.claude/skills/deprecation/SKILL.md#removal-protocol` | directives under this heading | durable-invariant | zero-usage evidence before deletion |
| `.claude/skills/deprecation/SKILL.md#zombie-code` | directives under this heading | process-contract |  |
| `.claude/skills/review-triage/SKILL.md#briefing-the-reviewer-the-adjudicators-own-failure-modes` | directives under this heading | model-workaround | assumption: reviewers given the author's conclusion validate it instead of testing it, and adjudicators under-engage after repeated rejects; sunset: re-evaluate when eval evidence shows claim-robust reviewing |
| `.claude/skills/db-concurrency/SKILL.md#database-concurrency-and-idempotency` | — | no-rules | |
| `.claude/skills/db-concurrency/SKILL.md#upserts-and-idempotency-keys` | directives under this heading | durable-invariant |  |
| `.claude/skills/db-concurrency/SKILL.md#state-transitions` | directives under this heading | durable-invariant |  |
| `.claude/skills/db-concurrency/SKILL.md#locks-and-critical-sections` | directives under this heading | durable-invariant |  |
| `.claude/skills/db-concurrency/SKILL.md#queues-retries-recovery` | directives under this heading | durable-invariant |  |
| `.claude/skills/db-concurrency/SKILL.md#ordering-and-determinism` | directives under this heading | durable-invariant |  |
| `.claude/skills/db-concurrency/SKILL.md#time` | directives under this heading | durable-invariant |  |
| `.claude/skills/dependency-upgrades/SKILL.md#dependency-upgrades` | — | no-rules | |
| `.claude/skills/dependency-upgrades/SKILL.md#before-bumping` | directives under this heading | durable-invariant |  |
| `.claude/skills/dependency-upgrades/SKILL.md#overrides-pins-and-peer-ranges` | directives under this heading | durable-invariant |  |
| `.claude/skills/dependency-upgrades/SKILL.md#lockfile-discipline` | directives under this heading | durable-invariant |  |
| `.claude/skills/dependency-upgrades/SKILL.md#verify-after` | directives under this heading | durable-invariant |  |
| `.claude/skills/dependency-upgrades/SKILL.md#audits-and-advisories` | directives under this heading | durable-invariant |  |
| `.claude/skills/fable-mode/SKILL.md#fable-mode` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#when-to-use` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#gate-1-scope-before-work` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#gate-2-evidence-before-reasoning` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#gate-3-reason-adversarially` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#gate-4-verify-before-declaring-done` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#gate-5-report-with-calibration` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#output-contract` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#standing-habits` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#rationalizations` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fable-mode/SKILL.md#invoking-from-agents-and-coordinators` | directives under this heading | model-workaround | the skill exists to port frontier working habits to sub-frontier executors (its own framing); assumption: executing model below the strongest available tier; sunset: strongest tier becomes the default executor — re-evaluate via WS4 eval. The disciplines themselves (evidence-before-reasoning, pre-mortem) are durable practice; the mandatory-overlay FORM is the workaround. Gate 3 wargame cross-reference (WS6) rides this file. |
| `.claude/skills/fail-loud/SKILL.md#fail-loud-fail-closed` | — | no-rules | |
| `.claude/skills/fail-loud/SKILL.md#the-prime-directive` | directives under this heading | durable-invariant |  |
| `.claude/skills/fail-loud/SKILL.md#fail-closed-defaults` | directives under this heading | durable-invariant |  |
| `.claude/skills/fail-loud/SKILL.md#boundary-validation-and-coercion-traps` | directives under this heading | durable-invariant |  |
| `.claude/skills/fail-loud/SKILL.md#catch-blocks` | directives under this heading | durable-invariant |  |
| `.claude/skills/fail-loud/SKILL.md#error-translation-and-status-codes` | directives under this heading | durable-invariant |  |
| `.claude/skills/fail-loud/SKILL.md#observability-of-failure` | directives under this heading | durable-invariant |  |
| `.claude/skills/frontend-correctness/SKILL.md#frontend-correctness-react` | — | no-rules | |
| `.claude/skills/frontend-correctness/SKILL.md#component-state-lifecycle` | directives under this heading | durable-invariant |  |
| `.claude/skills/frontend-correctness/SKILL.md#async-races` | directives under this heading | durable-invariant |  |
| `.claude/skills/frontend-correctness/SKILL.md#gating-permissions-errors` | directives under this heading | durable-invariant |  |
| `.claude/skills/frontend-correctness/SKILL.md#data-handling` | directives under this heading | durable-invariant |  |
| `.claude/skills/frontend-design-check/SKILL.md#frontend-design-check` | directives under this heading | model-workaround | routing patch: forces the doc-read the mockup pipeline does automatically; assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite |
| `.claude/skills/grill-me/SKILL.md#grill-me` | directives under this heading | process-contract |  |
| `.claude/skills/grill-me/SKILL.md#confidence-protocol` | directives under this heading | process-contract |  |
| `.claude/skills/grill-me/SKILL.md#hollow-yes-gate` | directives under this heading | model-workaround | assumption: the model accepts hedged/polite agreement as confirmation; sunset: re-evaluate when eval evidence shows hollow-yes detection without the explicit taxonomy |
| `.claude/skills/grill-me/SKILL.md#de-sophistication-probe` | directives under this heading | process-contract |  |
| `.claude/skills/grill-me/SKILL.md#stop-conditions` | directives under this heading | process-contract |  |
| `.claude/skills/llm-integration/SKILL.md#llm-integration-engineering` | — | no-rules | |
| `.claude/skills/llm-integration/SKILL.md#trust-and-verification` | directives under this heading | durable-invariant |  |
| `.claude/skills/llm-integration/SKILL.md#prompt-assembly` | directives under this heading | durable-invariant |  |
| `.claude/skills/llm-integration/SKILL.md#operational-shape` | directives under this heading | durable-invariant |  |
| `.claude/skills/llm-integration/SKILL.md#llm-as-reviewer` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#logging-and-observability` | — | no-rules | |
| `.claude/skills/logging-observability/SKILL.md#instrument-to-a-question` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#structure` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#levels` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#what-never-to-log` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#placement` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#metrics-and-events` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#tests` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#alerting` | directives under this heading | durable-invariant |  |
| `.claude/skills/logging-observability/SKILL.md#verify-the-telemetry-itself` | directives under this heading | durable-invariant |  |
| `.claude/skills/performance/SKILL.md#performance` | — | no-rules | |
| `.claude/skills/performance/SKILL.md#measure-first` | directives under this heading | durable-invariant |  |
| `.claude/skills/performance/SKILL.md#database` | directives under this heading | durable-invariant |  |
| `.claude/skills/performance/SKILL.md#caching` | directives under this heading | durable-invariant |  |
| `.claude/skills/performance/SKILL.md#payloads-and-memory` | directives under this heading | durable-invariant |  |
| `.claude/skills/performance/SKILL.md#client-and-bundle` | directives under this heading | durable-invariant |  |
| `.claude/skills/performance/SKILL.md#hot-paths` | directives under this heading | durable-invariant |  |
| `.claude/skills/postgres-migrations/SKILL.md#postgres-migration-and-schema-discipline` | — | no-rules | |
| `.claude/skills/postgres-migrations/SKILL.md#sql-three-valued-logic-the-silent-killer` | directives under this heading | durable-invariant |  |
| `.claude/skills/postgres-migrations/SKILL.md#constraints` | directives under this heading | durable-invariant |  |
| `.claude/skills/postgres-migrations/SKILL.md#indexes` | directives under this heading | durable-invariant |  |
| `.claude/skills/postgres-migrations/SKILL.md#structural-patterns` | directives under this heading | durable-invariant |  |
| `.claude/skills/postgres-migrations/SKILL.md#cross-layer-sync-the-drift-class` | directives under this heading | durable-invariant |  |
| `.claude/skills/postgres-migrations/SKILL.md#process` | directives under this heading | durable-invariant |  |
| `.claude/skills/refactor-safely/SKILL.md#refactor-safely` | — | no-rules | |
| `.claude/skills/refactor-safely/SKILL.md#moves-and-splits` | directives under this heading | durable-invariant |  |
| `.claude/skills/refactor-safely/SKILL.md#mass-edits` | directives under this heading | durable-invariant |  |
| `.claude/skills/refactor-safely/SKILL.md#where-the-fix-goes` | directives under this heading | durable-invariant |  |
| `.claude/skills/refactor-safely/SKILL.md#deleting-code` | directives under this heading | durable-invariant |  |
| `.claude/skills/refactor-safely/SKILL.md#merge-conflicts-and-provenance` | directives under this heading | durable-invariant |  |
| `.claude/skills/refactor-safely/SKILL.md#scope-discipline` | directives under this heading | durable-invariant |  |
| `.claude/skills/review-triage/SKILL.md#review-finding-triage` | directives under this heading | durable-invariant | measured FP taxonomy from a ~1,900-log adjudicated corpus — durable review method |
| `.claude/skills/review-triage/SKILL.md#triage-order-per-finding-in-this-sequence` | directives under this heading | durable-invariant | measured FP taxonomy from a ~1,900-log adjudicated corpus — durable review method |
| `.claude/skills/review-triage/SKILL.md#verify-before-adjudicating-by-claim-type` | directives under this heading | durable-invariant | measured FP taxonomy from a ~1,900-log adjudicated corpus — durable review method |
| `.claude/skills/review-triage/SKILL.md#process-level-rejections-two-thirds-of-all-rejects` | directives under this heading | durable-invariant | measured FP taxonomy from a ~1,900-log adjudicated corpus — durable review method |
| `.claude/skills/review-triage/SKILL.md#running-the-loop` | directives under this heading | process-contract | round caps are MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md); security never-auto-apply is DI |
| `.claude/skills/security-hardening/SKILL.md#security-hardening` | — | no-rules | |
| `.claude/skills/security-hardening/SKILL.md#tokens-nonces-secrets` | directives under this heading | durable-invariant |  |
| `.claude/skills/security-hardening/SKILL.md#webhookoauth-ingress` | directives under this heading | durable-invariant |  |
| `.claude/skills/security-hardening/SKILL.md#outbound-requests-ssrf-family` | directives under this heading | durable-invariant |  |
| `.claude/skills/security-hardening/SKILL.md#injection-surfaces` | directives under this heading | durable-invariant |  |
| `.claude/skills/security-hardening/SKILL.md#untrusted-content-channels-beyond-the-request` | directives under this heading | durable-invariant | security floor: injection defence for non-LLM channels (error text, CI logs, browser content, CLI-piped artifacts) |
| `.claude/skills/security-hardening/SKILL.md#authorization-shape` | directives under this heading | durable-invariant |  |
| `.claude/skills/spec-hygiene/SKILL.md#spec-and-plan-hygiene` | — | no-rules | |
| `.claude/skills/spec-hygiene/SKILL.md#ground-every-claim-in-the-real-tree` | directives under this heading | durable-invariant |  |
| `.claude/skills/spec-hygiene/SKILL.md#keep-the-document-self-consistent` | directives under this heading | durable-invariant |  |
| `.claude/skills/spec-hygiene/SKILL.md#contract-level-rules-that-prevent-build-drift` | directives under this heading | durable-invariant |  |
| `.claude/skills/spec-hygiene/SKILL.md#conformance-verification-implementation-vs-spec` | directives under this heading | durable-invariant |  |
| `.claude/skills/tenant-isolation/SKILL.md#tenant-isolation` | — | no-rules | |
| `.claude/skills/tenant-isolation/SKILL.md#the-one-mental-model` | directives under this heading | durable-invariant |  |
| `.claude/skills/tenant-isolation/SKILL.md#where-tenant-context-gets-lost-check-every-one` | directives under this heading | durable-invariant |  |
| `.claude/skills/tenant-isolation/SKILL.md#non-negotiable-write-time-rules` | directives under this heading | durable-invariant |  |
| `.claude/skills/tenant-isolation/SKILL.md#review-checklist-for-tenant-touching-diffs` | directives under this heading | durable-invariant |  |
| `.claude/skills/test-discipline/SKILL.md#test-discipline` | — | no-rules | |
| `.claude/skills/test-discipline/SKILL.md#tests-that-prove-nothing-audit-for-these` | directives under this heading | durable-invariant |  |
| `.claude/skills/test-discipline/SKILL.md#match-the-test-to-the-failure-mode` | directives under this heading | durable-invariant |  |
| `.claude/skills/test-discipline/SKILL.md#fixtures-and-determinism` | directives under this heading | durable-invariant |  |
| `.claude/skills/test-discipline/SKILL.md#acceptance-criteria-spec-side` | directives under this heading | durable-invariant |  |
| `.claude/skills/wargame/SKILL.md#wargame` | directives under this heading | process-contract | WS6 landing rows per batch spec |
| `.claude/skills/wargame/SKILL.md#scope-boundary-read-first` | directives under this heading | durable-invariant | wargame/plan.md boundary — durable (D5); misuse = duplicate planning artifact |
| `.claude/skills/wargame/SKILL.md#entry-test-anti-overuse-gate` | directives under this heading | process-contract | 2-of-4-marks threshold — process contract (D5) |
| `.claude/skills/wargame/SKILL.md#generation-protocol` | directives under this heading | process-contract | branch cap 25 / depth 2 are process-contract by design (D7), not model patches |
| `.claude/skills/wargame/SKILL.md#artifact-executor-grading` | directives under this heading | process-contract | WS6 landing rows per batch spec |
| `.claude/skills/wargame/SKILL.md#hard-invariants` | directives under this heading | durable-invariant | wargame authorises nothing; stale artifact never executes; every run appends a ledger entry (D5-D7 locked) |
| `.claude/skills/wargame/SKILL.md#calibration-loop-anti-drift` | directives under this heading | process-contract | WS6 landing rows per batch spec |
| `.claude/skills/wargame/SKILL.md#rationalisations` | directives under this heading | model-workaround | anti-rationalization armor; assumption: attention/state reliability degrades over long contexts (skipped steps, batched completions); sunset: re-evaluate per model upgrade via the eval suite |
| `.claude/skills/wargame/references/executor-contract.md#executor-contract` | directives under this heading | process-contract | WS6 executor protocol |
| `.claude/skills/wargame/references/executor-contract.md#pre-flight-before-move-1-in-this-order` | directives under this heading | durable-invariant | staleness refusal (commit/env fingerprint mismatch never executes) and placeholder refusal are hard invariants (D5-D7) |
| `.claude/skills/wargame/references/executor-contract.md#per-move` | directives under this heading | durable-invariant | OFF-MAP = stop and escalate, never improvise past the map (PLAN_GAP semantics); abort conditions are hard stops |
| `.claude/skills/wargame/references/executor-contract.md#completion` | directives under this heading | process-contract | WS6 executor protocol |
| `.claude/skills/wargame/references/executor-contract.md#verdict-vocabulary` | directives under this heading | process-contract | WS6 executor protocol |
| `.claude/skills/wargame/references/executor-contract.md#ledger` | directives under this heading | process-contract | WS6 executor protocol |
| `.claude/skills/wargame/references/executor-contract.md#dispatch-block-paste-into-a-separate-executors-prompt` | directives under this heading | process-contract | WS6 executor protocol |
| `.claude/skills/wargame/references/success-criteria.md#wargame-success-criteria` | directives under this heading | process-contract | WS6 grading procedure — process contract |
| `.claude/skills/wargame/references/success-criteria.md#grading-procedure` | directives under this heading | process-contract | WS6 grading procedure — process contract |
| `.claude/skills/wargame/references/wargame-template.md#wargame-artifact-template` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#frontmatter` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#body-sections-in-order` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#1-recon-summary` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#2-assumptions-ledger` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#3-moves` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#4-abort-conditions` | directives under this heading | durable-invariant | a wargame with no abort conditions is invalid — hard invariant (D5) |
| `.claude/skills/wargame/references/wargame-template.md#5-verification-runs` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#6-test-bridge-index` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wargame/references/wargame-template.md#7-red-team-record` | directives under this heading | process-contract | WS6 artifact format contract (scaffold) |
| `.claude/skills/wire-it-through/SKILL.md#wire-it-through` | directives under this heading | durable-invariant |  |
| `.claude/skills/wire-it-through/SKILL.md#the-done-check` | directives under this heading | durable-invariant |  |
| `.claude/skills/wire-it-through/SKILL.md#fields-crossing-boundaries` | directives under this heading | durable-invariant |  |
| `.claude/skills/wire-it-through/SKILL.md#client-server-contract` | directives under this heading | durable-invariant |  |
| `.claude/skills/wire-it-through/SKILL.md#value-sets-and-renames` | directives under this heading | durable-invariant |  |
| `.claude/skills/wire-it-through/SKILL.md#canonical-sources-and-stores` | directives under this heading | durable-invariant |  |
| `.claude/skills/wire-it-through/SKILL.md#paired-surfaces` | directives under this heading | durable-invariant |  |
| `.claude/skills/zoom-out/SKILL.md#zoom-out` | directives under this heading | model-workaround | assumption: model proposes changes in domains it has not Read; sunset: re-evaluate per model upgrade via eval |

## commands

| anchor | rule | class | notes (assumption + sunset for model-workarounds) |
|---|---|---|---|
| `.claude/commands/claudemerge.md#claudemerge` | directives under this heading | process-contract |  |
| `.claude/commands/claudemerge.md#what-to-do` | directives under this heading | process-contract |  |
| `.claude/commands/claudemerge.md#behavioural-files-framework-wins-relocate-dont-merge` | directives under this heading | durable-invariant | ADR-0006 byte-identical contract — durable ownership invariant |
| `.claude/commands/claudemerge.md#rules` | directives under this heading | process-contract |  |
| `.claude/commands/claudemerge.md#arguments` | — | no-rules | |
| `.claude/commands/claudeupdate.md#claudeupdate` | directives under this heading | process-contract |  |
| `.claude/commands/claudeupdate.md#what-to-do` | directives under this heading | process-contract |  |
| `.claude/commands/claudeupdate.md#status-mode---status` | directives under this heading | process-contract |  |
| `.claude/commands/claudeupdate.md#rules` | directives under this heading | process-contract |  |
| `.claude/commands/claudeupdate.md#arguments` | — | no-rules | |
| `.claude/commands/cleanfiles.md#cleanfiles` | directives under this heading | process-contract |  |
| `.claude/commands/cleanfiles.md#modes` | directives under this heading | process-contract |  |
| `.claude/commands/cleanfiles.md#hard-safety-rules` | directives under this heading | durable-invariant | never delete knowledge content; docs-only guard — data-loss floor |
| `.claude/commands/cleanfiles.md#targets` | directives under this heading | process-contract |  |
| `.claude/commands/cleanfiles.md#config-optional` | directives under this heading | process-contract |  |
| `.claude/commands/cleanfiles.md#when-to-run` | directives under this heading | process-contract |  |
| `.claude/commands/cleanfiles.md#report-format` | directives under this heading | process-contract |  |
| `.claude/commands/eval-prompts.md#eval-prompts` | directives under this heading | process-contract |  |
| `.claude/commands/eval-prompts.md#what-to-do` | directives under this heading | process-contract |  |
| `.claude/commands/eval-prompts.md#integration-contract` | directives under this heading | process-contract |  |
| `.claude/commands/eval-prompts.md#env` | directives under this heading | process-contract |  |
| `.claude/commands/eval-prompts.md#arguments` | — | no-rules | |
| `.claude/commands/fix-ci-gate-debt.md#fix-ci-gate-debt` | directives under this heading | process-contract |  |
| `.claude/commands/fix-ci-gate-debt.md#the-loop-this-is-the-job` | directives under this heading | model-workaround | 5-iteration cap + stuck detection; assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md |
| `.claude/commands/fix-ci-gate-debt.md#step-0-set-up-take-an-objective-baseline` | directives under this heading | durable-invariant | frozen read-only auditor asymmetry — durable anti-gaming design |
| `.claude/commands/fix-ci-gate-debt.md#step-1-for-each-failing-gate-diagnose-the-root-cause-before-touching-anything` | directives under this heading | process-contract |  |
| `.claude/commands/fix-ci-gate-debt.md#step-2-fix-at-the-root-common-debt-classes-correct-fix` | directives under this heading | process-contract | grep-whole-tree-before-delete is MW (assumption: LLMs over-delete; sunset: per model upgrade) |
| `.claude/commands/fix-ci-gate-debt.md#step-3-lock-the-wins-baselines-move-down-only` | directives under this heading | durable-invariant | baselines move down only — anti-gaming floor |
| `.claude/commands/fix-ci-gate-debt.md#hard-rules-non-negotiable` | directives under this heading | durable-invariant | never weaken/skip/delete a test to pass a gate |
| `.claude/commands/fix-ci-gate-debt.md#deliverable` | directives under this heading | process-contract |  |
| `.claude/commands/fix-ci-gate-debt.md#audit-script-contract-scriptsci-gate-debt-auditsh` | directives under this heading | process-contract |  |
| `.claude/commands/framework-doctor.md#framework-doctor` | directives under this heading | process-contract |  |
| `.claude/commands/framework-doctor.md#what-to-do` | directives under this heading | process-contract |  |
| `.claude/commands/framework-doctor.md#rules` | directives under this heading | durable-invariant | zero-writes read-only invariant |
| `.claude/commands/framework-doctor.md#arguments` | — | no-rules | |
| `.claude/commands/framework-init.md#framework-init` | directives under this heading | process-contract |  |
| `.claude/commands/framework-init.md#what-to-do` | directives under this heading | process-contract |  |
| `.claude/commands/framework-init.md#rules` | directives under this heading | process-contract |  |
| `.claude/commands/framework-init.md#arguments` | — | no-rules | |
| `.claude/commands/release.md#release` | directives under this heading | process-contract | tag-protocol rules cite the 23-version tag-lag incident — rule live, citation is candidate residue (kill-list LOW group) |
| `.claude/commands/release.md#what-to-do` | directives under this heading | process-contract | tag-protocol rules cite the 23-version tag-lag incident — rule live, citation is candidate residue (kill-list LOW group) |
| `.claude/commands/release.md#rules` | directives under this heading | process-contract | tag-protocol rules cite the 23-version tag-lag incident — rule live, citation is candidate residue (kill-list LOW group) |
| `.claude/commands/release.md#arguments` | — | no-rules | |

## references

| anchor | rule | class | notes (assumption + sunset for model-workarounds) |
|---|---|---|---|
| `references/test-gate-policy.md#test-gate-policy` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#rule` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#forbidden-locally` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#allowed-locally` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#finalisation-g5-carve-out-the-one-sanctioned-local-suite-run-scoped-by-default-full-on-escape-hatch-diffs` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#why` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#what-this-means-for-plans-and-specs` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#pre-existing-gate-violations` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#how-to-reference-this-file` | directives under this heading | process-contract |  |
| `references/test-gate-policy.md#project-specific-notes` | directives under this heading | process-contract |  |
| `references/iteration-caps.md#iteration-cap-registry-single-source-of-truth` | directives under this heading | model-workaround | the cap registry itself: every cap patches non-convergence detection; assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md — this file is the registered sunset home |
| `references/review-mode-resolution.md#review-mode-autonomy-resolution-single-source-of-truth` | directives under this heading | process-contract |  |
| `references/review-mode-resolution.md#mode-review-transport` | directives under this heading | process-contract |  |
| `references/review-mode-resolution.md#autonomy-blocking-behaviour` | directives under this heading | process-contract |  |
| `references/review-mode-resolution.md#invocation-context-chatgpt-pr-review-only` | directives under this heading | process-contract |  |
| `references/review-tier-redundancy-audit.md#review-tier-redundancy-audit-runbook` | directives under this heading | process-contract |  |
| `references/review-tier-redundancy-audit.md#the-question` | directives under this heading | process-contract |  |
| `references/review-tier-redundancy-audit.md#data-sources` | directives under this heading | process-contract |  |
| `references/review-tier-redundancy-audit.md#procedure` | directives under this heading | process-contract |  |
| `references/review-tier-redundancy-audit.md#decision-thresholds` | directives under this heading | process-contract |  |
| `references/review-tier-redundancy-audit.md#notes` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#local-override-convention-framework-v2100` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#syntax` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#how-it-works-during-syncjs` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#authoring-a-slot-in-the-framework` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#using-a-slot-as-a-consuming-project` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#removing-a-slot` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#what-slots-are-not-for` | directives under this heading | process-contract |  |
| `references/local-override-convention.md#reference-implementation` | directives under this heading | process-contract |  |
| `references/project-extensions-convention.md#project-extensions-convention` | directives under this heading | process-contract |  |
| `references/project-extensions-convention.md#why` | — | no-rules | |
| `references/project-extensions-convention.md#pattern` | directives under this heading | process-contract |  |
| `references/project-extensions-convention.md#directive-shape` | directives under this heading | process-contract |  |
| `references/project-extensions-convention.md#authoring-a-project-extension-file` | directives under this heading | process-contract |  |
| `references/project-extensions-convention.md#adoption-guidance` | directives under this heading | process-contract |  |
| `references/project-extensions-convention.md#long-term-direction` | — | no-rules | |
| `references/project-extensions-convention.md#see-also` | — | no-rules | |
| `references/skill-overlay-convention.md#skill-overlay-convention` | — | no-rules | |
| `references/skill-overlay-convention.md#why-this-exists` | directives under this heading | process-contract |  |
| `references/skill-overlay-convention.md#canonical-pointer-line-pinned` | directives under this heading | process-contract |  |
| `references/skill-overlay-convention.md#write-protocol` | directives under this heading | process-contract |  |
| `references/skill-overlay-convention.md#cleanfiles-drain-mechanism` | directives under this heading | process-contract |  |
| `references/skill-overlay-convention.md#mapping-doc-format-tasksknowledge-to-framework-skills-mapmd` | directives under this heading | process-contract |  |
| `references/skill-overlay-convention.md#framework-doctor-overlay-checks` | directives under this heading | process-contract |  |
| `references/skill-overlay-convention.md#deployment` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#eval-suite-format` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#why-golden-set-evals` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#suite-layout` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#configjson` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#promptmodule-contract` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#normalizer-contract` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#casesjsonl` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#baselinejson` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#metrics-pinned` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#run-semantics` | directives under this heading | process-contract |  |
| `references/eval-suite-format.md#not-shipped` | directives under this heading | process-contract |  |
| `references/spec-review-directional-signals.md#spec-review-directional-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#scope-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#sequencing-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#testing-posture-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#rollout-posture-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#production-caution-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#architecture-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#cross-cutting-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#framing-signals` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/spec-review-directional-signals.md#when-to-update-this-file` | directives under this heading | model-workaround | hardcoded directional-signal list + override prohibition; assumption: model directionality judgment unreliable; sunset: WS4 eval evidence |
| `references/verification-commands.md#verification-commands-stack-specific-template` | directives under this heading | process-contract |  |
| `references/verification-commands.md#stack-template` | directives under this heading | process-contract |  |
| `references/verification-commands.md#worked-examples-by-stack` | directives under this heading | process-contract |  |
| `references/verification-commands.md#node-typescript-express-vite-similar` | — | no-rules | |
| `references/verification-commands.md#python-fastapi-django-similar` | — | no-rules | |
| `references/verification-commands.md#rust` | — | no-rules | |
| `references/verification-commands.md#go` | — | no-rules | |
| `references/verification-commands.md#rules-stack-independent` | directives under this heading | process-contract | 3-attempt escalation caps are MW (assumption: executing models do not reliably detect non-convergence; sunset: re-evaluate per model upgrade via the WS4 eval suite; caps registered in references/iteration-caps.md) |
| `references/verification-commands.md#wiring-this-file-to-your-project` | directives under this heading | process-contract |  |

## hooks

| anchor | rule | class | notes |
|---|---|---|---|
| `.claude/hooks/bash-config-guard.js` | hook contract (event, block/advisory, fail-mode) | durable-invariant | closes the Bash bypass of the config/knowledge floors; HITL sentinel; fail-open on hook bugs |
| `.claude/hooks/code-graph-freshness-check.js` | hook contract (event, block/advisory, fail-mode) | process-contract | advisory cache maintenance; always exit 0 |
| `.claude/hooks/config-protection.js` | hook contract (event, block/advisory, fail-mode) | durable-invariant | protects "never suppress warnings to pass a check" floor via HITL sentinel; fail-open on hook bugs |
| `.claude/hooks/correction-nudge.js` | hook contract (event, block/advisory, fail-mode) | model-workaround | assumption: unprompted correction-capture into KNOWLEDGE.md is unreliable; sunset: re-evaluate per model upgrade via eval |
| `.claude/hooks/framework-merge-reminder.js` | hook contract (event, block/advisory, fail-mode) | process-contract | advisory pending-merge surface; always exit 0 |
| `.claude/hooks/knowledge-append-guard.js` | hook contract (event, block/advisory, fail-mode) | process-contract | append-only memory contract (fail-closed block on non-tail edits); F8 advisory dedup rides here fail-open (WS3) |
| `.claude/hooks/long-doc-guard.js` | hook contract (event, block/advisory, fail-mode) | model-workaround | assumption: single-shot long-document quality degrades without chunking; sunset: re-evaluate per model upgrade via eval |
| `.claude/hooks/memory-digest.js` | hook contract (event, block/advisory, fail-mode) | process-contract | session context bootstrap; byte/line-bounded; fail-open (F7 adds index-matched recall, WS3) |
| `.claude/hooks/phase-lock.js` | hook contract (event, block/advisory, fail-mode) | process-contract | per-phase allowed-write-paths matrix; fail-open on internal errors |
| `.claude/hooks/spec-creation-grill-nudge.js` | hook contract (event, block/advisory, fail-mode) | model-workaround | assumption: description-based skill/doc triggering is unreliable; sunset: re-evaluate when triggering proves reliable on the WS4 eval suite |
| `.claude/hooks/wargame-nudge.js` | hook contract (event, block/advisory, fail-mode) | model-workaround | trigger-reliability patch (D6); sunset: re-evaluate when description-based skill triggering proves reliable on the WS4 eval suite |
