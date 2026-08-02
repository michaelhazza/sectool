---
name: deprecation
description: Use when sunsetting, retiring, or removing a system, feature, API, service, or capability this codebase OWNS — deciding whether to deprecate, planning consumer migration, choosing advisory vs hard-deadline deprecation, or acting on unowned "zombie" code. Not for consuming someone else's deprecation (dependency-upgrades) or DB schema changes (postgres-migrations).
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## deprecation` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Deprecation (producer side)

Code is a liability: its value is the functionality, not the lines. With enough consumers, every observable behaviour becomes depended on (Hyrum's Law) — including bugs and timing quirks — so deprecation is active migration work, never an announcement. Plan removability at design time: "how would we remove this in 3 years?" is a design input.

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `deprecation-and-migration` at commit `98967c4` (MIT licensed); schema-migration content lives in the postgres-migrations skill, not here.

## The deprecation decision

Answer all five before deprecating anything:

1. Does it still provide unique value? Yes = maintain, stop here.
2. How many consumers depend on it? Quantify from usage data, not memory.
3. Does a replacement exist, proven in production? No = build the replacement first; never deprecate without an alternative.
4. What does migration cost each consumer? Trivially automatable = just do it; manual and high-effort = weigh against maintenance cost.
5. What does NOT deprecating cost? Security exposure, maintenance hours, the complexity tax on everyone working nearby.

## Advisory vs compulsory

- Default to advisory (warnings, docs, nudges; consumers move on their own timeline). Go compulsory (hard removal date) only when security risk or unsustainable maintenance justifies forcing it — and compulsory REQUIRES shipped migration tooling, a guide, and support, not just a deadline.
- The Churn Rule: the owner of the deprecated thing migrates its consumers — or ships backward-compatible updates needing no migration. Announce-and-abandon converts your maintenance debt into everyone else's migration debt.
- Advisory deprecations that sit for years with no migration progress are not deprecations, they are unowned risk — escalate to compulsory-with-tooling or rescind.

## Migration mechanics

- Strangler: run old and new in parallel, shift traffic incrementally (0% → canary → 100%), remove old at zero traffic.
- Adapter: keep the old interface, delegate to the new implementation underneath — consumers migrate on their schedule while the backend consolidates.
- Flag-switch: route consumers old→new per cohort via a flag; the flag carries an owner and expiry date like any other.
- Migrate consumers one at a time with per-consumer verification, never big-bang. Schema half (expand/backfill/dual-write/contract): postgres-migrations skill. Deletion mechanics (registry-driven "unused" false positives, tombstones, fail-closed retired backends): refactor-safely skill.

## Removal protocol

- Verify ZERO active usage from telemetry/logs/dependency analysis before deleting — "I grepped the monorepo" misses external and dynamic consumers; absence of traffic over a full business cycle is the evidence.
- Remove the code, its tests, its docs, its config, AND the deprecation notices in the same change — a surviving notice for a removed system misleads every future reader.

## Zombie code

- Trigger: no commits in ~6 months + active consumers + no owner. Limbo is forbidden — assign an owner and maintain it, or deprecate it with a concrete migration plan. There is no third state.
- New features landing on a deprecated system are a red flag: that investment belongs in the replacement.

Agent/skill/doc retirement in this framework follows the same discipline: never delete — move to `_retired/` with a `superseded_by` pointer, rename the file to `<name>.md.retired`, and sweep callers (see CONTRIBUTING § Retiring an agent). The extension rename is load-bearing, not cosmetic: Claude Code registers `.claude/agents/**` recursively, so a retired agent left as `.md` inside `_retired/` stays live in the session router despite its banner (found and fixed for reality-checker, 2026-07-16).
