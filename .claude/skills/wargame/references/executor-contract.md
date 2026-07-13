# Executor contract

How any executor (a cheaper model, a later session, or the planner itself on a later day) consumes a wargame. Callers dispatching a separate executor paste the Dispatch block at the end of this file into the executor's prompt.

## Pre-flight (before move 1, in this order)

1. **Staleness.** `status` must be `approved`. `repo_commit` must match `git rev-parse HEAD` (when the subject is a repo) and `env_fingerprint` must match reality. Any mismatch: refuse with verdict `STALE`. Only an explicit human override proceeds past staleness, and the override is logged in the ledger entry.
2. **Placeholders.** Any unfilled `{{PLACEHOLDER}}` anywhere in the artifact: refuse with verdict `BLOCKED_ON_INPUT`, listing the placeholders. Never invent a value.

## Per move

3. **Act exactly as written.** Then capture the actual observation (exit code, output, state), not a paraphrase of it.
4. **Match** the observation against the move's branches in listed order, deterministic predicates before `[JUDGEMENT]` calls. On match: execute that branch's counter-move and log the branch ID.
5. **OFF-MAP rule.** If no branch matches:
   - Non-risky move: stop the move, re-plan locally from first principles, log an `OFF-MAP` entry with the observation and your reasoning, then continue.
   - Risky move: STOP and escalate to the human with a state report (what completed, what did not, the unmatched observation). Same semantics as the builder agent's `PLAN_GAP` verdict: a missing map is a return value, never a licence to improvise.
6. **Bounded retries.** A counter-move that includes a retry is capped at the count it states; no counter-move retries more than 3 times regardless. Abort conditions are hard stops: no retries past an abort, ever.

## Completion

7. Run every verification run in §5 of the artifact; report pass or fail per run, with output.
8. Append a ledger entry (below). For audit purposes, a run without a ledger entry did not happen.

## Verdict vocabulary

`COMPLETE` | `ABORTED(<abort id>)` | `OFF-MAP-ESCALATED(<move>)` | `STALE` | `BLOCKED_ON_INPUT`

These align with the framework's builder verdicts (`SUCCESS` | `PLAN_GAP` | `G1_FAILED`): a structured return, never a shrug.

## Ledger

Location: `tasks/wargames/LEDGER.md` in the consuming repo; create it with this header on first entry. One row per executed mission:

| Date | Wargame | Executor | Verdict | Branches taken | OFF-MAP events | Aborts | Verification results | Patches fed back |
|---|---|---|---|---|---|---|---|---|

"Patches fed back" records edits made to the wargame or to a framework skill as a result of this run; `none` is a valid value. The ledger is the input to the skill's calibration loop (SKILL.md § Calibration loop) and to the "novel" mark of the entry test.

## Dispatch block (paste into a separate executor's prompt)

```
You are executing the wargame at <path>. Follow its executor contract strictly:
1. Refuse if status is not "approved" or if repo_commit / env_fingerprint mismatch reality (verdict STALE).
2. Refuse if any {{PLACEHOLDER}} is unfilled (verdict BLOCKED_ON_INPUT). Never invent values.
3. Per move: act exactly as written, capture the actual observation, match branches in listed
   order (deterministic before judgement). On match, run the counter-move and log the branch ID.
4. If nothing matches: STOP the move. Non-risky move: re-plan locally and log OFF-MAP. Risky
   move: escalate to the human with a state report. Never improvise past the map on a risky move.
5. Abort conditions are hard stops. No retries past an abort. No counter-move retries more than
   3 times.
6. On completion: run every verification run, report pass/fail per run, and append the ledger
   entry per the wargame's executor contract.
```
