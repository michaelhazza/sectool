# Handoff — audit-tool-v1

**Phase complete:** SPEC
**Next phase:** BUILD (run `feature-coordinator` in a new session)
**Spec path:** docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md
**Branch:** claude/lucid-albattani-kczh64
**Build slug:** audit-tool-v1
**UI-touching:** no
**Mockup paths:** n/a
**Spec-reviewer iterations used:** 0 / 5 (skipped — Codex CLI unavailable in remote environment; directional review operator-owned)
**Claude spec review log:** tasks/review-logs/claude-spec-review-log-audit-tool-v1-2026-06-12T11-05-00Z.md
**Claude spec review iterations used:** 1 / 3 (D5 cap) — verdict CHANGES_REQUESTED, 0 blocking; all 3 findings applied
**ChatGPT spec review log:** skipped — manual operator loop unavailable in autonomous walkaway session; Claude log preserved for D8 passthrough if the operator runs a round later
**Open questions for Phase 2:**
- Directional review is operator-owned (Codex + ChatGPT tiers skipped — environment/walkaway constraints). Operator may re-open Phase 1 reviews before or during build.
- Exact pinned versions for the 5 scanner binaries (resolve at P6 Dockerfile authoring; record in KNOWLEDGE.md).
- ZAP orchestration mode: daemon API vs automation-framework YAML (builder decides at P4 behind the wrapper interface).
- Whether automation-v1 staging gets `activeScan: true` at launch (shipped `false`; operator call).
- Operator inputs needed before first real portfolio run: real repo list + staging URLs + allowlist hosts; `AUDIT_GIT_TOKEN` and per-target staging cred secrets in GitHub Actions.

**Decisions made in Phase 1:** (all made autonomously per launch-prompt pre-authorization; flagged for operator review)
- Registries at `config/targets.json` + `config/allowed-staging-hosts.json` (shipped with empty allowlist — live path can scan nothing until operator adds hosts) + `config/baseline.json`.
- Severity: 4-level critical/high/medium/low with exploitability modifiers (spec §8.1); CVSS kept as evidence metadata only.
- Reports: CI artifacts + gitignored local `reports/`; committed `history/trend.jsonl` carries counts only (no finding bodies).
- Baselines: justification + expiry + approvedBy required; approval = PR review via CODEOWNERS (michaelhazza).
- Repo acquisition: optional `localPath`, else shallow clone-on-demand; CI always clones with read-only token.
- CI runs in the pinned GHCR Docker image (not per-run installs).
- Authenticated scanning: env-var-name indirection in registry (`form` login, closed set); missing creds → unauthenticated scan + explicit coverage-gap in report.
- Active scanning: per-target `activeScan` opt-in, default false (passive + non-intrusive only); owner attests staging data + owns cleanup.
- Purpose-built vulnerable fixture app (our stack) over Juice Shop for the live benchmark.
- claude-spec-review CR-002 applied: allowlist provenance pinned (§4.9) — `src/config/load.ts` is the only non-benchmark allowlist source; no flag/env substitute; benchmark exception confined to `benchmark/run.ts`.
- Adversarial-reviewer tier is MANDATORY at review phase (live-scan safety surface; launch-prompt requirement).
- Plan gate pre-approved: `operator pre-approval via launch prompt, 2026-06-12` — feature-coordinator proceeds past the plan gate without waiting.
- v1 exit loop bounds (launch prompt, binding for Phase 2/3): benchmark recall 100%, FP 0, safety-contract test green, lint+typecheck+tests green, self-scan clean; max 10 iterations; same fix failing same check twice = stop and escalate; exit conditions immutable; scope frozen to spec.
