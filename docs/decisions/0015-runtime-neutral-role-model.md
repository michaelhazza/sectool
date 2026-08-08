# ADR-0015: Runtime-neutral role model with identity-scoped merge authority

**Status:** accepted
**Date:** 2026-08-03
**Domain:** framework / governance
**Supersedes:** _n/a_
**Superseded by:** _n/a_

## Context

The framework was Claude-oriented: orchestration contracts assumed Claude primitives and agent locations. Admitting other runtimes (OpenClaw as a Builder, Codex as a reviewer) through a second parallel workflow would fork the lifecycle — duplicate specs, divergent status meanings, inconsistent review gates, unclear merge authority. The `framework-runtime-neutral-v3` build (spec at the initiative's build record; ships in framework `2.62.0`) resolves how to add worker runtimes without duplicating the lifecycle or weakening GitHub controls. Two adversarial review rounds narrowed the merge-authority question specifically, because a builder identity that can reach `MERGED` on prompt-based restrictions alone is not a control.

## Decision

We adopt a runtime-neutral **role** model layered over one canonical lifecycle, with four durable rules:

1. **Roles are runtime-neutral; Claude remains the v3 coordinating runtime.** Roles are `Coordinator, Architect, Builder, Reviewer, Test Author, Finaliser`. Claude Code performs all of them; OpenClaw is a **sequential Builder only** in the pilot; Codex keeps its review integration. The canonical role→runtime mapping lives in `references/runtime-roles.md` (FR-1: hardcoded for the pilot, a full registry deferred). A role describes responsibility; a runtime describes who performs it. No runtime may approve its own implementation.

2. **Merge authority is identity-scoped and GitHub-enforced — not prompt-enforced.** Claude operating on the operator's administrator credential keeps the deployed `finalisation-coordinator` / `bug-fixer` merge flows unchanged. The dedicated OpenClaw builder identity has branch-write + PR rights, **no admin, no ruleset bypass**, and **stops at `MERGE_READY`**. The guarantee — *no PR becomes mergeable by OpenClaw without the operator's prior code-owner approval, whether the PR was authored by OpenClaw or Claude* — is enforced by a default-branch ruleset (`require PR + one code-owner review after latest push, restrict deletion, block force-push, empty bypass_actors`) plus a CODEOWNERS file assigning all paths to the operator. An approval from any agent identity never satisfies the code-owner requirement. Consumers must prove this per-repo with the live rejection test (`scripts/pilot/rejection-test.sh`) before enabling OpenClaw.

3. **Schema evolution is additive-only.** Runtime/role identity is added as **optional** fields on `build-status.v2` (top-level `runtime` object + per-`log[]` `runtime`/`role` stamp); `contract_version` is unchanged — no `build-status.v3`, nothing to migrate. Work/completion packet schemas (`work-packet.v1`, `completion-packet.v1`) **formalise existing** dispatch-prompt and builder-verdict shapes rather than inventing a new contract (spec §6A prohibits re-implementing a capability under a runtime-neutral name).

4. **Deterministic gates over LLM judgement.** Status transitions (writer-side `transition-validator.mjs`), tests, and branch protection are enforced by code or GitHub, never by model judgement.

## Consequences

- **Positive:**
  - One canonical build record, status schema, review pipeline and GitHub Project per feature — no per-runtime fork.
  - The most safety-critical boundary (an agent reaching production) is a technical control, provable per-consumer, not a behavioural promise.
  - Additive/compatible: existing consumers keep running in Claude-only mode; every existing `build-status.v2` record stays valid.
- **Negative:**
  - OpenClaw is limited to a sequential Builder in the pilot; Reviewer/Coordinator/Finaliser roles, mixed-runtime parallel waves, and the Tank adapter are deferred.
  - Each consumer must configure the builder identity + ruleset + CODEOWNERS and pass the live rejection test before OpenClaw can build there — real setup cost, deliberately not automated away.
- **Neutral:**
  - A full machine-readable role registry, Actions/webhook `MERGED` projection, and the OpenClaw CLI adapter itself (B2) + coordinator dispatch wiring (B3) are deferred to follow-up runs; the transition validator ships as a module before it is wired into a status-write site.

## Alternatives considered

- **A second parallel workflow for OpenClaw/Tank** — rejected: duplicates specs, build records, status semantics and review gates; the exact divergence this ADR exists to prevent.
- **`build-status.v3` for runtime identity** — rejected under spec §11: nothing here is incompatible; a required field or version bump would invalidate every existing record on sync.
- **Prompt-based merge restriction for OpenClaw** — rejected: not enforceable. A builder told "do not merge" that technically can merge is not a control; GitHub ruleset + CODEOWNERS is.
- **A generic multi-runtime dispatch bus** — rejected for the pilot: the OpenClaw adapter follows the proven Codex CLI-wrapper pattern (bounded, versioned, fail-closed), not a standalone orchestration system.
