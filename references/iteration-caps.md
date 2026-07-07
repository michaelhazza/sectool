# Iteration-cap registry — single source of truth

Every bounded loop in the pipeline, in one place. Agent files cite this table
instead of restating numbers; when an agent file and this table disagree, THIS
TABLE WINS. Change a cap here first, then update the citing file in the same
commit. `validate-setup` may diff agent-stated caps against this table.

| # | Loop | Cap | Scope | Owner file |
|---|------|-----|-------|------------|
| 1 | claude-spec-review iterations | 3 | lifetime per artifact | `.claude/agents/claude-spec-review.md` |
| 2 | claude-plan-review iterations | 3 | lifetime per artifact | `.claude/agents/claude-plan-review.md` |
| 3 | spec-reviewer (Codex) iterations | 5 | lifetime per spec | `.claude/agents/spec-reviewer.md` |
| 4 | chatgpt-* review rounds | 5 | per session (soft — operator can extend) | `chatgpt-{spec,plan,pr}-review.md` |
| 5 | mockup same-finding repeats | 3 | soft cap; surface to operator | `.claude/agents/mockup-coordinator.md` |
| 6 | builder G1 retries | 3 | per chunk | `.claude/agents/builder.md` |
| 7 | builder plan-gap re-checks | 2 | per chunk | `.claude/agents/builder.md` |
| 8 | architect plan-revision rounds | 3 | per plan | `.claude/agents/feature-coordinator.md` (Step 3) |
| 9 | G2 integrated-gate retries | 3 | per build | `.claude/agents/feature-coordinator.md` (Step 7) |
| 10 | pr-reviewer fix-loop rounds | 3 | per review pass (re-review pass gets its own 3) | `.claude/agents/feature-coordinator.md` (Step 8.4) |
| 11 | dual-reviewer (Codex) iterations | 3 | per invocation | `.claude/agents/dual-reviewer.md` |
| 12 | G4 regression-guard fix attempts | 3 | per Phase 3 session | `.claude/agents/finalisation-coordinator.md` (Step 3) |
| 13 | G5 local CI-parity fix iterations | 10 | per Phase 3 session | `.claude/agents/finalisation-coordinator.md` (Step 8c) |
| 14 | CI watch auto-fix iterations (label-pull loop) | **5** | per Phase 3 session — applies to BOTH `finalisation-coordinator` Step 11 AND `chatgpt-pr-review` standalone step 12 (unified in 2.27.0; they previously disagreed 5 vs 3) | `.claude/agents/finalisation-coordinator.md`, `.claude/agents/chatgpt-pr-review.md` |
| 15 | CI poll count | 30 polls (~45 min at 90s) | per watch | `.claude/agents/chatgpt-pr-review.md` (step 12) |
| 16 | bug-fixer verification checks | 2 | per fix | `.claude/agents/bug-fixer.md` |
| 17 | experiment-runner consecutive non-keeps | 5 (warn) / 10 (stop) | per experiment | `.claude/agents/experiment-runner.md` |
| 18 | spec-coordinator Step 3a revise loop | 3 | per intent — on the 4th `revise`, escalate to the operator instead of looping (added 2.27.0; previously unbounded) | `.claude/agents/spec-coordinator.md` (Step 3a) |
| 19 | G3 lint+typecheck fix attempts | 3 | per gate invocation (§8.1 CONFORMANT_AFTER_FIXES, §8.4 fix-loop, §8.5 post-dual-review) — on exceed, escalate with full diagnostics per failure path 4; never mark the gate passed | `.claude/agents/feature-coordinator.md` (Step 8) |

Auto-fix guardrails AF1–AF4 (`finalisation-coordinator` Step 11) are rules, not
loops — they are intentionally not in this table.
