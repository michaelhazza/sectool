# Decisions (ADRs)

Architecture Decision Records — the "why" behind durable choices.

## Why this is separate from KNOWLEDGE.md

`KNOWLEDGE.md` is an append-only stream of patterns, gotchas, and corrections. Most entries are observations: "this trips up a future session, here's the trap." That's useful but not the same as an architectural decision with rationale and trade-offs.

This directory captures the durable decisions: "we chose X over Y, here's why, here's what we'd reconsider if Z." Future sessions retrieve them by domain, not by date.

Lightweight ADR format inspired by Nygard's original. Each ADR is one file, dated, immutable once accepted.

## Convention

- File naming: `NNNN-<short-slug>.md` where `NNNN` is sequential (`0001-`, `0002-`, ...) and `<short-slug>` is kebab-case. Pad to 4 digits.
- Status: `proposed` → `accepted` → `superseded by NNNN`. Once accepted, the file is immutable. Superseding is via a new ADR that points back.
- One decision per ADR. If a decision needs to be reconsidered, write a new ADR — do not edit the existing one.
- Keep them short. ≤300 lines. If it's longer, the decision belongs in a spec or in `architecture.md` and the ADR points there.

## Template

See [`_template.md`](./_template.md). Copy it for each new ADR.

## When to write an ADR vs a KNOWLEDGE entry

| Write an ADR | Write a KNOWLEDGE entry |
|---|---|
| Choosing between architectural options | Discovering a non-obvious codebase pattern |
| Locking in a contract or invariant the system depends on | Finding a gotcha that traps future sessions |
| Adopting / rejecting a primitive, library, or service | A user correction (always KNOWLEDGE) |
| Setting a policy (rate-limit, retention, security) | A learned convention you'd otherwise rediscover |
| The "why" matters for years | The "what" matters for next session |

When in doubt: KNOWLEDGE first, ADR if the decision keeps coming up.

## Discoverability

Future sessions retrieve ADRs by:
1. **Index.** Below table — keep it current.
2. **Grep by slug.** ADR slugs follow the same kebab-case convention as build slugs.
3. **Cross-link from architecture.md.** When an architecture rule has an ADR backing it, link to the ADR file inline.

---

## Index

Update when adding ADRs.

### Framework-shipped (canonical block — sync.js owns these rows; do not edit in consuming repos)

| ADR | Title | Status | Domain |
|-----|-------|--------|--------|
| [0001](./0001-mixed-mode-review-agents.md) | Mixed-mode review agents (auto-fix mechanical, route directional) | accepted | review fleet |
| [0002](./0002-interactive-vs-walkaway-review-agents.md) | Interactive vs walk-away review agent classification | accepted | review fleet |
| [0005](./0005-risk-class-split-rollout-pattern.md) | Risk-class split rollout for read-vs-write enforcement gaps | accepted | rollout / enforcement |
| [0006](./0006-no-inline-agent-overrides.md) | Agent files are framework-canonical — no inline per-repo overrides | accepted | framework / agent authoring |
| [0007](./0007-ground-mockups-in-real-render.md) | Mockups ground in real rendered output, not source inference | accepted | framework / mockup pipeline |
| [0008](./0008-parallel-worktree-builders.md) | Parallel worktree builders for independent chunks | accepted | build-orchestration |
| [0014](./0014-coordinators-run-inline.md) | Coordinators and audit-runner run inline — never Agent-tool dispatched | accepted | framework / orchestration |

ADRs 0001, 0002, 0005–0008, and 0014 ship as part of the framework — they are durable patterns that apply across projects. The numbering gaps (no 0003 / 0004, and the jump to 0014) reflect origin-project-specific ADRs that did NOT propagate. Starting your project's local ADRs at 0009 stays valid — 0014 is framework-reserved (consuming repos' agents already cite ADR-0014, so the framework claims that number rather than the next-in-sequence); skip it when numbering local ADRs.

### Local ADRs (consumer-owned)

Consuming repos add index rows for their local ADRs ONLY inside the slot below — `sync.js` preserves in-slot content across framework updates (see `references/local-override-convention.md`); rows added outside it trigger a `.framework-new` conflict on the next sync.

<!-- LOCAL-OVERRIDE:start name="local-adrs" -->
<!-- Consuming projects: add a table (same four columns: ADR | Title | Status | Domain) listing your local ADRs here. Number from 0009 upward; skip 0014 (framework-reserved). -->
<!-- LOCAL-OVERRIDE:end name="local-adrs" -->

---

## Project-specific notes

Consuming projects can add project-specific guidance for this file between the markers below. Sync.js preserves anything you put between the markers when the framework is updated. Do NOT edit outside the markers — those changes get a .framework-new diff on the next sync.

<!-- LOCAL-OVERRIDE:start name="project-notes" -->
<!-- LOCAL-OVERRIDE:end name="project-notes" -->
