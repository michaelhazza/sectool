# Schema CHANGELOG

## build-status.v2 — additive `log[]` activity log (2026-07-30, framework 2.61.0)

**`build-status.schema.json` — new OPTIONAL top-level `log[]` array. `contract_version` unchanged at `build-status.v2`; no enum changes; nothing to migrate.**

`log[]` is the operator-facing activity log rendered as the board card's `## Activity` section by `board-sync.mjs` (newest-first, capped at `ACTIVITY_RENDER_CAP` entries). Entry shape: `{at: date-time, stage: string, kind: start|done|info, note: string[1..6, each <=200 chars]}`. Coordinators append entries at every stage boundary (a forward transition appends a `done` for the closing stage plus a `start` for the opening one, in the same status write) and at notable mid-stage moments; entries are append-only and never edited.

**Why additive rather than v3:** a required field or a `contract_version` bump would invalidate every existing `status.json` in every consuming repo the moment the schema synced, before any coordinator had written the new shape — the generator would mark records INVALID and board cards would stop syncing. Optional-and-additive means pre-2.61.0 records stay valid forever and the log simply starts accumulating at each build's next status write.

**Consumers must:** nothing. The structural floor in `status-contract.mjs` derives its checks from the schema, so `log[]` validation (including the renderer-crash `[null]` element class) engages automatically on sync.

## build-status.v2 — documentation correction (2026-07-29, framework 2.55.0)

**`build-status.schema.json` — `$comment` only. No change to `contract_version`, the `status` enum, or any validation behaviour. Nothing to migrate.**

The top-level `$comment` still described the **v1** blocker-gated back-edges (`MERGE_READY → REVIEWING`, `REVIEWING → BUILDING`) after the enum widened 6 → 9 in 2.54.0. Corrected to the v2 set:

`MERGE_READY → FINALISING` (the label-pull CI fix loop) · `FINALISING → TESTING` (a review or doc finding needing a code change re-verified) · `TESTING → BUILDING` (a failing test that is a product defect, not a test defect) · `REVIEWING → BUILDING` (review findings)

**Why this entry is late, and the lesson:** the schema edit shipped in 2.55.0 *without* this entry. CI's D10 gate — "if `schemas/*.json` changed relative to `origin/main`, `schemas/CHANGELOG.md` must change too" — would have blocked it, but **the framework's `CI` workflow was `disabled_manually` at the time**, so no gate ran on that push or the fifteen before it. The omission was found later by running every CI step by hand. Two things follow: a gate that is switched off is indistinguishable from a gate that passes, and the D10 check compares against `origin/main`, so once a violating commit is pushed the gate goes quiet about it forever. Catching this required reading `git log -- schemas/`, not re-running the check.

## build-status.v2 (2026-07-29, framework 2.54.0)

**`build-status.schema.json` — `status` enum widened 6 → 9; `contract_version` bumped `build-status.v1` → `build-status.v2`.**

Before: `PLANNING BUILDING REVIEWING MERGE_READY MERGED ABANDONED`
After: `SPECIFYING PLANNING BUILDING REVIEWING TESTING FINALISING MERGE_READY MERGED ABANDONED`

Three values added, driven by the operator's board being unable to answer "what is actually happening right now":

- **`SPECIFYING`** — deciding *what* to build. Previously collapsed into `PLANNING` alongside build-plan sizing, which are different activities separated by a mandatory operator approval gate. This was the single most confusing thing about v1: the board could not distinguish "we are still working out what this is" from "we know what it is and are sizing the work".
- **`TESTING`** — Codex designs and authors the frontend/backend tests, runs the full suite, and iterates to green (the verify phase). Previously invisible inside `FINALISING`, so the board could not distinguish "tests are being built" from "tests are green and final checks are running". Operationally these are separate stages with different owners and very different durations.
- **`FINALISING`** — external review, doc-sync, capability registration, compound learning, cleanup, CI parity. Previously not a status at all; `REVIEWING` silently carried through the whole of Phase 3 until `MERGE_READY`.

**Migration:** none required. The board (`projects/2`) had **0 items** and no `status.json` file existed in any repo at the time of the change — verified before shipping. This was deliberately done at the only moment it would be free.

**Consumers must:** update the board's `Status` single-select options to match (no `gh` subcommand edits single-select options — it is a web-UI step, noted in `board-sync.mjs`'s `--init` guidance), and treat `contract_version: build-status.v1` records as absent rather than migrating them, since none exist.

> 2.28.x–2.30.0 — no schema changes (verified against `git log -- schemas/`; last change shipped in 2.27.0).

## Reconciliation pass (2026-07-05, framework 2.27.0)

The v2 entry below originally described draft enums that differ from what
`review-finding.schema.json` actually shipped (and what the Ajv gate in
`scripts/chatgpt-review.ts` + the pinned tests enforce). The schema file is
authoritative; the entry has been corrected to match it:

- `risk_domain` actual enum: `none`, `tenant_isolation`, `security`,
  `auth_authorisation`, `idempotency`, `data_integrity`, `user_visible`,
  `compliance` (NOT the draft `pii`/`sql_injection`/`privilege_escalation` set).
- `scope_signal` actual enum: `local`, `architectural` (NOT the draft
  `cross_file`/`cross_service`/`cross_tenant` set).
- `triage_hint` actual enum: `technical`, `user-facing`, `technical-escalated`
  (`security-escalated` was never shipped).
- `pr-context.schema.json`: the `reality_checker` key was removed from
  `phase_2_review_outcomes` — the agent was retired in 2.21.0 and the pipeline
  no longer produces that field.
- Status note: `pr-context.schema.json` and `prior-rounds.schema.json` are
  input-shape contracts for the driver's `--pr-context` / `--prior-rounds`
  flags; the driver currently reads these files without validating them
  against the schemas. Treat the schemas as documentation of the expected
  shape until validation is wired.

## review-finding.schema.json — `finding_type` enum extension (2026-05-28)

- Added `observability` and `spec_delta` to the `finding_type` enum to match
  the v2 spec/plan/PR prompts in `scripts/chatgpt-reviewPure.ts`, which
  instruct reviewers to emit these values. Previously valid model output
  was being quarantined as `schema_fail`. The corresponding TypeScript
  union (`FindingType`) and `FINDING_TYPES` runtime array were updated in
  lockstep.

## review-result.v2 (introduced in review-cascade-v3)

- `risk_domain` field introduced on findings (enum: `none`, `tenant_isolation`, `security`, `auth_authorisation`, `idempotency`, `data_integrity`, `user_visible`, `compliance` — corrected 2026-07-05, see reconciliation entry). Carve-out gate keys on `risk_domain`, not `finding_type`.
- `source_refs[]` replaces `evidence` (string). Each ref is `{type, value}` where type is one of `spec_section`, `diff_hunk`, `file_line`, `quote`, `section_name`. Minimum 1 item required.
- Versioning quartet mandatory: `contract_version`, one of `{prompt_version | reviewer_version | stitched_from}`, `project_context_version`, `source_artifact_sha`.
- `integrity_check` required on result envelope.
- `auto_apply_eligible: true` requires `proposed_edits[]` (min 1 item, each `{file_path, anchor, replacement}`) per §A11 patch contract.
- `acceptance_check` denylist via `pattern` constraint: rejects "covered by tests", "verify manually", "review the section", "see code", "spot check" (case-insensitive).
- Mutual-exclusivity on versioning: `oneOf` between OpenAI-tier (`prompt_version` only), Claude-tier (`reviewer_version` only), and coordinator-stitched (`stitched_from` + both).
- `scope_signal` added: `local`, `architectural` (corrected 2026-07-05).
- `triage_hint` added: `technical`, `user-facing`, `technical-escalated` (corrected 2026-07-05).

## review-result.v1 (prior version — read-only parse mode only)

Original shape. No `risk_domain`, no `source_refs`, no versioning quartet. Parser accepts v1 in backward-compat read-only mode; schema validation against v2 schema returns FAIL for v1 inputs.

---

## Consumer-local schema changes

Consuming repos that keep their own schemas in `schemas/` record those changes between the markers below — sync.js preserves slot content on every framework update. The framework schema history above is framework-owned; do not edit it.

<!-- LOCAL-OVERRIDE:start name="consumer-entries" -->
<!-- LOCAL-OVERRIDE:end name="consumer-entries" -->
