# Evidence contract (Codex run-final-uat)

Shared substrate with the framework `acceptance-testing` skill. The single editing home for the SHAPE is `schemas/uat-evidence.schema.json`; the deterministic checks are `scripts/uat/validate-uat-evidence.mjs` (both synced into consumer repos). Produce `uat-evidence.json` to this contract; the coordinator populates `status.json` ONLY from evidence the validator accepts, never the reverse.

## What you must produce

- `verdict` (`pass|fail|incomplete|proceed`), `applicability` (`applicable|non-applicable`, with `applicability_reason` when non-applicable), and `enforcement` recorded distinctly. `proceed` only for genuine non-applicability.
- `candidate` identity: full 40-hex `head_sha`/`base_sha`, `runtime_tree_clean`, `submodule_shas`, `allowed_dirty_paths` (UAT roots only).
- `run_id` namespacing every resource (scratch dir, DB name, temp dirs, browser profile, artifacts).
- `scenarios[]`: `id`, `origin` (blind|augmentation), `required`, `risk_tags`, `families` (from the matrix), `status`, `oracle`, structured `anti_vacuity`, `evidence[]` (`{path, sha256, bytes, media_type, redaction_status}`), `cleanup`, and a per-scenario `digest`.
- `blind_scenario_ids` (the frozen blind set), `risk_baseline` / `risk_inventory_at_execution_start` / `risk_inventory_final`, `plan_digests` (blind + input-manifest + expected == executed), `planner.*` and `execution.*` identities, `capabilities[]`, `environment`, `timestamps`, `secrets_redacted`.

## Non-negotiables the validator enforces (do not fight them)

- Digests are RFC 8785 (JCS) canonical, each computed over its object with its own digest field excluded — use the shipped `scripts/uat/canonicalize.mjs`, do not hand-roll canonicalisation.
- The blind scenario set is `blind ⊆ final-required ⊆ executed`: never mutate, delete, downgrade (required→optional), or skip a blind scenario.
- `risk_baseline ⊆ start ⊆ final`: you may ADD risks, never remove a baseline one.
- Coverage: every mandatory scenario family for every risk tag in the start inventory must be covered by a passing required scenario.
- `expected_plan_sha256 == executed_plan_sha256`; `augmentation_started_at` strictly after `blind_plan_frozen_at`.
- Artifact `sha256`/`bytes` are recomputed against the real file; textual evidence is secret-scanned (`redaction_status: redacted` is a claim, not proof); every evidence path must resolve within the permitted UAT artifact roots.

## What the validator rejects

Unknown verdicts/applicability; `pass` with a failed/skipped-required/incomplete scenario; `pass` with a missing required capability, an abbreviated SHA, or an unclean tree; a browser-pass claim while browser capability is absent; `proceed` without a reason and current SHA; missing/vacuous anti-vacuity; a tampered scenario or inventory digest; a coverage gap; an augmentation timestamp before the freeze; a plan-digest mismatch; an artifact hash/byte mismatch, a path escaping the roots, or a detected secret; and any `uat_enforcement_override` field (no override exists — do not emit one).
