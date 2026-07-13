# Wargame success criteria

The grading standard. A wargame is graded against all 10 criteria; every fail is recorded in the artifact, patched, and regraded. Status transitions: `draft` (any criterion failing, or red-team not yet run) → `red-teamed` (red-team pass recorded) → `approved` (all 10 pass). Only `approved` wargames execute.

Criterion 6 is special: a missing Abort Conditions section fails the whole grading immediately, regardless of the other nine. Fail closed.

| # | Criterion | Pass definition |
|---|---|---|
| 1 | Recon grounding | Every branch cites recon evidence (file:line, command output, URL) or is labelled `SPECULATIVE`. No unlabelled uncited branches. |
| 2 | Observation contracts | Every move has an expected observation. Deterministic predicates (exit code, status, file exists, string present) wherever possible; prose-only observations flagged `[JUDGEMENT]`. |
| 3 | Fork discipline | Every fork has a trigger; triggers within a move are mutually exclusive; the default when nothing matches is the OFF-MAP rule (stop, and on a risky move escalate). Zero judgement is unachievable; an explicit stop-and-escalate default is the honest version. |
| 4 | Failure coverage | Every risky move has its two branches (most likely, most damaging), each with signal, cause, and counter-move. Non-risky moves are not branched (depth budget respected, 25-branch cap). |
| 5 | Assumptions ledger | Complete: every `RECON NEEDED` names the exact settling check; every operator blank is a `{{PLACEHOLDER}}`; nothing pre-filled by the planner. |
| 6 | Abort conditions | Present, specific, observable triggers, hard-stop semantics. Absent section = automatic fail of the entire grading. |
| 7 | Verification | Every verification run has an explicit pass definition; at least one run is marked `[FORCED-FAILURE]` and can genuinely detect a bad state. |
| 8 | Test bridge | Every failure branch has a `WG-<mission>-T<n>` ID and a one-line forced-test description in the Test Bridge Index. |
| 9 | Executability | Executable with no avoidable questions; every unavoidable question is pre-declared in the Assumptions Ledger. (This replaces the source kit's "executable blind without asking a single question", which is over-rotated: blind continuation on a risky move is the failure mode, not the standard.) |
| 10 | Red-team record | At least one successful attack against the draft is recorded with its patch, alongside the attacks that failed. A red-team pass that found nothing is a failed pass: attack harder or justify why the artifact genuinely resisted. |

## Grading procedure

1. Grade the draft against all 10; write failing criterion numbers and one-line reasons into the artifact under a `## Grading` heading.
2. Patch, regrade. Repeat until clean or the mission is split (branch cap).
3. Record the red-team pass (criterion 10) before promoting past `red-teamed`.
4. Set `status: approved` only when all 10 pass. The grader records the grading date next to the status.

Self-grading by the planner is acceptable for `red-teamed`; promotion to `approved` for missions whose entry-test score includes the irreversible mark should be graded by a second session or model where practical, and by the operator when the risk ceiling includes production data.
