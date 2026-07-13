# GOAL

**Primary objective: operator leverage — maximise shipped, production-quality product per hour of operator attention.**

Everything in this harness — every agent, gate, hook, skill, cap, and checklist — exists to serve that objective. Anything that consumes operator attention without protecting quality is a defect, whatever its history.

Two subordinate constraints bound the objective; they are not tradable against it:

1. **Quality floor.** Security and tenant-isolation review rigor is a floor, not a dial. No leverage gain justifies lowering it. (Enforcers: the review pipeline's security carve-out — `risk_domain` findings are never auto-applied; `adversarial-reviewer` auto-trigger surface.)
2. **Cost is tertiary.** Token and compute cost matter only after operator attention and quality. Optimising cost at the expense of either is optimising the wrong variable.

## The decision test

Every rule, gate, agent, or mechanism — new or existing — must pass one test:

> Does this buy more operator-quality-time than it costs, and would we add it again today?

Apply it when adding anything, and re-apply it when a model upgrade, a measurement, or an incident changes the answer. "It caught a bug once" is history, not justification; the test is present-tense. (Enforcer: every new artifact's PR description or decision-gate row states its answer; reviewers reject additions without one.)

## The prescription rule

Verbatim prescription is justified only for **mechanically verifiable** steps: exact commands, schema shapes, gate invocations, file formats — places where a checker can prove compliance and deviation is failure. Judgment work gets **intent + constraints**, never scripts: state the outcome, the boundaries, and the evidence bar, and let the executing model choose the path. A step-locked playbook for judgment work encodes one past model's weaknesses as every future model's ceiling.

## Rule lifecycle

Every behavioural rule in the corpus carries a classification in `references/rule-classification.md`:

| Tag | Meaning | Lifecycle |
|-----|---------|-----------|
| `durable-invariant` | True regardless of model capability (safety floors, data-integrity contracts) | Permanent; amend only via decision gate or PR review |
| `process-contract` | Coordination agreement between agents/sessions/repos (formats, caps, registration surfaces) | Stable; renegotiate when the process changes |
| `model-workaround` | Patches a specific model-capability gap | Names the capability assumption it patches and its sunset trigger; re-evaluated on model upgrade via the eval suite |
| `residue` | Encodes a completed one-off (a fixed incident, a finished migration) | Delete; git history carries it |

A new rule lands with its tag; an untagged rule is a review finding. `model-workaround` entries without a named sunset trigger are misfiled.

## Autonomy registration

Every autonomous authority (a thing the harness does without asking) and every operator gate (a thing that waits for a human) is registered in `references/autonomy-ladder.md` with its risk class, reversibility, and operator-cost. A new gate or authority that is not registered there is a review finding. The ladder is where the decision test gets applied to the approval boundary: gates exist to protect quality, not to distribute liability.

## Precedence

GOAL.md sets the optimisation direction and the decision test for **adding, changing, or removing rules**. It never overrides an explicit safety or process contract — security/tenant-isolation floors, review gates, CI-only test policy — at execution time. A conflict between GOAL.md and a contract is resolved by amending the conflicting contract through the rule-classification ledger and the decision gate (or a later PR), never by a session preferring GOAL.md ad hoc.
