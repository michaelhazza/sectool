# Spec Review Context — Framing Ground Truth

This file is the ground-truth framing reference for the `spec-reviewer` agent. Every spec review run starts by reading this file and cross-referencing the spec's framing against it. If the spec contradicts this file, the agent pauses for HITL before running any review iterations.

**This file is maintained by hand.** When the product context shifts, update this file FIRST, then re-review the specs that referenced the old framing. The agent treats every statement below as authoritative — an automated finding that contradicts this file is classified as directional and sent to HITL.

---

## Framing statements

```yaml
# Staleness metadata — used by spec-reviewer's pre-loop context check.
# Update last_reviewed_at when the framing block below is verified or modified.
# stale_after_days = 60: spec-reviewer warns when last_reviewed_at is older.
# stale_blocks_at_days = 120: spec-reviewer refuses to start until reviewed.
last_reviewed_at: 2026-06-12
stale_after_days: 60
stale_blocks_at_days: 120
```

Current as of 2026-06-12. Update the date whenever any of the statements below change AND when the framing is verified to still apply (even if no statement changed). The staleness check above turns "I'll re-check this someday" into "the agent stops me at 4 months."

```yaml
# Deployment context — audit-tool (internal CLI, no end users)
pre_production: yes
live_users: no
live_agencies: no
testing_phase_started: no
production_incidents_expected: no

# Stage of the app
stage: rapid_evolution
feature_stability: low
breaking_changes_expected: yes

# Testing posture
# The benchmark corpus (recall/precision over seeded fixtures) is the primary
# quality gate — runtime tests are first-class here, unlike a typical
# rapid-evolution app. Every rule/check ships with known-bad + known-good
# fixtures; the live engine is exercised e2e against a local vulnerable
# fixture server in CI. The staging-only safety contract has its own test.
testing_posture: runtime_primary
runtime_tests: e2e
frontend_tests: none

# Rollout model
rollout_model: commit_and_revert
feature_flags: none

# Architecture defaults
prefer_existing_primitives_over_new_ones: yes
accepted_primitives:
  # (first build — primitives land with v1 and get listed here as they stabilise)

# Conventions the spec-reviewer should reject suggestions against
convention_rejections:
  - "any flag, config, or override that lets the live scanner target a host not on the staging allowlist (violates the staging-only safety contract)"
  - "weakening benchmark exit conditions (recall < 100% on corpus, FP > 0 on clean fixtures) to make CI pass"
```

---

## When to update this file

Update this file (and re-review any in-flight specs) when:

- A feature hits its per-feature stabilisation threshold (4+ weeks unchanged). The feature moves from "rapid evolution" to "stable" and the testing posture for that feature changes. Example: if `auth flow` stabilises, add a line to the `accepted_primitives` section or create a `stable_features` list.
- The first real agency client is onboarded. `live_users: no` becomes `yes`. Rollout model stops being `commit_and_revert` and becomes something more cautious. Feature flags become legitimate. This is the biggest single context shift and triggers a review of every spec in `docs/`.
- A new test category is adopted. If you decide E2E tests against the app are now worth building, add them to the testing-posture section and update the `e2e_tests_of_own_app` line.
- A new primitive lands that should become a preferred extension point. Add it to `accepted_primitives`.
- A convention the spec-reviewer was rejecting becomes OK to use. Remove it from `convention_rejections`.

---

## How the spec-reviewer agent uses this file

The agent reads this file once at the start of every review run. It uses the framing statements to:

1. **Classify directional findings.** If Codex suggests "add a staged rollout", the agent compares against `staged_rollout: never_for_this_codebase_yet` and classifies it as directional (not a mechanical fix).
2. **Reject findings in `convention_rejections`.** If Codex suggests "add supertest for API contract tests", the agent checks `convention_rejections` and rejects the finding mechanically with a logged reason.
3. **Prefer existing primitives.** If Codex suggests "introduce a new retry service", the agent checks `accepted_primitives` and rejects the finding because `withBackoff` exists.
4. **Flag context mismatches before the loop starts.** If the spec under review says "staged rollout to 10% of traffic" but `staged_rollout: never_for_this_codebase_yet`, the agent pauses for HITL before running iteration 1.

If you want to override any of these defaults for a specific spec, write the override into the spec's own framing section (Implementation philosophy / Execution model / Headline findings). The agent treats explicit spec-level framing as a permitted override AS LONG AS the override is flagged in a HITL checkpoint first — the human must confirm that the override is intentional.

---

## Emergency override

If you are running the `spec-reviewer` agent in a context where `docs/spec-context.md` is intentionally stale (e.g. you're specifically reviewing a spec that defines a new context), invoke the agent with an explicit override path:

```
spec-reviewer: review docs/my-spec.md with spec-context=docs/my-new-context.md
```

The agent will read the override file instead of this one. The override file must be a markdown file with the same `yaml` block structure.

Emergency overrides are logged in the final review report so the audit trail shows which context file the review was run against.
