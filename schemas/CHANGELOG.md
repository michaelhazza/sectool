# Schema CHANGELOG

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
