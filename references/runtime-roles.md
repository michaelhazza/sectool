# Runtime roles — single config point for approved runtimes per role

The one canonical mapping of pipeline role → approved execution runtime (spec `framework-runtime-neutral-v3` §8-FR1). Agent files and coordinators cite this table rather than restating runtime eligibility inline; when a summary elsewhere disagrees with this table, THIS FILE WINS.

**Canonical role-literal casing:** the table below uses Title Case for human readability, but every packet `role` value (`work-packet.schema.json`, `completion-packet.schema.json`, and their fixtures) is **lowercase** — `builder`, `coordinator`, `architect`, `reviewer`, `test-author`, `finaliser` — matching the runtime literals (`claude-code`, `openclaw`). When populating a packet's `role` field, use the lowercase form; the Title Case column here is presentation only.

## Role → approved runtimes

| Role | Approved runtime(s) | Notes |
|---|---|---|
| Coordinator (spec/feature/finalisation) | Claude Code | Never OpenClaw. Coordinators orchestrate other agents, own the plan gate, own gate evidence, and own merge — none of that is a candidate for a non-Claude runtime under this pilot. |
| Architect | Claude Code | Plan authoring and mid-build architectural decisions stay on Claude Code. |
| Builder | Claude Code, OpenClaw | Claude Code builds any chunk. OpenClaw is scoped to **sequential Builder work only** — one dispatched chunk at a time, never a coordinating or reviewing role, and it **stops at `MERGE_READY`** (see below). |
| Reviewer (`spec-conformance`, `pr-reviewer`, `adversarial-reviewer`, `dual-reviewer`, `chatgpt-*-review`) | Claude Code | Review judgment is not delegated to OpenClaw under this pilot. |
| Test Author | Claude Code | Test authoring (the TESTING status) stays on Claude Code. |
| Finaliser | Claude Code | Finalisation (Phase 3, `finalisation-coordinator`) stays on Claude Code. |
| Acceptance tester (fresh-context UAT executor) | Codex (fresh CLI process or Desktop task); Claude Code headless as advisory-only fallback | The BINDING acceptance verdict comes from a fresh Codex context — cross-vendor AND cross-context independence. A fresh `claude -p` headless run may execute only when `enforcement: advisory` and is recorded as lower-assurance evidence (`executor_class: claude-headless`); Codex unavailable while `enforcement: blocking` yields `incomplete`. The executor never edits production code. `acceptance-phase` (Claude Code) orchestrates; it is not the tester. |

## OpenClaw: Builder only, stops at MERGE_READY

OpenClaw is a **sequential Builder-role runtime**, dispatched by a Claude Code coordinator for one chunk at a time. It never coordinates, never reviews, never finalises, and never merges. An OpenClaw-authored chunk lands on a feature branch exactly like a Claude-Code-authored chunk and passes through the same review pipeline before merge.

Concretely: OpenClaw's authority ends the moment a build's status would advance to `MERGE_READY`. Everything from that point forward (label-pull CI fix loop, auto-merge) is Claude Code coordinator territory. This boundary exists because merge authority and coordination judgment are the highest-blast-radius actions in the pipeline (see `references/autonomy-ladder.md`), and the pilot's live rejection-test gate (spec §12.B Chunk B1) exists specifically to prove the OpenClaw builder identity cannot bypass it.

Coordinator dispatch of an OpenClaw builder, and the invocation contract OpenClaw is bound by, are covered elsewhere in this pilot's later chunks — not in this file. This file states the role boundary only.

## Stamping rule (FR-13)

Every status transition and every commit records the acting runtime and role. Concretely:

- **Per-build summary** — `status.json`'s top-level `runtime: {coordinator_runtime, coordinator_role}` records which runtime coordinated the build overall (see `schemas/build-status.schema.json`).
- **Per-stage / per-commit stamp** — every `log[]` entry MAY carry `runtime` and `role` string keys recording which runtime and role performed that specific stage transition or commit. This is the FR-13 stamping target: a build that mixes a Claude Code coordinator with an OpenClaw builder chunk shows the mix in its activity log, not just in a single build-level field.

Both are optional and additive on `build-status.v2` — a pre-2.62.0 record with neither field stays valid (see `schemas/CHANGELOG.md`). A coordinator or builder appending a `log[]` entry SHOULD populate `runtime`/`role` when the acting runtime is known; omitting them is valid but loses the audit trail this stamp exists to provide.
