# Evidence contract

The `uat-evidence.json` shape and every rejection the deterministic validator enforces. The coordinator populates `status.json` ONLY from evidence this validator accepts — never the reverse. Schema: `schemas/uat-evidence.schema.json`. Validator: `scripts/uat/validate-uat-evidence.mjs`.

## Verdict and applicability

`verdict`, `applicability`, and `enforcement` are three separate recorded facts. `applicability: non-applicable` requires `verdict: proceed` and a written `applicability_reason`; `proceed` never appears for an applicable change. `enforcement` (`advisory | blocking`) is the single downstream control — refusal rows and label transitions read it, never the raw rollout mode. The validator is fail-closed: it never rewrites `fail`/`incomplete` into `pass`/`proceed`, and it rejects any `uat_enforcement_override` field outright (no override ships).

## Identity — candidate vs harness

Evidence distinguishes the application candidate from the harness that judged it. `candidate.{head_sha, base_sha, runtime_tree_clean, submodule_shas, allowed_dirty_paths}` binds the verdict to an exact tree; `harness.{framework_sha, codex_skill_sha256, validator_sha256, classifier_sha256, evidence_schema_version, harness_manifest_sha256, executor_class, executor_version}` binds it to the exact machinery. `harness_manifest_sha256` is the completeness boundary — enumerating fields one by one never converges, so a deterministic builder lists every semantic input and a gate fails when a new harness-semantic file is uncovered. The evidence file's own `evidence_sha256` is recorded in `gate_evidence.uat`, cryptographically binding `status.json` to the exact validated document.

## Blind freeze and plan-digest identity

The blind plan is hash-bound (`plan_digests.blind_plan_sha256`) and its scenario id set (`blind_scenario_ids`) is frozen. `augmentation_started_at` must be strictly after `blind_plan_frozen_at`. The plan-digest handoff is two-sided: `expected_plan_sha256` (coordinator, before dispatch) must equal `executed_plan_sha256` (executor, recomputed before its first scenario) — a frozen plan cannot be swapped between validation and execution. All digests are RFC 8785 (JCS) canonical, computed over the object with its own digest field excluded.

## Risk inventories and coverage

Two named inventories: `risk_inventory_at_execution_start` (immutable, hash-bound to the executed plan) and `risk_inventory_final` (monotonic superset carrying late-discovered risks). The chain `risk_baseline ⊆ start ⊆ final` is enforced — the independently-derived baseline can be added to, never shrunk. Coverage is machine-checked: for every tag in the start inventory, every required scenario family in the policy must be covered by a passing required scenario. This kills the concrete failure the gate exists for — a `money-precision` change that omits the aggregate-to-route identity family while every included scenario passes and the JSON validates.

## Artifacts and redaction

Evidence artifacts are `{path, sha256, bytes, media_type, redaction_status}`. Integrity is recomputed, never trusted: the validator re-hashes each file and checks byte length against the manifest, resolves realpaths to prove containment within the permitted UAT artifact roots (defeating symlink escape), and runs a deterministic secret scan over all textual evidence and the evidence document itself. `redaction_status: redacted` is a claim, not proof — a seeded credential in a captured artifact fails validation regardless.

## What the validator rejects

Unknown verdicts/applicability; `pass` with a failed, skipped-required, or incomplete scenario; `pass` with a missing required capability; `pass` without a full head SHA or with an unclean runtime tree; `proceed` without a reason and current SHA; a browser-pass claim while browser capability is absent; missing/vacuous anti-vacuity for an applicable scenario; a mutated, deleted, downgraded, or non-executed blind scenario; a broken scenario or inventory digest; a coverage gap for a declared risk tag; an augmentation timestamp preceding the freeze; a plan-digest mismatch; an artifact hash/byte mismatch, a path escaping the allowed roots, or a detected secret; and any `uat_enforcement_override` field.
