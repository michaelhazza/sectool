---
name: wargame
description: Use when planning a risky operational mission that runs outside the build pipeline: an infrastructure or data migration, credential rotation, bulk edit/delete/rename, provider cutover, decommission, a deploy or publish with no undo, a repo restructure, or any multi-step plan a separate session or cheaper model will execute. Produces a persistent wargame artifact (a decision tree with expected observations, failure branches, counter-moves, and abort conditions) consumed by an executor. Also fires on "wargame", "war game", "battle plan", "pre-mortem this plan", "stress-test this plan", "what could go wrong", "failure modes", "make this executable by a cheaper model". NOT for feature builds inside the spec/plan/build pipeline (architect owns those plans) and NOT for hotfix or incident response (speed path).
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## wargame` section, read it: it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Wargame

A wargame replaces a linear plan with a fought-on-paper decision tree. For each move it records the intent, the action, what you should observe if the move worked, the most likely and most damaging failures with their signals and pre-computed counter-moves, fork triggers, unresolved assumptions, abort conditions, and the verification runs that prove completion. A strong planner generates it once; a cheaper executor (or a later session of any model) consumes it many times, following branches instead of improvising.

Lineage, for orientation: this is FMEA (failure mode and effects analysis) plus Gary Klein's pre-mortem, operationalised into an executor-consumable protocol. It is the artifact-level implementation of the framework's principle that planning must be adversarial, not merely decompositional, and that verification must defeat fast-exit paths. The technique is model-agnostic: any strong planner can generate, any tier can execute.

## Scope boundary (read first)

- **Feature builds never get wargamed.** Work flowing through spec, plan, and build belongs to the `architect` agent and `plan.md`; that pipeline already carries chunk metadata, risk sections, and the builder executor contract. Producing a second planning artifact for the same work is the primary misuse of this skill.
- **Hotfix and incident response are excluded.** Those paths trade planning depth for speed deliberately. If an incident fix reveals a risky follow-up operation, wargame the follow-up, not the fix.
- **Wargames cover risky operational missions:** migrations, credential rotations, provider cutovers, bulk changes, decommissions, one-off scripts against production state, cross-repo operations, and any plan handed to a separate executor session.

## Entry test (anti-overuse gate)

Score the mission, one mark each:

1. **Irreversible:** any step deletes, sends, publishes, pays, or overwrites without undo.
2. **External dependency:** auth, third-party API, DNS, network, or another system's state.
3. **Shared-state mutation:** production data, shared config, credentials, or anything other actors read.
4. **Novel:** no prior successful run of this mission shape in this repo (check `KNOWLEDGE.md` and the wargame ledger).

A mission consumed by a separate executor session or a cheaper model counts one extra mark.

**Score 2+:** wargame justified. **Score 0-1:** do NOT wargame; plan normally and state in one line why the test failed. An operator explicitly requesting a wargame overrides the test; record the override in the artifact frontmatter.

## Generation protocol

0. **Stance.** Adopt `fable-mode` for the generation session (Skill tool inline; dispatched sub-agents Read its SKILL.md during context loading). Wargame generation is judgment-heavy work.
1. **Recon, read-only, evidence-cited.** Inspect the actual subject (repo, site, document, environment) before writing any move. Every branch cites the recon evidence that grounds it: file path and line, command output, or URL. A branch with no evidence is labelled `SPECULATIVE`. A wargame without grounded recon is fan fiction with confident formatting.
2. **Risk triage per move.** Apply the four entry-test marks at move level. Risky moves get failure branches; non-risky moves get an expected observation only. This prevents combinatorial explosion.
3. **Depth budget.** Two branches per risky move (most likely failure, most damaging failure), consequences traced two orders deep, hard cap of 25 branches per wargame. Over the cap: split the mission into two wargames and say so. Never silently thin coverage.
4. **Assumptions ledger.** Every assumption recon could not settle is marked `RECON NEEDED` with the exact check that settles it. Every operator-supplied blank is a `{{PLACEHOLDER}}`; neither planner nor executor ever invents a value for one.
5. **Abort conditions.** Mandatory. A wargame with no abort conditions is invalid; do not emit it. Abort means stop and report, never "try one more thing".
6. **Verification runs.** Named commands or checks the executor performs at completion, each with an explicit pass definition. At least one is a forced-failure check (proves the check can fail), not a happy-path run.
7. **Test bridge.** Every failure branch carries a test ID (`WG-<mission>-T<n>`) and a one-line description of the forced test that would prove the counter-move works. The wargame is the systematic generator of the forced-failure test list.
8. **Red-team pass.** Before grading, attack the draft: find one path that defeats it, patch it, and record both the failed attacks and the successful attack with its patch in the Red-team Record. Required before status `approved`.
9. **Batch mode.** When multiple missions are queued, draft all wargames first, then polish in a second loop. Never polish one to perfection while others have no draft.

## Artifact, executor, grading

- **Schema and copy-paste skeleton:** `references/wargame-template.md`. Save completed wargames to `tasks/wargames/<mission>.md` in the consuming repo unless the caller specifies another path.
- **Consumption protocol** (staleness refusal, placeholder refusal, branch matching order, the OFF-MAP rule, ledger entry): `references/executor-contract.md`. OFF-MAP carries the same semantics as the builder agent's `PLAN_GAP` verdict: stop and report, never improvise past the map on a risky move.
- **Grading standard** (10 points) and the status flow `draft` to `red-teamed` to `approved`: `references/success-criteria.md`. Only `approved` wargames execute.

## Hard invariants

- **A wargame never authorises anything.** Permissions, risk gates, and policy are unchanged by its existence; it routes decisions only.
- No abort conditions means invalid artifact. Fail closed.
- Deterministic triggers match before judgement triggers, always, in listed order.
- Placeholders are never auto-filled by planner or executor.
- A stale wargame (commit or environment fingerprint mismatch) does not execute without explicit human override.
- Every execution appends a ledger entry. No silent runs.

## Calibration loop (anti-drift)

After each of the first three executed missions, review the ledger:

- Wargames generated for missions scoring 0-1: tighten this skill's description and entry-test wording.
- A risky mission went wrong without a wargame: add its vocabulary to the `wargame-nudge` hook patterns.
- The same branch fires across missions: fix the underlying logic or skill it exposes; do not fatten future wargames.

## Rationalisations

| Thought | Reality |
|---|---|
| "This build is complex, better wargame it" | Complex feature builds go to architect and `plan.md`. Wargames are for operational missions outside the pipeline. |
| "It's basically reversible" | Score the four marks, don't vibe them. Deletes, sends, publishes, and payments are marks even when a backup theoretically exists. |
| "The executor can figure out unmapped territory" | Off-map on a risky move means stop and escalate. Blind continuation is the failure mode this artifact exists to prevent. |
| "No time for recon, I know this system" | Unverified branches are model priors dressed as reconnaissance. Verify them or label them `SPECULATIVE`. |
| "Abort conditions feel pessimistic" | A wargame without abort conditions fails validation. Fail closed is the contract. |
| "One more retry might fix it" | Abort conditions are hard stops. Retries past an abort are how one bad step becomes an incident. |
