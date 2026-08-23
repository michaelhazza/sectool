# Schema CHANGELOG

## build-status.v2 — producer guidance on run_ids (2026-08-20, framework 2.73.0)

**`build-status.schema.json` — a `$comment` added to `gate_evidence.*.run_ids`. No shape change: `items.type` stays `string`, `contract_version` stays `build-status.v2`, nothing to migrate.**

The comment records why the type is `string` and not `number`: GitHub Actions returns run ids as numbers, so a producer that writes the raw value emits a schema-invalid record. During the PR #828 finalisation this was the D2 defect — `run_ids: [32310798762]` passed the one-level Ajv-unavailable floor, board-sync refused the record downstream, and the card stranded silently. The recursive floor (`scripts/status/status-contract.mjs`, W2.1) now rejects it in bare-consumer mode, `scripts/status/sync-status.mjs --slug` exits 2 on it at write time, and every producer example in the coordinator playbooks was corrected to show quoted ids in the same change.

**Consumers must:** nothing. The contract is unchanged; the comment and the surrounding validation make the existing `string` requirement enforced rather than advisory.

## build-status.v2 — additive UAT gate_evidence projection (2026-08-11, framework 2.71.0)

**`build-status.schema.json` — three new OPTIONAL properties on the `gate_evidence` entry shape: `evidence_sha256` (64-hex), `code_candidate_sha` (40-hex), `enforcement` (`advisory | blocking`). `contract_version` unchanged at `build-status.v2`; nothing to migrate.**

The fresh-context UAT acceptance gate writes its minimal merge-control projection into `gate_evidence.uat` so refusal rows 9-10 can enforce fail-closed against the exact validated evidence: `evidence_sha256` cryptographically binds `status.json` to the validated `uat-evidence.json`, `code_candidate_sha` is the tested SHA the certification-tail diff is measured from, and `enforcement` is the single downstream control the rows read (never the raw `uat_rollout_mode`). Populated only on the `uat` entry by `acceptance-phase` from validated evidence; every other gate omits all three and stays valid.

**Why additive rather than a version bump:** identical reasoning to the entries below — a required field or `contract_version` bump invalidates every stored `status.json` in every consuming repo the moment the schema syncs, before any coordinator emits the new shape. All three fields are optional; absence means "not a UAT gate", never a default.

**Consumers must:** nothing. Coordinators that do not run the UAT gate never write these fields; the gate ships disabled by default (`uat_rollout_mode` absent = disabled).

## review-result.v2 — additive finding evidence fields (2026-08-03, framework 2.63.0)

**`review-finding.schema.json` — new OPTIONAL `confidence`, `evidence_kind` and `verification_state` properties. `contract_version` unchanged at `review-result.v2`; no changes to existing enums; nothing to migrate.**

Every finding already carried `source_refs` (where the reviewer looked) and `risk_domain` (what it touches), but nothing recorded how strongly the reviewer believed it or what kind of observation backed it. A triage loop cannot mechanically separate "read the file, this is broken" from "inferred from a diff hunk, might be broken" without that. `verification_state` deliberately reuses the `verified | inferred | assumed` vocabulary of the fable-mode reasoning overlay so reviewer output and reasoning discipline share one word set; `evidence_kind: reasoning_only` names the class most prone to hallucinated premises.

**Why additive rather than a version bump:** identical reasoning to the `build-status.v2` entries below — a required field or a `contract_version` bump invalidates every stored review result in every consuming repo the moment the schema syncs, before any reviewer has emitted the new shape. All three fields are optional, and absence means "not rated", never a default of high confidence.

**Consumers must:** nothing. Reviewers may start emitting the fields at any time; coordinators that do not read them are unaffected.

## review-result.v2 — additive review lens (2026-08-03, framework 2.63.0)

**`review-finding.schema.json` — new OPTIONAL `lens` property (`product_value | engineering_feasibility | design_quality | developer_experience`). `contract_version` unchanged at `review-result.v2`; nothing to migrate.**

A reviewer with finite attention converges on whichever failure class is easiest to see — usually engineering feasibility, because it is the most concrete. Value, design and operability failures then reach the operator unexamined. Naming the four perspectives makes an unreviewed one visible as an omission rather than invisible as a non-finding. Definitions and reporting rules: `references/review-lenses.md`.

**Coverage is mandatory; tagging is not.** Plan reviewers sweep all four lenses and state which reviewed clean; a finding carries `lens` only when ONE lens clearly dominates. The field stays optional precisely so cross-cutting findings can omit it — a miscategorised finding is worse than an unclassified one.

Wired into all three plan-review tiers: `claude-plan-review` and `plan-reviewer` (lens sweep + a five-line decision brief in their prose logs — NOT a JSON field, the envelope stays closed), and `chatgpt-plan-review` via `SYSTEM_PROMPT_PLAN_V2`. Manual ChatGPT-web mode carries the lenses in the paste-ready prompt, since it does not get the system prompt.

**`prompt_version` deliberately stays `openai-plan-review.v2`.** In this repo that identifier names the prompt TIER (v1 legacy shape vs v2 canonical envelope, selected by `--prompt-version`), not each content revision; the v2 prompts have been revised in place before, e.g. the 2026-05-28 move of artefact content out of the system prompt. Adding a v3 tier would mean a new `getSystemPrompt` branch for a content change that alters no output shape.

**Consumers must:** nothing. `lens` is never a routing input — triage stays keyed on `risk_domain` and `triage_hint`.

## work-packet.v1 / completion-packet.v1 — additive execution policy (2026-08-03, framework 2.63.0)

**`work-packet.schema.json` — new OPTIONAL `execution_policy` object. `completion-packet.schema.json` — new OPTIONAL `effective_policy` (via `definitions.executionPolicy`), `effective_policy_hash`, `policy_evaluation` and `policy_violations`. Both `contract_version` values unchanged; nothing to migrate.**

`execution_policy` is capability-REMOVING dispatch metadata: `write_scope`, `protected_paths`, `destructive_actions`, `credential_access`, `network_egress` + `egress_allowlist`, `deploy_authority` (a `const false` — a policy can withhold deploy authority, never confer it) and `expires_at`. Normative semantics live in `references/execution-policy.md`; the computation lives in `scripts/packet-contract/execution-policyPure.mjs`.

**Three decisions worth recording:**

1. **Composition is a conjunction, not a merge.** A path is writable iff it matches `allowed_files` (when present) AND `write_scope` (when present) AND no `protected_paths` entry. Glob intersection is not computable over pattern strings — intersecting `server/**` with `**/*.test.ts` means "test files under server/", which no string operation on the two patterns yields — so both lists are carried and the conjunction is evaluated per path.
2. **The hash covers normalized declarations, not a resolved file set.** A coordinator must be able to recompute it from the work packet alone to detect mutation between dispatch and return, and a resolved set cannot express authority over files that do not exist yet — which is most of what a builder writes.
3. **The policy shape is duplicated** between the two schema files rather than `$ref`'d across them. `validate-packet.mjs` compiles each packet schema standalone with no `addSchema`, so a cross-file `$ref` would fail to resolve, be swallowed by the compile `try/catch`, and silently degrade that packet to the structural floor. `validate-packet.test.mjs` asserts every shared key stays identical and that `allowed_files` — folded into the echo so it is self-contained — is the only permitted divergence.

**Validator change:** `validatePacket` now returns `{ok, errors, warnings}` (previously `{ok, errors}`) and runs `validatePacketSemantics` after the structural check in BOTH modes. The structural floor reads only top-level `required`/`enum`/`const`, so every nested policy invariant would otherwise be enforced with Ajv and silently ignored without it — a constraint that holds only where a devDependency happens to be installed is not a constraint. Deleting the semantic call fails 23 tests across both modes.

Three fallback-mode gaps closed in review, each one a case where the same packet's verdict depended on whether Ajv was installed:

1. **Closed key sets.** `additionalProperties: false` lives in the schema, which the floor never reads, so an undeclared key inside `execution_policy`, `effective_policy` or `release_evidence` passed without Ajv. That is the authority-shaped hole the layer exists to close — a future consumer could read an undeclared field as a capability grant while the validator reported the packet valid. `POLICY_KEYS` and `RELEASE_EVIDENCE_KEYS` now close the sets, and a test asserts they match the schemas' `properties` so a new schema key cannot land unvalidated.
2. **Strict RFC 3339 for `expires_at`.** `Date.parse` accepts a date-only `2026-01-01`, a timezone-less `2026-08-03T12:00:00`, and silently rolls `2026-02-31` into March; `ajv-formats` rejects all three. `isRfc3339DateTime` replaces it, and a parity test checks it against the real Ajv format across 16 vectors rather than a remembered rule.
3. **`policy_evaluation: violated` with `policy_violations` absent.** Previously only the explicitly-empty array was rejected, so omitting the field entirely let a packet claim a violation while listing none.

A second round found the same class again in adjacent fields — array CONTENTS are invisible to the floor, so `policy_violations: [42]`, `evidence_paths: [""]`, duplicate `changed_docs`, an empty `release_control_id` or `doc_exemption_reason`, and duplicate `egress_allowlist` hosts all passed without Ajv. Shared `nonEmptyStringArrayErrors` / `nonEmptyStringErrors` helpers now mirror those constraints.

**The durable fix is the guard, not the patch.** `SEMANTICALLY_COVERED_PATHS` declares which schema paths this layer re-implements, and a test walks both schemas, collects every value-level constraint (`items.minLength`, `uniqueItems`, `minLength`, `pattern`, `format`), and fails if one is neither covered nor listed in `FLOOR_UNCOVERED_LEGACY_PATHS`. Verified by adding a constrained property to a schema: the suite fails naming the exact path and the fix. Two review rounds each found a different unmirrored constraint by hand; a third occurrence now fails the build instead.

`FLOOR_UNCOVERED_LEGACY_PATHS` inventories 26 PRE-EXISTING fields (`objective`, `changed_files`, `summary`, `allowed_files`, …) whose value constraints the floor has never enforced. Deliberately unchanged here: closing them alters validation of contracts consumers already emit, which belongs in its own change with its own migration note. They are now inventoried rather than merely unnoticed.

**Scope boundary:** this ships declarations only. Recompute-and-compare of the hash, `expires_at` evaluation at dispatch, matching patterns against a real checkout, symlink handling, and cross-field reconciliation against `allowed_resources` belong to the later enforcement build. A packet carrying `execution_policy` grants nothing and blocks nothing on its own.

**Why additive:** same reasoning as every entry below. All new fields are optional; a frozen pre-2.63.0 work packet and completion packet are asserted still-valid in the suite.

**Consumers must:** nothing. Callers reading `.errors` are unaffected by the added `.warnings` key.

## completion-packet.v1 — additive documentation impact and release evidence (2026-08-03, framework 2.63.0)

**`completion-packet.schema.json` — new OPTIONAL `documentation_impact`, `changed_docs`, `doc_exemption_reason` and `release_evidence`. `contract_version` unchanged at `completion-packet.v1`; nothing to migrate.**

`documentation_impact` is a Diataxis classification (`none | reference | how_to | tutorial | explanation | multiple`) declared by the producer at completion time, with `changed_docs` naming the files and `doc_exemption_reason` explaining a `none` alongside changed code. This makes the existing doc-sync judgement inspectable rather than implicit. The producer-side convention — how to classify, what counts as documentation, when the exemption is required — lives in `.claude/agents/builder.md` § *Documentation impact*, because a field with no instructed producer is a field nobody fills in.

Enforcement split, deliberately: `changed_docs ⊄ changed_files` and a non-`none` impact with no documents listed are ERRORS (factual contradictions inside one packet), while a missing exemption reason is a WARNING. Documentation judgement is not mechanically decidable, and failing there would make an optional field mandatory for every code change.

`release_evidence` (`release_control_id`, `canary_result`, `evidence_paths`) links a packet to what was deployed and observed. It carries no tested-commit field because the top-level `commit_sha` already does. A `pass`/`fail` canary must point at its evidence; `not_run` need not. A `SUCCESS` completion MAY carry `canary_result: fail` — canaries run after the work completes, so attaching the observation must not force a status rewrite, and the consuming release gate decides what a failed canary means.

**Why additive:** as below. Both objects are optional and `minProperties: 1`, so an empty stub cannot masquerade as a filled-in one.

**Consumers must:** nothing. Both are advisory in this contract; no gate reads them yet.

## build-status.v2 — additive runtime-identity fields (2026-08-02, framework 2.62.0)

**`build-status.schema.json` — new OPTIONAL top-level `runtime` object and new OPTIONAL `runtime`/`role` string keys on `log[]` items. `contract_version` unchanged at `build-status.v2`; no enum changes; nothing to migrate.**

Part of the runtime-neutral pilot (`framework-runtime-neutral-v3`, spec §12.A Chunk A3, FR-1/FR-4/FR-13). The top-level `runtime: {coordinator_runtime, coordinator_role}` records the build-level coordinating runtime. The `log[]` item's `runtime` + `role` string keys are the per-stage/per-commit stamp (FR-13): each activity entry records the acting runtime and role at that transition. See `references/runtime-roles.md` for the role-to-runtime vocabulary and the stamping rule.

**Why additive rather than v3:** same reasoning as the `log[]` addition below — a required field or a `contract_version` bump would invalidate every existing `status.json` in every consuming repo the moment the schema synced. Optional-and-additive means pre-2.62.0 records stay valid forever.

**Consumers must:** nothing. Both `runtime` objects are `additionalProperties: false`, so the new keys had to be declared in their respective `properties` — done here. The structural floor in `status-contract.mjs` derives its checks from the schema, so the new fields validate automatically on sync.

## work-packet.v1 / completion-packet.v1 — new schemas (2026-08-02, framework 2.62.0)

**New files: `schemas/work-packet.schema.json` and `schemas/completion-packet.schema.json`. Both draft-07, `additionalProperties: false`, versioned via a `contract_version` const. Part of the runtime-neutral pilot (`framework-runtime-neutral-v3`, spec §12.A Chunk A1, FR-2/FR-3).**

These formalise, as machine-checkable contracts, dispatch/return shapes that already exist informally today: `work-packet.schema.json` (`contract_version: "work-packet.v1"`) mirrors the fields already carried in Claude Code agent dispatch prompts (objective, governing artefacts, allowed files/resources, dependencies, verification commands, output locations, prohibited actions, resume id), plus additive `role` and `runtime` fields for runtime-neutral dispatch. `completion-packet.schema.json` (`contract_version: "completion-packet.v1"`) mirrors the builder verdict block in `.claude/agents/builder.md` (Verdict / Files changed / Spec sections / What was implemented / Plan gap / G1 attempts / Notes for caller / DID NOT TOUCH); its `status` enum (`SUCCESS`, `PLAN_GAP`, `G1_FAILED`) is exactly the builder verdict set, no drift permitted.

**Required set kept minimal** on both schemas so existing Claude Code dispatches map cleanly without every field being mandatory: work-packet requires `contract_version, packet_id, feature_slug, repo, branch, objective, role, runtime`; completion-packet requires `contract_version, packet_id, status, role, runtime, summary`. All other fields (arrays of strings, plus `tests[]` as `{name, result}` objects with `result` enum `pass`/`fail`/`skip`) are optional and additive.

**Consumers must:** nothing yet — these schemas are declarative contracts with no wired validator in this chunk. `scripts/packet-contract/validate-packet.mjs` (framework-runtime-neutral-v3 Chunk A2) adds the round-trip harness and fixtures that exercise them against Ajv.

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
