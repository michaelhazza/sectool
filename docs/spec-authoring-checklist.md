# Spec Authoring Checklist

This file is the **pre-authoring checklist** for any non-trivial spec in this repo. It exists because `spec-reviewer` kept catching the same eight categories of problem across 15+ different specs — all of which are cheaper to prevent at authoring time than to fix in a review iteration.

Use it when drafting any **Significant** or **Major** spec (per the task classification in `CLAUDE.md`). It is *not* required for trivial doc updates, ADRs, or single-page clarifications.

> **What this checklist is not.** It is not a replacement for the rules in `architecture.md`, `CLAUDE.md`, or `docs/spec-context.md`. It is a pre-flight checklist that *points at* those rules so the author applies them while writing. When in doubt, the deep references win.
>
> **What this checklist is.** It is the minimum set of authoring decisions that, if missed, force `spec-reviewer` to catch them post-hoc. Every item below has been caught by the reviewer in a production spec.

---

## Table of contents

0. Verify present state (before you write)
1. Existing primitives search (before you write)
2. File inventory lock
3. Contracts section (mandatory)
4. Permissions / RLS checklist
5. Execution model (sync/async, inline/queued, cached/dynamic)
6. Phase sequencing (dependency graph)
7. Deferred items section (mandatory, even if empty)
8. Self-consistency pass (last step before review)
9. Testing posture sanity check
10. Execution-safety contracts (new writes and state machines)
11. Spec frontmatter (status header convention)
12. Lifecycle Declaration and ABCd Estimate blocks (Standard+ only)
13. Mobile capability section (mandatory if spec touches UI)

Appendix — Pre-review checklist summary

---

## Section 0 — Verify present state (before you write)

Before authoring any spec that draws from deferred items in `tasks/todo.md` (or from a prior mini-spec), run a present-state verification pass on each cited item. **Do not assume the deferred item is still open.**

### Why this matters

Surrounding work routinely closes deferred items between mini-spec authoring and spec drafting. A mini-spec claimed 60 open gaps; verification found 2 — surrounding work had already closed the other 58. Without the verification step the spec would have re-litigated 58 already-fixed items, consuming review cycles and producing invalid scope.

### The verification pass

For each cited deferred item:

1. Does the file / migration / column / function the item references still exist?
2. Is the gap still present, or has surrounding work closed it?
3. Record one of:
   - `verified open: <evidence>` — the gap exists in the current codebase
   - `verified closed by <commit-sha or migration number>` — the gap is gone

Record the findings in a verification log (e.g. `tasks/builds/<slug>/verification-log.md`) so the spec reviewer has evidence, not assertions.

### When to apply

Any spec that begins with "address items from `tasks/todo.md`" or "implement deferred work from mini-spec X." Not needed for greenfield specs that introduce genuinely new behaviour with no prior deferred items.

### Reviewer signal this prevents

"This spec re-specifies items already closed by migration N" — caught at the start of the pre-launch hardening sprint Chunk 1 verification pass. The larger the gap between mini-spec authoring and spec drafting, the higher the risk.

---

## Section 1 — Existing primitives search (before you write)

Before you propose a new table, endpoint, service, or pattern, search the codebase for the closest existing primitive. If one exists, either:

- **Reuse it**, and state that explicitly in the spec, or
- **Extend it** (new column, new arg, new variant), and state why a new primitive would have been wrong, or
- **Invent a new primitive**, and state in one paragraph *why reuse and extension were both insufficient*.

The "invent new" path is the expensive one. Choosing it without justification is the single most common directional finding in the review corpus.

### Searches to run

| Proposing… | Grep | Then check |
|---|---|---|
| A new table | `your project's schema layer` for similar columns or naming | `your project's tenant-isolation manifest` to see how neighbouring tables are scoped |
| A new route | `your project's route handlers` for similar list/get/update shapes | existing permission guards on neighbouring routes |
| A new service | `your project's services` for similar responsibilities | whether an existing `*ServicePure.ts` already exports the logic |
| A new job | `your project's job workers` | whether an existing job can take a new payload variant |
| A new skill | `server/skills/**/*.md` + `your project's action registry` | whether the skill is a thin variant of an existing one |
| A new prompt partition or cache tier | the prompt assembly in `your project's prompt-assembly service` | which partition the new content genuinely belongs in |
| A new feature flag | `docs/spec-context.md` (`feature_flags: only_for_behaviour_modes`) | whether this is a *behaviour mode* (shadow vs active, dev vs prod) or a rollout gate (the latter is directional and almost always wrong here) |

If the spec does introduce a feature flag, name the flag's **owner** and its **cleanup/expiry date** in the spec at creation. A flag without an expiry becomes permanent debt — nobody owns removing it, and every future reader pays the branching cost.

### Reference

- `docs/spec-context.md` → `accepted_primitives` block. Any primitive listed there is the preferred extension point for its category.
- `architecture.md` → "Key files per domain" table. Start-here file for every common task.

### Reviewer signal this prevents

"You invented a new X, but the codebase already has a similar X — should you reuse it or are these genuinely different?" — a recurring directional finding across multiple specs.

> Origin-project examples: ClientPulse-GHL, session-1-foundation, skill-analyzer-v2.

### Section 1.1 — Primitive↔target cross-check (when locking helpers and consumers in the same spec)

For any spec that locks a set of helper primitives AND names the target consumers (gates, scripts, services) that will be built on them in the same spec, include a primitive↔target cross-check table showing that every named consumer's logic is expressible via the locked primitives.

**Why this matters.** A real failure: a spec locked four AST-query primitives and named ~33 migration targets in the same chunk. Implementation then found 34 targets whose detection logic the four primitives could not express (call expressions, property accesses, variable declarations, catch clauses, multi-file import graphs). The cross-check table would have surfaced the mismatch at spec-review time, not at chunk-implementation time.

**Format.** Two-column table: primitive → the target consumers that depend on it. Every named target must appear under at least one primitive. Targets that cannot be expressed via the locked primitives are blockers — either add the missing primitive to the spec or remove the target from scope.

> Origin-project example: gates-speedup-cluster (v5).

---

## Section 2 — File inventory lock

Every non-trivial spec has a "Files to change" table (usually `§3`, `§4`, or `§11` depending on the spec's template). This table is the **single source of truth** for what the spec touches.

### The rule

Every time you add a prose reference to a new file, column, migration, table, service, or endpoint, **cascade the reference into the inventory in the same edit**. No exceptions, even for "minor" additions — that's the path by which inventory drift gets introduced.

### Consistency pass (before sending to reviewer)

Grep your draft for the following phrases and verify each occurrence is reflected in the file inventory:

- `new table` / `new column` / `new migration`
- `new service` / `new endpoint` / `new route`
- `new job` / `new skill`
- `new hook` / `new middleware`
- `new partition` / `new cache tier`

If any prose reference is missing from the inventory, the reviewer will raise a `file-inventory-drift` finding.

### Reviewer signal this prevents

"File X is referenced in §5 but not in the Files-to-change table" — caught across multiple specs (migration numbers especially).

> Origin-project examples: agent-intelligence, canonical-data-platform, improvements-roadmap, memory-and-briefings, onboarding-playbooks.

---

## Section 3 — Contracts section (mandatory)

For every data shape that crosses a service boundary or is consumed by a parser, write a **Contracts** subsection. Do not describe the behaviour in prose without pinning the shape.

### Required fields per contract

- **Name** (e.g. `GEO_SCORE_PAYLOAD`, `agentProposals`, `ConfigQuestion`)
- **Type** (JSON / Drizzle enum / JSONB column / TypeScript union / Postgres composite)
- **Example instance** (one concrete, valid example — not pseudocode)
- **Nullability and defaults** (which fields can be null, what the default is when absent)
- **Producer** (which service/handler/job writes this)
- **Consumer** (which service/parser/UI reads this)

### Why the example matters

A contract without a worked example is ambiguous at the boundary the parser cares about. Example: "score is a number between 0 and 100" does not say whether missing dimensions produce `null`, `0`, or a skipped key — and the parser has to make a choice either way. Pin it in the spec, not in the implementation.

### Source-of-truth precedence (mandatory when multiple representations exist)

If the spec introduces behaviour where the same fact is represented in more than one place (execution record, step status, JSONB artefact, audit log, in-memory state), declare the source-of-truth precedence explicitly:

- Which representation wins when two representations disagree?
- What is the correct read path? (e.g. "execution record > artefact JSONB > log entry")

Add this as a named subsection in the spec's Contracts block, not as a prose aside. If the precedence is implicit, the implementation will make inconsistent choices and the inconsistency is invisible until it manifests as a concurrency bug under load.

### Reviewer signal this prevents

"X is processed by Y but the payload shape is never defined" — a recurring finding across multiple specs.

"Multiple representations of the same fact, no declared winner" — caught during cross-spec consistency sweeps (e.g. Phase 5/6 alignment on execution record vs artefact precedence).

> Origin-project examples: geo-seo, skill-analyzer-v2, improvements-roadmap, robust-scraping, memory-and-briefings.

---

## Section 4 — Permissions / RLS checklist

Every new tenant-scoped table (anything with `organisation_id` or `subaccount_id`) must have all four of the following. If any is absent, document *why* inline in the spec — do not leave it implicit.

### The four requirements

1. **RLS policy** in the same migration that creates the table. See your project's architecture documentation on tenant isolation for the three-layer model and the exact policy shape (record the section reference in `docs/spec-context.md` so reviewers can follow it).
2. **Entry in your project's tenant-isolation manifest** — the registry file your tenant-isolation CI gates enforce coverage from, if your project has one. Missing entry = CI gate failure.
3. **Route-level or middleware guard** if the table is accessed via HTTP. Name the guard in the spec (e.g. `authenticate`, `requirePermission(key)`, your tenant-resolution guard, or a new guard with a named location).
4. **Principal-scoped context** if the table is read from an agent execution path. See your project's architecture documentation on principal-scoped reads, if applicable.

### Canonical RLS-posture sentence

State the posture explicitly in the spec, using this exact phrasing: **"RLS enforces the organisation boundary; subaccount filtering is service-layer."** If the table actually uses dual-GUC (RLS checks both `app.organisation_id` and `app.subaccount_id`), say so and link to architecture.md's "Dual-GUC pattern". Prose that claims tables are "scoped to (org, subaccount)" without a `app.subaccount_id` GUC reference is a blocking spec review finding — reviewers cannot tell whether RLS or the service layer is doing the work.

### Opt-out rule

If a new table is intentionally *not* tenant-scoped (e.g. system-wide reference data), write one line explaining why. The reviewer's rubric correctly flags "missing RLS on org-scoped table" and won't be satisfied by implicit reasoning.

### Reviewer signal this prevents

"RLS claimed needed but migration doesn't include policies" / "Endpoint unguarded" / "Access control stated in Goals but not enforced in routes or migrations" — a recurring blocking finding across multiple specs.

> Origin-project examples: ClientPulse, config-agent-guidelines, canonical-data-platform, memory-and-briefings.

---

## Section 5 — Execution model (sync/async, inline/queued, cached/dynamic)

If your spec introduces behaviour that crosses a transactional or latency boundary, pick one execution model *explicitly* and keep the rest of the spec consistent with it.

### The three choices

- **Inline / synchronous** — caller blocks on the operation. Use when the result must be available before the caller returns. Example: prompt assembly during an agent run. Do NOT add a job row in your project's queue technology (pg-boss, BullMQ, Sidekiq, Celery, or whatever your stack uses) for inline operations.
- **Queued / asynchronous** — a durable job in your project's queue technology; survives restarts, retryable. Use when the operation is decoupled from the caller. Do NOT describe this as "the service does X" in prose — a job processor does X, and the spec should say so.
- **Cached / prompt-partition** — for LLM prompt sections that stay constant for a full request lifecycle. If you claim "stable prefix", the partition table and the assembly code must both agree. A prompt partition in `dynamic suffix` with a stated goal of 40–60% cache efficiency is a self-contradicting spec.

### Consistency pass

After writing the execution-model decision, check:

1. Does the job idempotency table include a row for this operation? (Queued only.)
2. Does the route/service prose describe a *synchronous call* or an *enqueue*? Match that to the model above.
3. Does any non-functional goal (cache efficiency, latency budget) contradict the model?

### Reviewer signal this prevents

"Bulk dispatch marked inline but job row exists" / "Briefing in dynamic suffix vs 40-60% cache efficiency" / "Sync postCall vs async job row" — caught across multiple specs.

> Origin-project examples: agent-intelligence, improvements-roadmap.

---

## Section 6 — Phase sequencing (dependency graph)

If your spec has phases, do one explicit pass over the dependency graph *before* sending to review.

### The three failure modes

1. **Backward dependency.** Phase N references a column/table/service that's created in Phase N+k. Fix: move the prerequisite earlier, or move the dependent later, or merge phases.
2. **Orphaned deferral.** A section says "X is deferred to Phase N+1" but Phase N+1 doesn't list X. Either add it to Phase N+1 or move it to the Deferred Items section (see Section 7).
3. **Phase-boundary contradiction.** A phase claims "no migrations" but is assigned a table-creation migration. Usually means the item's phase was changed in one section but not the other.

### How to check

For each phase, list (inline in a scratch note, not in the spec):

- Schema changes introduced: <migration numbers>
- Services introduced: <names>
- Services modified: <names>
- Jobs introduced: <names>
- Columns referenced by code: <column names>

Then for every "referenced by code" column, confirm it's in an equal-or-earlier phase's "schema changes introduced" line.

### Reviewer signal this prevents

"Phase N depends on column X but X ships in Phase N+k" — caught across multiple multi-phase specs.

> Origin-project examples: agent-intelligence, canonical-data-platform, improvements-roadmap, memory-and-briefings.

---

## Section 7 — Deferred items section (mandatory, even if empty)

Every spec has an explicit `## Deferred Items` section listing features/migrations/criteria mentioned in prose but intentionally deferred.

### The rule

Any time prose in the spec uses the words "deferred", "later", "Phase N+1 will", "not in this phase", "future", or "nice to have", the thing being deferred must appear in the Deferred Items section. The section is the single source of truth — prose mentions without a corresponding Deferred entry are treated as in-scope deliverables by readers.

### Format

```markdown
## Deferred Items

- **Name of deferred feature.** Phase N will ship [the small thing]. Phase N+1 will ship [the larger thing]. Reason: <one line>.
- **Another deferred feature.** <same shape>.
```

Empty is fine — if nothing is deferred, write "None." rather than omitting the section, so future readers know the author considered deferrals.

### Reviewer signal this prevents

"S14 described as standalone in §5.10 but marked deferred in Q6" / "Deferred items scattered through prose and inferred rather than listed" — caught across multiple specs.

> Origin-project examples: memory-and-briefings, geo-seo.

---

## Section 8 — Self-consistency pass (last step before review)

After completing Sections 1–7, do one final read-through focused on contradictions between sections. This is the cheapest pass to run and the highest-value pass to skip.

### Questions to answer

- Do the **Goals / Philosophy** sections match the **Implementation** sections? (The #1 directional finding — 35% of specs.)
- Does every phase item have an explicit verdict (BUILD IN PHASE N, DEFER, WON'T DO)?
- Does every "single source of truth" claim survive? Grep for the claimed source — is it actually written to by every path the spec describes? Is it filtered out anywhere?
- Do non-functional claims (cache efficiency, latency budgets, cost budgets) match the execution model in Section 5?
- Does every phrase using "must", "guarantees", "idempotent", "source of truth" have a backing mechanism named? Load-bearing claims without a mechanism are the most expensive finding class to fix in review.
- Does the spec carry a numbered **ASSUMPTIONS** block stating "correct now or these stand"? Enumerating the assumptions the spec rests on lets the reviewer and operator falsify them at review time instead of mid-build.
- Where operator judgment is load-bearing, does the spec carry a **Boundaries** tier — Always do / Ask first / Never do? The ask-first tier is the operator-approval surface; without it every ambiguous call defaults to silent implementer judgment.

### Numeric-count reconciliation pass

Before handoff, grep the draft for inventory counts and reconcile every occurrence against the file-inventory table. Counts of "N tables / N migrations / N jobs / N files / N columns" routinely drift across sections — §14.4 says "four tables", §19.3 lists three, §19.4 says "five migrations" but one is a script.

Run:

```bash
grep -Ei "\b(one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+)\b[[:space:]]+(table|tables|migration|migrations|job|jobs|file|files|column|columns|endpoint|endpoints|service|services|route|routes|section|sections|phase|phases|chunk|chunks)\b" <spec.md>
```

Every hit must reconcile to the same number in the file inventory. Mismatched counts are the dominant spec review finding in sandbox-isolation and consolidation reviews.

### Reviewer signal this prevents

"Goals say X but Implementation does Y" / "Load-bearing claim without enforcement" — caught across multiple specs, often more than once per spec.

> Origin-project examples: agent-intelligence, ClientPulse, geo-seo, improvements-roadmap.

---

## Section 9 — Testing posture sanity check

Before adding any test plan to the spec, re-read the testing-related sections of `docs/spec-context.md`. The keys below mirror that file's Testing posture block; the values shown are one example fill — your repo's actual values live in `docs/spec-context.md`:

```yaml
testing_posture: static_gates_primary
runtime_tests: pure_function_only
frontend_tests: none
api_contract_tests: none_for_now
e2e_tests_of_own_app: none_for_now
performance_baselines: defer_until_production
composition_tests: defer_until_stabilisation
```

If your spec's test plan proposes anything in the `none_for_now` or `defer_until_*` categories, either:

- Remove the test plan item, or
- Acknowledge it as a framing deviation in the spec's own Implementation philosophy section (not silently). The reviewer will flag this as directional either way, but flagging it yourself shortens the review loop.

### Reviewer signal this prevents

"Spec proposes E2E/frontend/API-contract tests against framing" — caught across multiple specs.

> Origin-project examples: onboarding-playbooks, routines-response.

### Section 9.1 — Risk-register correctness axis (test-infrastructure specs)

For specs that propose changes to the test infrastructure itself — global test-runner hooks, global setup files, or harness-wide configuration — the risk register MUST list BOTH a performance risk AND a correctness risk. A spec carrying only one axis is incomplete; reviewers flag it.

Every risk row for a global hook needs two entries:

1. **Performance risk.** E.g. "adding a per-file module reset adds ~Xms per test file; at N files that is Y seconds of suite time."
2. **Correctness risk.** E.g. "the reset changes what state tests actually share, so tests that silently depended on leaked state may begin passing/failing for a different reason than they assert."

The correctness axis is the one first drafts omit: a harness change that makes the suite faster but changes *what the tests verify* is a regression dressed as an optimisation.

> Origin-project example: fix-brittle-ci-tests (Learning 4).

---

## Section 10 — Execution-safety contracts (new writes and state machines)

Before sending any spec for review that introduces new write paths, state machine transitions, or externally-triggered operations, verify each of the following is pinned in the spec. These are routinely missing from first-draft specs and are the root cause of the most expensive post-ship bugs.

### 10.1 Idempotency posture

For every externally-triggered write, state one of:

- `key-based` — a unique key (e.g. `(artefactId, decision)`) guarantees exactly-once with a DB unique constraint. Name the key and the index.
- `state-based` — the write is guarded by an optimistic predicate (`UPDATE ... WHERE status = 'expected_pre_state'`). Name the predicate.
- `non-idempotent (intentional)` — the operation is inherently non-idempotent; state why and what the caller's retry contract is.

Do not describe an operation as "idempotent" without naming which of the three applies. "We'll handle retries" is not an idempotency posture.

### 10.2 Retry classification

For every write or external call, declare one of: `safe` (unconditionally retryable), `guarded` (retryable with an idempotency key or optimistic predicate), or `unsafe` (caller bears retry risk). Any `unsafe` operation must be wrapped by a `safe` or `guarded` boundary before the caller can retry it. Name the boundary.

### 10.3 Concurrency guard for racing writes

If two concurrent callers can race to write the same terminal state (e.g. two approve requests for the same decision, two job instances for the same org), the spec must declare the concurrency guard:

- Optimistic predicate: `UPDATE ... WHERE status = 'review_required'` → 0 rows affected = conflict
- Unique constraint: DB-level (`UNIQUE (artefact_id, decision)`) + catch `23505` → defined HTTP status
- First-commit-wins: the 0-rows-updated path returns the winning decision to the losing caller

Name the guard, the DB mechanism, and the losing-caller response. "The DB will handle it" is not a guard.

### 10.4 Terminal event guarantee

Every cross-flow chain that emits events must declare:

- Exactly one terminal event (the event that marks the logical run complete)
- Post-terminal prohibition — no further events with the same correlation key after the terminal
- The terminal event's `status` field: `success | partial | failed`

If the chain has multiple success paths or multiple error paths, each path gets exactly one terminal event — they are mutually exclusive.

### 10.5 No-silent-partial-success

Every flow that can partially complete must emit an explicit `status: 'partial'` terminal event (not `status: 'success'` with a silent partial-failure). Name the conditions under which `partial` fires vs `failed`.

### 10.6 Unique-constraint-to-HTTP mapping

For every DB unique constraint the spec introduces, pin the HTTP status returned to the caller when the constraint is violated. Never let a `23505 unique_violation` bubble as a 500 — map it to a named status (409, 422, or 200-idempotent-hit) and document which one and why.

### 10.7 State machine closure (if the spec introduces or modifies a state machine)

If the spec introduces or modifies a state machine (step transitions, run aggregation, approval boundaries, status enums), include a State/Lifecycle subsection that pins:

- Valid transitions (and which transitions are forbidden)
- What execution record must exist before a terminal state is written
- Whether the status set is closed (adding a new status value requires a spec amendment)

A spec that describes behaviour without pinning valid transitions and forbidden transitions will have its state machine diverge from implementation within two feature cycles.

### 10.8 Post-write recheck for residual race after row-lock release

When an orchestrator flow is `DB-update-inside-FOR-UPDATE-transaction → external HTTP call` (e.g. write a row's hash inside a `FOR UPDATE` transaction, then push the corresponding secret to GitHub Actions, Stripe, an IdP, etc.), the row-lock **cannot** span the HTTP call — holding it across an external round-trip would starve the connection pool, so the transaction commits and releases the lock before the HTTP write begins. That opens a residual race window: a concurrent writer can rotate the row between the lock release and the HTTP completion, leaving the external system with a stale/wrong value while the local audit still records success.

Pin the recheck in the spec. After the HTTP write returns 2xx, **re-select the row's relevant hash/state and compare it to a snapshot captured inside the original transaction.** If drift is detected, mark the terminal audit `status: 'partial'` + a named flag (e.g. `staleSecretDetected: true`) and surface a typed `errorCode` in the response step. This makes the residual race observable rather than silent — the catch ("the audit lies") is worse than the failure ("the external write didn't happen"), because a lying audit leaves the operator with no signal to investigate.

State three things in the spec for any such flow:

- The snapshot taken inside the transaction (which column/hash is captured, and where).
- The recheck after the 2xx (the re-select + comparison).
- The drift outcome (terminal audit `status: 'partial'`, the named flag, and the typed `errorCode` returned to the caller).

### Reviewer signal this prevents

"No idempotency posture declared" / "What happens when two callers race here?" / "How does the caller know if this partially failed?" / "The DB-then-HTTP write has no post-write recheck — a concurrent rotation between lock release and HTTP completion is silently lost" — all caught in the pre-launch hardening pre-implementation hardening pass. These gaps are architectural, not stylistic — they produce correctness bugs at production load.

---

## Section 11 — Spec frontmatter (status header convention)

Every non-trivial spec opens with a small frontmatter block so future archive sweeps can identify shipped/superseded specs without re-reading them.

### The required fields

```markdown
**Status:** draft | reviewing | accepted | shipped | superseded by <path-or-ADR>
**Spec date:** YYYY-MM-DD
**Last updated:** YYYY-MM-DD
**Author:** <handle>
**Build slug:** <slug> (or `n/a` for ADR-shaped specs without a build slug)
```

Status values:

- `draft` — being written; not yet sent to `spec-reviewer`.
- `reviewing` — sent to `spec-reviewer` / `chatgpt-spec-review`; not yet final.
- `accepted` — approved for build; either in flight or queued.
- `shipped` — feature has merged to main; spec is historical reference.
- `superseded by <path-or-ADR>` — replaced by a later spec or ADR. Include the path or ADR number so readers can find the successor.

### Why this matters

The 2026-05-03 docs/ archive triage found 84 specs in `docs/` and only 4 with explicit retirement markers. Without a uniform `Status:` header, the operator can't run a reliable archive sweep — every candidate has to be read end-to-end to judge whether it's still authoritative. With the header, archive becomes a one-line grep: "show me every spec with `Status: shipped` older than 90 days" → operator confirms successor links → archive.

### Maintenance rule

Update `Last updated:` whenever you edit the spec. Update `Status:` when the spec moves through its lifecycle:
- Sent to spec-reviewer → `Status: reviewing`
- Spec-reviewer returns READY_FOR_BUILD and operator accepts → `Status: accepted`
- Feature merges to main → `Status: shipped` (sweeper-friendly)
- Replaced by a successor → `Status: superseded by <path>`

### Reviewer signal this prevents

"Spec at `docs/<old-spec>.md` is still cited from architecture.md but the feature it specs has shipped and the implementation has drifted." With a `Status: shipped` marker on the old spec, the doc-sync sweep at finalisation flags the architecture.md citation for redirect to the implementation file, not the spec.

### Backfill

Existing specs without this frontmatter are NOT required to be updated retroactively — that's a separate, opt-in pass. New specs from 2026-05-03 forward MUST carry the frontmatter.

---

## Section 12 — Lifecycle Declaration and ABCd Estimate blocks (Standard+ only)

Every Standard+ spec must include two governance blocks. **This section (12.1 and 12.2) is the authoritative definition of both blocks** — they are required at spec authoring time (Step 6 of `spec-coordinator`) and are verified by `spec-conformance` via this checklist.

### 12.1 Lifecycle Declaration block

**What it is:** a five-field Markdown table placed at the top of the spec, after frontmatter, that captures the capability cluster, ownership, launch lifecycle state, risk surface, and review cadence for the capability being shipped.

**When required:** every Standard, Significant, or Major spec. Not required for Trivial builds or ADR-shaped specs with `Build slug: n/a`.

**Required fields (all five must be present and non-blank):**

| Field | Rule |
|---|---|
| Capability cluster | One or more values from the cluster header in `docs/capabilities.md`, comma-separated when multiple |
| Capability owner | Handle, or a clearly-marked placeholder (e.g. `TBD — <role>`) |
| Lifecycle state on launch | `Inception` or `Growth` only — no other value is valid at first registration |
| Risk surface | Copied verbatim from `intent.md § Risk Surface`; either the literal string `None.` or a comma-separated list of terms from the Risk Surface canonical vocabulary (spec-coordinator Step 3) |
| Review cadence | Free text, e.g. `quarterly`, `biannually`, `on-incident-only` |

**Launch-state restriction:** only `Inception` (no production traffic yet) or `Growth` (live but actively iterating) are valid at first registration. Any other state is a blocking spec review finding.

### 12.2 ABCd Estimate block

**What it is:** a four-row Markdown table placed inside the spec body that sizes the capability across four lifecycle cost dimensions using a coarse S / M / L bucket.

**When required:** every Standard, Significant, or Major spec (same scope as the Lifecycle Declaration block).

**Required dimensions (all four must be present):**

| Dimension | Meaning |
|---|---|
| Acquire | Cost to acquire or license an equivalent capability externally |
| Build | Engineering effort to build this capability from scratch |
| Carry | Ongoing maintenance and operations cost |
| decommission | Cost to turn off and fully remove the capability |

**Sizing constraint:** the `Sizing` column must be exactly one of `S`, `M`, or `L`. Numeric estimates are prohibited (false-precision class). No half-buckets, no ranges, no dollar figures.

### Reviewer signal this prevents

"Spec missing Lifecycle Declaration" / "ABCd block absent or uses numeric estimates" — caught by `spec-conformance` reading this checklist's Appendix. Adding these two blocks at authoring time (Step 6 of `spec-coordinator`) is cheaper than a blocking spec-conformance gap at Phase 2 review.

---

## Section 13 — Mobile capability section (mandatory if spec touches UI)

Every spec that introduces a new screen, modifies an existing screen, adds a new component, or changes navigation must include a **Mobile capability** subsection. Mobile is a peer to desktop in this framework, not an afterthought. See [`docs/mobile-capability-principles.md`](./mobile-capability-principles.md) for the full rule set.

### When required

- Any spec that adds, modifies, or removes a route.
- Any spec that adds or modifies a component, page, modal, drawer, table, form, or navigation surface.
- Any spec that changes how the user interacts with the UI (new actions, new flows, new states).

### When NOT required (and why state it)

- Pure backend specs with no UI surface (e.g. a new background job, a new internal service). State `Mobile capability: N/A — pure backend, no UI surface` in the spec to make the absence intentional. An unstated absence is a 🟡 finding from `spec-reviewer`.

### Required fields

For each new or modified screen / component / surface:

1. **Mobile tier** (per `mobile-capability-principles.md § Mobile capability tiers`). One of `Tier 1` (primary user journey, native-feeling), `Tier 2` (admin/operator, fully usable), `Tier 3` (rare/edge, acceptable fallback).
2. **Mobile shape decision.** How does the screen render at 375px? Pick one: `responsive (same component, breakpoint-driven)` / `divergent (separate mobile and desktop components)` / `desktop-only with justification (rare; explain)`.
3. **Navigation impact.** Does this spec touch navigation? If yes: how does the new destination surface in the mobile shell (bottom-tab, More sheet, hamburger, full-screen flow)?
4. **Table treatment** (only if the screen contains a table with more than 4 columns). Pick one: `card layout below md` / `sticky-first-column horizontal scroll inside the table region` / `column hiding at narrow widths`.
5. **Modal / drawer treatment** (only if the spec adds a modal or drawer). Pick one: `bottom sheet on mobile` / `full-screen on mobile` / `responsive width (no fixed pixel width over 375px)`.
6. **Hover-only interactions.** Confirm `none` or list each one and its tap equivalent.
7. **Form treatment** (only if the spec adds a form). Confirm reflow to single column below md. Confirm keyboard-open behaviour (inputs scroll into view, submit reachable).
8. **Touch target audit.** Confirm primary action buttons are at least 44px on touch viewports. Identify any icon-only buttons and confirm padding or label.

### Example format

```markdown
## Mobile capability

### Screen: New "Bulk Approve" panel (extending /admin/inbox)

- **Mobile tier:** Tier 2 (admin workflow, fully usable, not native-polished).
- **Mobile shape:** Responsive. Two-column desktop layout reflows to single column below md.
- **Navigation impact:** None. Surfaces inside an existing route.
- **Table treatment:** Card layout below md. Each row becomes a card with checkbox + identifier + state pill + tap-anywhere action.
- **Modal treatment:** Bulk-approve confirmation is a bottom sheet on mobile, centred modal at >=768px.
- **Hover-only:** None.
- **Form treatment:** N/A (no form on this screen).
- **Touch targets:** Bulk-action primary button at 48px. Row checkboxes at 24px visual size with 44px tap region.
```

### Reviewer signal this prevents

"Spec adds a table but doesn't say how it renders on mobile" / "New modal width is 520px with no mobile treatment" / "Hover-only row actions added with no tap equivalent" — these are routinely caught by `mockup-reviewer` at the prototype stage, but catching them at spec authoring is significantly cheaper. The mockup loop should not be the first time mobile is considered.

---

## Appendix — Pre-review checklist summary

Before invoking `spec-reviewer` on a draft spec, answer yes to all of the following:

- [ ] **[Section 0]** Every cited deferred item verified as still open (or annotated as `verified closed by <commit>`)
- [ ] Every new primitive has a "why not reuse" paragraph
- [ ] **[Section 1]** Every new feature flag names its owner and cleanup/expiry date
- [ ] Every new file / column / migration / endpoint is in the file inventory
- [ ] Every data shape crossing a boundary has a Contracts entry with an example
- [ ] Every contract that writes to multiple representations declares the source-of-truth precedence
- [ ] Every new tenant-scoped table has RLS policy + manifest entry + route guard + principal-scoped context (or a documented reason for opting out)
- [ ] RLS posture stated using the canonical sentence ("RLS enforces the organisation boundary; subaccount filtering is service-layer"), or dual-GUC explicitly declared with the exact GUCs (`app.organisation_id`, `app.subaccount_id`), policy expectation, and transaction helper (`your project's GUC-setting transaction helper`) named
- [ ] Execution model (sync/async, inline/queued, cached/dynamic) is picked explicitly and the prose + inventory + goals all agree
- [ ] Phase dependency graph has no backward references, no orphaned deferrals, no phase-boundary contradictions
- [ ] `## Deferred Items` section exists (even if "None.")
- [ ] Self-consistency pass complete: Goals ↔ Implementation match; every load-bearing claim has a named mechanism
- [ ] **[Section 8]** Numbered ASSUMPTIONS block present ("correct now or these stand"); Boundaries tier (Always do / Ask first / Never do) present where operator judgment is load-bearing
- [ ] Numeric-count reconciliation grep run; every count of tables / migrations / jobs / files matches the file inventory
- [ ] Testing plan consistent with `docs/spec-context.md`
- [ ] **[Section 10]** Every externally-triggered write has an idempotency posture, retry classification, and concurrency guard declared
- [ ] **[Section 10]** Every cross-flow chain has a declared terminal event + post-terminal prohibition
- [ ] **[Section 10]** Every DB unique constraint has a named HTTP mapping (no bubbled 500s from `23505`)
- [ ] **[Section 10]** If a state machine is introduced or modified: valid transitions, forbidden transitions, and status-set closure are declared
- [ ] **[Section 10]** Every `DB-update-in-transaction → external HTTP call` flow declares a post-write recheck (snapshot inside the tx, re-select after 2xx, `status: 'partial'` + typed errorCode on drift)
- [ ] **[Section 11]** Spec opens with `Status:` / `Spec date:` / `Last updated:` / `Author:` / `Build slug:` frontmatter
- [ ] **[Section 12]** Lifecycle Declaration present (5 required fields; launch state = `Inception` or `Growth` only)
- [ ] **[Section 12]** ABCd Estimate present with S/M/L sizing only (4 dimensions; no numeric values)
- [ ] **[Section 13]** If spec touches UI: Mobile capability subsection present, one entry per new or modified screen, with tier + shape + nav + table + modal + hover + form + touch fields completed. If spec is pure backend: explicit `Mobile capability: N/A — pure backend, no UI surface` line

If every box is checked, the spec is ready for `spec-reviewer`. If any box is unchecked and you're intentionally leaving it so (e.g. deferring the contract to implementation), mark the deviation inline in the spec's framing section — don't leave it implicit.

---

## Maintenance

This checklist is built from patterns observed in `tasks/spec-review-checkpoint-*.md` across 15+ specs. When a new recurring pattern emerges across three or more specs, extend this checklist with a new section that points at the reviewer signal and the existing deep reference.

When a section of this checklist stops catching recurrent findings (i.e. the reviewer no longer raises that signal for specs authored against this checklist), leave the section in place — it is working. Do not remove "working" sections; only remove sections that turn out to be noisy or wrong.

---

## Project-specific notes

Consuming projects can add project-specific guidance for this file between the markers below. Sync.js preserves anything you put between the markers when the framework is updated. Do NOT edit outside the markers — those changes get a .framework-new diff on the next sync.

<!-- LOCAL-OVERRIDE:start name="project-notes" -->
<!-- LOCAL-OVERRIDE:end name="project-notes" -->
