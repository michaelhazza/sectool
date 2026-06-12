# ADR-0005: Risk-class split rollout for read-vs-write enforcement gaps

**Status:** accepted
**Date:** 2026-04-27
**Domain:** rollout / enforcement
**Supersedes:** —
**Superseded by:** —

## Context

When a reviewer flags a "missing mechanical enforcement" finding (a query that bypasses the canonical isolation helper, a write path that doesn't go through the scope-resolved DB client, etc.), the finding often has BOTH a read side AND a write side. The cached-context isolation work surfaced this in PR #211 R2-2: every cached-context interaction had a read-leak risk (one tenant fetches another's cached data) and a write-leak risk (a write lands on the wrong tenant's cache row).

Shipping both sides together obscured the urgency gap between them. Read leakage is **exposure** — bounded per query, contained, eventually noticed. Write leakage is **corruption** — durable, compounds across reads, may not be caught until a customer complains.

The spec-author's job also got harder: deciding the discriminator shape (`{ orgScoped: true }` flag vs structural type) and the failure mode (log vs throw) for one side affects the other when they're entangled.

## Decision

When an enforcement gap has both read and write surfaces, **split the rollout by risk class**:

1. **Write side first, log-only.** Ship a logging helper at every write boundary (e.g. `logCachedContextWrite({ table, operation, organisationId, subaccountId, hasSubaccountId })`). Cheap to add, surfaces the higher-blast-radius surface in observability immediately. Promote log → hard assert under a follow-up spec, once the discriminator is defined and the call-site shape is known from the logs.

2. **Read side later, mechanical.** Ship the canonical helper (e.g. `assertSubaccountScopedRead(query, subaccountId)`) plus a grep-or-CI gate that catches new call sites. Lower urgency because exposure is bounded per query.

Each side carries its own decisions (failure mode, discriminator design, gate type) without entangling the other.

## When to apply

The reviewer's finding has a single mechanical-enforcement target (a helper, a guard, a gate) that protects both reads and writes? Ask:

- **Would each side need a different failure mode?** (log vs throw, soft vs hard assert)
- **Would each side need a different discriminator?** (e.g. write needs an `orgScoped: true` boolean; read can infer from the query shape alone)

If YES to either → split the rollout. Write side first, log-only; read side later, mechanical.

If NO to both → ship them together.

## Consequences

- **Positive:**
  - The high-blast-radius surface (writes) gets observability cover within hours, not weeks.
  - The spec author can decide the discriminator and failure mode for each side independently.
  - The follow-up "promote log → hard assert" path produces real call-site data before promotion.
  - Reviewers see a clear reason for the split in the spec — no need to re-litigate.
- **Negative:**
  - Two PRs and two specs instead of one. More overhead per rollout.
  - The "log-only" phase can drift if the follow-up promotion never lands. The deferred backlog must carry the promotion item.
- **Neutral:**
  - Adds a vocabulary the team needs to share: "this is a risk-class-split rollout, write side log-only, read side queued."

## Alternatives considered

- **Ship both sides together with full enforcement.** Rejected — couples discriminator decisions, slows the high-urgency write side waiting for the read side to be designed.
- **Ship both sides together with logging only.** Rejected — leaves writes unprotected for too long; logs aren't enforcement.
- **Read side first, writes later.** Rejected — read leakage is bounded exposure; write leakage is durable corruption. Urgency points the other way.

## When to revisit

- If a future enforcement gap emerges that has read AND write sides but the urgency / blast-radius gap is reversed (writes contained, reads catastrophic), re-evaluate the order.
- If the "log-only → hard-assert" promotion path consistently fails to land (logs accumulate forever without promotion), the pattern is incomplete — needs a default time-bound on the log phase or a backlog-pressure trigger.

## References

- KNOWLEDGE.md entry: `### [2026-04-27] Decision — Risk-class split for cached-context isolation rollout (read-leak vs write-leak)`
- PR #211 R2-2 — original F2 finding split into F2a (read, deferred) and F2b (write, partial-shipped)
- Implementation: `server/lib/cachedContextWriteScope.ts`
- Follow-up: `tasks/todo.md § CHATGPT-PR211-F2b`
