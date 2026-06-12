# Spec Review — Directional Signals

> Reference table extracted from `.claude/agents/spec-reviewer.md` Step 5. The agent reads this file during classification.

A finding is **directional** if ANY signal below matches. This list is hardcoded — if a finding matches any item here, it is directional REGARDLESS of how small the change seems or how obviously correct Codex's recommendation looks. You do not get to override this list based on your own judgment.

## Scope signals

- "Add this item to the roadmap"
- "Remove this item from the roadmap"
- "This should be Phase N" (where N differs from the current phase)
- "Defer this until later"
- "Bring this forward to an earlier phase"
- "Split this item into two"
- "Combine these two items into one"

## Sequencing signals

- "Ship this in a different sprint"
- "This blocks that" (introducing a new dependency edge)
- "Swap the order of these two items"
- "This should come after / before [other item]"

## Testing posture signals

- "Add more tests" beyond the pure-function + static-gate + 3-integration-test envelope
- "Add fewer tests" below the envelope
- "Introduce a test framework" (vitest, jest, playwright for the app itself, supertest, MSW, etc.)
- "Add composition tests for middleware"
- "Add performance baselines"
- "Add migration safety tests"
- "Add chaos / resilience tests beyond the existing round-trip"
- "Add adversarial security tests beyond what static gates catch"
- "Add frontend unit tests"
- "Add E2E tests of the audit-tool app"

## Rollout posture signals

- "Feature-flag this"
- "Stage the rollout"
- "Verify in staging between steps"
- "Add a canary deploy"
- "Add a kill switch"
- "Roll out one tenant at a time"

## Production-caution signals

- "Add monitoring for X" (production observability that isn't already there)
- "Add compliance reporting for Y"
- "Add retention / audit requirements beyond what the spec already has"
- "Add rate limiting to X" (where X is not already rate-limited)
- "Add circuit breaking to X"
- "Add multi-region / HA considerations"

## Architecture signals

- "Introduce a new abstraction / service / pattern"
- "This should be its own service"
- "This belongs in a different layer"
- "Split this service into two"
- "Merge these services"
- "Change the interface of X"
- "Deprecate primitive Y and replace with Z"

## Cross-cutting signals

- "This affects every item in the spec"
- "Add a new cross-cutting contract"
- "Change the Implementation philosophy section"
- "Change the Execution model section"
- "Change the verdict legend"
- "Add a new phase / sprint"

## Framing signals

- "The spec assumes pre-production but the reality is X"
- "The stage of the app is no longer rapid evolution"
- "The testing posture needs to change because [...]"
- Anything that would invalidate one of the baked-in framing assumptions at the top of `spec-reviewer.md`

If a finding matches any signal above, it is directional. Full stop. Apply the autonomous decision criteria in `spec-reviewer.md` Step 7 and move on to the next finding.

## When to update this file

Add a signal here when the spec-reviewer agent surfaces the same kind of "Codex thinks it's mechanical, but it's actually a scope/sequencing/posture call" finding more than twice. Each addition should match the existing voice (a verbatim or near-verbatim Codex finding shape).

Remove a signal when the underlying convention changes — e.g. if the project adopts feature flags as a standard pattern, remove the rollout-posture signals that auto-reject feature-flag suggestions.
