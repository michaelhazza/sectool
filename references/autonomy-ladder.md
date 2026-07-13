# Autonomy ladder — single registry of autonomous authorities and operator gates

Every autonomous authority (a thing the harness does without asking) and every operator gate (a thing that waits for a human) registers here with risk class, reversibility, and operator-cost. A new gate or authority not registered here is a review finding (see `GOAL.md § Autonomy registration`). The decision test for every row: does this gate buy more operator-quality-time than it costs, and would we add it again today?

Risk class: `low` (branch-scoped, checked, revertible) · `medium` (crosses a repo/PR/issue boundary, revertible with effort) · `high` (lands on main, publishes externally, or bypasses a check). Operator-cost: what the gate consumes per occurrence (`none` for authorities).

## Autonomous authorities

| Authority | Where | Risk | Reversibility | Operator-cost | Notes |
|---|---|---|---|---|---|
| Auto-merge to main via `--admin` squash — narrowed: only when G5 passed locally, CI ran green on the labelled HEAD, and the sole post-CI commit is the docs-only prep commit; otherwise required checks must pass | `finalisation-coordinator.md` Step 12.3 (DG-5, operator-locked 2026-07-10) | medium — bypass limited to a provably-redundant re-run | revert commit on main | none | Was high/unconditional before this batch |
| Label-pull CI fix loop (remove label → fix → re-add) | `finalisation-coordinator.md` Step 11 | medium | branch-scoped | none | Contains CI failures without operator paging |
| S2/S3 branch sync auto-resolve of known-shape conflicts in append-only artifact files | `finalisation-coordinator.md` Steps 2, 8b | low | git | none | Pauses on code-area conflicts (gate below) |
| Technical review findings auto-execute per recommendation | `chatgpt-pr-review.md` (operator opted out of approving technical findings) | low–medium | git | none | Boundary is the user-facing carve-out, not severity |
| Coordinator auto-apply of `auto_apply_eligible` findings (four-key gate) | `chatgpt-*-review.md` §11a protocol | low | lint+typecheck gate, revert on failure | none | `risk_domain` carve-out findings never auto-applied — durable-invariant |
| Duplicate findings (rounds 2+) auto-apply the prior decision | `chatgpt-pr-review.md` step 1a (KNOWLEDGE 2026-05-01 correction) | low | git | none | Repetition adds zero judgment once the operator decided |
| pr-reviewer mechanical auto-fix (`scope_signal: local` AND `risk_domain: none`) | `pr-reviewer.md` §Mechanical auto-fix | low | git; verify-after-each-fix | none | Architectural and carve-out findings never auto-fixed |
| Review agents auto-commit/auto-push within their own flows | `audit-runner.md` (push gated on post-audit review pass), `spec-reviewer`, `chatgpt-*`, `dual-reviewer`, `spec-conformance` | medium — leaves the machine | branch-scoped | none | Explicit operator opt-in recorded in consumer CLAUDE.md User Preferences |
| bug-fixer fix mode: branch + fix + PR + issue comment | `bug-fixer.md` fix mode | medium — PR is outward-facing | close PR | none | Never auto-finalises: merge waits for the "done" gate |
| Advisory reviewers route directional findings to backlog without blocking | `spec-reviewer.md`, `claude-spec-review.md`, `claude-plan-review.md` | low | n/a (read-only) | none | Advisory posture is the design |
| Required-reviewer skip proceeds with a logged `REVIEW_GAP` artifact | `feature-coordinator.md` §8, `finalisation-coordinator.md` Step 0 | medium — a required review did not run | git; remediation recorded in the artifact | none | The `REVIEW_GAP` line is the audit record; a silent skip is a policy violation |
| `unattended` autonomy: every pausing gate becomes surface-and-continue | `chatgpt-pr-review.md` / `chatgpt-plan-review.md` §AUTONOMY | medium | decisions logged, revisitable | none | Default `attended`; fail-closed to `attended` on resume; NOT the default anywhere |
| builder stop-authority: G1 cap exhaustion / PLAN_GAP → escalate, never improvise | `builder.md` verdicts | low | n/a | none | An authority to STOP is still an authority — registered |
| Blocking hooks (append-guard non-tail block, phase-lock, config-protection, long-doc-guard, bash-config-guard) | `.claude/hooks/*` | low | operator can override per hook contract | none | Fail-open on hook bugs except documented fail-closed guards |
| Wargame executor: on-map moves execute without escalation | `wargame` skill, executor contract | low | per-move verification | none | WS6 row: the artifact itself authorises nothing — advisory only |

## Operator gates

| Gate | Where | Risk it protects | Reversibility if wrong | Operator-cost | Notes |
|---|---|---|---|---|---|
| Plan gate: coordinator STOPS after plan authoring | `feature-coordinator.md` plan gate | wrong build direction (expensive downstream) | high cost to unwind | one review per build | High leverage per occurrence |
| Post-G2 spec-validity checkpoint (presented verbatim) | `feature-coordinator.md` | building past an invalidated spec | medium | one ack per build | |
| `ready-to-merge` label | `finalisation-coordinator.md` Step 10.3 | premature merge | label removal | one action per build | "The single operator-controlled decision point in this coordinator" |
| User-facing findings approval (per item) | `chatgpt-*-review.md` step 3b | product surface changing without owner intent | git | **per finding** | Under review: DG-8 proposes per-round batch approval |
| Manual ChatGPT-web loop (paste diff / paste response, per round) | `chatgpt-*-review.md` manual mode (hard default) | reviewer quality regression if flipped early | n/a | **highest recurring cost in the pipeline** — unbounded rounds | Under review: DG-6 (flip criterion DG-4) |
| Prompt-improvement proposals (Step 7 learning channels) | `docs/review-pipeline/parallel-mode.md` Step 7 | prompt regression | eval suite now exists (WS4) | per proposal | Under review: DG-7 proposes eval-gated auto-apply |
| Compound-learning rows | `finalisation-coordinator.md` Step 7a | bad lessons entering policy | git | per row | Advisory phase; no merge block |
| Spec FINAL approval; mockup operator loop | `spec-coordinator.md`, `mockup-coordinator.md` | building the wrong thing | high cost | per spec / per mockup round | |
| bug-fixer finalise: explicit "done"-class verb required | `bug-fixer.md` mode table | unreviewed merge | high | one word per bug | Never inferred — explicit signal only |
| `/release` push confirmation (commit, tag, push held until approved) | `.claude/commands/release.md` step 8 | broken release propagating to every consumer | pushed tags are hard to unwind | one confirmation per release | Blast radius = all consuming repos |
| Wargame: OFF-MAP escalation + abort conditions | `wargame` skill executor contract | executor improvising through unmapped risk | depends on mission | per escalation | WS6 rows: OFF-MAP risky moves escalate to the human; abort conditions are hard stops — durable-invariant |
| Decision-gate rows (this batch's mechanism) | batch spec §6 | judgment changes propagating unreviewed | per-row rejection | one gate per batch | |

## Registration convention

New gates and authorities register a row here **in the same PR** that introduces them; reviewers treat an unregistered gate/authority as a finding (convention stated in `GOAL.md § Autonomy registration`, enforced by review, checked by the ledger checker's keyword pass).
