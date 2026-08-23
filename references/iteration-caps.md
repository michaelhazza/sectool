# Iteration-cap registry — single source of truth

Every bounded loop in the pipeline, in one place. Agent files cite this table
instead of restating numbers; when an agent file and this table disagree, THIS
TABLE WINS. Change a cap here first, then update the citing file in the same
commit.

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
| 11 | dual-reviewer (Codex) iterations | 5 | per invocation — raised from 3 (operator, 2026-07-29: real reviews regularly need more rounds; this build used all 3 with findings still flowing, and its own iterations 1-2 each introduced a bug the next caught). Convergence rule unchanged: a zero-accepted round still exits early | `.claude/agents/dual-reviewer.md` |
| 12 | G4 regression-guard fix attempts | 3 | per Phase 3 session | `.claude/agents/finalisation-coordinator.md` (Step 3) |
| 13 | G5 local CI-parity fix iterations | 10 | per Phase 3 session | `.claude/agents/finalisation-coordinator.md` (Step 8c) |
| 14 | CI watch auto-fix iterations (label-pull loop) | **5** | per Phase 3 session — applies to BOTH `finalisation-coordinator` Step 11 AND `chatgpt-pr-review` standalone step 12 (unified in 2.27.0; they previously disagreed 5 vs 3) | `.claude/agents/finalisation-coordinator.md`, `.claude/agents/chatgpt-pr-review.md` |
| 15 | CI poll count | 30 polls (~45 min at 90s) | per watch | `.claude/agents/chatgpt-pr-review.md` (step 12) |
| 16 | bug-fixer verification checks | 2 | per fix | `.claude/agents/bug-fixer.md` |
| 18 | spec-coordinator Step 3a revise loop | 3 | per intent — on the 4th `revise`, escalate to the operator instead of looping (added 2.27.0; previously unbounded) | `.claude/agents/spec-coordinator.md` (Step 3a) |
| 19 | G3 lint+typecheck fix attempts | 3 | per gate invocation (§8.1 CONFORMANT_AFTER_FIXES, §8.4 fix-loop, §8.5 post-dual-review) — on exceed, escalate with full diagnostics per failure path 4; never mark the gate passed | `.claude/agents/feature-coordinator.md` (Step 8) |
| 20 | plan-reviewer (Codex) iterations | 5 | lifetime per plan | `.claude/agents/plan-reviewer.md` |
| 21 | brief-reviewer rounds | single-round | per brief revision — one Codex + one ChatGPT pass, no loop; a revised brief may be re-reviewed once | `.claude/agents/brief-reviewer.md` |
| 22 | verify-phase fix loop | 5 | per verify-phase invocation — exceed escalates to the operator with the failure set; recorded as REVIEW_GAP-style entry in `progress.md` (blocks merge) | `.claude/agents/verify-phase.md` |
| 23 | acceptance fix cycles | 3 | per build — on the third repeated failure or the same blocking condition twice with the same diagnosis, stop and escalate with evidence rather than looping. Each cycle is a fresh execution on a new SHA, never a replayed conversation (brief §11) | `.claude/agents/acceptance-phase.md` |

Auto-fix guardrails AF1–AF4 (`finalisation-coordinator` Step 11) are rules, not
loops — they are intentionally not in this table.
