# Claude Code Framework — Changelog

This file tracks framework versions for cross-repo drift detection. The version lives in `.claude/FRAMEWORK_VERSION` (single line, semver). When you propagate this framework to a new repo, the version travels with it; future updates can compare versions and produce a delta.

## Format

```
## <version> — <YYYY-MM-DD>

**Highlights:** one paragraph of what shipped.

**Breaking:** changes that require manual migration in repos already on a previous version.
**Added:** new agents, hooks, conventions, or scaffolding.
**Changed:** existing files updated in place; agents now do X instead of Y.
**Deprecated:** still works, but slated for removal.
**Removed:** files / agents / conventions no longer in the framework.
**Fixed:** bugs, doc-rot, broken cross-references.
```

## Upgrade protocol

When a repo's `FRAMEWORK_VERSION` falls behind the latest:

1. **Read this changelog** from the latest version backward to your current one.
2. **For each `Breaking:` entry**, follow the migration note. Don't skip.
3. **For each `Added:` entry**, decide whether to adopt (some additions are opt-in).
4. **For each `Changed:` entry**, diff your local file against the new template — the change may already exist locally if you customised, or may need to be re-applied.
5. **Update `.claude/FRAMEWORK_VERSION`** to the new version.
6. **Run `validate-setup`** (when that skill exists) or the agent fleet's smoke test to confirm the upgrade landed cleanly.

Repos can stay on older versions intentionally. The framework is designed to be additive; older versions don't break.

---

## 2.73.0 — 2026-08-20

**Highlights:** Status-sync hardening — the four defects observed firing together in a real finalisation (PR #828) turned from discipline rules into mechanism. Every status transition now runs ONE citable command, `scripts/status/sync-status.mjs --slug <slug>`, which validates the build's `status.json` record before projecting it to the board; the former generator + board-sync pair is an implementation detail and is unciteable (a CI grep-gate fails any direct reference in an agent file). board-sync reads the complete board inventory via paginated GraphQL and heals archived/stranded cards; a new CI authoritative-check resolver stops a superseded cancelled run reading as a failure; and every squash-merge now writes a durable, greppable post-merge handover (what shipped / what to enable / what's urgent next).

**Added:**
- `scripts/status/sync-status.mjs` — the one status-sync command coordinators cite (target validation, `--expect-status`, `--require-handover`, injectable-deps test seam) + tests.
- `scripts/ci/resolve-authoritative-checks.mjs` — pure CI run-identity resolver (cancelled-superseded rule, per-producer judgment, registration fence) + 11 fixtures.
- `scripts/ci/label.sh apply` subcommand — routes the ready-to-merge label add through the resolver registration fence; fails closed without a configured `ci_workflow_files.ci_workflow`.
- W6 post-merge handover contract (fixed heading + three subheads + triage ledger), enforced at write time by `sync-status --require-handover`.
- CI step: status-sync citation gate (no direct generator/board-sync references in `.claude/agents/*.md`).

**Changed:**
- `scripts/status/status-contract.mjs` — the Ajv-unavailable structural floor is now genuinely recursive (nested `properties`, schema-valued `additionalProperties`, `additionalProperties:false`, `minItems`/`maxItems`/`maxLength`/`pattern`), so a schema-invalid record (e.g. a numeric `run_ids`) is caught in a bare consumer, not just where Ajv is installed.
- `scripts/status/board-sync.mjs` — importable `runBoardSync()` returning a target-aware `{exitCode, reasons, target, records}` contract (the core never touches `process.exitCode`); complete-inventory GraphQL read (zero mutations when completeness is unprovable); `_archive` scan; bounded lazy backfill; archived-card state machine with honest failure compensation.
- The three coordinators' § Status contract sections now define one command + one exit-contract table; finalisation Step 12.4 is a single ordered write→handover→sync→archive sequence with quoted `run_ids`, and Step 11 gains resolver-first phantom handling.
- `.claude/commands/cleanfiles.md` target 4 syncs before archiving a merged build (audit reports, apply syncs then moves only on a satisfying target outcome).

**Breaking (label-add only):** `scripts/ci/label.sh apply` and `restore` now REQUIRE two consumer-config keys and fail closed without them — `ci_workflow_files.ci_workflow` (which workflow) and `ci_workflow_files.ci_workflow_trigger` (`push` | `pull_request` | `none`: which event a push to a feature branch fires for it, or that it fires nothing). Set both during adoption; every other subcommand (`pull`, `parity`, `refile`, `reconcile`) is unchanged. The trigger is DECLARED because the fence must never infer "no run is coming" from how long it has waited: a registration timeout now BLOCKS the add (it proves nothing), and the genuine nothing-to-race case is `trigger: "none"`.

**Fixed:** a schema-invalid status write is refused at write time instead of stranding a board card silently (D2); a merged build's record can no longer become invisible to board-sync by being archived (D3); a cancelled duplicate CI run no longer masquerades as a failure and triggers a wasteful label pull (D4); an external required check whose name is emitted by two different apps no longer lets the newest one decide the verdict (it fails safe to WAIT); `gh api --paginate` over a commit's check-runs is parsed with `--slurp`, so a SHA with more than one page of checks no longer throws.

## 2.72.0 — 2026-08-12

**Highlights:** Doc-retrieval tooling ported from automation-v1 (its doc-token-reduction build, 4 external review rounds): `scripts/architecture-search.ts` gives every consumer ranked section retrieval over `architecture.md` (`--toc` for the section map, telemetry with fail-closed accounting), and `scripts/doc-read-audit.ts` measures reference-doc Read cost from session transcripts with event-time windowing and a fail-closed decision-grade metric. The canonical agent fleet now prefers sliced `architecture.md` reads everywhere (the pack-sliced pattern generalised: 10 agent definitions updated; `context-pack-loader.md` Step 2 mechanics now front-ended by `architecture-search --toc`).

**Breaking:** none. Migration v2.72.0 appends three gitignore lines (arch-search telemetry + audit reports) to consumers and removes consumer-side orphans of the four `.cjs` script renames below (diverged copies conflict, never deleted).

**Added:**
- `scripts/architecture-search.ts` + `scripts/lib/architectureSearchPure.ts` (+ test) — ranked `architecture.md` section retrieval; anchor/alias/fence-aware parser; request telemetry (agent/manual origin via `CLAUDECODE`) with durable gap marker and refuse-to-deliver on unrecordable telemetry.
- `scripts/doc-read-audit.ts` + `scripts/lib/docReadAuditPure.ts` (+ test) — transcript-mined requested-Read token audit over the standard reference docs; half-open event-time windows; per-active-session headline metric that fails closed on malformed or un-windowable evidence.
- `migrations/v2.72.0.js` — consumer `.gitignore` lines for the tools' runtime artifacts.

**Changed:**
- Slice-first `architecture.md` wording in: `feature-coordinator.md` (architect plan prompt), `plan-reviewer.md`, `spec-reviewer.md` (read lists + "Never skip" rules), `chatgpt-pr-review.md` (first-recommendation rule), `adversarial-reviewer.md`, `audit-runner.md`, `dual-reviewer.md`, `spec-conformance.md`, `verify-phase.md` (read lists), `context-pack-loader.md` (Step 2 anchor mechanics; `architect.md`/`builder.md`/`pr-reviewer.md` inherit by reference).
- `scripts/run-migrations.js` → `scripts/run-migrations.cjs`, `scripts/framework-merge.js` → `scripts/framework-merge.cjs`, and the shipped smoke tests `scripts/__tests__/local-override-{smoke,e2e}.js` → `.cjs` (ESM-consumer safety, 2.43.3 precedent; migration `v2.72.0.js` cleans up consumer-side orphans of all four pairs; `SYNC.md` / `/claudeupdate` / `/claudemerge` invocation paths updated; historical CHANGELOG entries keep the old names by design).

**Fixed:** (pre-existing issues surfaced while driving the full `npm test` suite green on Windows; unrelated to the port)
- `scripts/cleanfiles-audit-headless.mjs` — on Windows `shell:true` masked a missing command as a successful `cmd.exe` spawn: resolve the executable via PATH+PATHEXT so a missing launcher maps to exit 127, and drive the timeout tree-kill through `taskkill /T` (never `child.kill()`, which orphaned the worker + grandchild and left the repo cwd locked → EBUSY).
- `.claude/hooks/code-graph-freshness-check.js` — same `shell:true`/npx-ENOENT masking left the rebuild lock held and falsely reported a background rebuild; pre-resolve npx and route a miss to the existing lock-release path.
- Test infra: Windows-safe teardown for the spawn-based code-graph hook test; `status-vocabulary` allowlist for new non-status schema-prose words; `check-shipped-source` test reads the gate source once in-process (removes a redundant per-case spawn); vitest `maxWorkers` 8→12 so per-worker file chains stay under the 60s birpc deadline on 16-CPU hosts.
- README/ADAPT profile-inventory reconciliation with disk (30 agents, 14 hooks; FULL profile enumerations completed in both docs; stale "known pre-existing drift" parentheticals retired) — `check:profiles` green.
- `check-shipped-source` engine-file governance correction: framework-executed files (engine scripts not manifest-shipped, plus `migrations/v*.js`, whose consumer copies are inert — the runner requires them only from the framework checkout) resolve module-system governance against the framework root `package.json`, fail-closed (only an explicit `"type": "commonjs"` is clean) — `check:shipped-source` green.
- doc-read-audit target attribution (external review, blocking): `matchTarget` was basename-suffix based, so a Read of `docs/architecture.md`, `vendor/*/architecture.md`, or another repo's `architecture.md` was silently valued at the root target's size and contaminated the decision-grade metric with no completeness signal. Attribution now binds by canonical absolute-path equality under the repo root (separators/casing normalised, `.`/`..` resolved, relative Read paths resolved against the root), with regressions proving nested and foreign-repo paths never match.
- doc-read-audit report filename (external review, minor): a date-only name made two same-day runs — exactly the documented baseline/post comparison workflow — overwrite each other. Filenames now embed the window identifiers plus the generation timestamp (still matched by the shipped `references/.doc-read-audit-*.md` gitignore glob), with tests proving two same-date windows and identical-window re-runs all keep distinct artifacts.
- arch:search gap marker atomicity (external review, blocking): the "first telemetry gap" marker was written behind an `existsSync` check — two concurrently-losing processes could race it and the later one would move `firstGapTs` FORWARD, letting the audit call a window complete that already contained the earlier loss. The marker is now created atomically (`flag: 'wx'`, EEXIST = success, never overwritten), with spawn-based regressions: an existing marker stays byte-identical through later losses, and concurrent losing bursts yield exactly one valid marker that later bursts cannot replace.
- doc-read-audit case folding (external review, blocking): the round-1 exact-path fix lowercased ALL paths, silently re-attributing a distinct `/repo/Architecture.md` to the tracked `/repo/architecture.md` on case-sensitive filesystems — the same false-attribution class, via case folding instead of suffixes. Canonicalisation is now path-shape aware: drive-letter/UNC (Windows-contract) paths fold, POSIX absolute paths stay case-exact, relative paths inherit the resolved root's shape, and UNC `//server` prefixes stay distinct from POSIX `/server`. POSIX case-variant negative regressions added alongside the retained Windows positives.

## 2.71.0 — 2026-08-11

**Highlights:** R2 of the fresh-context UAT acceptance gate — the enforcement wiring, shipping DISABLED by default (`uat_rollout_mode` absent = disabled; a consumer that syncs for unrelated reasons runs ZERO UAT lanes and refusal rows 9-10 stay inert). Wires acceptance into finalisation at Step 8c.5 (after G5, before merge readiness) under the plan's §10 enforcement-conditional transition matrix, adds merge-refusal rows 9-10, the `gate_evidence` UAT projection schema delta, the `uat_rollout_mode` flag, the expected-remote-head merge precondition, and a post-merge/post-abort scratch-cleanup step. The §10 matrix and rows 9-10 also ship as EXECUTABLE, tested policy (`scripts/uat/enforcement.mjs`) rather than prose alone. `enforcement` is the single downstream control everywhere — never the raw rollout mode. Enforcement stays dormant until a consumer explicitly flips to `shadow` after the plan §9 forward-validation battery passes (that battery + consumer adoption are the next session's work).

**Added:**
- `scripts/uat/enforcement.mjs` — the §10 enforcement matrix (`deriveEnforcement`, `pipelineAction`, `escalate`) and refusal rows 9-10 (`row9Passes`, `row10Passes`, `baseFreshnessRequired`) as executable policy, with the strict-protection conditioning pair and override rejection tested mechanically.
- `scripts/uat/__tests__/enforcement.test.mjs` + `finalisation-source-contract.test.mjs` — 45 new tests (transition matrix, shadow-fail/incomplete never machine-blocking, strict-protection pair, rows 9-10, ordering, certification tail, disabled-default, manifest coverage). The UAT suite is now 122 tests.
- `uat_rollout_mode` in `.claude/project-registries.json.template` (`disabled | shadow | high-risk | default`; **absent = disabled**).

**Changed:**
- `finalisation-coordinator.md`: inserted **Step 8c.5** (fresh-context UAT acceptance, after G5, before Step 9) with the enforcement-conditional transitions (shadow writes `uat_advisories`, never the blocker field), the `code_candidate_sha`/`certification_head_sha` identity + operation-aware certification tail validated against `certification-commit-manifest.json`; added **refusal rows 9-10** (enforcement+verdict together with override rejection; evidence-binding + staleness always + four-fact strict-protection base-freshness iff `enforcement: blocking`); Step 9/10 preconditions now require a valid UAT gate; the merge command carries `--match-head-commit` (expected-remote-head precondition, always); added **Step 12.6** post-merge/post-abort UAT scratch cleanup (evidence-tier retention preserved); TodoWrite skeleton and row-count updated to 10.
- `schemas/build-status.schema.json`: additive `gate_evidence` UAT projection `{evidence_sha256, code_candidate_sha, enforcement}` (`schemas/CHANGELOG.md` in lockstep; `contract_version` unchanged at `build-status.v2`; nothing to migrate).

## 2.70.0 — 2026-08-11

**Highlights:** R1 of the fresh-context UAT acceptance gate — the reusable machinery, shipping DISABLED by default (absent `uat_rollout_mode` = disabled lands in R2; no consumer runs a UAT lane until it explicitly opts in). Closes the gap where `verify-phase` only *reports* UAT readiness and nothing between final review and merge executes real user workflows — the class of gap that let a `2^53` money-precision defect survive 7,195 green tests. Ships a deterministic evidence contract, a three-class change classifier, the `acceptance-testing` skill, the `acceptance-phase` agent with sealed blind-stage tooling and a hermetic blind-planner runtime contract, a narrower Codex acceptance invocation mode, and the version-controlled Codex `run-final-uat` skill package with an installer. Enforcement wiring (finalisation Step 8c.5, refusal rows, rollout flag) lands in R2. Built to plan `fresh-context-uat-gate` (v8, amendments A1–A10); R1 covers the machinery, not enforcement.

> growth-gate: .claude/agents/acceptance-phase.md — replaces: none — no existing agent runs a fresh-context, evidence-bound pre-merge UAT gate, and verify-phase authors tests in its own context so it cannot run a blind first pass (the calibration defect survived exactly that same-context verification); footprint: 383 bytes
> growth-gate: .claude/skills/acceptance-testing/SKILL.md — replaces: none — test-discipline covers unit/mock test authoring, whereas this skill covers fresh-context real-workflow acceptance reasoning, a distinct failure mode; footprint: 382 bytes

**Added:**
- Evidence contract: `schemas/uat-evidence.schema.json` (candidate/harness identity split, dual risk inventories, structured anti-vacuity, artifact hashes, planner/execution identities, plan digests) + `scripts/uat/validate-uat-evidence.mjs` (deterministic: full §8.6 rejection list, the blind ⊆ final-required ⊆ executed set invariant, risk-baseline superset, recomputed artifact sha256/bytes, secret scan, realpath containment, two-sided plan-digest identity, and rejection of any `uat_enforcement_override` field) + `scripts/uat/canonicalize.mjs` (RFC 8785 / JCS, golden-vector tested) + `scripts/uat/risk-to-scenario-policy.json`.
- Change classifier: `scripts/uat/classify-change.mjs` (three staleness classes — application/harness/inert, unknown→application-impacting; plus independent domain-risk tags) + `classification-registry.example.json`.
- `acceptance-testing` skill (SKILL.md + `scenario-matrix.md`, `evidence-contract.md`, `freshness-and-applicability.md`), routing eval, rule-ledger rows.
- `acceptance-phase` agent + deterministic security-boundary builders `scripts/uat/build-blind-snapshot.mjs` (source export with no `.git`, fail-closed submodule materialisation, hash-bound input manifest), `build-harness-manifest.mjs` (`harness_manifest_sha256` completeness boundary), `build-certification-manifest.mjs` (out-of-band certification tail) + canonical carriers `schemas/uat-plan-blind.schema.json` / `uat-plan.schema.json` + `references/blind-planner-runtime.md` (hermetic contract: isolated CODEX_HOME, web-search/memories off, no resume, clean env allowlist, five-escape adversarial fixture).
- Codex acceptance mode in `references/codex-invocation-contract.md`; third carve-out in `references/test-gate-policy.md`; `references/iteration-caps.md` row 23 (acceptance fix cap 3); `references/runtime-roles.md`, `references/autonomy-ladder.md`, `docs/agent-selection.md` updates.
- Codex `run-final-uat` skill package at `templates/codex-skills/run-final-uat/` (built with the Codex skill-creator; `quick_validate` clean) + `scripts/uat/install-codex-skill.mjs` (installs to consumer `.agents/skills/run-final-uat/` with a drift check). 77 new Vitest tests across `scripts/uat/__tests__/`.

**Changed:**
- `docs/agent-selection.md`: corrected the stale "the one exception is finalisation's G5" — there are now three test-gate carve-outs (G5, verify-phase, acceptance).

**Removed:**
- `tasks/builds/fresh-context-uat-gate/` build-planning docs (bundle-hygiene: only `_example/` may ship under `tasks/builds/`; canonical copies live in the source project).

## 2.69.1 — 2026-08-10

**Highlights:** Consumer-compatibility hotfix for v2.69.0's new preflight test. `scripts/__tests__/review-preflight.test.ts` shipped in `node:test` style, which this repo's runner accepts — but consuming repos collect `**/__tests__/**/*.test.ts` with Vitest AND run a quality gate that REJECTS `node:test`/`node:assert` in any `*.test.ts`. It would therefore have failed every consumer's CI on adoption. Converted to Vitest (19 tests, unchanged coverage). Same class of producer-side blind spot as v2.68.1, now closed for tests as well as lint.

**Fixed:**
- `scripts/__tests__/review-preflight.test.ts`: `node:test` + `node:assert` → Vitest `test`/`expect`; `{ skip }` option → `test.skipIf`. Behaviour and assertions identical; 19/19 pass.

**Changed:**
- `.claude/commands/release.md` step 5b: the consumer gate now covers **test shape** as well as lint — new `*.test.ts` must be Vitest (the standalone-node shape stays valid only for `.claude/hooks/*.test.js`, which consumers run directly), with a grep check that no `node:test`/`node:assert` import ships. Lint alone cannot catch this class.

## 2.69.0 — 2026-08-10

**Highlights:** Completes the ci-efficiency-hardening framework track (F2 + F3, after v2.68.0's F1). The `ready-to-merge` label discipline is now enforced at the point of failure rather than documented: a `git push` on a labelled PR is INTERRUPTED with an executable remediation, so the wasted full-suite re-run cannot happen by accident. Review transports are now probed BEFORE a coordinator commits to a review path, so a missing Codex binary or a capped OpenAI org surfaces at Step 0 instead of halfway through a pipeline. The release protocol also gains the consumer-lint gate that v2.68.1 was needed to undo.

> growth-gate: .claude/hooks/ci-push-guard.js — replaces: none: the label-pull discipline existed only as coordinator prose, and prose cannot stop a push; the sibling `bash-config-guard.js` guards config paths, not push semantics, so no existing hook covers this trigger; footprint: 12333 bytes

**Added:**
- `.claude/hooks/ci-push-guard.js` (hook, PreToolUse `Bash`): blocks `git push` when the pushed branch's PR currently carries `ready-to-merge`. **The predicate is the live label state and nothing else** — an unlabelled branch is never blocked, even with CI in flight (the "block on any run in flight" shape is what gets a guard disabled); in-flight run info appears only as advisory context. The block message names the executable remediation (`label.sh pull --pr N --reason pre-push`, no `--run-id`, no `--slug`). Override is the framework's one-shot HITL sentinel ONLY — deliberately no agent-settable env var. Fails OPEN on absent/unauthenticated/slow `gh` (>3s). Supported refspecs: plain push, `origin <branch>`, `src:dst`; `--all`/`--mirror`/multi-refspec are advisory allows rather than wrong blocks.
- `.claude/hooks/ci-push-guard.test.js`: 30 checks — block/allow matrix, the allow-with-CI-in-flight regression, fail-open paths, one-shot sentinel (including that a different branch's sentinel does not authorise), refspec edges, malformed stdin, and the end-to-end proof that the remediation the guard PRINTS actually succeeds against a fake `gh`.
- `scripts/review-preflight.sh` (helper-script): review-tier transport preflight. Composes the EXISTING `scripts/codex/resolve-codex-bin.sh` and `scripts/verify-chatgpt-model.ts` rather than reimplementing them, so the probe exercises the same code the real reviewers use. Emits one machine-readable line — `REVIEW TIER PREFLIGHT: codex=... openai-api=...` with `PASS|FAIL|UNAVAILABLE|SKIPPED` — and never the reserved `REVIEW_GAP` token. Exit 0 whenever the preflight ran and produced a well-formed block; probe results are DATA, not the script's verdict. The Codex exec probe inherits the mandatory `-s read-only` sandbox from `references/codex-invocation-contract.md` (no unsandboxed fallback: a health probe has no authority to write to the checkout). A capped OpenAI organisation is reported explicitly.
- `scripts/review-preflightPure.ts` + `scripts/__tests__/review-preflight.test.ts` (19 tests): the CALLER side is unit-tested, not just the probes — `parseStatusBlock`, the status→action mapping, `buildRequiredTiers` (mode-aware), and the rule that a non-zero exit and an exit-0-with-unparseable-block are treated IDENTICALLY as `UNAVAILABLE` for every required tier (a crashed preflight must not be softer than a failed probe).

**Changed:**
- `spec-coordinator.md`, `feature-coordinator.md`, `finalisation-coordinator.md`: Step 0 now runs the preflight with a `--require` set built AFTER task class AND review mode are resolved. Capabilities are TRANSPORTS, not review tiers: `openai-api` probes the Responses API, which manual ChatGPT-web review never touches, so manual mode reports `SKIPPED` instead of manufacturing a gap. `codex` is required for Standard+ in Phases 1-2 (feature-coordinator's Step 3c `plan-reviewer` is unconditional) and ALWAYS in Phase 3 (Codex-owned `verify-phase`). A completed transport fallback is recorded as `transport fallback: automated→manual`, **not** a `REVIEW_GAP` — that artifact stays reserved for a review genuinely skipped.
- `.claude/settings.json`: `ci-push-guard.js` appended to the PreToolUse `Bash` group (settings-merge, verified duplicate-free).
- `.claude/commands/release.md`: NEW step 5b — **consumer-lint gate**. Every `.js`/`.mjs`/`.cjs`/`.ts` added or modified since the previous tag must be linted with a CONSUMING repo's ESLint config before the release commit. Framework CI does not run consumers' rule sets, which is exactly how v2.68.0 shipped a `no-useless-assignment` error that turned automation-v1's trunk red and made v2.68.1 necessary. Fixes go upstream, never as a local edit to a synced file. (The gate caught two real errors in this very release's test file.)
- `manifest.json`: sync entries for all five new files.

## 2.68.1 — 2026-08-09

**Highlights:** Consumer-lint hotfix for the v2.67.0 description-budget gate. `scripts/gates/verify-description-budgets.mjs` used the `let x = []; try { x = … } catch { x = [] }` idiom in three places; the dead initialiser trips ESLint's `no-useless-assignment` **as an error** under a consuming repo's config, so the file failed `npm run lint` in every consumer that adopted v2.67.0+ with that rule enabled — turning a green framework release into a red consumer trunk. Caught by automation-v1's labelled CI immediately after the v2.68.0 adoption.

**Fixed:**
- `scripts/gates/verify-description-budgets.mjs`: drop the dead `= []` initialisers (`let entries;` + the existing `catch { entries = []; }` fallback). Behaviour identical — the gate still reports `violations=0` and its 12 self-tests pass.

**Process note (producer-side rule this release enforces):** every new or modified framework `.mjs`/`.js` file must be linted with a CONSUMING repo's ESLint config before release, not just the framework's own. Framework CI does not run the consumers' rule sets, so a rule enabled downstream (here `no-useless-assignment`) is invisible upstream until it breaks a consumer's trunk.

## 2.68.0 — 2026-08-09

**Highlights:** First slice of the ci-efficiency-hardening framework track (F1): the `ready-to-merge` label-pull discipline is now mechanised. `scripts/ci/label.sh` is an audited state machine around the merge-label lock — journalled pull/restore with durable intent records and crash recovery, a shared slug resolver, and a restore that fails closed on three-way SHA agreement (local HEAD == PR head == journal parity SHA) plus evidence-class match, HITL-overridable. The finalisation coordinator's Step 11 first-failure action is now a numbered sequence with the label pull as command #1, and check→class mapping fails closed on unrecognised check names (`CLASS_UNRESOLVED`). F2 (push-guard hook) and F3 (review-tier preflight) follow in a later release.

**Added:**
- `scripts/ci/label.sh` (helper-script, sync): subcommands `pull` / `restore` / `parity` / `refile` / `reconcile`; journal + lock under `$(git rev-parse --git-dir)/ci-label/` (untracked, per-worktree); typed outcomes (PULLED / ALREADY_ABSENT / RESTORED / ALREADY_PRESENT / RECOVERED_AUDIT / SLUG_UNRESOLVED / NO_PARITY_EVIDENCE / SHA_MISMATCH / NO_OPEN_PR); input validation (numeric ids, slug path-containment, single-line bounded values); `GH_BIN` test seam; `LABEL_HITL_OVERRIDE` for the human bypass.
- `scripts/ci/label.test.mjs` (helper-script-test, sync): 13 fake-`gh` Vitest cases — all typed outcomes, pre-push pull + fail-closed restore, SHA-mismatch, HITL override, crash reconciliation, stale-lock reclaim, and the terminal-state proof (label present + heads equal + journal parity present).

**Changed:**
- `finalisation-coordinator.md` Step 11 label-pull discipline: numbered sequence (pull via label.sh as command #1 → fix → one push → journal parity evidence → fail-closed restore → re-watch); caller-side KNOWN-CHECK class mapping with fail-closed `CLASS_UNRESOLVED` on unknown names (per-repo table lives in the consuming repo's `agent-context.md`); pre-adoption `gh pr edit` fallback preserved. The journal (never a tracked file) carries audit + parity records, so the loop closes porcelain-clean and the progress.md summary is informational, never a merge prerequisite.
- `feature-coordinator.md`: label batching rule on every push — while `ready-to-merge` is present, pull first (no in-flight-fix exception); docs-only commits ride the next functional push.
- `manifest.json`: sync entries for both new files.

(No new agents, skills, hooks, or commands — no growth-gate declarations required; the two additions are non-always-loaded helper scripts.)

## 2.67.1 — 2026-08-07

**Highlights:** Defensive hardening of the v2.67.0 description-budget gate. No behavioural change for any current agent/skill/command file — a robustness + test-coverage patch surfaced by the v2.67.0 PR review.

**Fixed:**
- `scripts/gates/verify-description-budgets.mjs`: the block-scalar detector now recognises YAML block headers carrying indentation and/or chomping indicators (`>2`, `|-4`, `|2-`), so such a `description:` is measured as a block scalar instead of being mis-parsed as an inline plain scalar. Detection-only — the indent is still auto-derived from the content lines.
- `scripts/gates/verify-description-budgets.test.mjs`: added coverage for the literal (`|`) block scalar (under + over budget), single-quoted inline unwrapping, escaped-double-quote unescaping, and the `>2` indent-indicator path, closing the gap between the extractor's implemented scalar styles and its tests (self-test now 12 cases).

## 2.67.0 — 2026-08-07

**Highlights:** Always-loaded and per-dispatch context-cost reductions measured at a live consumer (cryptotrackr, ~90-session transcript audit, 2026-08-07): agents read only their own agent-context.md section, description frontmatter is trimmed to WHEN-TO-INVOKE signals, the memory digest caps each recent-knowledge entry, the doc-size gate is wired into the cleanup surfaces, and the code-graph cache becomes opt-in. One new BLOCKING release gate (`verify-description-budgets.mjs`). No additions to the growth-gate behavioural surface (`.claude/{agents,skills,hooks,commands}`).

**Added:** `scripts/gates/verify-description-budgets.mjs` (+ test) — BLOCKING frontmatter description-budget gate (agents 400B / skills 450B / commands 180B), registered in the /release gate step and `references/doc-size-budgets.md`. It lives under `scripts/gates/`, NOT the always-loaded surface, so no growth-gate declaration is required.

**Changed:**
- Sectioned agent-context read contract in all 29 agent files: each agent Greps `agent-context.md` for `## ` boundaries and reads only the binding preamble plus its own `## <name>` section, never the whole file (~27KB/dispatch saved at one consumer; 24 of 29 agents have no section). Template preamble, ADR-0006, `ADAPT.md`, and the local-override e2e read-instruction pin aligned.
- 32 description trims (19 agents, 8 skills, 5 commands) to WHEN-TO-INVOKE signals; procedure stays in file bodies. Skill-routing eval regression-checked (0 errors, rank-1 at the 92% baseline).
- memory-digest per-entry cap on the recent-knowledge block (`KNOWLEDGE_ENTRY_MAX_LINES = 12`, heading excluded), with a shared `### [` / `## ` entry predicate matching `verify-doc-size`'s live-entry census so a bare `### Subheading` no longer resets the cap or counts as a recent entry.
- doc-size enforcement wired in: cleanfiles target 15 turns `[action-needed]` rows into archive actions; finalisation Step 8 archives todo.md debt and surfaces standing doc debt at every merge; `CLAUDE.md` joins the budget table (16KB / 400 lines, advisory).
- code-graph demoted to on-demand (FUQ-2): the shipped `settings.json` no longer registers the SessionStart freshness hook (the hook ships as an opt-in library, allowlisted under `hookLibraries`), the no-args build exits without a watcher (`--watch` / `--watch-only` start one), `project-map.md` carries a generated-on stamp, and zoom-out treats the map as rebuild-first.

**Breaking:** none. The code-graph default behaviour intentionally changes from always-on / session-start to opt-in; consumers relying on the previous watcher or SessionStart freshness check must explicitly opt back in (re-add the one `settings.json` SessionStart entry and use the `--watch` flag, documented in the hook header).

**Fixed:** `validate-framework` hook-wiring no longer fails on the now-unregistered code-graph hook — it is declared under `hookLibraries` in `scripts/validate-framework-allowlist.json` (the opt-in-hook skip), and the allowlist comment now documents intentionally-unregistered opt-in entry hooks alongside require()d libraries.

## 2.66.6 — 2026-08-07

**Highlights:** patch — lint hygiene for the files shipped in 2.66.x. The framework repo has no lint lane, so a consuming repo's `eslint` CI was the first place these surfaced; they are dead initialisers only, no behaviour change.

**Fixed:**
- `scripts/gates/verify-doc-size.mjs` and `scripts/cleanfiles-audit-headless.test.mjs`: three `no-useless-assignment` errors — `entries`, `childAlive`, `grandchildAlive` were each initialised and then reassigned on BOTH the `try` and `catch` paths, so the initialiser could never be read. Declared without an initialiser.

**Note for framework contributors:** shipped `.mjs`/`.js` under `scripts/` and `.claude/hooks/` is linted by consumers even though this repo has no lint gate. Until a lint lane exists here, run a consumer's `npx eslint <synced paths>` after touching shipped scripts.

## 2.66.5 — 2026-08-07

**Highlights:** patch — fifth review round on the F1 safety controls, closing two High lifecycle gaps (an unbounded number of hung background rebuilds; POSIX killing only the direct child) and two Medium hardenings. No behavioural-surface additions; no migration. The locking ACQUISITION protocol is unchanged from v2.66.4 — this release is about process lifecycle.

**Fixed:**
- `code-graph-freshness-check.js` (High): the rebuild lock directory now records `owner.pid` once `'spawn'` confirms, and a stale takeover KILLS that owner's process tree (POSIX process-group SIGKILL / Windows `taskkill /T /F`) before reaping. Moving the rebuild detached in v2.65.0 had removed the old synchronous `BUILD_TIMEOUT_MS` lifetime bound, so a rebuild that spawned and then hung would never touch the lock mtime, be reaped every 10 minutes, and accumulate hung processes without bound. Killing on reap bounds live rebuilds to AT MOST ONE: a takeover now implies its predecessor is dead. Test: a live ignore-SIGTERM owner is provably dead after the takeover.
- `scripts/cleanfiles-audit-headless.mjs` (High): on POSIX the audit child is spawned `detached` so it leads its own process GROUP, and the timeout path signals the group (`kill(-pid)`) — graceful SIGTERM, then uncatchable SIGKILL. A headless Claude run spawns subprocesses; killing only the immediate child left those grandchildren orphaned for an unattended scheduler. Test: the stub spawns an ignore-SIGTERM grandchild and both pids are proven dead after the wrapper returns.
- `code-graph-freshness-check.js` (Medium): context-pack inputs are now CONTENT-HASHED (sha1) in the audit fingerprint, so a same-size edit with a preserved mtime re-triggers the audit. `architecture.md` remains size+mtime as a deliberate, now explicitly documented, session-start latency tradeoff — the comment no longer claims "any edit" is detected.
- `scripts/cleanfiles-audit-headless.mjs` (Medium): on Windows — the wrapper's primary scheduled deployment target — the command is invoked through the shell with explicit per-arg quoting, so an npm-installed `claude.cmd` shim actually runs (Node refuses to spawn `.cmd` directly since the CVE-2024-27980 hardening, and `shell: true` arg joining does not quote embedded spaces like `/cleanfiles audit`). A win32-gated `.cmd` fixture test proves shim execution and exit-code propagation; on POSIX it records an explicit skip rather than silently passing.

## 2.66.4 — 2026-08-07

**Highlights:** patch — fourth review round on the F1 safety controls: two High (the lock takeover was still raceable; the timed-out audit child was left as an orphan) and two Medium. No behavioural-surface additions; no migration.

**Fixed:**
- `code-graph-freshness-check.js` (High): the rebuild lock is now a DIRECTORY (mkdir is the atomically-exclusive filesystem primitive on POSIX and Windows), and stale takeover elects a SINGLE reaper via a second atomic mkdir, then RE-CHECKS staleness while holding the reaper lock. This closes the last takeover race (a contender acquiring the reaper after another reaper finished could otherwise reap the now-fresh lock). Provable invariant: the main lock is replaced only while holding the reaper lock, which admits exactly one holder. The concurrency test (6 simultaneous contenders → exactly one takeover) is deterministic across 75+ stress runs; the prior rename-quarantine variant reproduced two winners.
- `scripts/cleanfiles-audit-headless.mjs` (High): after the graceful kill and grace window, the wrapper now FORCE-terminates the child — POSIX `SIGKILL` (uncatchable), Windows `taskkill /PID <pid> /T /F` (whole tree) — so a child that ignores termination is not left running as an orphan for an unattended monthly scheduler. The test records the child pid and asserts it is dead after the wrapper returns.
- `scripts/gates/verify-growth-gate.mjs` (Medium): declaration-target ownership is now a whole-token match, not a substring. A target of `.claude/agents/foo.md.backup` no longer counts as declaring `.claude/agents/foo.md`, and the bare-name fallback no longer matches a stem embedded in a path (path-form targets are matched by full path only).
- `code-graph-freshness-check.js` (Medium): the audit fingerprint is now `name:size:mtime`. A content change that preserves the mtime (coarse filesystem timestamp resolution, restore/copy tools, or explicitly-preserved timestamps) now re-triggers the audit instead of being skipped.

## 2.66.3 — 2026-08-07

**Highlights:** patch — third review round on the F1 safety controls: two High (a still-raceable lock takeover; declaration ownership matching the wrong field) and two Medium. No behavioural-surface additions; no migration.

**Fixed:**
- `code-graph-freshness-check.js` (High): stale-lock takeover is now genuinely atomic. The prior remove-then-exclusive-create was raceable — two contenders that both saw the stale lock could interleave so that one removes the other's freshly-created lock and both proceed. Takeover now RENAMES the exact stale inode to a unique quarantine name; `rename(2)` is atomic, so of N contenders only one rename of that inode succeeds and the rest get ENOENT and back off. A concurrency test (6 simultaneous contenders) asserts exactly one takeover.
- `scripts/gates/verify-growth-gate.mjs` (High): declarations are parsed into structured `target — replaces: … ; footprint: …` fields, and a new file's ownership is matched ONLY against the target, never against the `replaces:`/`footprint:` values. A file whose name appears only inside another declaration's `replaces:` rationale is no longer treated as declared (adversarial two-addition test added).
- `scripts/cleanfiles-audit-headless.mjs` (Medium): the per-run timeout is now HARD. After the kill signal, a bounded grace timer settles the wrapper as 124 even if the child ignores the signal or never emits `'close'`, so the wrapper's wall time stays bounded (test with an ignore-SIGTERM child). Note: on Windows `child.kill()` still terminates only the immediate child, not the whole tree.
- `code-graph-freshness-check.js` (Medium): the spawn-settle timeout is a distinct third outcome, not success. If `child.pid` is set it is positive evidence the process was created (treat as spawned); otherwise the hook fails open — warns that spawn status is unconfirmed and releases the lock — rather than reporting a rebuild that may never have started.

## 2.66.2 — 2026-08-07

**Highlights:** patch — second focused review round on the F1 safety controls closed one High and four Medium residues left by v2.66.1. No behavioural-surface additions; no migration.

**Fixed:**
- `scripts/cleanfiles-audit-headless.mjs` (High): a failed spawn emits `'error'` AND then `'close'`; the wrapper ended/exited from each, racing a write-after-end on the log stream. Now a single `settled` flag owns settlement, a `log.on('error')` listener keeps a stream failure from crashing the wrapper, and the stdio pipes are guarded against a null-stream spawn failure. A non-existent executable now exits exactly `127` with a clean log (test added).
- `scripts/gates/verify-growth-gate.mjs` (M1): `replaces:` must carry a real value — `replaces: ; footprint: 1200 bytes` no longer passes, because the `;` delimiter is not a value. The value is parsed and required to contain a word character (adversarial test added).
- `scripts/gates/verify-doc-size.mjs` (M2/H4): doc-sync registration now reads the first-column backtick PATH of a registry table ROW, not any code span anywhere in the file — a backticked path mentioned in prose (e.g. "do not register …") no longer false-greens the megadoc gate (negative test added).
- `code-graph-freshness-check.js` (M3): the hook previously `process.exit(0)`'d synchronously right after the detached spawn, so the async `'error'` was dropped (no crash, but also no cleanup or warning). It now defers exit to the `'spawn'`/`'error'` event (`unref()` only on `'spawn'`), so a failed spawn emits the visible fail-open warning and releases the rebuild lock; a bounded settle-timeout keeps session start from ever hanging (test asserts the warning + lock cleanup).
- `scripts/gates/verify-growth-gate.mjs` (M4): the file header + config section now document the fail-CLOSED default for an unresolvable baseline and the `GATE_GROWTH_ADVISORY` escape hatch (they still described the removed fail-open behaviour).

## 2.66.1 — 2026-08-07

**Highlights:** patch — hardening of the F1/F1-growth safety controls after an external code review found seven real defects in the mechanisms v2.65.0 + v2.66.0 introduced. These are the classic ways a safety control lies: fail-open enforcement paths, non-atomic concurrency, an async error that could crash the very hook meant to fail open, a dedup that discards unique data, and a substring registration check that false-greens. No behavioural-surface additions; no migration.

**Fixed:**
- `code-graph-freshness-check.js` (H1): the detached rebuild now registers a `child.on('error')` handler, so an async `spawn` failure (e.g. `npx` not on PATH → ENOENT) is caught and the hook stays fail-open instead of crashing session start on an unhandled `error` event. The lock is cleared on the error.
- `code-graph-freshness-check.js` (H2): stale-lock takeover is now atomic — remove the stale lock then re-create it with an exclusive `wx` write, which is the arbiter. Two sessions that both observe the same stale timestamp can no longer both "take over" and launch duplicate rebuilds.
- `code-graph-freshness-check.js` (M2): the audit stamp is a membership fingerprint (`name:mtime` per input, sorted), not a max mtime. Deleting a context-pack now changes the fingerprint and re-triggers `audit-context-packs` instead of being silently skipped because the remaining max mtime fell below the stamp.
- `memory-digest.js` (H3): index-matched entry dedup is now EXACT body equality (normalised body, title excluded), not "≥50% of lines already shown". The overlap heuristic could discard a genuinely-new entry that shared boilerplate/template lines with a shown one, silently losing unique knowledge.
- `scripts/gates/verify-doc-size.mjs` (H4): docs/ root-file registration is matched against backtick-quoted PATH tokens in `doc-sync.md` (full repo-relative path or exact filename), not an arbitrary substring. `docs/plan.md` no longer counts as "registered" because the word "plan" appears somewhere in the registry prose.
- `scripts/gates/verify-growth-gate.mjs` (H5): the growth gate now FAILS CLOSED (exit 1) when a previous version exists but its baseline ref is unresolvable (tagless/shallow checkout, bad ref, git failure). The first release (no previous version) still passes. `GATE_GROWTH_ADVISORY=1` opts into local advisory (warn, exit 0).
- `scripts/gates/verify-growth-gate.mjs` (M1): declarations must carry a non-empty `replaces:` value and a conforming `footprint:` (`<N> bytes` or `not-always-loaded`); an empty `replaces: ; footprint:` no longer passes. A bare-name-only declaration shared across two additions is rejected in favour of the full path.

**Not changed (reviewed, out of scope):** `board-sync.mjs`'s non-zero `EXIT_NOT_SYNCED` is v2.64.1's deliberate observable-but-non-blocking contract (coordinators record + report it, per that release); it predates this batch and is unchanged here.

## 2.66.0 — 2026-08-07

**Highlights:** minor — the F1 prevention batch's last guardrail (report C5 / plan I5). New always-loaded behavioural additions (agents, skills, hooks, commands) can no longer land in a release without justifying their footprint. This closes the anti-bloat loop that v2.65.0 opened: v2.65.0 cut the accumulated cost and added the doc-size gate; this release stops the fleet/skill/hook/command surface from quietly regrowing it. The enforcement point moved here from the retired `validate-setup` agent to a deterministic release-flow gate.

**Added:**
- `scripts/gates/verify-growth-gate.mjs` (+ test): diffs files ADDED under `.claude/{agents,skills,hooks,commands}/` since the previous release tag and fails (exit 1) if any lacks a `> growth-gate: <path> — replaces: <what|none: why>; footprint: <N bytes|not-always-loaded>` declaration in the current CHANGELOG section. Fails-open only when the previous tag is unresolvable (tagless/shallow checkout). Precision over recall: only the four behavioural file classes are diffed; new tiers / always-loaded doc sections are declared in prose per the release checklist.

**Changed:**
- `/release` (`.claude/commands/release.md`): step 5 now requires a `> growth-gate:` declaration line per new behavioural file; step 7 runs `verify-growth-gate.mjs` after the CHANGELOG is written, before the release commit.

## 2.65.0 — 2026-08-07

**Highlights:** minor — the F1 cost-optimization batch. A full-audit of the framework found the always-loaded and per-build context had grown far past what the work needed; this release cuts the safe, non-posture drivers and adds standing guardrails so the bloat cannot silently regrow. Three low-invocation agents retire, the session-start digest and context-pack loading get guard-rails, and a new doc-size gate plus overwrite-not-append conventions hold the line. Review-posture changes (reviewer-tier thinning, model demotions, playbook slimming) are deliberately NOT in this release — they ship as separately-gated staged releases. Migration `v2.65.0.js` ships (session-state gitignore).

**Migration:** `v2.65.0.js` — appends `.claude/session-state/` to the consumer `.gitignore` when absent (idempotent, non-destructive), so the mtime-gated hook stamps + rebuild lock introduced in this release never dirty a consumer working tree. Auto-covered by the `migrations/v*.js` runner glob.

**Deprecated:**
- Retired three low-invocation agents to `.claude/agents/_retired/*.md.retired` (removed from the active `.claude/agents/*.md` fleet; `removedFiles` manifest entries warn consumers to drop the stale copies): `codebase-explainer` (human onboarding tour — overlaps `architecture.md` + repo docs), `validate-setup` (read-only health check — role now `/framework-doctor` + the deterministic gates; its aspirational build-failing enforcement was never a real CI gate, and genuine agent-divergence enforcement is `/claudeupdate`'s 6d2 guard), `experiment-runner` (metric-optimisation loop — never a required stage; its tested pure helper `scripts/experiment-runner-loopPure.ts` is retained). Reference cascade swept in the same change: rule-classification ledger rows, the dead `experiment-eligible` sections in `triage-agent`/`bug-fixer`, README/ADAPT FULL enumerations, enforcer claims repointed to the real mechanisms, and `check-profiles` fixture. The new-agent/skill/hook **growth gate** (report C5) moves to the release checklist (plan I5) now that `validate-setup` no longer hosts it.

**Added:**
- `scripts/gates/verify-doc-size.mjs` (+ test, + `references/doc-size-budgets.md`): control C1 — warning-level size budgets on the accretion-prone docs (current-focus operator portion, todo.md, KNOWLEDGE.md, architecture.md, capabilities.md, docs/ root new-megadoc prevention with a consumer grandfather baseline `.claude/doc-size-baseline.json`). Grace annotations on KNOWLEDGE/architecture/capabilities until their remediation chunks land.

**Changed:**
- `memory-digest.js` (control A8): hard ~8KB byte cap alongside the line cap, 200-char per-line truncation, focus block stops at `### Machine-readable`, body-hash dedupe, reduced entry caps — a real consumer's session-start digest dropped 22.3KB → 6.2KB.
- `sync.js` (control A5): finalises a context pack's `Status: template` → `Status: mapped` and strips the adoption note only when zero unresolved `{{ARCHITECTURE_ANCHOR:` tokens remain; `architect`/`builder`/`pr-reviewer` fallback gates narrowed to unsubstituted anchors in the `## Sources` block; `audit-context-packs.ts` false-green fixed.
- `code-graph-freshness-check.js` (control A10): mtime-gated `audit-context-packs` spawn, detached-with-atomic-lock rebuild on the watcher-dead cold path (no more blocking ≤120s), runtime state under gitignored `.claude/session-state/`.
- Skill descriptions (control A9): trimmed 7 over-length framework descriptions (kept every trigger + NOT-for clause; `eval:routing` recall gate stays green at 92% rank-1).
- Dispatch gates (control A11): `architect`/`spec-coordinator` skip the cross-repo-scout dispatch unless `sibling_repos[]` warrants it; the five grep-heavy agents exclude `.claude-framework/` by default.
- `phase-lock.js` (control A4, framework half): removed the `docs/superpowers/specs/**` spec/plan allow-glob so new spec writes outside `tasks/builds/<slug>/` are blocked.
- Coordinators (control C2): overwrite-not-append rule for the current-focus operator pointer block in `feature`/`spec`/`finalisation-coordinator`; `generate-current-focus.mjs` contract note.
- `finalisation-coordinator` (control C4): Step 8a `.gitignore` review-logs check made fail-loud; dropped a dangling `review-logs/README § Retention` citation; post-merge step archives the merged build dir.
- `cleanfiles.md` (control C6): target 14 reports any `context-load: full architecture.md` fallback in the most-recent build's logs (per-session budget regression signal).

**Fixed:**
- `check-migrations` version-ceiling + CHANGELOG-coverage findings for `v2.65.0.js` clear with this release (version bump + this entry's `v2.65.0.js` mention). The 4 pre-existing test-coverage findings (v2.8.0/2.12.0/2.13.0/2.27.0) predate this work and are unchanged.

## 2.64.1 — 2026-08-06

**Highlights:** patch — the build board could stop being written to and nothing would say so. `board-sync.mjs` now emits a stable `NOT_SYNCED` marker and a distinct exit code on any run that did not reach the board, and the three coordinators are required to report that to the operator in-session rather than only to `progress.md`. Found in a consuming repo where `projects_board` had never been recorded: `loadBoardConfig()` returned null, the script warned and exited 0, and every coordinator push was a silent no-op for an unknown number of builds. The only thing that eventually surfaced it was an operator opening the board and finding an empty column. The board remains a view, not a gate — this change buys observability, not enforcement.

**Added:**
- `board-sync.mjs`: `EXIT_NOT_SYNCED` (3), the frozen `NOT_SYNCED_REASONS` set, and the pure helpers `buildNotSyncedMarker()` / `notSyncedReasonFromDiagnostic()`, all exported so the did-not-sync contract is unit-testable without shelling out to `gh` (the thin I/O layer stays untested by design). Marker format `[board-sync] NOT_SYNCED reason=<reason>` is contract; callers grep `NOT_SYNCED reason=`.
- Every did-not-reach-the-board path now signals: missing config, unresolvable repo identity, `gh` failure reading board state (carrying the existing permission diagnostic through to a typed reason), board-contract mismatch, per-card sync failure, and the top-level unexpected-error catch. A single stale card is the same class of bug as a run that never landed, so per-card failures set it too.
- spec-, feature- and finalisation-coordinator: a **board preflight** at context load — check `projects_board` is recorded and that `gh` can actually read the board, and tell the operator once, up front, with the exact remediation for each (record the config, which travels with the repo; or `gh auth refresh -s project`, which is per-machine because the token lives in the OS keyring).
- 9 tests covering marker format, the exit code being distinct from `--init`'s 1, diagnostic-to-reason mapping, unclassified failures degrading to `gh_failure` rather than being mislabelled a permission problem, and the reason set staying closed and frozen.

**Changed:**
- All three coordinators' § Status contract: "Board-sync is non-blocking" becomes "non-blocking, but never silent" — on the marker the coordinator MUST both record it and report it to the operator in the same message as the phase transition. The build still never stops.
- `board-sync.mjs` header contract: the "always exits 0 on the sync path" clause is replaced by fail-open-but-observable, with `--init`'s exit 1 explicitly reserved for operator-input errors so the two codes are never confused.

## 2.64.0 — 2026-08-05

**Highlights:** minor — wire the finalisation learning loop into canon. The finalisation-coordinator now routes each extracted lesson to zero-to-many destinations (a skill overlay, an upstream queue) alongside its single `Target`, the KNOWLEDGE.md entry template is indexable by construction and enforced by the append guard, and `/cleanfiles audit` is genuinely read-only with a durable monthly clock. This is the first tracked run of the project-to-framework learning loop.

**Added:**
- `templates/framework-upstream-queue.template.md`: bootstrap for the consumer upstream-queue ledger the coordinator creates on first use.
- `docs/examples/learning-routing-fixture.md`: the worked Step 7a routing fixture (three-effect example, two-cycle unattended-produce then attended-drain, duplicate-production no-double-append, and same-day/same-title/different-category identity cases).
- `scripts/cleanfiles-audit-headless.mjs` (+ test): thin scheduler wrapper for `/cleanfiles audit` supplying cwd pinning, dated external-log redirection, a per-run timeout, and exit-code propagation the Windows Task Scheduler cannot express in a task action alone.
- finalisation-coordinator Step 7a: `Overlay mirror?` and `Upstream queue?` destination-effect columns, recurrence escalation (Rule 2), overlay coverage check (Rule 3), pending-mirror drain (Rule 4), a worked-fixture reference, and a ninth `Target` enum value `required-parameter/type-contract`.
- cleanfiles.md: a queue-staleness sweep target (target 13, read-only, 180-day) and a "Wire the clock" deployment section (operator-owned monthly Desktop scheduled task, external dated-log sink, repository-purity vs external-operational-output invariants).

**Changed:**
- finalisation-coordinator Step 7 KNOWLEDGE.md template is now the indexable `### [YYYY-MM-DD] [Category] -- [Pattern title]` form, and Step 7 closes with an index dry-run assertion. The v1 auto-apply prohibition is replaced by the normative destination write-authority truth table (`Target` stays todo-only in all contexts; queue rows are non-binding in-cycle bookkeeping; overlay mirrors are operator-gated, with an unattended pending-mirror path).
- `knowledge-append-guard.js`: newly-appended KNOWLEDGE.md headings must match the indexable dated form, else block-with-guidance; scoped to the new content only, so legacy H2 entries never block an unrelated append.
- `cleanfiles.md` target 11 uses the index generator's `--dry-run` path in audit mode; audit mode is now write-free by contract.

**Fixed:**
- `/cleanfiles audit` no longer regenerates the knowledge index (a header-timestamp rewrite) in audit mode, restoring the mode's read-only contract.

## 2.63.1 — 2026-08-04

**Highlights:** patch — one comment line upstreamed from automation-v1.

**Fixed:**
- `.claude/hooks/path-portability-guard.js`: carry the `eslint-disable-next-line no-control-regex` annotation on `INVALID_CHARS_RE` in canonical. automation-v1 lints its `.claude/hooks/` and added the comment locally (CI remediation #748), which made the hook diverge from canonical and trip the behavioural-divergence guard on every `/claudeupdate`. Consumers that lint hooks get a clean pass; consumers that do not are unaffected — the change is a comment.

## 2.63.0 — 2026-08-03

**Highlights:** Five contract additions distilled from the 2026-08-02 gstack cross-repository audit, shipped as one release because each is an additive schema change and separate releases would cost consumers five sync cycles. Reviewer findings gain evidence provenance and a review lens; work packets gain a capability-removing `execution_policy` with a normative composition contract and canonical hash; completion packets echo the effective policy, classify documentation impact, and attach release evidence. Everything here DECLARES — no enforcement authority, no merge or deploy capability, no external persistence, and nothing that can grant an authority a role did not already have.

**Breaking:** none. Every field is optional and every `contract_version` is unchanged; a frozen pre-2.63.0 work packet and completion packet are asserted still-valid in the suite. Consumers need no migration — `sync.js` ships the schemas, two new helper modules and two new references, and nothing reads the new fields yet.

**Added:**
- `review-finding.schema.json`: optional `confidence`, `evidence_kind`, `verification_state` (the fable-mode `verified | inferred | assumed` vocabulary) and `lens`.
- `work-packet.schema.json`: optional `execution_policy` — `write_scope`, `protected_paths`, `destructive_actions`, `credential_access`, `network_egress` + `egress_allowlist`, `deploy_authority` (a `const false`), `expires_at`.
- `completion-packet.schema.json`: optional `effective_policy`, `effective_policy_hash`, `policy_evaluation` (`passed | violated | not_evaluated`), `policy_violations`, `documentation_impact`, `changed_docs`, `doc_exemption_reason`, `release_evidence`.
- `references/execution-policy.md` — normative composition, normalization and hashing semantics, plus the explicit enforcement boundary.
- `references/review-lenses.md` — the four plan-review lenses and the coverage-versus-tagging distinction.
- `scripts/packet-contract/execution-policyPure.mjs` — `normalizeExecutionPolicy`, the single sanctioned computation of an effective policy and its hash.
- `scripts/packet-contract/packet-semanticsPure.mjs` — bounded semantic invariants shared by both validator modes.

**Changed:**
- `validatePacket` now returns `{ok, errors, warnings}` (previously `{ok, errors}`) and runs the semantic layer after the structural check. The floor reads only top-level `required`/`enum`/`const`, so nested policy and release-evidence invariants would otherwise hold only where Ajv happens to be installed; deleting the semantic call fails 23 tests across both modes. Review closed six further fallback-only gaps across two rounds: undeclared keys inside the policy and release-evidence objects (the authority-shaped one), `Date.parse` accepting date-only, timezone-less and impossible-calendar `expires_at` values that `ajv-formats` rejects, `policy_evaluation: violated` passing when `policy_violations` was omitted rather than empty, and unvalidated array contents (non-string, empty-string and duplicate entries) in `policy_violations`, `changed_docs`, `evidence_paths` and `egress_allowlist`. The durable fix is a coverage guard: `SEMANTICALLY_COVERED_PATHS` plus a test that walks both schemas and fails when any value-level constraint has no semantic-layer counterpart and no documented legacy exemption — verified by adding a constrained property and watching the suite name it. `FLOOR_UNCOVERED_LEGACY_PATHS` inventories 26 pre-existing fields whose constraints the floor has never enforced; closing those changes validation of contracts consumers already emit and belongs in its own change.
- `.claude/agents/builder.md`: the chunk verdict block gains Documentation impact / Changed docs / Doc exemption reason, with the classification convention. A contract field with no instructed producer is a field nobody fills in.
- `.claude/agents/claude-plan-review.md`, `plan-reviewer.md`, `chatgpt-plan-review.md` and `SYSTEM_PROMPT_PLAN_V2`: a lens sweep on every plan review, plus a five-line decision brief in the prose logs. `prompt_version` deliberately stays `openai-plan-review.v2` — that identifier names the prompt tier, not each content revision.

**Deliberately not adopted from the audit:** wholesale vendoring, an auto-update control plane, autonomous merge or deploy authority, external memory persistence, browser-cookie import, and duplicate generic personas. The browser-QA adapter, local learnings store and model-benchmark envelope are deferred pending a benchmark rather than built.

## 2.62.0 — 2026-08-02

**Highlights:** Runtime-neutral pilot, Phases A + C plus the non-live half of Phase B (`framework-runtime-neutral-v3`). Work-packet and completion-packet JSON Schemas formalise the existing builder dispatch/verdict shapes into a contract any runtime's Builder path can validate against, with a round-trip harness proving structural comparability across a Claude-path and an OpenClaw-path fixture. `build-status.v2` gains optional additive runtime-identity fields (a build-level `runtime` object plus per-`log[]`-entry `runtime`/`role` stamps) so a future OpenClaw Builder run is attributable without invalidating any existing `status.json`. `references/runtime-roles.md` is the one canonical config point recording the two supported runtime/role mappings. A writer-side transition validator, board-sync permission diagnostics, and a recovery-state detector round out the release. **Live OpenClaw enablement is deferred** — see Deferred below.

**Added:**
- `schemas/work-packet.schema.json`, `schemas/completion-packet.schema.json` — draft-07 contracts (`work-packet.v1` / `completion-packet.v1`) formalising the existing dispatch prompt and builder verdict block; `completion-packet`'s `status` enum matches the builder verdict set (`SUCCESS`, `PLAN_GAP`, `G1_FAILED`) exactly.
- `scripts/packet-contract/validate-packet.mjs` (+ test) — `validatePacket(kind, obj)` round-trip harness (Ajv with a structural-floor fallback) plus fixtures (`work-packet.example.json`, `completion-packet.claude.json`, `completion-packet.openclaw.json`) proving the Claude and OpenClaw completion shapes are structurally comparable.
- `references/runtime-roles.md` — canonical runtime/role mapping: Claude Code as Coordinator/Architect/Builder/Reviewer/Test-Author/Finaliser; OpenClaw as sequential Builder only, stopping at `MERGE_READY`; the per-stage/per-commit runtime-identity stamping contract.
- `scripts/status/transition-validator.mjs` (+ test) — pure, never-throws `validateTransition(from, to, {hasBlocker})` encoding the `build-status.v2` forward path and its four blocker-gated back-edges, read from the schema enum so it cannot drift.
- `scripts/status/recovery-checks.mjs` (+ test) — `detectRecoveryState({repo, slug})`: dirty branch, orphaned worktree, partial integration, stale status, missing CI, already-completed-work detection. Artefact/Git-driven, never mutates repo state.
- `docs/pilots/openclaw-rejection-test-runbook.md`, `scripts/pilot/rejection-test.sh`, `scripts/pilot/classify-rejection.mjs` (+ test) — the live disposable-repo GitHub-enforcement rejection-test gate (fail-closed classification pure module + offline fixture tests; the live probe script itself carries no token literal and is operator/coordinator-run, not a CI step).
- `templates/CODEOWNERS.template`, `templates/default-branch-ruleset.json`, `docs/openclaw-pilot-adoption.md` — consumer-facing assets for adopting the OpenClaw pilot's branch-protection posture, plus the Claude-only regression procedure an existing consumer runs to prove no regression.

**Changed:**
- `schemas/build-status.schema.json` — new OPTIONAL top-level `runtime` object (`coordinator_runtime`, `coordinator_role`) and new OPTIONAL `runtime`/`role` string keys on `log[]` items. `contract_version` unchanged at `build-status.v2`; additive only, no consumer migration. See `schemas/CHANGELOG.md`.
- `.claude/agents/architect.md`, `docs/spec-authoring-checklist.md` — plan chunks now carry a mandatory existing-component mapping (spec §6A): the deployed component the chunk builds on and its disposition (`reuse` / `extend` / `replace` / `new`), citing `references/runtime-roles.md` for runtime/role vocabulary.
- `scripts/status/board-sync.mjs` — `classifyBoardPermissionError` labels a swallowed `gh` failure as `MISSING_PROJECT_SCOPE` / `MISSING_BOARD_ACCESS` / `UNKNOWN` when the message matches a known permission shape. Purely informational: the board stays a non-blocking projection either way.

**Fixed:**
- `references/rule-classification.md` — added the missing ledger row for `.claude/hooks/path-portability-guard.js` (shipped in 2.61.3, ledger row omitted at the time).

**Deferred:** the live OpenClaw Builder CLI adapter (Chunk B2) and the coordinator OpenClaw dispatch + `MERGE_READY` stop + API merge-verification wiring (Chunk B3) are quarantined pending a live disposable-repo rejection-gate run — no builder token or disposable repo was available this session. B1's tooling and B4's templates ship regardless (no live dependency); the live rejection evidence and the adapter/dispatch code are a follow-up run. `scripts/status/transition-validator.mjs` ships as a standalone module in this release; it is not yet called from any coordinator status-write site — wiring it in is also a follow-up.

**Migration:** none. Every schema change is additive; no existing `status.json` or consumer file is invalidated.

## 2.61.3 — 2026-08-02

**Highlights:** Patch. Filename portability enforcement, prompted by a live incident: a dual-review log written from a Linux session with colons in its ISO timestamp (`...2026-08-01T21:14:58Z.md`) made `git pull` fail on every Windows clone of the consuming repo — Windows cannot create paths containing colons, so the branch was un-checkout-able until the file was renamed via index plumbing. Three layers ship: a PreToolUse hook that blocks non-portable filenames at write time on every OS, a CI gate that scans all tracked paths as the backstop for files created outside `Write` (bash redirects, generators), and the root-cause doc fix in `dual-reviewer.md`.

**Added:**
- `.claude/hooks/path-portability-guard.js` (+ test) — PreToolUse hook on `Write`: blocks Windows-invalid characters (colons etc.), trailing dots/spaces, and reserved device names (`CON`, `NUL`, `COM1-9`, …) in target paths; normalises drive-letter/UNC prefixes so absolute Windows paths don't false-positive; fails open. Registered under the `Write` matcher in `.claude/settings.json`.
- `scripts/gates/verify-portable-paths.sh` (+ `verify-portable-paths.fixture-test.sh`) — CI gate over `git ls-files -z`: invalid characters, trailing dot/space components, reserved device names, case-collisions; a zero-path scan fails (proof-of-life). Consumers wire it as a static-gate step (see `scripts/gates/README.md`).

**Changed:**
- `.claude/agents/dual-reviewer.md` — log-filename timestamps now explicitly hyphenated (`2026-08-01T21-14-58Z`; shell `date -u +%Y-%m-%dT%H-%M-%SZ`), with colons named as forbidden. This file's ambiguous "ISO 8601 UTC timestamp" wording produced the incident filename.
- `scripts/gates/README.md` — gate catalogue entry + directory count (9 gates + 1 gate fixture test + 1 meta-validator).

## 2.61.2 — 2026-07-31

**Highlights:** Patch. Full audit of the status-contract surface across all three coordinators, prompted by the v2.61.1 find: every edge of the forward chain was checked for a matching write instruction, generator + board-sync pairing, and post-PLANNING-rename vocabulary. One more edge was missing: `feature-coordinator`'s own transition table promises `PLANNING → BUILDING` at Step 5 on plan approval, but no step body ever wrote it — the board sat on `PLANNING` through the entire construction phase (the longest phase of a build) and the `BUILDING` column could never show a live build. `finalisation-coordinator` (all four owned transitions plus the Step 11.5 back-edge and the terminal `MERGED` write), the status scripts (enums derived from the schema, no drift surface), `phase-lock.js`, and `verify-phase`'s gates-only writes all audited clean.

**Fixed:**
- `feature-coordinator.md` Step 5 — the `proceed` reply now writes the `PLANNING → BUILDING` transition it owns: current-focus prose to `BUILDING`, `status.json` upsert carrying the forward-transition `log[]` pair (`done` closing `Plan`, `start` opening `Build`), then the generator and `board-sync.mjs`.
- `feature-coordinator.md` Step 5 — the `.phase: plan` upsert parenthetical claimed `status` was "still `BUILDING`" (v1 leftover from before the PLANNING handoff rename); it is `PLANNING` until the operator approves the plan.

**Migration:** none. Playbook-only change.

## 2.61.1 — 2026-07-31

**Highlights:** Patch. Phase 1 was invisible on the Projects v2 board: `spec-coordinator`'s § Status contract ran only the current-focus generator and assigned the board obligation to `feature-coordinator`, so no card existed until Phase 2's first write — the SPECIFYING column could never show a live build. Found watching a real Phase 1 session author intent for half an hour against an empty board. The same pass fixes the first-write timing (Step 4 → Step 0 for brief-file invocations) and five stale `BUILDING` references left over from the v2 PLANNING-handoff rename.

**Fixed:**
- `spec-coordinator.md` § Status contract — the command block now runs `board-sync.mjs` together with the generator at every status write, matching the other two coordinators; the mis-assigned "`feature-coordinator` owns the board-update obligation" sentence and its error-handling echo are removed.
- `spec-coordinator.md` Step 0 — new **Early board presence** rule: when the invocation argument names an artefact under an existing `tasks/builds/<slug>/` directory, the build's first `status.json` write (`SPECIFYING`, `phase: spec`, `log[]` `start` entry for `Spec`) happens at the lock flip, so the card appears when the phase begins rather than after intent authoring. Topic invocations keep their first write at Step 4, which is now an idempotent re-upsert that must not duplicate the `Spec` start entry.
- `spec-coordinator.md` Steps 1/9/10/11 — five stale `BUILDING` references corrected to `PLANNING` (TodoWrite template row, abort-write-order invariant, Step 10 prose template, Step 10 `status.json` upsert, Step 11 verbatim prompt). Step 10's upsert previously instructed a `SPECIFYING → BUILDING` write that the file's own transition matrix forbids.

**Migration:** none. Playbook-only change; consumers pick it up via `sync.js` on the next update.

## 2.61.0 — 2026-07-30

**Highlights:** Board activity log. Each build's Projects v2 card now carries an append-only, timestamped `## Activity` section: coordinators append short operator-level dot points at every stage boundary (`start`/`done`) and at notable mid-stage moments (`info`), so opening the card answers "what has this build done, what is it doing now" without the session transcript. Previously the card's summary was replaced on every write, leaving no history. The log also doubles as the compact build narrative later reviewers (e.g. Codex) can read from `status.json`.

**Added:**
- `schemas/build-status.schema.json` — optional additive `log[]` array (`{at, stage, kind: start|done|info, note[]}`; `note` capped 6 bullets × 200 chars). `contract_version` stays `build-status.v2`: records without `log` remain valid, so no consumer migration. See `schemas/CHANGELOG.md`.
- `scripts/status/board-sync.mjs` — `buildCardBody` renders `log[]` newest-first as the card's `## Activity` section; `ACTIVITY_RENDER_CAP` (default 40, env `BOARD_SYNC_ACTIVITY_RENDER_CAP`) bounds body size with an "N earlier entries not shown" pointer at the full log in `status.json`. Records without a log render exactly as before.
- Tests: Activity rendering (`board-sync.test.mjs`), `log[]` shape validation incl. the renderer-crash `[null]` class and nested date-time/enum checks (`status-contract.test.mjs`).

**Changed:**
- `spec-coordinator.md`, `feature-coordinator.md`, `finalisation-coordinator.md` — § Status contract gains a binding **Activity log** rule: forward transitions append `done` + `start` in the same write, back-edges and notable mid-stage moments append `info`, entries are append-only, and `note` bullets are operator language (counts over detail; no file paths, agent names, or jargon).
- `scripts/status/status-vocabulary.test.mjs` — `NON_STATUS_TOKENS` gains `NEVER`, `OPTIONAL` (prose words in the new schema `$comment`).

**Migration:** none. The field is optional; pre-2.61.0 `status.json` records and existing cards are untouched until a coordinator first appends.

## 2.60.1 — 2026-07-29

**Highlights:** Patch. `board-sync.mjs` could not UPDATE a card on a real Projects v2 board, only create one. Two `gh project item-edit` constraints were violated at once, and the script's own fail-open contract (gh failures are recorded, non-blocking) hid both: creates worked, every update silently no-opped, so a board froze at each build's first-seen state and never moved a column again. Found by running the sync twice against a live board during the cryptotrackr pilot adoption, which is exactly the class of defect no amount of review catches: the second constraint only surfaced after the first was fixed.

**Fixed:**
- `scripts/status/board-sync.mjs` — a draft card has TWO non-interchangeable ids. Field-value edits address the project item (`PVTI_…`); title/body edits address the draft-issue content (`DI_…`) and gh refuses anything else ("ID must be the ID of the draft issue content which is prefixed with `DI_`"). `updateCard` passed the item id to all three calls and `normaliseItem` never retained `content.id`, so the correct id was not even in scope at the call site. `normaliseItem` now returns `contentId` (null when absent, never guessed).
- `scripts/status/board-sync.mjs` — title and body must travel in ONE invocation. A draft-issue edit maps to `updateProjectV2DraftIssue`, which treats an omitted field as a blanking request, so a body-only edit fails with "GraphQL: Title can't be blank". The new pure `buildDraftContentEditArgs(contentId, card)` emits a single argv carrying both, refuses a `PVTI_` id, and refuses a blank title rather than blanking a live card.
- `scripts/status/board-sync.mjs` — `updateCard` now writes field values BEFORE title/body. `Status` is the board column, the most load-bearing value on the card; previously a title-edit throw aborted the update before any field was written, so a failed cosmetic edit also froze the column.

**Changed:**
- `scripts/status/board-sync.mjs` header docs: the gh command-surface notes claimed title/body edits "use --id alone" without saying WHICH id, and the pure-function inventory now lists `buildDraftContentEditArgs`. The which-id-goes-where rule deliberately lives in an exported pure arg-builder: an argv choice made inline inside the I/O layer is untestable, and that is precisely where this defect hid.

**Tests:** +7 regression tests (68 in `board-sync.test.mjs`, 120 across the status lane). They pin the id choice, the single-invocation shape, the `PVTI_` refusal and the blank-title refusal. Note the honest limit: the two-call version passed every unit test and still failed against a live board, so the single-call rule is pinned by an argv assertion, not by a mock.

**No migration.** Consumers pick this up with `/claudeupdate`; no consumer state or board data changes shape. A board already created by `--init` on 2.60.0 needs no repair, its cards simply start updating.

---

## 2.60.0 — 2026-07-29

**Highlights:** The framework's own `CI` workflow was **`disabled_manually`**. It had not run once in the last sixteen pushes — every release from 2.44.x through 2.59.0 landed on `main` with **zero automated verification**. The only thing checking anything was a human running `node scripts/run-tests.js all` by hand. This release runs every CI step, fixes what they found, makes the suite reliable, and re-enables the workflow.

### The suite exited non-zero on a fully passing run, about half the time

Reproduced deterministically, then root-caused: not a test, but Vitest's worker-to-main reporting RPC missing its birpc deadline (60s, not exposed as config), which Vitest raises as an **unhandled error**:

```
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 Test Files  29 passed (29)
      Tests  691 passed (691)
```

A green suite that exits 1 is the worst available signal — `npm test` reports FAILED, every gate downstream reports FAILED, and the only explanation names an internal RPC call rather than any test. It is also precisely the shape that trains the reflex of re-running until green.

**Fixed — `scripts/runner/install-runner.test.mjs`: 79.6s → 3.6s.** It spawned a fresh PowerShell per case; a cold PowerShell start on Windows costs over a second, and at 20+ cases the file was four times slower than the next-slowest and long enough to hold a worker past the deadline by itself. All three AST helpers now share **one** PowerShell process (`psBatch()`), with inputs passed as a **JSON file** — not inlined into the script text and not via argv, because half these cases deliberately contain quote characters and backslashes that do not survive the JS → argv → PowerShell-parser hop. Declared input lists are exhaustive and lookups **fail loud** on an undeclared value, so a new case cannot quietly reintroduce a per-case spawn (this fired immediately on an input I had missed).

With that load gone, the two files that had failed *only* under full-suite parallel load — `resolve-codex-bin` and `check-shipped-source` — stopped failing. They were never broken; they were losing a CPU race. Measured in isolation, one gate invocation costs 856ms; under the old load it inflated roughly sixfold.

**`maxWorkers: 8` is the secondary half, and the intuition is wrong in both directions.** Measured: default ~16 workers with the 79.6s file → ~50% of runs exit 1; `maxWorkers: 6` → 2 of 3 exit 1; `maxWorkers: 3` → 2 of 2 exit 1 with *more* timeouts, because a smaller pool lengthens the chain of files one worker runs back-to-back; `maxWorkers: 8` with the 3.6s file → 3 of 3 green, 0 timeouts. **Do not respond to a recurrence by lowering the worker count — find the slow file.** The config comment records the numbers and says so.

Whole-suite wall clock: 148s worst case → 66-74s. Verified with **three consecutive full runs**, per the standing rule that one green proves nothing about a flaky suite.

### Fixed — rule-ledger drift: 71 findings

`references/rule-classification.md` had fallen behind this build's agent work: 4 behavioural files with no ledger row (`brief-reviewer`, `plan-reviewer`, `verify-phase`, `review-artifact-nudge.js`), 67 headings unlisted, and 4 anchors pointing at headings that had since been renamed (`dual-reviewer` max iterations 3 → 5, two `finalisation-coordinator` steps, the `test-gate-policy` G5 carve-out). Rows were generated from the checker's own output so the work-list cannot disagree with the gate, and the renamed anchors were recomputed with the **checker's own `slugify`** rather than a hand-written guess. Now `PASS` on all four passes.

### Fixed — a D10 schema-discipline violation that the disabled gate let through

v2.55.0 changed `schemas/build-status.schema.json` with **no** `schemas/CHANGELOG.md` entry. CI's D10 gate would have blocked that push. Entry added retrospectively, and it carries the more important point: the D10 check diffs against `origin/main`, so **once a violating commit is pushed the gate goes quiet about it permanently**. Finding it needed `git log -- schemas/`, not a re-run.

### Re-enabled

`gh workflow enable CI`. Every step verified locally first: `test:sync`, `test:scripts`, `test:hooks`, `validate`, `eval:routing`, `check-rule-ledger`, `check-secrets`, JSON validity, version consistency, `removedFiles` absence, and the D10 schema gate.

**The generalisable lesson, recorded in `KNOWLEDGE.md`:** a disabled gate is indistinguishable from a passing gate at every place a human or agent looks. Sixteen releases reported green because nothing reported at all.

---

## 2.59.0 — 2026-07-29

**Highlights:** Found by running the merge gate for real on the first PR to use it, not by review. The label resolver swallowed every failure mode into a single answer, and that answer was "not ready".

**Fixed — `templates/github-workflows/merge-gate.yml` — the label resolver failed open into a false negative:**
The live label re-query was `gh api ... 2>/dev/null || echo ""`, which made three unrelated situations indistinguishable: the label is genuinely absent, the API call failed, and **`gh` is not installed on the runner**. On a fresh self-hosted runner the third is the common case — and it is exactly the case a brand-new runner rollout hits.

The observed symptom was badly misleading. A correctly-labelled PR resolved to `ready=false`, so both gated suites were skipped, and `merge-guard` then failed with `Gated suites did not both succeed (suite=skipped, light=skipped)`. That message points at the suites, which never ran and were never at fault, rather than at the resolver that skipped them. Two full re-runs were spent before the cause was located on the runner rather than in the workflow.

The resolver now:
- **refuses outright when `gh` is absent**, with an error naming the install as the fix, rather than reporting "not ready";
- **captures stderr and the exit status separately**, so a failed API call is a failure rather than an empty label list;
- **echoes what it resolved and why** on both branches, so a skipped-suite run says which labels it actually saw.

A resolver that cannot read the thing it gates on must say so. Answering "no" is the one response that is indistinguishable from a legitimate negative.

**Runner note (consumer-side, not shipped):** `gh` is a hard dependency of this workflow and is not part of a default `actions-runner` install. Any repo standing up a self-hosted runner needs it installed alongside the runner.

Full suite green: 29 vitest files / 691 tests, exit 0.

---

## 2.58.0 — 2026-07-29

**Highlights:** Round-6 external review, and the final round of this build. One finding: **a "known divergence" pin turned out to be encoding a real defect as intended behaviour.** The round-5 release deliberately did not implement `format: date-time` in the Ajv-free floor, on the stated grounds that a malformed timestamp produced "a wrong-looking card, not a bad write". That reasoning was wrong, and because it was written into a passing test with an explanatory failure message, it would have looked deliberate and correct to every future reader.

**Fixed — `scripts/status/status-contract.mjs` (high) — `updated_at` is load-bearing in three places, all verified in `board-sync.mjs` before fixing:**
- **`shouldSkipStale` compares timestamps as plain strings.** `'2026-07-29T10:00:00Z' > 'zzzz'` is **false**, so a malformed value sorting high defeats stale-write protection entirely: an older record overwrites a newer card. A value sorting low does the reverse and silently suppresses legitimate updates.
- **`chooseSurvivor` orders duplicates by the same string comparison,** so the malformed card wins survivor selection and the legitimate one is archived.
- **`shouldArchive` computes `now - new Date(updated_at)`,** which is `NaN` for a malformed value, and `NaN >= threshold` is false — terminal cards never age out.

And the damage compounds: the bad value is written back into the card body, poisoning every subsequent comparison. `format: date-time` is now enforced generically, including inside the `oneOf` nullable shapes where the keyword sits in a *branch* rather than on the property (`blocker.cleared_at`), and on nested `blocker.raised_at`.

**Stricter than `Date.parse` on two axes, both load-bearing for path equivalence:**
- `Date.parse` accepts far more than RFC 3339 (`'29 Jul 2026'` parses fine). A regex pins the RFC 3339 shape.
- `Date.parse` silently **rolls over** impossible dates, so `2026-02-31` becomes 3 March and parses finite. `ajv-formats` rejects it. A `Date.parse`-only check would therefore have put the two validation paths straight back out of step — the exact class of gap this test suite exists to prevent. `isRealCalendarDate` round-trips the Y-M-D components.

**Changed — the divergence pin is now coverage.** Malformed `updated_at`, malformed `cleared_at`, malformed `raised_at`, and the calendar-rollover case are all in the Ajv-vs-floor agreement set. `additionalProperties: false` remains the single pinned divergence, and it is genuinely inert: an unknown extra key cannot crash a renderer or corrupt a write.

**The generalisable lesson, recorded in `KNOWLEDGE.md`:** a divergence pin asserts *"this cannot hurt us"*, which is a claim about **every consumer of the field**, not a claim about the validator. It needs the same verification as any other such claim — read the consumers. Pinning is still the right mechanism; the round-5 pin failed because the reasoning behind it was never checked against `board-sync`, not because pinning is wrong.

**Test-suite flakiness (pre-existing, not introduced here — routed to `tasks/todo.md`, not fixed in this release):** four consecutive full runs produced two clean greens (691/691, exit 0), one run where all 691 tests passed but the process exited 1 on a post-run `ERR_IPC_CHANNEL_CLOSED` teardown crash in the tinypool worker pool, and one run with two failures in `resolve-codex-bin` and `check-shipped-source` — both spawn-heavy files, both untouched by this release, both green in isolation and on a stashed clean tree. This is the spawn-heavy flake class already recorded in `KNOWLEDGE.md`, now presenting as a worker-teardown crash rather than a timeout. It will make CI red roughly half the time until addressed.

Verification for this release: 691/691 tests, exit 0.

---

## 2.57.0 — 2026-07-29

**Highlights:** Round-5 external review. Two findings. The high-severity one **reopened the split-brain board defect from round 3** through a different door, and it landed because a claim made in the review handoff was wrong: the round-5 prompt asserted that an out-of-enum status was "separately caught by the generator's own status check". The generator does have one. **`board-sync` does not** — it relies entirely on `validateRecordShape`. Verified in the code before fixing.

**Fixed — `scripts/status/status-contract.mjs` (high) — the schema-derived floor ignored `enum` and `const`:**
The round-4 floor enforced `required` and `type` but no vocabulary constraints, so `status: "TESTNG"` passed as a string. `checkBoardContract` also passed, because the *board* was correctly provisioned. The card body was then written saying `TESTNG`, `setFieldValues` found no matching option, warned, skipped the Status field, and the card disagreed with its own column — the round-3 defect, reached from local data instead of board state. The same omission accepted `contract_version: "build-status.v1"` against a `const` of v2, i.e. a record written under a superseded contract. Now enforced generically, including inside `blockers[]` and on items fragments that carry vocabulary directly.

**Also fixed, found by the extended agreement test rather than by review:** `minLength` was a further divergence — Ajv rejected an empty blocker `text`, the floor accepted it. Closed. Any gap between the two paths makes "which validator happened to load" a correctness variable.

**Changed — the Ajv-vs-floor agreement test was passing over a subset that excluded the bug:**
Its case set only covered rules the floor already implemented, so the two paths "agreed" precisely where they could not disagree. Extended with the vocabulary cases. This is the third instance in this build of a test that asserted the implementation rather than the contract, and it is now the specific thing to check when reviewing any equivalence test here.

**Added — known divergences are pinned, not described:**
The floor implements `required`, `type` (with the `oneOf`/`anyOf` nullable shapes), `enum`, `const`, `minLength`, and one level into arrays-of-objects. It does not implement `format` or `additionalProperties: false`. Both gaps now have tests asserting the current behaviour, with failure messages instructing a future reader to move the case into the agreement set if the gap is ever closed. A comment claiming equivalence is what produced this finding; a test that fails when the claim stops being true does not.

**Fixed — `scripts/runner/install-runner.test.mjs` (low) — a vacuous test:**
`"'/home/mike/a\b/runsvc.sh'"` puts a *backspace control character* in a JavaScript string, not a backslash followed by `b`. The expectation contained the identical character, so the assertion held without ever supplying a literal backslash, and a future parser change stripping backslashes would have kept it green. Escaped properly, plus an explicit assertion that the input contains a reverse solidus and not `\b`, so it cannot silently degrade again.

**Fixed — `scripts/runner/install-runner.ps1` (low, availability) — unquoted escaped whitespace:**
Surfaced while writing the test the reviewer asked for. systemd processes backslash escapes in unquoted words too, so `/home/mike/runner\ installs/repo/runsvc.sh` was truncated to `/home/mike/runner\`. Safe rather than dangerous — a trailing backslash matches no canonical directory, so the caller refuses — but it is the same availability bug as the quoted case fixed in 2.56.0: the installer declines to manage a runner it installed itself. A new test asserts the general property that every ambiguous or escaped form resolves to the correct full path or to empty, never to a truncated non-empty path, because wrong-path is what feeds a stop/disable/delete decision.

Full suite green: 29 vitest files / 685 tests, plus 14 node:test and 14 plain-node suites.

---

## 2.56.0 — 2026-07-29

**Highlights:** Round-4 external review. Three findings plus one lower-severity issue, and the streak holds: all four are defects in code written in the last two versions. Two share a single root cause worth naming — **a guard that reports "fine" when it cannot actually tell.** `checkBoardContract` returned "contract valid" when the schema was unreadable, and `validateRecordShape`'s Ajv-free floor returned "valid" for records it had never really inspected. Both were introduced by the round-3 fixes that were supposed to make these failures visible.

**Fixed — `scripts/status/board-sync.mjs` (high) — an unreadable schema disabled the board guard:**
`checkBoardContract` opened with `if (!statusEnum) return null`, and `null` is its success value. A missing, unreadable or malformed `schemas/build-status.schema.json` therefore switched off the entire preflight and let every card mutation proceed, at the exact moment the script could no longer say which statuses the board must support. Now returns an explicit refusal. The board stays non-blocking (the run still exits 0) but performs zero mutations.

**Added — `scripts/status/board-sync.mjs` `checkBoardHygiene()` (medium) — extra and out-of-order options are now reported:**
The contract check verified only that required options were *present*, so a board carrying a leftover `REVIEWNG` beside the real `REVIEWING`, or the right nine options in the wrong sequence, passed silently — while the refusal message told the operator to "delete any that are not listed", a rule nothing enforced. Missing, extra and out-of-order are now reported as three separate, individually actionable categories.

*Deviation from the review recommendation, recorded deliberately:* the reviewer asked for exact-match **refusal**. Escalation is split by consequence instead. A **missing** option means a status cannot be written at all and cards would disagree with their own column — a correctness failure, so it still refuses. An **extra** option, or correct options in the wrong order, writes every status correctly; it is a display problem. Refusing all mutations there would take the board offline over column order and would brick the board of an operator who deliberately added a column of their own. Those warn loudly on every run and keep writing.

**Fixed — `scripts/status/status-contract.mjs` (high) — the Ajv-free floor accepted records that crash the renderer:**
The hand-written floor checked that `blockers` was an array but never the shape of its elements, so `blockers: [null]` passed and then threw on `blocker.cleared_at` inside `buildCardBody` — which the per-record catch reported as a **"gh failure"**, pointing the operator at GitHub for a defect in local data. It also omitted `title`, `branch` and `pr`, all dereferenced by the card renderer, while the module's own docstring claimed it covered "exactly the dereferences the renderers perform". **The floor is now derived from the schema rather than hand-maintained** — it reads `required`, `properties` and `items` straight out of the JSON and enforces them generically, including one level into `blockers[]`. A hand-kept mirror of a schema is the same drift class this build already wrote a guard for. Parsing JSON needs no dependency; only ajv's richer keywords are lost.

**Fixed — `scripts/runner/install-runner.ps1` (medium, availability) — `ExecStart` parsing ignored systemd quoting:**
The path was extracted with a bare whitespace split, so a work directory containing a space produced `"/home/mike/runner` from `ExecStart="/home/mike/runner installs/repo/runsvc.sh"`. No directory matches that, so the installer refused to manage a runner it had installed itself. The script permits spaces in `WorkDir`, so this was reachable, not theoretical. New `Get-SystemdExecPath` honours single and double quoting with backslash escapes, and returns empty on unterminated quoting so the caller refuses rather than guessing — a wrong path here feeds a stop/disable/delete decision.

**Added — tests:**
- `scripts/status/status-contract.test.mjs` (14 cases) exercises the **Ajv-unavailable** path for real via `vi.doMock`, including a case that fails if Ajv loaded after all, so the block cannot silently test the wrong code path. Also asserts the two paths return the *same verdicts* on the round-4 regression cases, so which one happens to load is not a correctness variable.
- `checkBoardContract` refusal on an unresolvable enum; `checkBoardHygiene` across exact / extra / out-of-order / both-wrong.
- `Get-SystemdExecPath` across quoted-with-spaces, quoted-with-arguments, single quotes, backslash escapes, unterminated quoting and empty input. The harness passes the value **through the environment** rather than inlining it, because every interesting case contains quote characters that do not survive the JS to argv to PowerShell hop.

Full suite green: 29 vitest files / 677 tests, plus 14 node:test and 14 plain-node suites.

---

## 2.55.0 — 2026-07-29

**Highlights:** Round-3 external review. Four findings, and — as in rounds 1 and 2 — every one of them is a defect in a fix made earlier in this same build, not in pre-existing code. Two are in the WSL runner installer (both in ownership/lifecycle logic added two versions ago), two are in the status pipeline (both in the v2 widening shipped in 2.54.0 one version ago). The pattern is now measured across three rounds and is recorded in `KNOWLEDGE.md`: **recently-written code is the highest-yield place to review, and a fix is not evidence of correctness.**

**Fixed — `scripts/runner/install-runner.ps1` (both critical/high, both self-inflicted):**
- **Unit-ownership proof was `OR`, not `AND`.** `Test-UnitOwnedByUs` accepted a unit if *either* its `WorkingDirectory` *or* its `ExecStart` pointed at our canonical directory. A systemd unit with an unrelated `ExecStart` and a coincidentally-matching `WorkingDirectory` (or the reverse) was therefore claimed as ours and could be stopped, disabled and deleted. Now requires exactly one `WorkingDirectory` and exactly one `ExecStart` directive, both resolving to the canonical directory, and refuses outright on prefixed `ExecStart` forms (`@`, `-`, `:`, `+`, `!`) whose argv semantics it cannot safely parse.
- **`deactivating` was treated as stopped.** The stop path matched on `-match '^active'` to decide whether a unit was still running, so the transient `deactivating` state read as stopped and `$WorkDir` was deleted out from under a live process. Replaced with `Test-SystemdStateStopped` (an explicit `inactive|failed|unknown` allowlist, extracted as a pure function so it is directly testable), bounded polling (15 × 2s) and a `MainPID` check before any deletion.

**Fixed — `scripts/status/board-sync.mjs` (high) — split-brain cards on an unmigrated board:**
Board writes were validated per card, but a status-enum mismatch is a property of the *board*. Against a board still provisioned with the v1 six-status field, `updateCard` wrote a title and body saying `TESTING`, `setFieldValues` could not find a `TESTING` option, warned, skipped the Status field, and the run exited 0 (board failures are deliberately non-blocking). The card body and the board column then disagreed — for exactly the three statuses the v2 migration added, the ones whose visibility was the entire point of the change. New `checkBoardContract()` runs once, before any mutation, and refuses **all** writes with a single actionable migration error naming every missing option. Its required-field list is derived from `BOARD_FIELDS_TO_CREATE`, so "what `--init` provisions" and "what sync requires" cannot drift.

**Added — `scripts/status/status-contract.mjs` (medium) — one definition of "valid":**
`generate-current-focus.mjs` validated records against the schema; `board-sync.mjs` checked only that the JSON parsed and the slug matched its directory. The two consumers of the same file could therefore disagree — the generator classifying a record `INVALID` and refusing to render it while board-sync happily published it to a card — and a malformed record reaching board-sync surfaced as a *"gh failure"*, a misleading diagnosis pointing at GitHub for a defect in local data. Both readers now share this module. Ajv is loaded dynamically with a structural fallback covering exactly the dereferences the renderers perform, preserving the stdlib-only-at-runtime property.

**Added — `scripts/status/status-vocabulary.test.mjs` — drift guard for the status vocabulary:**
The enum widened 6→9 in 2.54.0 and four things had to move together; one did not. The schema's own `$comment` went on describing the v1 back-edges (`MERGE_READY→REVIEWING`, `REVIEWING→BUILDING`) through a full external review round until a reviewer caught it by eye. Each coupling is now mechanical: board options ≡ schema enum (order included, because that order *is* the board columns); `STATUS_PRIORITY` covers exactly the non-terminal statuses with a dense unambiguous ranking; terminal statuses are a subset of the enum; and **no status name may appear in the schema's prose that is not in its own enum** — the assertion that would have caught the stale `$comment` on the day it was written. On first run it immediately found two more live drifts: `BOARD_FIELDS_TO_CREATE` was not exported, and the framework's own `tasks/current-focus.md` still documented the v1 six-value list.

**Fixed — `schemas/build-status.schema.json`:** `$comment` now describes the v2 back-edges (`MERGE_READY→FINALISING`, `FINALISING→TESTING`, `TESTING→BUILDING`, `REVIEWING→BUILDING`) and points at the guard that keeps it honest.

**Fixed — `tasks/current-focus.md`:** status list updated to the nine v2 values with the schema named as canonical.

---

## 2.54.0 — 2026-07-29

**Highlights:** Implements the board-status vocabulary the operator approved — `build-status.v2`, 6 statuses → 9. The docs described it; this makes the code do it. **Schema change with a `contract_version` bump; migration is a no-op because there were zero `status.json` files and zero board cards at the time of the change.**

**Changed — `schemas/build-status.schema.json` (`build-status.v1` → `v2`):**

`SPECIFYING PLANNING BUILDING REVIEWING TESTING FINALISING MERGE_READY MERGED ABANDONED`

Three additions, each closing a case where the board could not describe the work:
- **`SPECIFYING`** — `PLANNING` previously meant both "working out *what* to build" and "sizing the build plan". Different activities, separated by a mandatory operator approval gate, and the operator's most frequent question ("is it still deciding the spec, or is it planning the work?") was unanswerable from the board.
- **`TESTING`** — Codex authoring the frontend/backend tests, running the full suite and iterating to green was invisible inside the Phase 3 span. Often the longest single stretch of a build, and indistinguishable from "green, final checks running".
- **`FINALISING`** — was not a status at all; `REVIEWING` silently carried the entire finalisation phase through to `MERGE_READY`.

**Changed — transitions.** Forward chain is now `SPECIFYING → PLANNING → BUILDING → REVIEWING → TESTING → FINALISING → MERGE_READY → MERGED`, with an ownership table naming the coordinator and step for every edge. Consequences worth stating:
- **Phase 2 now ENTERS at `PLANNING`, not `BUILDING`** — plan authoring is Phase 2 work, so `spec-coordinator` hands over at `PLANNING` and `feature-coordinator` writes `BUILDING` at Step 5, **after** the operator approves the plan. Entry guards updated on both sides.
- `finalisation-coordinator` gains two write-sites: `REVIEWING → TESTING` at **Step 4a** (written *before* invoking verify-phase, deliberately — a board that only updated on completion would show `REVIEWING` for hours of test work) and `TESTING → FINALISING` at **Step 5**, gated on the verify suite actually being green.
- Back-edges are now `MERGE_READY → FINALISING` and `FINALISING → TESTING`. Choosing between them is a judgement about *where the work goes*: a red CI check on unchanged code returns to `FINALISING`; a defect needing a code or test change returns to `TESTING`. Both still require a blocker entry in the same write.
- `spec-coordinator`'s "PLANNING lock" is now the **SPECIFYING lock** throughout (10 references migrated).

**Changed — `board-sync.mjs`:** the `Status` single-select options list matches the enum in pipeline order (these *are* the board columns, left to right), and the `--init` guidance now derives the option names from the field spec instead of hard-coding a list that could silently drift.

**Tests:** +2 contract tests asserting the board's option list is exactly the schema enum, in order, and that the three new values plus the `v2` contract version are present. This pair is the guard against the two halves drifting — a status the board lacks cannot be written to a card, which would break publishing for that state only. Existing fixtures migrated `v1` → `v2` (9 tests failed on the bump, correctly — they were pinned to the contract). Full suite green.

**Operator action required, once:** the live board's `Status` field options must be updated in the **web UI** to match. There is no `gh` subcommand that edits single-select options, so this is the one genuinely manual step; `board-sync --init` prints the expected list.

## 2.53.0 — 2026-07-29

**Highlights:** Frontend test scope becomes the tester's judgement rather than a rule written months earlier — bounded by *how* to test and *what to be accountable for*, not by *how much*. Plus a false-positive fix in the review-artifact hook, caught by its own first day of real use.

**Changed:**
- `.claude/agents/verify-phase.md` — **a posture may now DELEGATE scope, not only dictate it.** Previously the phase treated any breadth beyond the posture's named classes as an unauthorised expansion, so a posture that *hands* the tester a decision would still have been read at its narrowest "out of caution". It now obeys what the posture actually says: prescriptive lines remain boundaries, delegating lines are exercised. Discretion is over *what to cover* — never over *how carelessly* or *what to leave unsaid*. The Design prompt gains two required outputs when scope is delegated: **SCOPE RATIONALE** (surfaces chosen and why they earn their maintenance cost) and **DELIBERATE GAPS** (what was not covered and why, including anything automated tests cannot honestly judge, which routes to UAT instead of being approximated by a brittle assertion). Standing instruction: optimise for defects caught per test maintained, never for count or coverage percentage — a suite that fails on every cosmetic change costs more than it returns, and the operator pays that cost later, not the agent.
- `.claude/hooks/review-artifact-nudge.js` — **a bare tool name is no longer handoff intent.** The first day of live use produced a false positive on the operator's own message: "can we set it up so Codex uses its discretion…" matched `spec` + a passing mention of `codex`. In a codebase whose pipeline discusses these tools constantly that pattern was far too broad. Intent now requires the artifact to be directed *at* the tool ("to/into/**for** ChatGPT", "Codex review") rather than merely discussed near it. The observed false positive and two true positives it initially broke (`prepare the brief for ChatGPT`, `create a handoff for codex`) are all now in the test matrix.

**Consumer-side companion (automation-v1, not shipped by this release):** `docs/spec-context.md` replaces `frontend_tests: vitest_dom_tests_for_critical_flows` with `tester_discretion_within_adopted_frameworks` plus a `frontend_test_mandate` block carrying hard limits (adopted frameworks only; Playwright stays focused and non-PR-gating; never weaken a passing assertion to go green), a quality bar (assert behaviour not implementation; no blanket component snapshots; a test must fail for exactly one understandable reason), and accountability clauses. The operator was hand-prompting broader coverage on every build, which is the tell that the prescriptive line was wrong: the reader of the diff judges scope better than a months-old rule.

## 2.52.0 — 2026-07-29

**Highlights:** Aligns `verify-phase` with the operator's proven manual practice — the "build the tests, run them, loop until it's genuinely working, then hand me something I can UAT" goal. The loop already existed; two things it did not do explicitly are now required.

**Changed:**
- `.claude/agents/verify-phase.md` Step 1 + Step 2 — **stale tests are now first-class work, not just new coverage.** The Design pass emits its plan in three parts, and part 2 is explicitly "existing tests this build's refactoring has invalidated, made misleading, or left asserting the old shape, each named with the file and why it is now wrong". The Author step then updates them. Rationale recorded inline: after a refactor, a test that still passes while asserting behaviour that no longer exists is **worse than no test** — it reports green for something that is gone. The old wording ("writes the tests the plan called for") could be read as new-tests-only, which is exactly the gap the operator was filling by hand. When code is right and the test is wrong, fix the test; when the test is right, it is an app defect and routes to Claude. Amended tests must be listed with their reason, because a silently rewritten assertion is indistinguishable from a weakened one.
- `.claude/agents/verify-phase.md` Step 5 — **added a required operator-facing UAT-readiness block.** The existing report is machine-facing (release-control uploads, run ids); it never answered the operator's actual question, "can I start using this?". The new block states ready-yes/no, suite results, new vs amended test counts, bugs found and fixed, **what UAT should focus on**, and **what automated tests could NOT cover**. Two rules: `Ready for UAT: yes` requires a genuinely green full suite (never "green apart from known failures"), and the block must name what the tests cannot judge — visual polish, copy, workflow feel — because otherwise "all tests pass" reads as "everything is fine" and UAT degrades into a rubber stamp.

**Not changed, deliberately — operator decision required.** The operator's manual practice authors broader frontend coverage than this repo's declared posture permits: `docs/spec-context.md:82` reads "do not add frontend unit tests beyond focused Vitest DOM tests for critical flows", and `verify-phase` refuses to widen a repo's posture on its own ("a deliberate posture expansion is an operator-approved carve-out … never a verify-phase default"). That guard is doing real work — it is what stops an agent generating hundreds of brittle frontend tests unasked — so widening it is a posture edit the operator makes, not something this release should slip in.

## 2.51.0 — 2026-07-29

**Highlights:** Round-2 external review. Four findings, **every one a defect in a v2.50.0 fix made the same day** — two of them my own guards scoped only halfway, leaving the original hazard reachable through the path I did not cover. All verified at source before acceptance.

**Fixed:**
- `scripts/runner/install-runner.ps1` — **the primary service lookup was still unscoped (critical).** v2.50.0 scoped the *fallback* enumeration to this repo's slug but left the higher-priority `$WorkDir/.service` path accepting any name matching `^actions\.runner\..+\.service$`. So a stale or hand-edited `.service` file in repo B's work dir naming repo A's unit was returned immediately, never reaching the scoped fallback — and the residue sweep then stopped, disabled, deleted and "verified absence of" **repo A's service**. The cross-repository destructive failure the fix was written to close stayed open through the door I did not scope. Both paths now go through `Test-UnitBelongsToWorkDir`, which proves ownership **by path** — `WorkingDirectory`/`ExecStart` must resolve beneath the canonical (realpath'd) work dir — because a name prefix is a hint an operator or a stale file can forge. It reads the unit file directly rather than asking `systemctl`, since uninstall deliberately skips the systemd health precondition and `systemctl show` may be unavailable exactly when this check matters.
- `scripts/runner/install-runner.ps1` — **the sweep verified the wrong thing (high).** It swallowed `systemctl stop`/`disable` failures with `|| true` and then verified only that the unit **file** was gone. On a degraded systemd, a stuck unit, or no connection to the manager: the stop failed silently, the file was deleted, absence was "verified", and the sweep went on to delete the work directory **out from under a still-running runner process** while reporting the residue cleared. Now: stop first, require `is-active` to report `inactive`/`failed`/`unknown`/`deactivating` before proceeding, then disable + remove, then verify **both** file absence **and** non-active state. "Unit does not exist" is success; "exists and would not stop" is a hard stop.
- `scripts/gates/verify-factory-invocation.mjs`, `verify-duplicate-registrations.mjs` — **the corpus guard covered roots but not the method set (high).** With canonical roots and `GATE_METHOD_SET: options`, one clean `.options()` registration satisfies the zero-match tripwire while every `.get()` violation goes unexamined — the right files inspected through the wrong lens. Under `CI=true` the method set must now equal the canonical default exactly unless `GATE_FIXTURE_MODE=1` is declared, closing the sibling of the vector v2.50.0 closed.
- `scripts/status/generate-current-focus.mjs` — **terminal records bypassed validation entirely (medium).** The terminal-status `continue` ran *before* `validateRecordShape`, so a `MERGED`/`ABANDONED` record carrying `blockers: null` and a bogus phase vanished silently — neither rendered nor surfaced as `INVALID` — purely because its status happened to be terminal. That defeats the distinction between "valid terminal, deliberately excluded" and "schema-invalid, surfaced". Validation now precedes classification. Ordering detail worth keeping: the status check runs *before* ajv so the friendlier "unrecognised status, expected one of …" diagnostic survives — otherwise ajv's generic enum message would have replaced it, which the reviewer explicitly asked to avoid.

**Tests:** 622 green (+6 regression cases, each written against the reviewer's concrete scenario, including a two-runner machine state and a narrowed method set).

**Reviewer's confirmed-clean areas, recorded so they are not re-litigated:** the body-key format is safe for schema-valid records (repo identities cannot contain whitespace, slugs are kebab-case); the structural fallback in `generate-current-focus.mjs` does cover the actual crash-producing dereferences; and the fixture-root check is not bypassable by path casing or symlink under `CI=true`. One open observation retained: `board-sync.mjs` does not itself schema-validate records, relying on the producer contract.

## 2.50.0 — 2026-07-29

**Highlights:** Implements all five findings from the external (ChatGPT) code review of the dev-pipeline-v2 surface — every one verified at source before acceptance, every one real. Two destructive-path fixes in the runner installer, a corpus-narrowing guard on both CI gates, a duplicate-card fix in board-sync, and schema validation in the status generator.

**Fixed:**
- `scripts/runner/install-runner.ps1` — **service discovery was global, not scoped (critical).** Both the post-install unit lookup and the residue probe took the FIRST `actions.runner.*` unit on the machine, so with runners for two repositories, repo B's install could wire its Windows auto-start task to repo A's service, and repo B's residue sweep could stop, disable and DELETE repo A's unit. Now resolved per-repo via `Get-RunnerServiceUnit`: primary source is `$WorkDir/.service` (svc.sh writes the exact unit name there — per-work-dir by construction), fallback is slug-scoped enumeration accepting EXACTLY one match; zero or several means refuse, never guess.
- `scripts/runner/install-runner.ps1` — **the residue sweep still used non-interactive `sudo` and discarded its exit code (high).** Written before the v2.47.0 sudo→root migration and missed by it: on a stock Ubuntu each `sudo` fails, `| Out-Null` swallowed the evidence, and the sweep printed "Removed systemd unit" and "residue cleared" while the unit stayed installed and could restart the runner — a regression in the exact runtime condition that motivated the migration. Now `wsl -u root`, exit code checked, unit absence VERIFIED before success is claimed, and the service-removal verdict is established before the auto-start task or work dir are touched. A source-invariant test asserts no executed payload contains `sudo` at all.
- `scripts/gates/verify-factory-invocation.mjs`, `verify-duplicate-registrations.mjs` — **both gates passed after inspecting an arbitrarily narrowed corpus (high).** The zero-match tripwires catch a scan that finds nothing, but a branch-controlled `env:` block could point `GATE_SCAN_DIR` at one small clean file — the committed fixtures are ideal ammunition — and collect a green that inspected none of the production tree. New contract: roots under `scripts/gates/fixtures` always refuse without `GATE_FIXTURE_MODE=1`, and under `CI=true` ANY non-default root requires it. The gates' own tests set the flag when spawning against temp dirs; a production workflow adding it is a visible, greppable diff.
- `scripts/status/board-sync.mjs` — **a partial create produced one new duplicate card per sync, forever (high).** `item-create` succeeds, the subsequent field edits fail → the card had no field identity, the upsert skipped it as "not one of ours" and created another. The identity key now rides IN THE BODY MARKER, written atomically with `item-create` (`<!-- board-sync:v1 key=<repo>::<slug> updated_at=... -->`), `normaliseItem` falls back to it when fields are missing — so orphans are adopted and healed by the normal update path — and `createCard` compensates by archiving the partial item when field writes fail. Legacy cards without a body key keep working; fields remain the primary identity.
- `scripts/status/generate-current-focus.mjs` — **key-complete but malformed records crashed the whole run (medium; also pr-reviewer PR-012).** `"blockers": null` passed the key-presence check and crashed `buildBody` on `.length`; the run exited non-zero and wrote nothing, taking every healthy build's status down with one bad directory. Records are now validated against `schemas/build-status.schema.json` via ajv (dynamic import — the file is stdlib-only by design, so ajv is an enhancement with a structural fallback covering the crash vectors) and malformed values take the documented `INVALID:` channel. Verified zero live `status.json` files exist anywhere, so the stricter validation regresses nothing.

**Tests:** 616 across 27 vitest files plus the node suites, all green (was 602). +14 regression cases, each written against the reviewer's concrete failure scenario.

## 2.49.0 — 2026-07-29

**Highlights:** Raises the Codex code-review cap from 3 to 5 iterations (operator-driven), and adds the `review-artifact-nudge` hook that enforces the v2.48.0 handoff contract at the moment of the ask instead of leaving it as prose.

**Changed:**
- `references/iteration-caps.md` row 11 + `.claude/agents/dual-reviewer.md` — **dual-reviewer cap 3 → 5 iterations per invocation.** Operator experience: real code reviews regularly need more rounds, and the framework's own review used all 3 with findings still flowing. The termination rules are unchanged and now documented explicitly at the decision point: a **clean round** (Codex raises nothing) exits as converged; a **stalled round** (Codex raises findings but zero are accepted) exits because re-running reproduces rejected items, not convergence; the cap bounds only the genuine tail where every round accepts fixes. **Cap exit stays loud** — accepted-but-unresolved findings force `CHANGES_REQUESTED`; the cap bounds effort, it does not manufacture approval.

**Added:**
- `.claude/hooks/review-artifact-nudge.js` (+ test; wired into `UserPromptSubmit`; 12th hook) — detects a request for an external-review artifact or a file link (artifact noun AND handoff intent, so "the spec says X" stays silent) and injects the § *External-review artifact handoff* contract before the response is composed. The v2.48.0 contract was prose; prose already failed twice this build (the Codex binary rule, then this very contract being violated by the ad-hoc diff request it was written about — file outside the workspace, bare-text path, no reviewer prompt). The trigger matrix in the test includes the operator's verbatim phrasings from that incident. `UserPromptSubmit` rather than `Stop`, deliberately: nudging after the fact still ships a broken handoff and costs the operator a round trip.

## 2.48.0 — 2026-07-29

**Highlights:** Three operator-driven process fixes, each closing a failure that actually occurred: external-review handoffs that arrived unlinked and promptless, 92 MB of review scratch that no step ever cleaned up, and a test session that ran to completion against a stale database and only mentioned it afterwards.

**Added:**
- `references/review-mode-resolution.md § External-review artifact handoff` — **MANDATORY, any artifact, any route.** Binding whenever a file is produced for a human to hand to an external reviewer (spec, plan, code diff, brief, cross-tool handoff) — including bare ad-hoc requests, which previously bound nothing because the rule lived only in the three ChatGPT agents' round loops. Three requirements, same message: the file lives INSIDE the workspace (gitignored if it must not be committed — never exiled to a temp dir the editor cannot open); linked clickably, workspace-relative; and shipped with a ready-to-paste reviewer prompt as its own linked file (what the code is/is not, how to read the artifact, what to prioritise, do-not-re-report and verified-clean lists, wanted output format). Also names the link-only tier: any file the operator is told about gets a clickable link; the prompt requirement is what distinguishes "someone else reviews this" from "you read this". Canonical paths: `tasks/builds/<slug>/code-only.diff` + `code-only-review-prompt.md`.
- `.claude/agents/finalisation-coordinator.md` **Step 8a — review-scratch sweep.** Review logs had NO retention step: one consumer accumulated 92 MB / 2,509 files, including 343 committed raw transcripts (67 MB). Policy now split by value: final reports (`.md`/`.json`/`.jsonl`) are the audit trail, committed forever; raw transcripts/prompt inputs/stderr captures (`.txt`/`.stderr`/`.tmp`) are scratch whose durable content is distilled into the final report before a round closes, gitignored and swept after Step 7's learnings extraction (deliberately after — Step 7 is the raws' last possible consumer). Escape hatch: rename a genuinely evidentiary capture to `.md` with a preamble; the extension is the retention decision.
- `references/codex-invocation-contract.md § Environment parity for TEST-EXECUTING dispatches` — **MANDATORY precondition.** Before any dispatch that executes tests, the caller applies pending migrations via the repo's declared migrate command (idempotent at head — run it, don't reason about whether it's needed), requires exit 0 (non-zero is a blocking stop, never a dispatch), and states parity in the handoff prompt. The executing session re-runs the migrate command on any doubt (branch switch, schema-shaped failure) instead of authoring around the gap. Written because it happened: a browser-test session completed against stand-in data and the stale database surfaced only as a closing caveat — a caveat after the work is a precondition that was skipped. Wired concretely into `verify-phase.md` (blocking pre-Step-1 check) and `bug-fixer.md` (step 0 of its check sequence).

## 2.47.0 — 2026-07-28

**Highlights:** Fixes the defect that stopped the first real runner install dead, and adds this repo's own `workflow_call` suite callees. Both came out of installing a self-hosted runner for real, on real hardware, for the first time.

**Fixed:**
- `scripts/runner/install-runner.ps1` — **the install could never complete the service step on a stock Ubuntu.** It ran `sudo ./svc.sh install` through a **non-interactive** `bash -lc`, which cannot answer a password prompt. On any distro whose default user lacks passwordless sudo — the Ubuntu default — the install stalls there, **after** `config.sh` has already registered the runner with GitHub. Result: a registered runner with no service, permanently `offline`, putting a never-satisfied check on every gated PR. Observed exactly this on the reference machine (`sudo -n true` → "a password is required"). Service install/start and service stop/uninstall now run through `wsl -u root`, which needs no password and cannot depend on the distro's sudoers policy. The removal path is deliberately **split by privilege**: `svc.sh` as root, `config.sh remove` as the runner user, because running `config.sh` as root leaves its config and credential files root-owned and a later re-install then fails on permissions. Collapsing both into one root call would trade one silent breakage for another. `svc.sh install` is passed the target user explicitly, since running it as root would otherwise default the service to root and the runner must not execute jobs as root. The printed plan and `-WhatIf` now say "AS ROOT (not sudo)" so the preview matches what executes.

**Added:**
- `.github/workflows/suite.yml` and `.github/workflows/ci-light-suite.yml` — this repo's own heavy and light `workflow_call` callees under the (c2) mechanism (ADR-0052), authored from its **actual** command surface: `test:sync` → `test:scripts` → `test:hooks` → `validate` → `eval:routing` → `check-rule-ledger.js` → `check-secrets.cjs` → JSON validity → version consistency. This repo has no `lint` or `typecheck` script, so the light lane is `validate` + secret sweep + JSON validity rather than lint/typecheck.
  - The heavy callee makes one **deliberate behaviour change**: the schemas-vs-CHANGELOG gate used to print `schema changelog gate skipped (origin/main not available)` and continue **green**. Under an explicit-SHA checkout that is a fast-exit path — green having verified nothing, letting a schema change ship without its CHANGELOG entry. It now fetches the ref and **fails hard** if `origin/main` still cannot be resolved.
  - Both callees are `workflow_call`-only, so they never self-trigger.
- `.claude/project-registries.json` — created from the shipped template with this repo's own `ci_templates` values.

**Not done, and why — the trust boundary refused it.** This release does **not** register a runner for this repo and does **not** delete its `ci.yml`. `install-runner.ps1`'s new private-repo precondition **correctly refused**: `claude-code-framework` is a **public** repo, and spec §7.5 pins the runner trust boundary to private repos only. A persistent self-hosted runner on a public repo lets any fork PR execute attacker-authored workflow code on the operator's machine as a docker-group (root-equivalent) user with `/mnt/*` access to the whole Windows drive. The two callees ship because they are inert without a caller; the rendered callers are deliberately withheld, since a workflow targeting `[self-hosted, linux]` with no runner queues forever. Resolving this needs an operator decision, recorded in the consuming repo's `tasks/todo.md`.

## 2.46.0 — 2026-07-28

**Highlights:** Acts on an external Codex review of the v2.45.x surface. The headline fix turns a rule that existed **only as prose** into a single enforced implementation: every Codex-using agent resolved the binary with a PATH-first lookup that contradicted the contract's own newer-of requirement. Also fixes a board-sync bug where a stale terminal record archived a **newer active** card, a silent-drop in the status generator, and an uninstall path that could not clean up the exact partial-install state this build's own runner spike produced.

**Added:**
- `scripts/codex/resolve-codex-bin.sh` (+ `resolve-codex-bin.test.mjs`) — **one implementation of the Codex binary-resolution rule.** Considers the PATH binary, the npm global shim and `CODEX_FALLBACK_PATH`, reads `--version` from each, returns the newest, and fails closed (exit 1, empty stdout) when nothing runnable exists — never emitting a bare `codex` for a caller to invoke blindly. Announces on stderr when it discards the PATH binary, because silently preferring a different binary than the caller's PATH is how the original defect stayed invisible.
- `vitest.config.mjs` — `testTimeout`/`hookTimeout` raised to 30 s. See *Fixed (test reliability)*.

**Fixed:**
- **`.claude/agents/{spec-reviewer,dual-reviewer,plan-reviewer,brief-reviewer,verify-phase,feature-coordinator}.md` — the newer-of binary-resolution rule was documented and unenforced.** `references/codex-invocation-contract.md` § Binary resolution has required "the newer of PATH vs the npm global shim" since it was written, and then showed the old `CODEX_BIN=$(command -v codex …)` snippet as "the existing lookup". All **six** agents used that snippet, so on the operator's reference machine every tier silently selected 0.138.0 — which hard-errors against the provisioned model — while a working 0.144.3 sat in the npm prefix. Every agent now calls the shared resolver, the contract shows only that call, and a test asserts no agent reintroduces a PATH-first lookup. *A resolution rule stated in prose and re-implemented per caller will drift; one script, called by every caller, cannot.*
- **`scripts/status/board-sync.mjs` — a stale terminal record archived a NEWER active card.** `shouldSkipStale` and `shouldArchive` were each correct, but the sync loop evaluated archival **independently** of whether it had accepted the record: existing card updated 28 Jul, incoming `MERGED` record dated 1 Jul → the update was correctly skipped as stale, and then the newer active card was archived on the strength of the record just rejected. Because the bug was in the *composition*, the decision is now a pure exported `decideCardAction(survivor, record, now)` with the invariant pinned by test — a record too stale to apply is too stale to archive on. A test over the two predicates alone could never have caught this.
- **`scripts/status/generate-current-focus.mjs` — unrecognised statuses vanished silently.** Terminal (`MERGED`/`ABANDONED`) and *unrecognised* statuses shared one bare `continue`, so a typo (`REVIEWNG`) or a future enum value dropped out of the generated block entirely — despite this module documenting a fail-loud `INVALID:` channel for schema problems, and a status outside the schema enum being exactly that. Terminal statuses are now a named set and excluded silently; anything else reports `INVALID: <dir> — unrecognised status "..." — expected one of ...` and still exits 0.
- **`scripts/runner/install-runner.ps1` — `-Uninstall` could not recover a partial install.** With no `.runner` present it printed "nothing to uninstall" and exited 0, leaving the work directory, the systemd unit and the Windows auto-start task behind. That is precisely the state the C22 spike produced (tarball extracted, `config.sh` timed out, no registration), so the one case the script most needed to handle was the one it declined. It now sweeps residue: reports exactly what it found, removes the systemd unit and the scheduled task, and deletes the work directory **only when `config.sh` is present** — without that evidence it reports the directory and refuses, because deleting an operator directory that merely shares the configured path is worse than leaving residue. The `-WhatIf` plan describes the sweep.

**Fixed (test reliability):**
- Suites here test shell, PowerShell and CLI entry points by **spawning** them, and on Windows each spawn costs hundreds of milliseconds. Under full-suite parallel load that crossed Vitest's 5 s default: one observed run failed **11 cases across 7 files** while the very next run passed everything. Raised globally rather than per file, since the flakiness is a property of the whole spawn-based suite class. This weakens no assertion — a genuinely hung test still fails, 30 s later. **A flaky suite is worse than a slow one:** every gate reading downstream of `npm test` becomes untrustworthy, and the standard response to a flaky red is to re-run until green, which is exactly how a real failure gets waved through.

**Tests:** 602 across 54 files, green on three consecutive full runs (was 586/53, with a known intermittent timeout).

## 2.45.1 — 2026-07-28

**Highlights:** Follow-up release fixing defects **introduced by v2.45.0's own fixes**, plus a latent template bug that would have broken the merge gate on first real use. Found by a three-iteration Codex review loop run specifically to hunt for regressions in the previous release. 22 findings fixed, 6 rejected. Anyone on v2.45.0 should take this.

**The lesson worth recording:** every *critical* finding in this round was a defect in a v2.45.0 fix. Two of the three review iterations each introduced a further bug that the next iteration caught. That is an argument for keeping the review loop at three iterations rather than one, and for verifying fixes by **execution** rather than inspection — two of the sharpest findings below were only reachable by running the code.

**Fixed (regressions introduced by v2.45.0):**
- `scripts/runner/install-runner.ps1` — **every uninstall would deregister the runner and then throw.** `config.sh remove` deletes `.runner` as part of unconfiguring, and v2.45.0's new pre-delete assertion (which requires both `.runner` and `config.sh` to be present) ran *after* it. So `-Uninstall` removed the GitHub-side registration, failed before deleting anything, and left the files behind; `-Repair` never reached its reinstall. The assertion now runs before `config.sh remove`, and the ordering constraint is documented at both call sites.
- `scripts/runner/install-runner.ps1` — **the work-dir floor compared spellings, not paths.** `-WorkDir '~//'` resolved to `"$HOME/"`, which is not string-equal to `$HOME`, so the guard passed and the installer would have untarred across the home directory that a later `-Uninstall` would `rm -rf`. Two further bypasses surfaced after the first fix: a symlink pointing into `/mnt`, and a case-insensitive comparison combined with a logical (non-resolved) `pwd`. All verified closed against real symlinks, including `/MNT -> /mnt`.
- `scripts/status/board-sync.mjs` — **still could not read its own cards.** v2.45.0 unified the field *name* behind one constant but not the *key shape*: `gh` emits the field as `build Repo`, not `Build Repo`, so the upsert key still never matched and every sync would still have created a duplicate. Worse, the regression test built its fixture from the code's own constant, so it asserted the implementation's assumption rather than testing the real shape — and the live board has zero cards, so nothing exercised it.

**Fixed (latent, pre-existing since the template was authored):**
- `templates/github-workflows/merge-gate.yml` — **`resolve-label` could not check out the tested commit.** A job-level `permissions:` block **replaces** the workflow-level one rather than merging with it, so every scope omitted becomes `none`. `resolve-label` declared only `pull-requests: read`, which withdrew `contents: read` from the one job in the file that runs `actions/checkout` — the gate would have failed on every run on a private repo. Present since the template was written (v2.44.4 has the same job-level block and no workflow-level one), so v2.45.0's least-privilege floor neither caused nor fixed it. Both scopes are now listed together, with the replace-not-merge semantics documented inline.

**Fixed (found by executing the code, not reading it):**
- `scripts/runner/install-runner.ps1` — `$ErrorActionPreference = 'Stop'` turns redirected native stderr into a **terminating** error, so every carefully-worded fail-closed message in the installer was unreachable, and the deliberately-tolerated `(sudo ./svc.sh stop || true)` aborted the uninstall anyway. The preference is now scoped around native invocations.
- `scripts/runner/install-runner.ps1` — **a bash payload containing a double quote did not survive the argv hop**: `printf %s 'A"B'` made bash exit 2. That breaks `ConvertTo-BashSingleQuoted`, which is the file's entire shell-injection defence and which quotes the registration token.

Plus 16 further important/minor fixes across the gates, status scripts, and their tests. Full per-finding detail with accept/reject reasoning: `tasks/review-logs/dual-review-log-dev-pipeline-v2-2026-07-28T10-54-01Z.md` in the consuming repo.

**Known and deliberately not changed** (routed for an operator decision): bind mounts and a non-default WSL `[automount] root=` can still reach the Windows drive — closing that needs filesystem-type detection rather than path canonicalisation, and the comment that overclaimed coverage has been corrected. Separately, the PowerShell test suite silently **skips** on a Linux runner because `pwsh` is not installed there.

**Tests:** 586 across 53 files, all green (up from 561).

## 2.45.0 — 2026-07-28

**Highlights:** Review-hardening release. Fixes one reproduced data-loss bug, one broken idempotency key, and four fail-open safety gaps found by an independent code review and an adversarial threat-model review of the CI/runner surface shipped in v2.44.x. **Behaviour changes** are called out below: `-WorkDir ~` is now rejected, and `ci-light.yml` no longer inherits repo secrets.

**Fixed (blocking):**
- `scripts/status/generate-current-focus.mjs` — **the marker-replacement path silently destroyed file content (reproduced).** It re-derived both block boundaries with unchecked `indexOf` calls: `indexOf('\n', begin) + 1` evaluates to `0` when the BEGIN marker has no following newline, collapsing the "before" slice to `''` and deleting everything above the block; and a fresh `indexOf(END_MARKER, …)` returning `-1` made `slice(-1)` substitute the file's last character for the entire tail. With a marker pair sharing one line, the operator's prose below it was deleted while the script printed success and exited 0 — directly against the module's own byte-preservation promise. Both boundaries now come from the already-validated indices. All three coordinators invoke this at every status write.
- `scripts/status/generate-current-focus.mjs` — **added the entry-point guard** its two siblings already had. `main()` ran at module scope with `--root` defaulting to the CWD, so an `import` rewrote `tasks/current-focus.md` in whatever repo the importing process was in. This had already fired once against the framework's own file.
- `scripts/status/board-sync.mjs` — **the upsert key was read under a different name than it was written**, so every sync created a duplicate card. v2.44.1 renamed the field `Repo` → `Build Repo` (Projects v2 reserves `Repo`) at the create and write sites, but `normaliseItem` still read `item.Repo`. The parsed repo was therefore always `null`, every existing card was skipped as "not one of ours", and duplicate recovery, stale-skip and the MERGED auto-archive were all unreachable. Both sides now read one exported `REPO_FIELD_NAME` constant, and `normaliseItem` is exported so the read side is testable — it was unexported, which is why a full test run could not catch the divergence.
- `scripts/runner/install-runner.ps1` — **`Get-ExistingRunnerConfig` failed open.** `cat … 2>/dev/null` made "absent", "unreadable" and "wsl error" indistinguishable, and the caller reads that as "nothing registered" and proceeds to install with `config.sh --replace`, clobbering whatever registration is actually present. That is the detect-and-skip behaviour the script's own description forbids and its headline safety property. Absence and unreadability are now distinguished, and both unreadable and non-zero-exit fail closed.

**Fixed (security / fail-open):**
- `scripts/runner/install-runner.ps1` — **refuses to register a persistent runner on a PUBLIC repo.** Spec §7.5 pins "private repos only", but nothing verified it. A runner's jobs run as a user that must be in the docker group (the installer makes `docker info` a hard precondition), docker group is root-equivalent, and `/mnt/*` exposes the whole Windows drive — so a runner on a public repo turns any fork PR into arbitrary code execution against every `.env` and sibling repo on the machine. Now a fail-closed precondition, checked with the already-authenticated `gh`; unknown visibility also refuses.
- `scripts/runner/install-runner.ps1` — **bounded what `-WorkDir` may resolve to, and added a pre-delete assertion.** `~` resolved to the distro home and any absolute path was accepted, so `-WorkDir ~` would untar the runner across `$HOME` and a later `-Uninstall`/`-Repair` would `rm -rf` the home directory; an absolute `/mnt/…` path reached the Windows filesystem. The home directory, filesystem root, and `/mnt/*` are now rejected, and both delete paths first assert the target actually contains `.runner` **and** `config.sh`. **Behaviour change:** `-WorkDir ~` is now an error — pass a dedicated subdirectory.
- `scripts/gates/verify-factory-invocation.mjs` — **the gate was silenceable to a clean green.** It failed closed on 0 *derived* factories but not on 0 *matched* registrations, so a `GATE_METHOD_SET` naming a method the repo never calls made every AST walk match nothing while the pass line still read like a real inspection — reachable from a branch-controlled workflow `env:` block. Now fails closed on zero matched call sites, and both gates fail closed on an empty method set. The pass line reports registrations matched, suppressions applied, and the effective method set, so a neutered run is visible as a log diff.
- `scripts/gates/verify-gate-syntax.sh` — **the "guards for the guards" reported success having validated nothing.** An empty or failed scan printed `[PASS] All 0 parsed scripts` and exited 0; `set -euo pipefail` does not propagate a failure out of the process substitution feeding the loop, so the count is the only signal. Now fails closed at zero parsed scripts.
- `templates/github-workflows/ci-light.yml` — **dropped `secrets: inherit` from the ungated lane.** This lane runs on every pull request with no label gate, so inheriting the entire repo secret set meant a one-line edit to a branch's own callee could exfiltrate every secret with no operator action and no gate involved. Lint, typecheck and static gates need none. **Behaviour change:** a consumer whose light suite genuinely needs a secret now declares it explicitly. Both templates also gained a workflow-level `permissions: contents: read` floor, so spec §7.5's read-only-token posture travels with the workflow instead of depending on an unverifiable repo settings default.
- `templates/github-workflows/*.yml` — **the trust-boundary standing condition now survives rendering.** It lived in the leading header comment, which the renderer strips by design, so the workflow an operator actually reads in their repo carried no trust-boundary text at all — voiding what the spec says is "recorded as a standing condition in the templates". Moved below `name:`, where body comments are retained verbatim.

**Fixed (correctness):**
- `scripts/gates/verify-factory-invocation.mjs` — `deriveFactories` now recurses and skips test files, matching its own scan side. It read only the top level of `GATE_SOURCE_DIR`, so a repo organising middleware into subdirectories silently lost every factory in that subtree while the gate still printed a confident "N factories tracked" pass. The zero-count tripwire catches total derivation failure but is blind to this partial narrowing.

**Tests:** +13 cases covering every bug above, each written to fail against the previous version — the one-line-marker truncation, the import-writes-the-file guard, the upsert-key round trip (including that the legacy `Repo` key must *not* resolve), the neutered method set, and the work-dir floor. One prior assertion was **changed**: `install-runner.test.mjs` asserted that a bare `~` resolves to the home directory, encoding the hazard as the contract; it now asserts the fail-closed behaviour. Full suite green: 561 tests across 53 files.

## 2.44.4 — 2026-07-28

**Highlights:** Patch. Fixes a rethrow in `scripts/adopt-ci-templates.mjs` that passed this repo's lint but failed a consuming repo's stricter config. Found by running the consumer's G2 gate over the synced copy, which is the only place the two configs meet.

**Fixed:**
- `scripts/adopt-ci-templates.mjs` — the JSON-parse failure path rethrew a new `Error` without attaching the original as `cause`, discarding the parser's position information (`preserve-caught-error`). A malformed `project-registries.json` reported *that* it could not be parsed but dropped the underlying detail that says *where*. Now rethrows with `{ cause: err }`. Swept the rest of the framework's `.mjs` scripts for the same pattern: no other uncaused rethrows.

> **Note for framework maintainers.** This class of defect is invisible to the framework's own lint. Consumers may enable rules the framework does not, and a synced script is linted under *their* config. When a shipped script changes, running a consuming repo's lint over the synced copy is the check that catches it — the framework being green is not sufficient evidence.

## 2.44.3 — 2026-07-28

**Highlights:** Patch. Fixes a work-dir resolution defect in `scripts/runner/install-runner.ps1` found by running the installer on real hardware: a self-hosted runner installed itself into the calling repo's working tree instead of the WSL2 distro's home directory. Any repo that adopted v2.44.0–v2.44.2 and ran the installer should check for a literal `~` directory at its root.

**Fixed:**
- `scripts/runner/install-runner.ps1` — `$WorkDir` defaulted to `~/actions-runner/<slug>` and was then single-quoted into every `bash -lc` payload (the injection defence added in the same release). Bash does not expand `~` inside single quotes, so `mkdir -p '~/actions-runner/...'` created a **literal** directory named `~` relative to bash's working directory — which, for `wsl.exe` launched from a Windows directory, is that directory under `/mnt/c`. Observed on a pilot repo: 666 MB of runner extracted into the working tree, where the runner's own symlinks then made `git add -A` fail with `Function not implemented`. The same quoting reached `Get-ExistingRunnerConfig`'s `.runner` probe and the `rm -rf` in repair/uninstall, so the idempotency guard could miss an existing install and uninstall could leave the orphan behind. The distro's real `$HOME` is now read once and `~` resolved up-front, keeping the quoting defence intact while every downstream site operates on an absolute, CWD-independent path. Relative and `~user` forms fail closed with a message naming the `/mnt/c` trap instead of being guessed at. Resolution runs after the `-WhatIf` early-exit, because reading `$HOME` starts the WSL2 VM and `-WhatIf` documents that it never does. `-WhatIf` could not have caught the original bug: the preview prints the unexpanded string, which reads as correct.

**Added:**
- `scripts/runner/install-runner.test.mjs` — regression suite. Executes the real `Resolve-DistroWorkDir` extracted from the `.ps1` via the PowerShell AST, so the logic under test is the shipped logic rather than a copy; source invariants cover the wiring a pure-function test cannot see (resolver runs before the main flow passes `$WorkDir` onward, resolution stays after the `-WhatIf` exit, file stays ASCII-only). Skips cleanly where no PowerShell host exists, so it stays green on Linux runners.

## 2.44.2 — 2026-07-28

**Highlights:** Patch. Promotes three spec-review rules that had been living as an un-upstreamed local delta in a consuming repo, surfaced when v2.44.1 sync flagged the file as customised.

**Added:**
- `scripts/chatgpt-reviewPure.ts` — three spec-review hunt rules promoted from a consumer overlay: invariant-vs-mechanism contradictions (a stated determinism/idempotency/replay invariant undermined by a resource-budget stop, cache regeneration or partial-failure path), fingerprint / stable-identity completeness (acceptance depending on a fingerprint no section derives is unimplementable-as-specified), and closed-membership completeness under multi-relationship inputs. Load-bearing review capability that would have been lost by resolving the sync conflict in the other direction.

## 2.44.1 — 2026-07-28

**Highlights:** Patch. `board-sync.mjs` could not create its identity field on a real Projects v2 board — `Repo` is a reserved field name and `createProjectV2Field` rejects it outright. Found by running `--init` against a live board during the pilot adoption, which is precisely the class of defect no amount of review catches.

**Fixed:**
- `scripts/status/board-sync.mjs` — the repository identity field is now named `Build Repo` (`Repo` is reserved; GraphQL returns `Name cannot have a reserved value`). The upsert key semantics, lowercase canonicalisation and duplicate-recovery tie-break are unchanged; only the field label moved. Header docs and the card-mapping test updated to match.

## 2.44.0 — 2026-07-28

**Highlights:** Development Pipeline v2 — the orchestrated multi-vendor pipeline. Every Codex review tier now invokes the CLI through one canonical contract with full repository context; two new review tiers (plan, brief) close the gaps at the plan and brief stages; a Codex-owned verify phase becomes a real gate at Phase 3 entry; per-build `status.json` replaces the hand-merged current-focus pointer and feeds a GitHub Projects board; and CI moves to self-hosted templates with the full suite gated at exactly two checkpoints per build. Ships alongside two auth-guard gate ports and the guards-for-the-guards meta-validator.

**Added:**
- `references/codex-invocation-contract.md` — the single source every Codex tier cites. Read-only review mode (`codex exec -s read-only`, artefact by path, explicit grounding instruction) and a separately-named write-enabled mode for verify-phase test authoring, so no tier infers write access from the read-only shape. Newer-of PATH-vs-npm-shim binary resolution. Fail-closed sandbox clause: no fallback accepting read-only means STOP and record a REVIEW_GAP, never an unsandboxed invocation.
- `.claude/agents/plan-reviewer.md` — Codex plan tier, cloned from spec-reviewer, reviewing `tasks/builds/<slug>/plan.md` with plan/spec drift as its primary hunt target. Cap 5 per plan lifetime.
- `.claude/agents/brief-reviewer.md` — inline playbook: Codex grounding pass then a ChatGPT right-thing-to-build pass. Single round per brief revision, advisory, never a gate. No Claude tier at the brief stage by design.
- `.claude/agents/verify-phase.md` — the stage-6 gate. Design → author (bounded by the consuming repo's declared testing posture) → run → fix loop (test defects fixed by Codex, app defects routed to Claude; Codex never edits production code) → report. Re-entry resumes from the persisted plan; stale-input mismatch refuses resume.
- `schemas/build-status.schema.json` — the `build-status.v1` contract. Closed status/phase enums, an open `gates` map with a closed value enum, `gate_evidence` with `run_ids[]`.
- `scripts/status/generate-current-focus.mjs` — lists every non-terminal build inside `STATUS:GENERATED` markers, ordered by status priority; atomic writes; duplicate markers are a hard error; invalid records surface as `INVALID:` lines rather than vanishing.
- `scripts/status/board-sync.mjs` — one draft card per build on an account-level Projects v2 board, keyed `{repository, slug}` with the repo lowercased. Non-blocking by design; the sole fail-closed case is a slug/directory mismatch, which would corrupt another build's card.
- `templates/github-workflows/{ci-light,merge-gate}.yml` — callers owning the gate contract; each repo supplies its suite through a `workflow_call` callee. Event-conditional commit identity, provenance echo, live label re-query, and a merge-guard that observes the suites' actual results.
- `scripts/adopt-ci-templates.mjs` — fail-closed renderer. Per-target requirements, presence-not-truthiness boolean checks, path targets must exist, and bare `{{TOKEN}}` substitution that leaves GitHub Actions expressions untouched.
- `scripts/runner/install-runner.ps1` — per-repo runner registration inside WSL2, with wrong-repo detection that errors rather than skipping, `--repair`/`--uninstall`, and boot auto-start.
- `scripts/gates/verify-factory-invocation.mjs`, `scripts/gates/verify-duplicate-registrations.mjs` — generic ports of two silent-override detectors, warning-first with an env flip to blocking, plus fixture self-tests.
- `scripts/gates/verify-gate-syntax.sh` — guards for the guards. A closed, enumerated extension-routing table so the failure branch is only reachable by deliberate fall-through. Not a counted gate: the library is 8 gates + 1 meta-validator.

**Changed:**
- `spec-reviewer` and `dual-reviewer` now cite the invocation contract instead of embedding divergent command lines; the stdin pipe and `codex review`-on-diff are gone.
- All three coordinators upsert `status.json` at every phase transition and run the generator; feature- and finalisation-coordinator also sync the board. `status.json` is authoritative; `.phase` is a derived projection rewritten on disagreement.
- `feature-coordinator` gains a `plan-reviewer` step between the Claude and ChatGPT plan tiers, and a mandatory turn-discipline rule: a chunk-completion report never ends a turn.
- `finalisation-coordinator` gains the verify-phase step at Phase 3 entry, a conditional Codex confirmation pass, an 8-row merge-refusal table keyed on the PR head SHA as the enforcement of record, and a `runner_live` conditional that retires G5 only where a real merge gate replaced it.
- `.claude/hooks/phase-lock.js` — `status.json` admitted to the spec/plan allowlists; the governing slug is derived from the path being written; the `build_slug` fallback is scoped to the generated marker region when it exists. Pre-migration behaviour is byte-identical.
- `references/test-gate-policy.md` — narrow carve-out naming verify-phase as the sole additional agent permitted the full local suite.
- `references/iteration-caps.md` — registers the plan-reviewer, brief-reviewer and verify-phase fix-loop caps.
- `ci-gate-integrity` and `wire-it-through` skills gain the silent-override registry lessons.
- `package.json` — `typescript` added as a devDependency, pinned `^5` because the v7 rewrite removed the classic Compiler API the two new gates use.

**Fixed:**
- `phase-lock.js` resolved the governing slug from the first `build_slug:` match anywhere in `current-focus.md`, so a frozen legacy block could hijack resolution and — when that slug had no `.phase` — silently disable phase enforcement entirely.
- `config-protection.js` no longer gates `package.json` (standing operator pre-approval); every other protected surface is unchanged.
- The three ChatGPT review agents now carry a mandatory next-round artifact discipline, so a manual or parallel review round always hands over the updated artifact, refreshed context, pinned hash and next prompt.

## 2.43.3 — 2026-07-17

**Highlights:** patch — ESM-consumer compatibility for the secret scanner and vitest-convention adoption for the anchors test, the third and final fix in the 2.43.x consumer-gate series. `scripts/check-secrets.js` is CommonJS, so consumers with `"type": "module"` parsed it as ESM and both the CLI and its test suite crashed ("require is not defined"); renamed to `scripts/check-secrets.cjs`, which pins CJS in every consumer. `scripts/__tests__/generate-architecture-anchors.test.ts` was written on node:test, which vitest-only consumers collect as an empty suite; the vitest conversion automation-v1 had already made locally is adopted upstream (with explicit 120s timeouts on the three CLI-spawn tests — the spawns exceed vitest's 5s default on slower machines).

**Changed:** scripts/check-secrets.js → scripts/check-secrets.cjs (content identical; manifest, ci.yml, CONTRIBUTING, gates README, verify-no-secrets.sh, and the test import updated). scripts/__tests__/generate-architecture-anchors.test.ts — node:test → vitest (consumer conversion adopted; run-tests.js routes it by runner automatically). Migration: v2.43.3.js — deletes the consumer's orphaned `scripts/check-secrets.js` when it matches the framework-deployed content (state entry dropped too); diverged copies get a conflict note instead, never deleted. Covered by three new cases in tests/migrations.test.ts.

## 2.43.2 — 2026-07-17

**Highlights:** patch — second consumer lint-gate compatibility sweep, same failure class as 2.43.1. automation-v1's ESLint errors on `no-useless-escape` and `no-useless-assignment`; canonical `harness-metricsPure.ts` carried `[:\-]` character classes (4 sites across the TS_TAIL and dateTime regexes) and `knowledge-citations.ts` a dead `let ok = false` initialiser. The consumer copies had been locally lint-fixed (the very divergence /claudeupdate flagged as customised), and the post-merge resync clobbered those fixes back to canonical — so the fixes land upstream, keeping consumers byte-identical AND gate-green.

**Fixed:** scripts/harness-metricsPure.ts — `[:\-]` → `[:-]` in both timestamp regexes (dash last in class, no escape needed; behaviour identical, 25 tests green). scripts/knowledge-citations.ts — `let ok = false;` → `let ok: boolean;` in the pathExists cache helper (both branches assign before use). No migration: content-only changes deployed by `sync.js`.

## 2.43.1 — 2026-07-17

**Highlights:** patch — consumer lint-gate compatibility fix for the memory-digest hook. automation-v1's ESLint flat config enforces `no-useless-assignment` as an error and rejected canonical `memory-digest.js` line 296 (`let lines = [];` where both the try and catch branches assign `lines`), failing the consumer's Lint + Typecheck + Static gates CI on the 2.43.0 bump PR. The consumer copy had been locally lint-fixed, which made it divergent-from-canonical — exactly the fork the behavioural framework-wins rule forbids — so the fix lands upstream instead.

**Fixed:** .claude/hooks/memory-digest.js — dropped the redundant initialiser (`let lines = [];` → `let lines;`) in `sourceLines()`; both branches assign before use, behaviour unchanged, hook test green. No migration: content-only change deployed by `sync.js`.

## 2.43.0 — 2026-07-16

**Highlights:** harness self-audit batch (source: clean-my-ai-harness read-only audit of this repo's own Claude setup + the validate-setup ↔ framework-doctor probation comparison it prescribed; PR #46). Headline discovery: Claude Code registers `.claude/agents/**` recursively, so the `_retired/` subfolder alone never unloaded a retired agent — reality-checker sat retired-but-live in the session router since 2.21.0. Fixed by an in-place `.md.retired` extension rename (verified live: the host dropped it from the agent list mid-session), and the retirement convention now encodes the rename as the load-bearing step. Also ships a behavioral drift gate between the two config-guard hooks' duplicated protected-path lists, restores this changelog to greppable UTF-8 text, and lands all seven follow-up findings from the health-check comparison (verdict: keep both — disjoint coverage).

**Added:** bash-config-guard.test.js sync block — 10 behavioral checks driving BOTH guard hooks (bash-config-guard + config-protection) over shared probe paths, failing on protected-path drift beyond the two documented deltas (settings.local.json Bash-side only; tooling basenames Edit-side only); drift detection proven against a doctored hook copy. CONTRIBUTING § Retiring an agent (five-step retirement; `.md.retired` rename is the de-registration step). docs/doc-sync.md: 14 previously unregistered docs added to the coverage table with per-doc update triggers (9 references/*, 5 docs/*). manifest: scripts/__tests__/applyFindingsPure.test.ts + review-mode-flip-consistency.test.ts (review-script-test) and eval-promptsPure.test.ts (helper-script-test) now ship with their already-managed sources.
**Changed:** fable-mode SKILL trigger reworded to any-tier — the five gates are the discipline, not a substitute for capability (skill-routing evals 202/202 green). deprecation SKILL retirement paragraph names the `.md.retired` rename and its dangling "CONTRIBUTING § agent lifecycle" pointer now targets the new CONTRIBUTING section. regression-scribe: docs/incidents/_template.md citations made conditional with an inline fallback — the agent's five post-mortem sections ARE the template, so a repo without the file can't block the nightly rail. pr-reviewer: scripts/verify-test-quality.sh citation qualified ("where the project ships a test-quality gate"). agent-context.md template: regression-scribe added to the valid-agent-names hint. scripts/validate-framework-allowlist.json: docs/integration-reference.md registered in consumerFiles.
**Fixed:** retired reality-checker de-registered for real (renamed `.claude/agents/_retired/reality-checker-2026-06-18.md` → `.md.retired`, content byte-identical). This changelog restored as UTF-8 text — raw NUL/0x1F/0x7F control bytes inside the 2.36.x entry's documented regex literal replaced with their escape spellings (`/[\x00-\x1f\x7f]/`); the file had been classified binary by git, grep, and scanners, hiding release history from text search. Framework-repo housekeeping: session-generated code-graph artifacts (references/.code-graph-cache.json, .watcher.pid, import-graph/, project-map.md) gitignored; stale tasks/current-focus.md reset to NONE. No migration: nothing here requires a consumer-side reaction — the `_retired/` file never synced (single-star agents glob), and the new manifest entries flow through normal `sync.js` deployment.

## 2.42.0 — 2026-07-16

**Highlights:** consumer-facing secret-sweep gate (source: launch-readiness coverage audit 2026-07-16, deferred item 4). `scripts/gates/verify-no-secrets.sh` joins the verify-gates library as a thin fail-closed wrapper over the now-framework-synced `scripts/check-secrets.js` scanner: 8 provider-shaped pattern families (AWS, GitHub classic + fine-grained PAT, OpenAI/Anthropic, Stripe secret/restricted, Slack, Google, private-key blocks), proof-of-life on zero files scanned, redacted findings with sha256 fingerprints, and an exact-instance allowlist (`{path, sha256, reason}`) where glob paths are config errors and stale entries fail the gate.

**Added:** scripts/gates/verify-no-secrets.sh (covered by the existing `scripts/gates/*.sh` manifest glob); scripts/check-secrets.js + scripts/__tests__/check-secrets.test.ts promoted from framework-only tooling to managed files (categories helper-script / helper-script-test) so consumers receive the scanner and its 26-test suite.
**Changed:** scripts/gates/README.md (verify-no-secrets section + wiring example); scripts/check-secrets.js allowlist path now overridable via `CHECK_SECRETS_ALLOWLIST` (the gate wrapper points it at `scripts/gates/.baselines/secrets-allowlist.json`, keeping consumer baselines in consumer state per the gates convention); docs/codebase-audit-framework-template.md Module A secrets bullet now points at the shipped gate for the tracked-file layer (template is adopt-only — existing adopters add the pointer to their calibrated copy manually). No migration: new files deploy via `sync.js`; wiring the gate into consumer CI is a consumer-side step documented in the gates README.

## 2.41.0 — 2026-07-16

**Highlights:** launch-readiness coverage batch (source: consumer audit-runner coverage review 2026-07-15 — a gap analysis of the audit framework + skills against an external production-readiness checklist found 3 unchecked concern classes and 6 partial ones). The audit-framework template's generic modules gain account-lifecycle security, extended secret sweeps, HTTPS/session-cookie enforcement, environment separation, payment live-mode readiness, response-payload sizing, auth-flow critical paths, off-screen human alerting, backup/restore-drill verification, and a migration-discipline sweep, plus a Pre-launch audit mode; `performance` gains write-time pagination and background-job rules; `postgres-migrations` gains the FK-covering-index rule. No new modules, headings, or scoring axes (template Scope Guard respected).

**Changed:** docs/codebase-audit-framework-template.md (Module A: client-bundle + git-history secret sweeps, rate-limiter surface enumeration + public-route sweep, account lifecycle incl. email-verification-required, bot/fake-account protection, password-reset token hygiene + brute-force lockout, HTTPS + session-cookie flags, environment separation, payment live-mode readiness; Module B: response-payload projection bullet; Module C: auth flows named as critical paths; Module E: off-screen human alert sink, backup/restore drill, migration-discipline sweep; §9: Pre-launch Audit mode row); .claude/skills/performance/SKILL.md (Database: every list query carries LIMIT/pagination at write time; Hot paths: expensive or slow work runs as a background job, never inside an HTTP request handler); .claude/skills/postgres-migrations/SKILL.md (Indexes: every new FK column ships with a covering index in the same migration or a one-line recorded reason). No migration: content-only changes deployed by `sync.js` (template is adopt-only — existing adopters apply the new checks to their calibrated copy manually; skills sync automatically).

## 2.40.0 — 2026-07-15

**Highlights:** new `feature-register` skill — a paste-ready register entry for a build (feature name, one-sentence description, branch, brief/spec/plan paths as a six-line dot-point block) for operators tracking features in a spreadsheet. Sourced from `tasks/builds/<slug>/` with a deterministic current-build resolution order (branch match → current-focus pointer → most recent build dir) and an `all` mode for backfilling a register. Read-only by contract.

**Added:** .claude/skills/feature-register/ (SKILL.md; manifest entry; routing eval case `evals/skill-routing/feature-register.json`; README count 23; rule-ledger rows for all six headings). No migration: pure additive file, deployed by `sync.js` automatically.

## 2.39.0 — 2026-07-13

**Highlights:** external-catalogue adoption batch, tier 2 of 2 (source: addyosmani/agent-skills, MIT, commit 98967c4): reviewer-briefing discipline (withhold the claim, contract-misread precedence, doubt-theater stop signal), a supply-chain install-script gate, a new producer-side deprecation skill (22nd skill — sunset decisions, Churn Rule, zombie-code trigger, removal protocol), structural review heuristics for pr-reviewer, and a 10-fragment rule sweep across coordinators, skills, and checklists.

**Added:** .claude/skills/deprecation/ (SKILL.md; manifest entry; routing eval case; README count 22); CONTRIBUTING "Adding a skill" steps 6-7 (routing eval case + ledger registration).

**Changed:** .claude/skills/review-triage (new § Briefing the reviewer — claim-withholding, contract-misread-first, doubt-theater signal); .claude/skills/dependency-upgrades (new § Install scripts and supply chain — scripts-off-by-default gate, per-manager policy verification, installation-boundary rule, typosquat review; description names install-script policy); .claude/agents/pr-reviewer.md (new § Structural review heuristics — propose-the-move catalogue, relocated-vs-reduced complexity test, file-total-size signal, lead-with-leverage); fragment sweep: feature-coordinator (hedged approval is not approval at the plan gate), builder (DID NOT TOUCH verdict line), docs/spec-authoring-checklist.md (flag owner/expiry at creation; ASSUMPTIONS block; Always/Ask-first/Never boundaries tier), test-discipline (blind repro-test subagent), security-hardening (SSRF DNS-rebinding TOCTOU pin), performance (symptom-routed measurement picker, metric-honesty rule, CI-gated budgets, named CWV thresholds), architect (chunk split signals: "and" in title, 8+ files, >3 acceptance bullets), ci-gate-integrity (validator-owned exemption allowlists fail loud on self-declared exemptions), refactor-safely (Rule of 500 — codemod over hand edits), fable-mode Gate 4 (anti-reassurance rerun rule). Rule-classification ledger: 9 new rows.

## 2.38.0 — 2026-07-13

**Highlights:** external-catalogue adoption batch, tier 1 of 2 (source: addyosmani/agent-skills, MIT, audited 2026-07-13): a deterministic skill-routing eval harness protecting the 21-skill catalogue from silent trigger drift, a metrics/alerting layer for logging-observability, an accessibility baseline (first a11y coverage in the framework — checklist doc + mockup-reviewer gating axis + frontend-design-check step), grill-me interview mechanics (confidence protocol, hollow-yes gate, de-sophistication probe, stop conditions), and untrusted-content-channel rules extending injection defence beyond LLM output to error text, CI logs, browser content, and CLI-piped artifacts.

**Added:** scripts/skill-routing-evals.ts + skill-routing-evalsPure.ts + Vitest test + evals/skill-routing/ (21 routing case files + README; framework CI only, not consumer-shipped) + `npm run eval:routing` + CI step; docs/accessibility-checklist.md (manifest: reference, sync).

**Changed:** .claude/skills/logging-observability (instrument-to-a-question, RED/USE + cardinality, symptom-based two-severity alerting + test-fire rule, telemetry-verification gate; description now names alerts/metric labels); .claude/skills/grill-me (confidence protocol, hollow-yes gate, de-sophistication probe, stop conditions incl. mandatory Out-of-scope restate line and non-interactive guard); .claude/skills/security-hardening (new § Untrusted content channels beyond the request; description extended); .claude/skills/frontend-design-check (step 4: accessibility baseline); .claude/agents/mockup-reviewer.md (new Axis 3.5 — accessibility baseline, gating; reads accessibility-checklist); .claude/agents/dual-reviewer.md (untrusted-channel rule for CODEX_OUTPUT); README What-ships (accessibility row, scripts row); package.json (`eval:routing` script, operator-approved 2026-07-13).

## 2.37.0 — 2026-07-11

**Highlights:** six harness meta-upgrades in one batch: a stated harness goal (GOAL.md — operator leverage, with decision test, prescription rule, rule lifecycle, and precedence contract), a full rule-classification ledger over the behavioural corpus with a coverage checker, memory that compounds (knowledge index + index-matched digest recall + append-time dedup advisory + supersede convention + citation/staleness checker), the measurement layer turned on (harness-metrics aggregator + metric definitions + starter eval suite contract exercised consumer-side), an autonomy-ladder registry of every autonomous authority and operator gate, and the wargame skill (risky-operation planning artifact) with its nudge hook.

**Added:** GOAL.md; references/rule-classification.md; references/harness-metrics.md; references/autonomy-ladder.md; .claude/skills/wargame/ (SKILL.md + 3 references — first multi-file skill); .claude/hooks/wargame-nudge.js + wargame-nudge.test.js; scripts/generate-knowledge-index(Pure).ts, scripts/knowledge-citations(Pure).ts, scripts/harness-metrics(Pure).ts + Vitest tests; scripts/check-rule-ledger.js (framework-only tooling).

**Changed (decision-gate applications, operator-approved 2026-07-10):** `--admin` merge narrowed to the provably-redundant docs-only prep-commit case (DG-5, finalisation Step 12.3); evidence-flip rung + pinned flip-to-automated criterion, dormant (DG-4/DG-6, review-mode-resolution.md); eval-gated prompt-proposal auto-apply (DG-7, parallel-mode.md + three chatgpt agents); per-round batch approval with [INDIVIDUAL] carve-out (DG-8, three chatgpt agents); MODE/AUTONOMY restatements deduplicated into review-mode-resolution.md pointers (kill-list K1); incident-history clauses reduced to lock markers in seven rule sites, evidence now carried by the rule-classification ledger (K3). Also: purpose lines tracing to GOAL.md in 17 coordinator/reviewer agent files; ADAPT.md Phase 4 gains the GOAL.md pointer section; finalisation-coordinator Step 7 supersede convention (replaces update-instead-of-duplicating) + knowledge-index regeneration ownership + Step 7a reads harness-metrics reports; .claude/hooks/memory-digest.js index-matched recall + knowledge-append-guard.js dedup advisory (with expanded tests); README What-ships counts (21 skills, 11 hooks); CONTRIBUTING hook-manifest correction (per-file entries, not globs); .claude/settings.json wargame-nudge UserPromptSubmit registration.

## 2.36.0 — 2026-07-10

**Highlights:** context-pack adoption is now self-completing. v2.35.0 activated the pack system but left the per-repo anchor mapping (ADAPT.md Phase 3b) as a manual step — realistically the kind of chore that gets deferred forever, leaving repos paying whole-file context costs indefinitely. This release automates it end to end: a deterministic, idempotent anchor-generator script handles the mechanical half, and a new `/claudeupdate` step 6c2 performs the judgment half (purpose→anchor mapping) automatically, exactly once per repo, on its next ordinary update. The step is fail-safe — mapping trouble never blocks the version bump, and an incomplete mapping stays visible and re-arms on the following update. Operators do nothing beyond running `/claudeupdate` as usual.

**Breaking:** none. Repos without `architecture.md` skip 6c2 silently (packs stay in whole-file fallback); already-mapped repos have no `UNMAPPED` trigger and skip it too.

**Added:**
- `scripts/generate-architecture-anchors.ts` — idempotent anchor-generation pass for a consuming repo's `architecture.md`: inserts `<a id="<slug>"></a>` before every unanchored `## ` heading, skipping code blocks, using the SAME GFM slug algorithm as `audit-context-packs.ts` (shared import, so generated anchors are exactly what the audit validates and the loader slices on). Collisions with existing anchors or duplicate headings get `-1`, `-2` suffixes. CLI: atomic in-place write, `--dry-run`, exit 1 when `architecture.md` is absent. New manifest entries (helper-script + test, `mode: sync`).
- `scripts/__tests__/generate-architecture-anchors.test.ts` — ten tests: slugging, idempotency (second pass adds zero), level-1/3 exclusion, code-fence exclusion, collision suffixes, inline-code/link heading slugs, end-to-end coherence with `auditContextPacks`, and CLI contracts (write + idempotent re-run, `--dry-run`, missing-file exit 1).
- `/claudeupdate` step 6c2 — one-time context-pack adoption per repo. Trigger: `architecture.md` exists AND the audit prints `UNMAPPED` lines. Procedure: run the generator, list purposes and anchors, judgment-map each purpose to the section that actually serves it (read the sections, don't string-match), write `"ARCHITECTURE_ANCHOR:<purpose>": "#<anchor>"` substitutions to `.claude/.framework-state.json`, rebaseline via `sync.js --adopt`, verify with `--strict-unmapped`. Mapping decisions land in the step-9 report and the update commit message.

**Changed:**
- `scripts/audit-context-packs.ts` — exports `gfmSlug` and `buildCodeBlockMask` for reuse by the generator (no behaviour change).
- `ADAPT.md` Phase 3b — step 1 now runs the generator script instead of describing a manual anchor-insertion pass; notes that mounted repos self-complete this phase via `/claudeupdate` 6c2.
- `docs/context-packs/README.md` — migration-tracker step 2 records the automation.
- `/claudeupdate` step 9 report — gains a `packs:` outcome note (`mapped <N> purposes` / `mapping incomplete — <reason>`) whenever 6c2 ran.

---

## 2.35.0 — 2026-07-10

**Highlights:** context-pack activation, plus an explicit framework-wins ownership contract for behavioural files in the update flow. The pack system shipped in v2.2.0 as templates and stayed inert in every consumer: the `{{ARCHITECTURE_ANCHOR:<purpose>}}` placeholders were never mapped, no agent loaded a pack, and the audit script could not see the placeholders — so it green-lit fully-unmapped packs while every agent paid whole-file context costs on `architecture.md`. This release makes the audit honest, routes anchor mapping through the existing sync substitution engine (no hand-edited packs, no `.framework-new` merge debt), and wires the three highest-volume agents (`builder`, `architect`, `pr-reviewer`) to load pack slices with a fail-safe whole-file fallback. Consumers that have not run ADAPT.md Phase 3b see zero behaviour change; consumers that map their anchors get sliced context loading plus a `context-load:` measurement line from every wired agent. Separately, `/claudeupdate`, `/claudemerge`, and SYNC.md now state and enforce what ADR-0006 established: agents, skills, hooks, and commands are always taken verbatim from the framework — local deltas relocate to `agent-context.md` / `skill-context.md`, never survive in the canonical files.

**Breaking:** none. Audit exit-code semantics are unchanged by default (unmapped placeholders exit 0, advisory), the pure-function result shape is backward-compatible (`unmapped` field present only when non-empty), and agent pack wiring falls back to today's whole-file reads whenever a pack is missing, unmapped, or drifted.

**Added:**
- `scripts/audit-context-packs.ts` — detects unmapped `{{ARCHITECTURE_ANCHOR:<purpose>}}` placeholder tokens (outside code blocks, strict purpose charset so syntax documentation never registers) and prints one `UNMAPPED <pack>:<line> <token>` line per token plus a remediation `NOTE:`. New flags: `--strict-unmapped` (unmapped tokens exit 1 — for repos that completed Phase 3b and want mapping regressions caught) and `--list-anchors` (prints the explicit `<a id>` anchors in `architecture.md` to make mapping mechanical). New export `extractExplicitAnchors`.
- Pack wiring: `builder` and `architect` slice `architecture.md` via `docs/context-packs/implement.md`; `pr-reviewer` via `docs/context-packs/review.md`. Conditional on the pack existing with zero unmapped placeholders; any anchor miss falls back to the whole-file read. Every wired agent records the mode used as a `context-load:` line in the single shared format pinned in `context-pack-loader.md` Step 4 (sliced-load form, or `context-load: full <file> (<reason>)` on fallback) — the measurement hook for the before/after token comparison, greppable on `^context-load: `.
- `scripts/__tests__/audit-context-packs.test.ts` — nine new tests: unmapped-token detection (incl. code-fence and `<purpose>`-syntax-doc exclusions), back-compat result shapes, combined fail+unmapped, `extractExplicitAnchors`, and CLI exit-code contracts for default, `--strict-unmapped`, and `--list-anchors`.

**Changed:**
- `ADAPT.md` Phase 3b — anchor mapping now goes through `.claude/.framework-state.json` → `substitutions` (`"ARCHITECTURE_ANCHOR:<purpose>": "#<real-anchor>"`, then `sync.js --adopt` to rebaseline) instead of hand-editing the pack files, which are `mode: sync` and would accrue `.framework-new` merge debt on every update. Every purpose must map to some anchor (nearest enclosing section if no exact counterpart) — one leftover token keeps the whole pack in fallback mode.
- `.claude/agents/context-pack-loader.md` — documents the substitution-based mapping route and pins the confirmation-line format (`context-load: <mode> pack. Sources: … Fallbacks: …`) so it doubles as the measurement record.
- `.claude/agents/validate-setup.md` Step 4 — distinguishes unmapped placeholder tokens (warning: installed-but-not-adopted, consumers fall back safely) from mapped anchors that no longer resolve (failure: packs drifted from `architecture.md`).
- `.claude/agents/finalisation-coordinator.md` Step 6.0 — documents that `UNMAPPED` advisory lines (exit 0) do not block finalisation; only broken mapped anchors do.
- `docs/context-packs/README.md` — status block and migration tracker updated: step 4 (wire packs to agents) shipped; step 2 (map at adoption) and step 5 (measure) are per-consumer, with the `context-load:` line as the measurement hook.
- `/claudeupdate` — new 6d2 behavioural-file divergence guard: after conflicts resolve, the one-shot pauses if any `.claude/agents/` (excluding `extensions/`), `.claude/skills/`, `.claude/hooks/`, or `.claude/commands/` entry is still flagged `customisedLocally` in `.claude/.framework-state.json`. New step 7b + rule: for behavioural files the resolution is always framework-wins; local deltas relocate to `agent-context.md` / `skill-context.md` (or go upstream for hooks/commands, which have no runtime overlay). The update is not complete while any behavioural file diverges from canonical.
- `/claudemerge` — conflicts are now classified before resolution: content/docs keep the line-by-line operator merge (preferring `LOCAL-OVERRIDE` slots); behavioural files follow a new relocation protocol (§ *Behavioural files: framework wins — relocate, don't merge*): extract the local-only delta, operator confirms its destination in the context files, framework content overwrites the target verbatim. The operator decides WHERE the delta goes, never WHICH side wins.
- `SYNC.md` Phase 5 — new ownership-contract paragraph; step 3 no longer suggests "the operator's version may be worth preserving" for behavioural files (that guidance now applies only to docs/references/templates, with a preference for `LOCAL-OVERRIDE` slots).

**Fixed:**
- `scripts/audit-context-packs.ts` was blind to `{{ARCHITECTURE_ANCHOR:…}}` tokens: its two reference-extraction forms (markdown links, bare `#anchor` fragments under a source-block heading) matched neither the placeholder syntax nor anything else in an unmapped pack, so `extractPackAnchors` returned zero refs and the audit reported `OK` on packs that had never been adopted. The finalisation gate built on it (Step 6.0) therefore never fired on the actual defect.

---

## 2.34.0 — 2026-07-10

**Highlights:** divergence-elimination pass driven by the origin project's convergence to framework-canonical docs. Two spec-authoring rules proven in origin-project builds are promoted into the canonical checklist, and the one managed doc that still had no consumer slot (`schemas/CHANGELOG.md`) gains one — so a consumer that keeps its own schemas in `schemas/` can record their history without forking the framework-owned changelog. With this release, every framework-managed doc that consumers routinely extend carries a named `LOCAL-OVERRIDE` slot; repo-specific content belongs inside the slots (or in `agent-context.md` for agent behaviour), never as out-of-slot edits.

**Added:**
- `docs/spec-authoring-checklist.md` § Section 1.1 — *Primitive↔target cross-check*: specs that lock helper primitives AND name their consumers must include a cross-check table proving every consumer is expressible via the locked primitives (origin example: gates-speedup-cluster v5, 34 inexpressible targets found at implementation time).
- `docs/spec-authoring-checklist.md` § Section 9.1 — *Risk-register correctness axis*: test-infrastructure specs (global hooks, harness config) must carry BOTH a performance risk AND a correctness risk per risk row (origin example: fix-brittle-ci-tests Learning 4).
- `schemas/CHANGELOG.md` — `## Consumer-local schema changes` section with a `consumer-entries` LOCAL-OVERRIDE slot.

**Changed:** none beyond the files above. No new managed files, no migration (slot additions flow through normal sync; consumers with customised copies of these docs get a `.framework-new` and should move their local content into the slots — see `references/local-override-convention.md`).

## 2.33.0 — 2026-07-09

**Highlights:** compound-learning suite — three additive, fail-open capabilities that make lessons and quality compound faster in consuming repos. (A) a SessionStart `memory-digest` hook that surfaces a bounded (≤150-line) plain-text digest of current-focus + recent lessons + the tail of KNOWLEDGE.md so a session starts with recent context in view; (B) a local skill-overlay convention — an adopt-only `.claude/context/skill-context.md` sidecar, a greppable pointer line in all 20 skills, an executable pointer-coverage gate in `validate-framework.js`, a `/cleanfiles` promotion drain, and two `/framework-doctor` checks — so repo-specific skill failure modes have a home and a path back upstream; (C) a `/eval-prompts` golden-set runner (`scripts/eval-prompts*.ts`) that scores a repo-local prompt suite's catch rate + false-alarm rate against a pinned baseline and fails on a regression, so a prompt change lands only if its suite still passes. Externally reviewed across 3 spec rounds before build.

**Added:**
- `.claude/hooks/memory-digest.js` (+ `.test.js`, + manifest entry, + SessionStart registration in `settings.json` with a 5s `timeout` backstop). README hooks 9→10; SECURITY per-hook row.
- `.claude/context/skill-context.md` (adopt-only skill-overlay template) + `references/skill-overlay-convention.md` (drain-protocol single source of truth).
- `scripts/eval-prompts.ts` + `scripts/eval-promptsPure.ts` (+ vitest test) + `.claude/commands/eval-prompts.md` + `references/eval-suite-format.md`.
- `migrations/v2.33.0.js` (adopts the one new adopt-only file, `skill-context.md`; idempotent; covered in `tests/migrations.test.ts`).
- 6 new `managedFiles` entries in `manifest.json` (memory-digest.js, skill-context.md, skill-overlay-convention.md, eval-suite-format.md, eval-prompts.ts, eval-promptsPure.ts).

**Changed:**
- All 20 `.claude/skills/*/SKILL.md` gain the skill-overlay pointer line after their frontmatter.
- `scripts/validate-framework.js` gains an executable skill-pointer-coverage check (CI-enforced via `npm run validate`).
- `.claude/commands/cleanfiles.md` (overlay-drain target), `.claude/commands/framework-doctor.md` (Checks 6, 7, 8), `CONTRIBUTING.md` (Adding-a-skill pointer step), `docs/doc-sync.md` (two new reference docs registered), `README.md` (hooks 9→10, commands 7→8, What-ships rows).

**Consumer migration notes:** after `/claudeupdate`, the `memory-digest` hook activates on the next session start (fail-open; a repo without `tasks/current-focus.md`/`tasks/lessons.md`/`KNOWLEDGE.md` sees a clean, silent start). The `skill-context.md` overlay is seeded once (adopt-only) and is yours to populate. `/eval-prompts` is inert until you author a suite under `eval/<suite>/` per `references/eval-suite-format.md`. No breaking changes.

## 2.32.1 — 2026-07-08

**Highlights:** migration hotfix — `migrations/v2.13.0.js` line 6 contained the phase-marker glob inside its block comment; the glob's star-slash sequence terminated the comment early and made the rest of the line a SyntaxError. The bug was latent for every consumer already past v2.13.0 (the runner only loads migrations in the upgrade range) and fired the moment any pre-2.13.0 consumer (e.g. a repo on 2.12.1) attempted `/claudeupdate`, blocking the entire upgrade before sync.js ran.

**Fixed:** reworded the v2.13.0.js header comment to reference the `gitignoreLine` constant instead of spelling the glob; `node --check` parse sweep now passes across all migration files.

**Highlights:** fable-mode hardening pass — a dual adversarial audit (loophole hunt + coverage check against the canonical Fable-quality list) drove 11 defect fixes and 4 new disciplines into the skill, plus one new wiring point. Loophole closures: "load-bearing" now operationally defined (recommendation changes when the claim is false), the assumed-tag escape hatch closed (checkable recommendation-changing claims MUST be verified), anti-strawman rules for the pre-mortem and competing alternative, falsifiable kill criteria ("none" needs justification), under-pressure rule (shrink every gate, skip none), preamble substance test, unverified load-bearing claims downgrade stated confidence, and a schema-locked-output carve-out for reviewers returning D10 JSON. New disciplines: risk-weighted verification (blast radius first), failure-signature rule (a symptom pattern-matching a known failure may have a different cause — confirm before state-changing actions), evidence stopping rule (two unchanged conclusions = stop gathering), and stuck detection (same approach failing twice = change approach; rephrasing is not a new approach).

**Added:** `finalisation-coordinator.md` reasoning-discipline wiring — gates apply at the two judgment-heavy steps only (Step 5 chatgpt-pr-review finding adjudication, Step 11 CI-failure diagnosis in the label-pull fix loop); mechanical steps exempt.
**Changed:** `fable-mode/SKILL.md` (all fixes above), `architect.md` (verified/inferred/assumed tags now inline where claims appear — file inventory, contracts, chunk prerequisites — not only the risks section), `spec-coordinator.md` (Gate 1 kill-check clarified as pre-satisfied by Step 3a; the Step 6 preamble cites that result instead of re-running it).

**Highlights:** new `fable-mode` skill — a reasoning-discipline overlay that ports frontier-model (Fable-class) working habits to any executing model tier. Five gates (scope before work, evidence before reasoning, reason adversarially, verify before done, report with calibration) plus a compact output contract (preamble + calibrated close) so callers can audit that the gates actually ran. Validated with an A/B subagent test: the with-skill run surfaced a kill-criterion hit (requested feature already existed), tagged every load-bearing claim verified/inferred/assumed, and disclosed unverified areas the baseline run left implicit. Wired into the seven judgment-heavy Opus surfaces so specs, plans, audits, post-mortems, and review adjudication inherit the discipline automatically.

**Added:** `.claude/skills/fable-mode/SKILL.md` (+ manifest entry; README What-ships row now 20 skills).
**Changed:** `architect.md` (adopt gates during context loading; Output contract brackets the plan), `spec-coordinator.md` (Step 6 invokes fable-mode before drafting; Gate 1 kill criteria fold into Step 3a duplication), `feature-coordinator.md` (gates at adjudication steps 3b/4/5/8 only — mechanical steps exempt), `audit-runner.md` (context-loading item 9; pass-1 findings carry evidence tags), `incident-commander.md` (Gates 2–3 on the post-mortem only; Steps 2–4 stay speed-optimised), `claude-spec-review.md` + `claude-plan-review.md` (Gate 2 evidence tags inside finding text — no new JSON fields, D10 schema shape unchanged).

**Highlights:** lint fix — the deployed `scripts/review-coordinator/applyFindingsPure.ts` shipped an intentional control-character rejection regex (`/[\x00-\x1f\x7f]/`) with no `eslint-disable`, so every consuming repo running full `eslint` (not diff-scoped) hit a blocking `no-control-regex` error after adopting the framework. Recurring: consuming repos patched it locally, then the next framework sync overwrote the fix.

**Fixed:** add `// eslint-disable-next-line no-control-regex` above `ACCEPTANCE_CHECK_CONTROL_CHARS` in `applyFindingsPure.ts` (the control chars are intentional — they reject NUL/escape sequences in acceptance-check commands). Matches the convention used by `ssrfGuard.ts` for the identical pattern. Consuming repos should re-sync to drop their local override.

## 2.30.1 — 2026-07-07

**Highlights:** packaging fix — `CONTRIBUTING.md` and `SECURITY.md` become `adopt-only` (seeded once, consumer-owned thereafter).

**Fixed:** 2.30.0 shipped `CONTRIBUTING.md` and `SECURITY.md` as `mode: sync`, but both files' content is framework-repo-specific (contributor workflow for the framework itself; the framework's security posture). In a consuming repo, sync mode overwrite-conflicts with the consumer's own CONTRIBUTING/SECURITY docs — the origin repo's real `CONTRIBUTING.md` surfaced as a `.framework-new` conflict on first 2.30.0 sync. `adopt-only` seeds the files into repos that lack them and leaves existing consumer versions untouched.

## 2.30.0 — 2026-07-07 — Audit remediation: sync-engine hardening, self-testing CI, fleet tooling

**Highlights:** Implements all five workstreams of the 2026-07-07 exhaustive framework audit (issue #32, ~45 findings). Sync engine: false-conflict short-circuit + self-healing state, atomic managed writes, adopt-divergence detection, downgrade guard, orphaned-conflict scan, symlink refusal. Fleet tooling: three-way `.framework-new` merge helper + `/claudemerge`, `/claudeupdate --status`, `/framework-init`, `/release`, `/framework-doctor`. CI now discovers tests by glob (4 shipped test files that never ran now run — one immediately caught a real agent regression), `npm test`/`npm ci` work locally, and frontmatter/schema/link/bundle-hygiene validation gates ship. Three new hooks close the Bash bypass of config protection, enforce KNOWLEDGE.md append-only, and warn on unresolved merges at session start. Consumer machinery generalised: code-graph generator (completes the previously inert freshness hook), five generic verify-gates, parameterised regression-scribe, three review hunt-targets upstreamed. Three new skills; cross-skill dedupe with declared owners; ADR-0014 created; origin-project pollution stripped from the bundle.

**Breaking / migration notes:**
- Migration `v2.30.0.js` appends `*.framework-new` to consumer `.gitignore` (idempotent).
- Hooks manifest glob replaced with per-file entries; hook `*.test.js` files no longer sync to consumers (already-synced copies are harmless; `/cleanfiles` or manual delete).
- `--adopt` now flags pre-existing divergent files (`customisedLocally: true` + `.framework-new`) instead of silently baselining them — matches the documented contract.
- sync.js refuses downgrades unless `--force-downgrade`.
- Code-graph cache format bumped to v2; consumers get a one-time rebuild. `verify-duplicate-blocks.sh` needs jscpd (via npx).

**Added:** `scripts/framework-merge.js` + `/claudemerge`; `/framework-init`, `/release`, `/framework-doctor`; `/claudeupdate --status`; `migrations/_helpers.js` + `_template.js` + `v2.30.0.js`; `tests/migrations.test.ts` + `tests/sync-hardening.test.ts`; hooks `bash-config-guard` (protects config paths AND KNOWLEDGE.md from all Bash write shapes), `knowledge-append-guard` (strict append-only: any non-tail-append edit requires HITL), `framework-merge-reminder` (+ tests for long-doc-guard, correction-nudge, code-graph-freshness-check); `scripts/run-tests.js` (glob test discovery), `scripts/validate-framework.js` (+allowlist; frontmatter, schema-compile, links, bundle hygiene); `package.json` scripts + pinned devDependencies + lockfile; `scripts/build-code-graph.ts` + `scripts/code-graph-health-check.ts` (dependency-free); `scripts/gates/` (5 generic verify-gates + README); `regression-scribe` agent (parameterised); skills `dependency-upgrades`, `performance`, `logging-observability`; ADR-0014 (coordinators run inline) + consumer-owned local-ADRs slot in the ADR index; `docs/capabilities-template.md`, `docs/codebase-audit-framework-template.md`, `docs/agent-selection.md`, `CONTRIBUTING.md`, `SECURITY.md`; `tasks/builds/_example/spec.md` + `chunk-learnings.md`; `tasks/runbooks/README.md`; G3 row in `references/iteration-caps.md`; builder DB-migration carve-out; finalisation Step 12.5 advisory release notes; experiment-runner P95 worked example.

**Changed:** CI runs via npm scripts with glob discovery, `npm ci`, fetch-depth 0, removedFiles-absence + schemas-changelog gates; `config-protection` repo-root walk-up fixes a silent fail-open; audit-runner holds its push until its self-run post-audit review pass completes; mockup-reviewer promoted to Opus; chatgpt-plan-review description restores the session-state mode tier and drops provenance slugs; adversarial-reviewer "Phase 1 advisory" renamed "advisory (rollout mode)"; consumer-only doc cites marked "if present" across 15 agents; read-instruction restored as first body line in the three chatgpt-review agents (2.28.0 regression caught by the newly-running e2e test); cross-skill rules deduplicated with declared owners; sibling frontend skill triggers made disjoint; db-concurrency bullets split; `chatgpt-reviewPure.ts` gains three hunt-targets from the consumer review-learning loop; SYNC.md documents the far-behind squash path and automated gitignore step; MIGRATION-FROM-COPY-PASTE.md §3 corrected (no prompts; seed substitutions, then `--adopt`); README What-ships regenerated (manifest-authoritative footnote); ADAPT.md Phase 3c seeds project-registries from the existing template.

**Removed:** origin-project pollution from the bundle — 5 real build dirs under `tasks/builds/`, 8 origin review logs, `tasks/review-logs/openai-raw/` and `.parallel-mode/` raw model output (bundle-hygiene gate now enforces this); redundant `.framework-new` gitignore manual step.

**Deferred (explicitly not in this release):** running the review-tier redundancy audit (runbook `references/review-tier-redundancy-audit.md`; requires accumulated `_index.jsonl` decision data that does not exist yet).

## 2.29.0 — 2026-07-07 — /cleanfiles repo-maintenance command

**Highlights:** New operator command `/cleanfiles` — a repo-maintenance sweep for the working files every consuming repo accumulates (KNOWLEDGE.md, tasks/todo.md, lessons, review logs, merged-build artifacts, stale current-focus pointers, prototypes, session state). Audit-first with operator confirmation, archive-with-pointer for knowledge content, git-history-backed removal for the rest, docs-only diff guard, one reviewable commit on a `chore/cleanfiles-<date>` branch. Configurable retention via `.claude/cleanfiles.json`.

**Breaking:** none — purely additive. The command syncs to consumers via the existing `.claude/commands/*.md` manifest glob.

**Added:**
- `.claude/commands/cleanfiles.md` — the `/cleanfiles` command: modes (`audit`, default confirm-then-apply, `--yes`), 9 cleaning targets with per-target process, hard safety rules (never delete knowledge; untracked files report-only; docs-only guard), size thresholds for suggesting a sweep, and the before/after report format.
- README What-ships row for `.claude/commands/`.

## 2.28.2 — 2026-07-07

**Highlights:** settings-merge idempotency fix — hook identity now recognises every `$CLAUDE_PROJECT_DIR` quoting variant, so consumer `settings.json` hooks no longer duplicate on every sync.

**Fixed:** `sync.js` `frameworkHookIdentity` / `isFrameworkOwnedCommand` only matched the `${CLAUDE_PROJECT_DIR}` (braced, unquoted) prefix; when 2.28.0 changed canonical hook commands to the quoted `"$CLAUDE_PROJECT_DIR"` style, every framework hook stopped being recognised as framework-owned and the settings merge appended a fresh copy of every hook on every sync (consumers accumulated 2-3 registrations per hook; duplicated config-protection instances also consumed the one-shot HITL sentinel and deadlocked approved edits). Identity is now normalised to the `.claude/hooks/<file>` suffix across all prefix spellings (braced/unbraced/quoted/bare), `isFrameworkOwnedCommand` delegates to it, and merged hook lists dedupe by identity (first occurrence wins; agent-type hooks without a `command` key dedupe by full shape). Existing accumulated duplicates collapse to one entry per hook on the next sync. Regression suite: `tests/settings-merge.test.ts § hook identity — quoting variants`.

## 2.28.1 — 2026-07-07

**Highlights:** lint-hygiene patch for the build-scheduler validator pair — no behaviour change.

**Fixed:** `scripts/build-scheduler/validatePlanMetadata.ts` used `let` for a never-reassigned binding (fails `prefer-const` in strict consumer repos); now `const`. `scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts` cast invalid-input fixtures with `as any` (fails `no-explicit-any`); now `as never`. Both changes make canonical content identical to what lint-strict consumers (origin repo) had to fork locally, eliminating those forks.

## 2.28.0 — 2026-07-06 — Distilled-judgment skill library

**Highlights:** Ships 14 new portable skills distilled from a consuming repo's accumulated engineering knowledge base (~470 lessons) and an exhaustive mine of its full review-log corpus (~1,900 logs in 194 batches across the Codex, ChatGPT, Claude, and spec-conformance reviewer families; ~5,300 accepted-defect and ~1,300 rejected-finding mentions). Each skill encodes the recurring defect classes reviewers actually caught, as write-time rules, so builders prevent at authoring time what the review pipeline previously caught two tiers later. Skills are trigger-described for automatic surfacing and wired into the builder and reviewer agent contracts.

**Breaking:** none — purely additive. Consuming repos receive the skills as `new` files on next sync; no migration required.

**Added:**
- `tenant-isolation` — multi-tenant data boundaries: RLS context loss in jobs/workers/webhooks, FK non-propagation, explicit tenant predicates, client-supplied scope ids, IDOR on nested routes.
- `postgres-migrations` — SQL three-valued logic, CHECK/enum/index discipline, ORM↔migration sync, renumbering protocol.
- `db-concurrency` — upsert/idempotency-key correctness, guarded state transitions, lock discipline, queue retry/recovery, DB-time rules.
- `wire-it-through` — the "shipped but unwired" class: consumer-site verification for every new artifact, boundary field tracing, client↔server contract parity, value-set renames.
- `fail-loud` — fail-closed defaults, catch-block rules, 4xx/5xx contracts, observability of failure.
- `ci-gate-integrity` — gates that cannot fail: grep-gate pitfalls, diff-gate refs, baselines, workflow consolidation, Actions specifics.
- `test-discipline` — vacuous tests, mock/reorder hazards, test-kind selection, fixture determinism, verifiable acceptance criteria.
- `review-triage` — the measured false-positive taxonomy for adjudicating external/LLM reviewer findings, per-claim verification steps, loop-convergence signals, the security auto-apply carve-out.
- `spec-hygiene` — grounding specs in the real tree, document self-consistency sweeps, contract-level rules, the ranked conformance checklist.
- `frontend-correctness` — React state lifecycle, async races, permission fail-closed, data-handling pitfalls.
- `security-hardening` — tokens/nonces, SSRF/redirects, injection surfaces (URL, shell, SQL fragments, ReDoS, prompt), authorization shape.
- `frontend-design-check` — thin trigger skill routing direct UI edits (outside the mockup pipeline) to the canonical design docs and the five hard rules.
- `refactor-safely` — moves/splits/renames/deletions: move-executed-as-copy, replace-all indentation misses, split verification, dead-code caution, merge-conflict provenance.
- `llm-integration` — the model as an unreliable injectable dependency: self-report distrust, echo canonicalisation, prompt trust channels, lock/retry/budget shape, judge harness rules.

**Changed:**
- `builder.md` — Step 3 now requires consulting the matching skill(s) before writing code in a covered area (table added to the minimal-change checks).
- `pr-reviewer.md` — Specific Things to Check points at the defect-pattern skills as a review checklist source.
- `dual-reviewer.md`, `chatgpt-pr-review.md`, `chatgpt-spec-review.md`, `chatgpt-plan-review.md` — adjudication sections point at the `review-triage` skill.
- `README.md` — What-ships table reflects 16 portable skills.

---

## 2.27.0 — 2026-07-05 — Harness-audit remediation + visual-craft layer

**Highlights:** Largest hardening release to date, driven by a full-harness audit (spec + findings in `tasks/builds/harness-audit-remediation/`). Closes verified hook bypasses (config-protection MultiEdit, phase-lock fail-closed), removes an LLM-output shell-injection surface in the review apply path, fixes the sync engine's same-version rebaseline trap, and reconciles every cross-agent contradiction the audit catalogued (double-merge hazard, spec-location split, review-mode defaults, doc-sync cardinality, test-runner idiom, gate-name collision). Purges origin-project leakage from all canonical files. Adds CI, and ships the visual-craft layer for the mockup pipeline (design-language template, reviewer Axis 5, mandatory polish round).

**Breaking / migration notes for consuming repos:**
- **Origin-specific content moved out of canonical agents.** Repos that relied on baked-in specifics (the origin PR-review checklist, adversarial-reviewer identifiers, Codex fallback path, mockup nav/route registry pins) must now pin them in `.claude/context/agent-context.md` under the matching agent section (ADR-0006). Machine-specific Codex path: set `CODEX_FALLBACK_PATH` or pin in agent-context.
- **Spec location standardised on `tasks/builds/{slug}/spec.md`.** Repos using a dated-specs directory keep it but must stub the canonical path (spec-coordinator Step 6 back-compat rule).
- **`chatgpt-pr-review` INVOCATION CONTEXT.** Coordinators must pass `coordinator-invoked`; the agent's own merge/label/CI steps are forbidden in that context (double-merge fix).
- **Review-mode default is `manual` everywhere** — the `OPENAI_API_KEY`-presence auto-default is gone from feature-coordinator too. Opt into automated via `CHATGPT_REVIEW_DEFAULT_MODE=automated` (see `references/review-mode-resolution.md`).
- **Finalisation auto-fix guardrails renamed G1–G4 → AF1–AF4.** Any local prose citing the old names should be updated.
- **`doNotTouch` is now enforced** as a hard write-refusal by sync.js, and `manifest.frameworkVersion` must match `FRAMEWORK_VERSION`.
- Deleting an unwanted agent now requires a `syncIgnore` entry (ADAPT Phase 1.5 / MIGRATION §4 document the mechanism; the old "deletions stick" claim was false).

**Added:** `references/review-mode-resolution.md` (MODE/AUTONOMY single source of truth); `references/iteration-caps.md` (all 18 loop caps in one table); `references/review-tier-redundancy-audit.md` (the 2.21.0 measurement method as a runbook — prerequisite for cutting review tiers); `docs/design-language-template.md` + two-doc contract section in `frontend-design-principles.md`; mockup-reviewer **Axis 5 — Visual craft** (gating with a design-language doc, advisory without); mandatory visual polish round in mockup-coordinator/spec-coordinator (default-on, operator opt-out recorded in the log); `tasks/review-logs/prompt-evolution-log.md` template; `.github/workflows/ci.yml` (all four test suites + manifest/settings validity + version consistency); `.claude/hooks/config-protection.test.js` (28 cases); `scripts/verify-chatgpt-model.ts` (restored); `migrations/v2.27.0.js`; `.claude/hooks/package.json` and `references/project-extensions-convention.md` now managed.

**Changed:** doc-sync verdict tables derive from the `docs/doc-sync.md` registry at run time (hard-coded 6/7-doc templates removed; `docs/design-language.md` registered conditionally); test-runner rule unified (single-file runner rule in `references/test-gate-policy.md`); chatgpt-pr-review standalone CI loop aligned with the coordinator (5 remedies, label-pull-first, squash); adversarial-reviewer → opus, mockup-reviewer → sonnet; context packs use `{{ARCHITECTURE_ANCHOR:...}}` tokens mapped at ADAPT Phase 3b; ADAPT/README/MIGRATION counts and submodule narrative corrected; spec-context template gains the four §9 testing-posture keys; co-author trailers normalised; spec-coordinator Step 3a revise loop capped at 3.

**Fixed:** config-protection MultiEdit bypass (verified by execution; extractor now consumes top-level `file_path` — and the hook self-protects `.claude/settings.json` + hooks, with the sentinel bound to the relative path); phase-lock blocking legitimate writes when `CLAUDE_PROJECT_DIR` unset, and `..`-paths in unrestricted phases; shell injection via reviewer-controlled strings in `applyFindings.ts`/`buildDiffPackage.ts` (spawnSync array args; acceptance_check hardened across two review rounds to a command-SHAPE allowlist — `npm run <lint|typecheck|build*>`, `npx vitest run <path>`, `npx tsx --test <path>`, `vitest run <path>`, read-only `git <diff|status|rev-parse>` — with control-char/quote rejection and shell-less execution, closing both newline injection and overbroad binary authorization like `git clean -fdx`/`npx rimraf`); sync.js same-version runs now rebaseline resolved merges (maintenance mode); malformed consumer settings.json aborts instead of being overwritten; `callResponsesApi` timeout + 429/5xx retry; chatgpt-review.ts exit-code contract; schemas CHANGELOG reconciled to shipped enums and `reality_checker` removed from pr-context; missing 2.3.0/2.16.1 changelog headings backfilled; release-notify workflow fails loudly; settings.json hook paths quoted + SessionStart timeout; ~20 dangling references to unshipped specs/ADR-0014 stripped or inlined; dead scaffold text ("Chunk 8a/10", "(NEW)", superseded S0 force-rule, duplicate step numbers) removed.

**Removed:** `reality_checker` key from `pr-context.schema.json`; personal Windows Codex path, "Automation OS" naming, `michaelhazza/altessa` example, `worker/.eslintrc` protection, origin primitives/test-stats/prototype paths from all canonical files; fictitious sync.js "Going backward" guard from SYNC.md.

## 2.26.0 — 2026-07-04 — Builder reuse-before-duplicate check

**Highlights:** Adds minimal-change check 5 (**Reuse-before-duplicate**) to `builder.md`. Repeated code blocks are the field's most-reported Claude Code failure mode, yet the builder's binding write-time checklist omitted the CLAUDE.md §6 "never duplicate logic" rule, and the Three-Similar-Lines check read like copy-paste licence. The new check requires the builder to Grep for an existing helper before writing a familiar-looking block, clarifies that Three-Similar-Lines limits new abstraction and never blocks reuse, and warns that projects with a duplicate-block CI gate (e.g. a jscpd ratchet baseline) fail on any net-new duplicated block. Sourced from the 2026-07-04 coding-process audit in the Automation OS repo (`docs/audits/coding-process-audit-2026-07-04.md` there), which mapped an external best-practice post against the pipeline: this was the single write-time gap found.

**Changed:**
- `.claude/agents/builder.md` — minimal-change check 5 (**Reuse-before-duplicate**) added; checklist intro updated to note checks 4-5 are field-sourced additions.

**Breaking:** none.

---

## 2.25.0 — 2026-06-19 — Parallel worktree builders for independent chunks

**Highlights:** Adds opt-in concurrent chunk dispatch to the `feature-coordinator` Step 6 build loop. Provably-independent chunks (disjoint `declared_files`, no shared `exclusive_resources`, no `depends_on` edge) can now build concurrently, each in its own git worktree, and integrate back to the feature branch serially in stable chunk-id order. Two new pure modules drive scheduling: `computeWaves.ts` (deterministic wave scheduler, unit-tested) and `validatePlanMetadata.ts` (plan-metadata validator, unit-tested). Architect now emits a snake_case `id`, `declared_files`, `depends_on`, `exclusive_resources` per chunk. File identity is compared case-insensitively (Windows/macOS-safe), and the diff-apply merge-back uses intent-to-add so a builder's untracked new files are integrated. The strict-sequential default is preserved byte-identically (A8 by non-execution: the new machinery is unreachable without an explicit opt-in). Integration uses `git apply --3way` (diff-apply, not `git merge`). Rollout: opt-in via `launch feature coordinator parallel` for the first 3 builds; then a one-line maintainer change flips the default.

**Added:**
- `scripts/build-scheduler/computeWaves.ts` — pure deterministic wave scheduler. Input: `ChunkNode[]` + `concurrencyCap`. Output: `Wave[]` + `serialisedReasons[]`. Algorithm: cycle detection, Kahn topological layering (stable by chunk-id), greedy pairwise-disjoint wave packing within each layer. Serialised-reason priority: `dependency` > `exclusive-resource` > `file-overlap` > `cap-spill`.
- `scripts/build-scheduler/__tests__/computeWaves.test.ts` — Vitest unit tests (A1-A5, A8 support, cap-spill, cycle, unknown-dep-id, serialisedReasons priority).
- `scripts/build-scheduler/validatePlanMetadata.ts` — pure plan-metadata validator + `parsePlanMetadata` (single snake_case-to-camelCase normalisation point). Path canonicalisation: backslash-to-slash, collapse double-slashes, resolve `.` segments, case-fold for intersection; rejects absolute paths, `..` segments, empty strings.
- `scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts` — Vitest unit tests (A6, snake_case fixture, path-canonicalisation cases, dangling deps, duplicate ids).
- `docs/decisions/0008-parallel-worktree-builders.md` — ADR capturing the decision, safety argument, and alternatives considered.

**Changed:**
- `.claude/agents/architect.md` — per-chunk output spec now requires an `id:`, `declared_files:`, `depends_on:`, `exclusive_resources:` YAML block and a `## Build parallelism` section. Conservative-default stance and singleton-survey instruction added.
- `.claude/agents/feature-coordinator.md` — Step 6 rewritten as a wave loop. Strict-sequential mode (the default) is gated off before any new machinery runs; when `effectiveCap == 1` or the opt-in phrase is absent, the old Step 6 loop runs verbatim. Parallel mode (opt-in phrase present, worktree available, `effectiveCap >= 2`): parse + validate plan metadata, compute waves, dispatch multi-chunk waves concurrently with `isolation: "worktree"`, serialise merge-back as a transaction in ascending chunk-id order using `git apply --3way`, clean-branch precondition + post-commit clean-state assertion, crash-safety resume (dirty branch on resume = reset + re-run), INDEPENDENCE_VIOLATION quarantine for remaining unintegrated siblings.
- `.claude/agents/claude-plan-review.md` — under-declared `declared_files` hunt target added.
- `.claude/agents/chatgpt-plan-review.md` — same under-declared-`declared_files` hunt target mirrored.
- `.claude/agents/builder.md` — worktree-awareness note added (§6.1): builder may run inside an isolated git worktree; no behavioural change required.
- `docs/decisions/README.md` — ADR-0008 row added; local-ADR reservation moved to 0009 (ADR-0007 was taken by the concurrently-merged grounded-mockups work).
- `docs/doc-sync.md` — trigger row added for build-loop orchestration and chunk-metadata format changes.
- `manifest.json` — `frameworkVersion` reconciled from 2.20.0 to 2.25.0; ADR-0008 row registered.

**Breaking:** none. Strict-sequential mode is the default. No existing workflow changes without the explicit opt-in phrase.

---

## 2.24.0 — 2026-06-19 — Render-grounded mockups + behaviour capture

> Version assigned during the coordinated reconcile with the parallel-worktree-builders work (which merged second and took 2.25.0). The grounded-mockups change merged first and takes 2.24.0; its files synced at merge time, the version number is finalised here.

**Highlights:** The mockup pipeline now grounds designs in the *real rendered current state* of the surfaces they extend, not in a reading of the source code, and pins *interaction behaviour* as a first-class written deliverable. A new Playwright-driven capture script reuses each consuming repo's existing UI-test server + storageState auth to capture, per extended surface, a real screenshot (375/768/1280), a de-duplicated page-wide token sheet, and a structured DOM outline (real nav/tabs/headings/column-headers/status-pills). `mockup-reviewer` verifies the mockup against that observed capture (Axis 1) instead of re-reading the same source, closing the "designer and reviewer both trust the same wrong inference" loop. A behaviour manifest (fixed checklist) captures reveal model, interactive/async states, transitions, primary-action feedback, and input behaviour, gated for completeness (Axis 4) and pulled into the spec. Render-grounding is default-on when renderable, always degradable, never a hard gate. Generic across repos: the capture script references conventional consuming-repo paths only (ADR-0006) and degrades to source-read grounding where no UI-test harness exists. Rationale: ADR-0007.

**Added:**
- `scripts/mockup/capture-surface.ts` — impure Playwright orchestrator (attaches to the consuming repo's UI-test server, captures existing surfaces only, atomic screenshot writes, graceful degradation). Shipped; exercised live in consuming repos.
- `scripts/mockup/capture-surfacePure.ts` + `scripts/__tests__/capture-surfacePure.test.ts` — pure token-sheet de-dup + DOM-outline pruning, Vitest-tested.
- `scripts/mockup/capture-manifestPure.ts` + `scripts/__tests__/capture-manifestPure.test.ts` — capture-manifest contract (discriminated-union per-screen entry) + validator, Vitest-tested. The gate `mockup-reviewer` Axis 1 trusts.
- `docs/behaviour-manifest-template.md` — fixed, grep-able interaction-behaviour checklist (`adopt-only`).
- `docs/decisions/0007-ground-mockups-in-real-render.md` — ADR for the methodology choice (synced).

**Changed:**
- `mockup-designer` — Step 0a gains a render-capture sub-step (capture before drafting; ground in captured tokens + DOM outline; explicit logged fallback) and per-screen capture-status enumeration; new Step 3c authors the behaviour manifest.
- `mockup-reviewer` — Axis 1 gains capture-aware checks (capture-present-or-downgrade-justified, mockup-matches-captured-vocabulary, token fidelity, fallback-explicit); new Axis 4 gates behaviour-manifest completeness; preamble + tier lists updated to four axes.
- `spec-coordinator` — Step 6 pulls the behaviour manifest into an `## Interaction behaviour` spec section; Step 5/Step 9 handoff records the capture + behaviour manifests.
- `mockup-coordinator` — per-round + Step 8 artifact discipline persists the capture and behaviour manifests alongside the existing mockup logs.
- `docs/frontend-design-principles.md` — new "Ground in the real render" + "Interaction behaviour" subsections.
- `docs/mobile-capability-principles.md` — hover-only and keyboard-handling rules cross-link the behaviour checklist.

**Version:** assigned 2.24.0 in the coordinated reconcile (see the 2.25.0 entry above). The `managedFiles` entries for the capture scripts, tests, behaviour-manifest template, and ADR-0007 sync as registered; `frameworkVersion` is reconciled to 2.25.0 (the latest of the two coordinated releases).

---

## 2.23.0 — 2026-06-18 — `/fix-ci-gate-debt` command + finalisation gate-debt flag

**Highlights:** A new operator-triggered slash command that exhaustively clears CI gate debt at the root (production code, not the tests/baselines) via a bounded audit→fix→re-audit loop, plus a finalisation-coordinator change that surfaces (never auto-runs) the command when a build merges past inherited trunk-health gate failures. Motivated by a consumer-repo build whose feature branch inherited main's accumulated gate debt (npm-audit, no-direct-boss-work, error-code-taxonomy baseline regressions) on merge and had to admin-squash past it. Generic across repos — the command discovers gates dynamically from each repo's CI workflow(s) and gate manifest; nothing repo-specific is hardcoded.

**Added:**
- `/fix-ci-gate-debt` (`.claude/commands/fix-ci-gate-debt.md`) — bounded (≤5 iteration) audit→fix→re-audit loop. Un-gameable by design: acceptance is a separate read-only auditor (`scripts/ci-gate-debt-audit.sh`, bootstrapped per-repo on first run) that enumerates gates by parsing the repo's CI config — the fixer cannot move the goalposts. Hard rules: baselines move DOWN only and only with the paired code fix; tests are never weakened/skipped; orphans deleted only after proof; root cause classified (production-bug vs test-bug vs false-positive vs accepted-external-debt) before any fix; cap-reached/stuck escalates rather than games.

**Changed:**
- `finalisation-coordinator` Step 13 — new §13.3 "Outstanding CI gate-debt flag": when a build completes with any required check still failing (typically inherited trunk-health debt surfaced by the S2/S3 merge, not introduced by the PR), the end-of-phase summary classifies each failure PR-introduced vs inherited and surfaces the `/fix-ci-gate-debt` command for the operator to run manually. It is NOT auto-invoked — debt cleanup is its own reviewable unit, so a feature PR never absorbs repo-wide debt it did not create. A matching plain-English line is added to the §13.1 CEO-summary "Further action required" rule.

---

## 2.22.0 — 2026-06-18 — PR-review hunt targets: persisted-output hygiene, claim/condition consistency, service-wiring test gaps

**Highlights:** Folded three review heuristics into the canonical PR-review prompt (`scripts/chatgpt-reviewPure.ts`, `USER_PROMPT_PR_V2` Hunt targets). They were originally learned during a consumer-repo build and written into that repo's local copy of the script — drift that this release upstreams so every framework consumer gets them and the consumer can re-sync back to canonical. Prompt-content only; no API, schema, or agent-contract change.

**Added:**
- *Durable-storage / persisted-output hygiene* hunt target — flag upstream- or external-derived strings (readiness reasons, upstream status text, third-party error messages, raw model output) copied verbatim into durable or user-visible storage without an allowlist or content-class guard; recommend a closed enum + counts or an allowlisted projection.
- *Claim/condition consistency* hunt target — flag a finding, log line, label, or persisted message that asserts a specific cause while its trigger predicate only checks a broader proxy.

**Changed:**
- *Test quality* hunt target extended — also flag security/permission-critical SERVICE WIRING (permission flags such as `includeRawContent:false`, tenant-scoped id passthrough, dedupe scope, no-raw-body guarantees) left untested when the pure logic is thoroughly covered.

---

## 2.21.0 — 2026-06-18 — Retire `reality-checker` from the review cascade

**Highlights:** Retired the `reality-checker` agent after a cross-repo review-cascade redundancy audit (8 recent multi-tier builds) found it produced **zero net-new findings** in every build it ran, plus one false-assurance pass. Its only real function — refusing to mark a build done without supplied evidence — is retained as a `feature-coordinator` step; the actual code is already verified by `pr-reviewer`, `dual-reviewer`, and `adversarial-reviewer`. The Phase-2 branch-level review pass drops from `… → pr-reviewer → reality-checker → dual-reviewer` to `… → pr-reviewer → dual-reviewer`.

**Breaking:** STANDARD-profile repos lose `reality-checker`. Profile counts: STANDARD 11→10, FULL 24→23. Any automation that invokes `reality-checker` or parses `reality-check-log-*` verdicts must drop it. Historical `reality-check-log-*` files are unaffected.

**Removed:**
- `.claude/agents/reality-checker.md` — moved to `.claude/agents/_retired/reality-checker-2026-06-18.md` (kept for history per Agent lifecycle; no successor).
- `feature-coordinator.md` §8.4 (reality-checker invocation step) and its handoff verdict line; former §8.5/§8.6 renumbered to §8.4/§8.5.

**Changed:**
- `experiment-runner.md` — recommendation surfaces 3→2 (`reality-checker` numeric-gap surface removed).
- `pr-reviewer.md` — caller-input contract no longer lists `reality-checker`.
- `.claude/context/agent-context.md` valid-names list; `ADAPT.md` and `README.md` profile lists + counts.
- `chatgpt-pr-review.md`, `chatgpt-spec-review.md`, `chatgpt-plan-review.md` — the `OPENAI_API_KEY` check now **loads `.env` first** (`set -a; [ -f .env ] && . ./.env; set +a`) before deciding the key is missing. Fixes the recurring false "OPENAI_API_KEY not set" abort when the key lives in `.env` but isn't exported into the shell.
- `finalisation-coordinator.md` — Invocation section gains an explicit **Trigger phrases** list (`full finalisation`, `finalisation and merge`, etc. all map to the same end-to-end run) and a **Full-finalisation guarantee** block making the mandatory step chain unmissable: run all relevant CI locally (G5) → loop to green → apply `ready-to-merge` → watch Actions, on failure pull-label/fix/re-add/loop → squash-merge → summary report. Documents the finalise-without-merge variant and the distinction from "automated up to PR review."

**Why:** Frontier models plus the existing pr-reviewer / dual-reviewer / adversarial passes already verify the code; the evidence-meta-gate added no net signal. Full evidence and overlap matrix in the consuming repo's `tasks/audits/review-cascade-prune-2026-06-18.md`. The `.env` and finalisation-cue changes are operator-reported papercuts folded into the same version.

## 2.20.0 — 2026-06-17 — Agent files are framework-canonical: per-repo overrides move to a global agent-context file

**Highlights:** Two changes. **(Part B, main)** Agent `.md` files under `.claude/agents/` are now framework-canonical and MUST NOT be edited per-repo (ADR-0006). The inline `LOCAL-OVERRIDE` mechanism is **deprecated for agent files** — all project-specific operating notes for an agent move to the consuming repo's new `.claude/context/agent-context.md`, under a `## <agent-name>` section, which every framework agent reads at the start of every run and treats as binding project context. This is the fleet-wide analogue of `CLAUDE.md`: one file the whole agent fleet reads, owned by the repo, never overwritten by a sync. A long section may link out to a `references/<topic>.md` file. Every framework agent gained one uniform, greppable read-instruction line after its frontmatter, and every agent's inline `project-notes` override slot was removed. **(Part A, small)** ChatGPT-PR review's "always write the diff file every round" mandate is hoisted into a prominent `### Diff-file discipline (manual + parallel)` invariant in `chatgpt-pr-review.md` and the per-round/On-Start steps are relabelled `[MANUAL + PARALLEL]`, closing a discoverability gap where `parallel` mode was covered only by inference; `finalisation-coordinator` Step 5's contract bullet was strengthened to match.

**Breaking:** Consuming repos that carried inline `LOCAL-OVERRIDE` content in any `.claude/agents/*.md` must migrate that content to `.claude/context/agent-context.md` (one `## <agent-name>` section each) and re-sync the agents to clean framework copies. On the next sync, the framework agents no longer declare the `project-notes` slot, so any unmigrated in-slot content is orphaned and dropped (sync warns). Migrate before syncing. The `.claude/context/agent-context.md` template ships `adopt-only`; populate it per repo.

**Added:**
- `.claude/context/agent-context.md` — `adopt-only` template (manifest entry); the global per-repo agent-context file every framework agent reads each run.
- `docs/decisions/0006-no-inline-agent-overrides.md` — ADR capturing the rule and rationale.
- `validate-setup` Step 3a — agent-canonical gate: fails (critical) if any `.claude/agents/*.md` carries an inline `LOCAL-OVERRIDE` block or omits the `agent-context.md` read-instruction.
- `scripts/__tests__/local-override-e2e.js` STEP 5 — asserts the framework's own agents are LOCAL-OVERRIDE-free and all reference `agent-context.md`.

**Changed:**
- Every `.claude/agents/*.md` — uniform read-instruction line added after frontmatter; inline `project-notes` `LOCAL-OVERRIDE` slot removed; `## Project-specific notes` section now points at `agent-context.md`.
- `chatgpt-pr-review.md` — new `### Diff-file discipline (manual + parallel) — MANDATORY, NO EXCEPTIONS` block; On-Start "Prepare Round 1" and per-round step-9 relabelled `[MANUAL + PARALLEL]`.
- `finalisation-coordinator.md` — Step 5 chatgpt-pr-review contract strengthened (diff file always at round 1, round summary incomplete without the link, mandatory in manual AND parallel); G5 prose references repointed from "the LOCAL-OVERRIDE block" to `.claude/context/agent-context.md`.
- `ADAPT.md` — new mandatory rule section (ADR-0006).

**Deprecated:**
- Inline `LOCAL-OVERRIDE` blocks **in agent files only**. The mechanism remains valid for non-agent managed files (docs, references). See `references/local-override-convention.md` (deprecation note at top).

**Migration (consuming repos):** on next sync, expect `.framework-new` for any agent that still carries customised content — migrate the content to `.claude/context/agent-context.md` first, then resolve the `.framework-new` by taking the framework copy, and re-baseline the agent's state entry. Populate `.claude/context/agent-context.md` from the shipped template.

## 2.19.0 — 2026-06-12 — G5-scoped: diff-scoped pre-merge verification mode for the G5 local CI-parity gate

**Highlights:** The 2.18.0 G5 gate requires the FULL CI-parity suite locally before the ready-to-merge label — on large consuming repos that is 45–60+ minutes per attempt on a dev machine. G5 now has two modes, selected at the new Step 8c.2. **G5-scoped (default when the repo ships `scripts/g5-scoped.sh`)** runs only the checks the branch diff can plausibly trip: lint and typecheck always run in full (cheap, cross-file); test selection uses the runner's related-files mode (e.g. `vitest related --run <changed files>`) per suite, so only test files whose transitive import graph touches the changed code run; static gates are selected by a declarative path-glob → gate-script mapping table pinned in the consuming repo's script. **Full G5 remains as a mandatory escape hatch (not optional):** scoped mode REFUSES (distinct exit code 3) when the diff touches aggregate/global surfaces where subset runs are blind — migration directories, package manifests/lockfiles, the project's shared registry files, `*baseline*` files, the test-runner config, CI workflow files — or when a merge commit from main brought such changes into the branch (the real failure classes: migration-number collisions, baseline drift, allowlist grace-window expiry). Whichever mode runs records `G5 mode: scoped (<N> test files, <M> gates)` or `G5 mode: full (reason: <trigger>)` in the build's `progress.md`. The labeled CI run remains the system of record and the Step 11 label-pull discipline is unchanged; in scoped mode a labeled-CI failure's fix verification runs that check's FULL local-parity command plus a clean scoped pass.

**Added:**
- `scripts/g5-scoped.sh` — generic, consumer-adoptable template (manifest mode `adopt-only`): changed-file computation (branch commits + uncommitted, deletions included — a deleted migration/baseline/registry/workflow file still trips the escape hatch and surface gates), escape-hatch refusal including merge-commit inspection, always-full lint/typecheck, per-suite `vitest related` runs (integration leg with its own env block and a `G5-residual` skip recorded to `progress.md` when no local test DB), declarative `GATE_MAP` / `DB_GATE_MAP` tables, CI-parity gate exit semantics (gates listed in the repo's shard manifest run with the shard runner's env and treat exit 2 as warning / exit 3 as info, mirroring CI, unless the gate also appears as a direct workflow step — strictest runner wins; all other gates are strict), a parse self-check when the script itself changes, and the Step 8c.2 mode-recording line (auto-appended to `tasks/builds/$G5_SLUG/progress.md` when `G5_SLUG` is set). Consumers pin their escape-hatch list and gate mapping in the marked CONFIG section.

**Changed:**
- `.claude/agents/finalisation-coordinator.md` — Step 8c restructured: 8c.1 (derive parity list) unchanged; new **8c.2 — Select the G5 mode** (scoped default, mandatory full-G5 escape hatch, mode-recording contract, Step 11 interaction); **8c.3 — Run the selected set** (the previous full-set text is now the full-mode fallback path); **8c.4 — Local fix loop** (renumbered; the final clean pass is of the selected set, with escape-hatch re-evaluation after fix commits). Step 11 fix verification and the frontmatter description updated to be mode-aware. Consuming repos pin their gate mapping + registry-file escape list in the LOCAL-OVERRIDE block.
- `references/test-gate-policy.md § Finalisation G5 carve-out` — describes both modes, the escape hatch, and the mode-recording line; rationale extended (scoped mode keeps the local-first discipline at a cost proportional to the change).
- `manifest.json` — `frameworkVersion` 2.18.0 → 2.19.0; new `scripts/g5-scoped.sh` entry (`adopt-only`).

**Breaking:** none. Repos without `scripts/g5-scoped.sh` keep running full G5 exactly as in 2.18.0.

**Migration:** `git submodule update --remote .claude-framework && node .claude-framework/sync.js` (first sync adopts the `scripts/g5-scoped.sh` template; it is consumer-owned afterwards). Then: (1) fill the script's CONFIG section with your repo's escape-hatch registry files and path-glob → gate mapping; (2) note the scoped default + escape list in your `finalisation-coordinator.md` LOCAL-OVERRIDE block.

## 2.18.0 — 2026-06-11 — local-first CI gate: full check suite passes locally before the ready-to-merge label; label-pull fix loop

**Highlights:** Reduces GitHub Actions spend by inverting where test failures are discovered. Consuming repos gate their heavy CI jobs on the `ready-to-merge` label, but the previous finalisation flow applied the label after only lint + typecheck, then fixed CI failures by pushing to the labeled PR — re-firing the entire label-gated suite on every fix push (observed at scale on automation-v1: 2,500+ Actions runs). The new contract: after all reviews complete, re-sync main into the branch (S3) and resolve conflicts locally, drive the FULL CI-parity check suite to green locally (G5, with a bounded local fix loop), and only then apply the label — making the labeled CI run a single final confirmation. If that run still fails, the label is removed IMMEDIATELY (first action, before diagnosis), the failure is fixed and re-verified locally against the full parity set, and the label is re-added — which is what re-fires CI, exactly once per fix iteration. Target: one full labeled CI run per ticket.

**Changed:**
- `.claude/agents/finalisation-coordinator.md` —
  - New **Step 8b — post-review branch re-sync (S3)**: after Steps 5–8 (review + doc work), re-run the full Step 2 S2 contract against current `origin/main` so conflicts are resolved locally before the local gate run. S3/G5 commits are held locally and published in the single Step 10.2 push.
  - New **Step 8c — G5 local CI-parity gate (mandatory, pre-label)**: derive the parity command list from the consuming repo's CI workflow (consumers SHOULD pin the list in the LOCAL-OVERRIDE block; workflow file wins on disagreement), run every locally-runnable check, fix failures in a bounded local loop (cap 10 iterations, test files off-limits, stuck-detection applies), and finish with one clean uninterrupted pass of the full set. Jobs that genuinely cannot run locally are recorded as `G5-residual` in progress.md — "slow/expensive" is not a residual reason. Step 10.3 (label apply) is unreachable until G5 is green; operator override requires a `REVIEW_GAP`.
  - **Step 11 fix sub-loop — label-pull discipline**: on any CI failure, `gh pr edit --remove-label "ready-to-merge"` is the FIRST action (removal does not trigger CI). Fix verification now requires the failing check's local-parity command plus a clean full G5 pass — not just lint + typecheck. Fix pushes go out with the label off (only always-on jobs fire); re-adding the label re-fires the full suite exactly once per iteration.
  - **Step 12.2** — pull the label before the docs-only post-merge prep push so it cannot re-fire the label-gated suite; `--admin` merge needs no label.
  - Frontmatter description, intro (local-first CI discipline block; removed the stale "You do NOT auto-merge" line that contradicted Step 12), Step 1 TodoWrite list (now matches the 13-step body), and failure/escalation paths updated to match.
- `references/test-gate-policy.md` — new **§ Finalisation G5 carve-out**: finalisation-coordinator Step 8c and Step 11 fix verification are the ONE sanctioned local full-suite run; strict scope (no other agent, phase, plan, or spec inherits it); rationale documented (Actions minutes are billed; local iteration is cheap). The headline Rule now names the single carve-out instead of claiming "no carve-outs".
- `manifest.json` — `frameworkVersion` 2.16.2 → 2.18.0 (also repairs the 2.17.0 release's missed manifest bump).

**Breaking:** none structurally, but consuming repos SHOULD pin their CI-parity command list in the `finalisation-coordinator.md` LOCAL-OVERRIDE block (Step 8c.1) so G5 doesn't have to re-derive it from the workflow file every run. Repos whose CI is not label-gated still benefit: G5 catches failures before any push, and the label-pull loop degrades gracefully (removal is a no-op for their triggers).

**Migration:** `git submodule update --remote .claude-framework && node .claude-framework/sync.js`. Both changed files update outside the `LOCAL-OVERRIDE` markers, so project notes are preserved. Then: (1) add the pinned G5 parity list to the consumer's `finalisation-coordinator.md` project-notes block; (2) if the consumer's own docs restate "test gates are CI-only" (e.g. CLAUDE.md), add a one-line pointer to the new carve-out.

## 2.17.0 — 2026-06-10 — review autonomy: separate autonomy from transport for the chatgpt-*-review agents

**Highlights:** The three OpenAI-tier review coordinators (`chatgpt-spec-review`, `chatgpt-pr-review`, `chatgpt-plan-review`) gained an explicit `AUTONOMY` contract that separates *autonomy* from *transport*. Previously `MODE` (manual/automated/parallel) only chose how the review text was obtained, but operators reasonably read "automated" as "runs end-to-end without stopping." In reality the agents still gated on every round (HUMAN_IN_LOOP), every user-facing finding, every `NEEDS_DISCUSSION` fork, and finalised only on an explicit "done" — and when dispatched as sub-agents (no interactive operator) those gates degraded to premature returns-to-caller. This aligns the OpenAI tier with the always-autonomous `spec-reviewer`.

**Changed:** `chatgpt-spec-review`, `chatgpt-pr-review`, `chatgpt-plan-review` — added `AUTONOMY: attended | unattended`; `MODE` is now documented as transport-only. When `unattended` (the default when the agent is dispatched as a sub-agent, or on explicit `autonomous`/`unattended`, or via `.claude/session-state/review-autonomy`), the agent never blocks for input: HUMAN_IN_LOOP forced off; user-facing / technical-escalated findings surfaced-but-non-blocking and routed to `tasks/todo.md`; `NEEDS_DISCUSSION` / `NEEDS_REVISION` directional forks auto-resolved conservatively (prefer artifact-as-is) and routed to backlog, with the session verdict reflecting open items (never a silent `APPROVED`); finalisation/termination auto-triggers on convergence; the only hard-stops are genuine tooling failures (non-zero CLI exit, file-write failure, `git push` failure).

**Fixed:** sub-agent dispatch of the OpenAI review tier no longer deadlocks or returns prematurely on directional forks or at finalisation when no interactive operator is present. Autonomy is persisted in the session log and restored on resume with precedence over the session-state file and dispatch context, **failing closed to `attended`** when it cannot be restored — a lost, deleted, or unavailable `.claude/session-state/review-autonomy` file can no longer silently flip a resumed session's autonomy (aligns the persistence contract with the resolution contract).

**Migration:** none required. `attended` (interactive) sessions behave exactly as before; the new `unattended` defaults apply only to sub-agent dispatch or explicit opt-in.

## 2.16.2 — 2026-06-09 — review-pipeline fixes: Codex spec-review invocation + optional .env loading for the OpenAI review CLI

**Highlights:** Fixes two breakages in the review pipeline surfaced on automation-v1 against Codex CLI 0.138.0 and a fresh-machine OpenAI key. (1) `spec-reviewer` invoked `codex review --file <spec> --rubric implementation-readiness` with a `cat … | codex review --stdin` fallback, but modern Codex `review` only reviews git changes (`--uncommitted` / `--base` / `--commit`) and has no `--file` / `--rubric` / `--stdin` — so the Codex spec-review tier could not run at all (it errored on unknown arguments). It now uses `codex exec` (read-only sandbox) with the spec piped on stdin, which is the correct command for reviewing an arbitrary document; verified against a live spec, Codex returned structured findings + a verdict. (2) `scripts/chatgpt-review.ts` did not load `.env`, so the OpenAI tier failed on machines where `OPENAI_API_KEY` lives only in a dotfile; it now optionally loads dotenv via a guarded `createRequire`, a no-op when `dotenv` is not installed. `dual-reviewer` was checked and is unaffected — its `codex review --uncommitted` / `--base main` invocation is valid in current Codex.

**Fixed:**
- `.claude/agents/spec-reviewer.md § Step 1` — replaced `codex review --file/--rubric` (+ `--stdin` fallback), which are not valid flags in current Codex CLI, with `codex exec -s read-only --skip-git-repo-check "$REVIEW_PROMPT" < "${SPEC_PATH}"`. On non-zero exit the fallback escalates while preserving the read-only sandbox as long as the installed Codex accepts it (drop `--skip-git-repo-check` first, keep `-s read-only`; bare `codex exec` only as a last resort), and the shared `$REVIEW_PROMPT` opens with an explicit read-only instruction so the sandbox-less last resort still tells Codex not to modify files. The Codex spec-review tier now reviews the spec document instead of erroring on unknown arguments.
- `scripts/chatgpt-review.ts` — optionally load `dotenv/config` via `createRequire(import.meta.url)` wrapped in try/catch, so `OPENAI_API_KEY` can live in a local `.env`; repos without the `dotenv` package are unaffected (the import is a no-op). Verified ordering: the sole env consumer reads the key lazily in `main()` and `callResponsesApi` takes it as a parameter, so the post-import load runs before the key is read (documented inline for future refactors).

**Changed:**
- `.claude/FRAMEWORK_VERSION` and `manifest.json` — frameworkVersion bumped to 2.16.2 (was 2.16.0).

**Breaking:** none.

**Migration:** repos on 2.16.0 pick this up via `git submodule update --remote .claude-framework && node .claude-framework/sync.js`. The `spec-reviewer.md` change is outside the `LOCAL-OVERRIDE` markers, so project notes are preserved. To use `.env` loading for the OpenAI review CLI, ensure `dotenv` is installed in the consuming repo (optional; absent it, export `OPENAI_API_KEY` in the shell as before).

---

## 2.16.1 — 2026-06-08 — (backfilled heading) G1 gate narrowed to scoped lint; typecheck + build deferred to G2

Shipped untagged between 2.16.0 and 2.16.2 (`builder.md` + `feature-coordinator.md`: per-chunk G1 runs scoped `eslint` on touched files plus builder-authored targeted tests only; typecheck and build:server/client moved to the end-of-construction G2 integrated-state gate). Heading backfilled so sync.js changelog-excerpt ranges spanning this version terminate correctly.

---

## 2.16.0 — 2026-06-06 — cross-cutting UI safety rules in the mockup loop (capability-check states, coupled-field invariants, analytics PII discipline, desktop preservation)

**Highlights:** Adds five durable UI design rules to the mockup-loop that prevent a class of bugs that look fine in the mockup but ship as silent-authorisation, generic-validation-error, or PII-leak failures in code. Surfaced from the 2026-06-06 mobile-first-web-pwa Phase 2 audit (automation-v1 PR #474) which closed three categories: (a) the push permission gate was checking "not wrapper_required" instead of the positive `ok` result, silently authorising future denied/unsupported states; (b) the analytics PII denylist had exact-match-only coverage and missed common credential variants (`accessToken`, `refreshToken`, `clientSecret`, `authToken`); (c) the analytics `ts` field was unbounded, allowing year-275760 timestamps to 500 the route. The rules generalise these from "things ChatGPT R1 caught on one PR" into "things mockup-reviewer audits on every PR going forward". Drawing the failure-state UI at design time is what prevents the silent-authorisation pattern; declaring the tier classification at design time is what aligns the implementation pattern; declaring coupled-field grouping at design time is what surfaces invariants the operator can see.

**Added:**
- `.claude/agents/mockup-designer.md § Step 3a` — Cross-cutting UI safety checklist with 5 rules:
  - Capability-check failure states drawn (push permission, biometric, secure storage, native file picker, payment API, geolocation, mic/camera, WebAuthn — anything with granted/denied/unsupported/wrapper-required/transport-failed states). The deferred-by-default rule does NOT apply to capability failure states; they are the half of the design that prevents silent-authorisation bugs.
  - Coupled-field invariants drawn as a group (quiet-hours start/end/timezone; address line/city/postcode/country; bank acct + sort code; cron schedule fields). Single enable-toggle + grouped fieldset. Off → fields hidden/cleared. On → fields required + submit-disabled until all set.
  - Analytics / log surfaces never name PII-adjacent props. The server's denylist will strip them, but the mockup is the source of truth for what the team INTENDS to emit; intending to emit `accessToken` is a design smell.
  - Mobile-extending screens preserve desktop reference (Before/After pairing must show the desktop After view unchanged alongside the mobile After).
  - Tier classification declared per screen for mobile-touching mockups (Tier 1 / Tier 2 / Tier 3 per §13.12).

- `.claude/agents/mockup-reviewer.md § Axis 1.5` — Cross-cutting UI safety audit axis added alongside grounding (Axis 1) and simplicity (Axis 2). 4 specific findings: missing capability-check failure-state UI (🔴 if brief names the check, 🟡 otherwise); coupled-field invariants drawn as independent inputs (🟡 default); analytics surfaces naming PII-adjacent props (🟡); mobile-extending mockup missing desktop reference (🟡 unless desktop is the only viewport in scope).

**Changed:**
- `manifest.json` — `frameworkVersion` bumped to 2.16.0 (was 2.15.0).

**Breaking:** none. The rules operationalise expectations that mockup-reviewer was already partially auditing on a per-prototype basis but not as a documented axis. Existing prototypes that pre-date this version are not retroactively required to comply; new mockup-loop rounds from 2.16.0 forward are.

**Migration:** repos on 2.15.x pick this up by running `git submodule update --remote .claude-framework && node .claude-framework/sync.js`. Both updated agent files (`mockup-designer.md`, `mockup-reviewer.md`) update outside the `LOCAL-OVERRIDE` markers, so any project-specific notes are preserved.

**Note on consuming-repo `docs/frontend-design-principles.md`:** the canonical "Cross-cutting UI safety rules" section lives in each consuming repo's own copy of `docs/frontend-design-principles.md` (it's not in the framework's distributed reference because consuming repos build different products with different capability surfaces). The reference in this changelog is to the automation-v1 instance at `docs/frontend-design-principles.md § Cross-cutting UI safety rules (Phase 1 + Phase 2 + ChatGPT PR-R1 learnings, 2026-06-06)`. Consuming repos may copy that section as a starting point and adapt the cited capability checks to their product surface.

**Origin lineage** (scope clarification — addresses ChatGPT PR #17 review note 1):

The "Rules A-H" lettering used below refers to the **8-rule consuming-repo `docs/frontend-design-principles.md § Cross-cutting UI safety rules` section**, NOT to framework artifacts. The framework's own contribution in this release is 5 mockup-loop rules (Step 3a checklist + Axis 1.5 audit). Those 5 framework rules map to a subset of the consuming-repo's 8 rules:

| Framework rule | Consuming-repo rule | Surface |
|---|---|---|
| Step 3a item 1 / Axis 1.5 item 1 — capability-check failure states | Rule A | Mockup-loop UI |
| Step 3a item 2 / Axis 1.5 item 2 — coupled-field invariant grouping | Rule D | Mockup-loop UI |
| Step 3a item 3 / Axis 1.5 item 3 — analytics PII-adjacent prop names | Rule C (partial — naming only) | Mockup-loop UI |
| Step 3a item 4 / Axis 1.5 item 4 — desktop reference preservation | Rule H | Mockup-loop UI |
| Step 3a item 5 — tier classification | Mobile patterns Pattern 5 | Mockup round-summary metadata |

The consuming-repo doc carries four additional rules that the framework's mockup loop does NOT enforce, because they are code-time concerns audited by `pr-reviewer` / `spec-reviewer` / `dual-reviewer`, not by `mockup-designer` / `mockup-reviewer`:

- **Rule B** — plausibility-window validation on client-supplied data (Zod refines for timestamps, counts, strings). Server-side.
- **Rule C** (server-side half) — PII denylist substring stems. Server-side.
- **Rule E** — PWA `navigateFallback` is the SPA shell. Build-config / SW.
- **Rule F** — module-level "already-happened" flag for pre-React-mount events. Client lifecycle code.
- **Rule G** — iOS Safari touch file picker defer focus cleanup. Client integration code.

**Origin per rule** (consuming-repo rule → PR/finding/commit that surfaced it):
- Rule A ← ChatGPT PR-R1 finding 3 (push permission gate, automation-v1 PR #474)
- Rule B ← ChatGPT PR-R1 finding 1 + adversarial-reviewer W3 (analytics ts unbounded)
- Rule C ← ChatGPT PR-R1 finding 2 + R2 finding 1 (PII denylist exact + substring + array recursion)
- Rule D ← Phase 2 Chunks 13+14 quiet-hours UX + claude-plan-review F3
- Rule E ← Phase 2 Chunk 16 + dual-reviewer Codex iter 1 (vite-plugin-pwa navigateFallback regression)
- Rule F ← Phase 1 SwUpdatePrompt + Chunk 5 finalisation ChatGPT R2 (module-level "already-happened" flag)
- Rule G ← Phase 1 Chunk 5 (iOS Safari touch file picker focus race)
- Rule H ← Phase 1+2 hard constraint (desktop ≥ md unchanged across mobile-extending diffs)

Each rule has cited code-level provenance in the consuming-repo doc so future maintainers can verify the lineage instead of trusting the rule abstractly.

**First instance of the consuming-repo 8-rule section:** automation-v1 PR #474, `docs/frontend-design-principles.md § Cross-cutting UI safety rules (Phase 1 + Phase 2 + ChatGPT PR-R1 learnings, 2026-06-06)`. Other consuming repos may copy that section as a starting point and adapt the cited capability checks to their product surface.

---

## 2.15.0 — 2026-06-04 — mobile capability as first-class requirement (frontend principles + mockup loop + spec checklist)

**Highlights:** Adds mobile capability as a non-negotiable peer to desktop in every UI design decision across every consuming repo. Surfaced from the 2026-06-04 mobile-first audit of automation-v1, which found the codebase had ~9% responsive coverage, 50 desktop-fixed multi-column tables, fixed-width modals, no mobile navigation pattern, and no mobile-detection infrastructure. The root cause was systemic: mockup-designer was not required to produce a mobile shape, mockup-reviewer was not auditing mobile capability, frontend-design-principles.md had no mobile rules, and spec-authoring-checklist.md had no mobile section. Future builds across all consuming repos now have mobile capability baked into every design decision from spec authoring through prototype review.

The rule is **mobile capability, not mobile-first dogma.** Desktop remains a first-class target. Both work, or the artifact is not ready to ship.

**Added:**
- `docs/mobile-capability-principles.md` — new canonical doc with 17 sections covering tiers (Tier 1 native-feeling / Tier 2 fully usable / Tier 3 acceptable fallback), viewport widths to design against (375 / 390 / 412 / 430 / 768 / 1024+), mobile navigation pattern (bottom-tab + More sheet default), mobile-native idioms vs desktop modals, table treatments (cards / sticky-first-column / column hiding), form reflow, touch targets (44px primary, 36px secondary minimum), hover not equal tap rule, keyboard handling, safe-area handling, network/offline behaviour, performance budget, pre-design checklist, re-check, when to break, mockup loop integration. Distributed via `manifest.json` to every consuming repo.
- `.claude/agents/mockup-designer.md § Step 3b` — Mobile shape mandate. Every prototype produced this round must include a working mobile shape (single responsive HTML preferred, side-by-side mobile/desktop variants when layouts diverge). Seven required checks per screen: no page-level horizontal overflow at 375px, mobile navigation present and intentional, touch targets 44px on primary actions, mobile-native idioms over desktop modals, hover-only interactions with tap equivalents, single-column form reflow below md, table treatment for 5+ column tables. Round summary now records per-screen mobile shape check.
- `.claude/agents/mockup-reviewer.md § Axis 3` — Mobile capability review axis added alongside grounding (Axis 1) and simplicity (Axis 2). 11 specific blocking findings: missing mobile shape, page-level horizontal overflow at 375px, fixed-width modal over 375px, hover-only interaction, missing mobile navigation, non-reflowing multi-column form grid, untreated wide table, touch target below 36px, missing safe-area on Tier 1 fixed element, missing keyboard-open handling on Tier 1 form. Tier-sensitive grading (Tier 3 tolerates sticky-first-column scroll, Tier 1 expects card layouts).
- `docs/spec-authoring-checklist.md § Section 13` — Mobile capability subsection mandatory for any spec that touches UI. Eight required fields per new or modified screen: tier, mobile shape decision, navigation impact, table treatment, modal treatment, hover-only interactions, form treatment, touch target audit. Pure backend specs must explicitly state `Mobile capability: N/A — pure backend, no UI surface` to make the absence intentional. Appendix checklist updated.

**Changed:**
- `docs/frontend-design-principles.md` — top-of-doc banner pointing to `mobile-capability-principles.md` as a peer document, both must be satisfied simultaneously. Pre-design checklist adds "the mobile re-check" item. Re-check before delivery adds explicit mobile capability check.
- `manifest.json` — `frameworkVersion` bumped to 2.15.0 (was 2.13.0; the v2.14.0 bump was missed in that release). `docs/mobile-capability-principles.md` added to `managedFiles` as reference distributed to consuming repos with adoption-time substitution.

**Breaking:** none. The rule operationalises a previously unwritten expectation. Existing builds and prototypes that pre-date this version are not retroactively required to comply; new work from 2.15.0 forward is. Repos with in-flight builds at this version boundary should treat the new rules as forward-looking.

**Migration:** repos on 2.13.x or 2.14.x pick this up by running `git submodule update --remote .claude-framework && node .claude-framework/sync.js`. The new `docs/mobile-capability-principles.md` lands as a new file. Updated agent files (`mockup-designer.md`, `mockup-reviewer.md`) and updated reference files (`frontend-design-principles.md`, `spec-authoring-checklist.md`) update outside the `LOCAL-OVERRIDE` markers, so any project-specific notes are preserved.

**Note on CLAUDE.md.** CLAUDE.md is in the framework's `doNotTouch` list (each consuming repo owns its own). Consuming repos that want to surface the mobile capability rule prominently in their CLAUDE.md should add a one-line reference to `docs/mobile-capability-principles.md` under their existing Frontend Design Principles section. The canonical rules live in the distributed reference docs; CLAUDE.md is just an entry point.

---

## 2.14.0 — 2026-06-04 — operator-vocabulary rule for the mockup loop (no engineer jargon in default UI)

**Highlights:** Adds an explicit "no engineer jargon" rule to all three mockup agents so prototypes do not surface protocol terms (MCP, JWT, manifest), behaviour-state internals (shadow mode, kill switch, promote to live), identifier-style labels (`request_demo`, `evaluate_fit`), internal architecture vocabulary (pillar, primitive, orchestrator, charge router, spend ledger), or telemetry jargon (provenance chain, lineage, blast radius) to non-technical operators. Surfaced from the 2026-06-04 `agent-first-aeo-bundle` build, where Round 3 of the mockup loop passed codebase grounding but the operator surfaced repeated questions about what terms like "manifest drift", "MCP read-only", "shadow mode", and `evaluate_fit` actually meant. The rule is now codified so future mockup rounds catch the same failure mode automatically.

**Added:**
- `.claude/agents/mockup-designer.md` — new `Step 3a — Operator-vocabulary rule (no engineer jargon)` section with five forbidden categories, plain-English replacement examples, required positive behaviour (one-line subtitle on every internal-capability surface), permitted contexts (designer-notes blocks, admin-only / power-user surfaces), and failure-mode severity mapping.

**Changed:**
- `.claude/agents/mockup-reviewer.md` — `No jargon in default UI` bullet under Axis 2 expanded into five named categories with per-occurrence 🟡 / high-traffic-surface 🔴 escalation, plus new bullet requiring plain-English subtitles on every internal-capability surface.
- `.claude/agents/mockup-coordinator.md` — Step 3 (designer dispatch) brief list adds explicit reminder of the operator-vocabulary rule on every dispatch.
**Breaking:** none. The rule operationalises the existing five-hard-rules check ("would a non-technical operator complete the task without feeling overwhelmed"); previous mockup rounds were already expected to comply implicitly. Explicit articulation lets `mockup-reviewer` flag violations mechanically.
**Migration:** repos on 2.13.x pick this up by running `git submodule update --remote .claude-framework && node .claude-framework/sync.js`. The deployed `.claude/agents/mockup-*.md` files update outside the `LOCAL-OVERRIDE` markers, so any project-specific notes are preserved.

---

## 2.13.0 — 2026-06-01 — framework learning loops (phase-lock + experiment-runner + chunk-learnings + audit-context-packs + cross-repo-scout)

**Highlights:** Five framework augmentations derived from a 2026-05 comparison against the open-source `vibecode-pro-max-kit`. All five are additive, no breaking changes to existing pipelines.

1. **Phase-lock hook** (`.claude/hooks/phase-lock.js` + `settings.json` registration): mechanically blocks Edit/Write/MultiEdit calls outside the allowed-paths matrix for the current build phase. Coordinator playbooks write `tasks/builds/{slug}/.phase` at each phase transition (spec-coordinator Step 6, feature-coordinator Steps 5/6/7, finalisation-coordinator Step 0).

2. **`experiment-runner` agent** (`.claude/agents/experiment-runner.md` + `scripts/experiment-runner-loopPure.ts` + test): generic metric-optimisation loop for non-binary work (perf tuning, flake hunting, prompt A/B). Pure helper `decideKeepOrDiscard` (Contract 1) drives keep/discard per iteration; TSV audit trail (Contract 7) with status enum {keep, discard, failed}. Surfaced from `reality-checker` (numeric NEEDS_WORK), `triage-agent` (capture-phrase classifier), `bug-fixer` (flake:* / perf:* labels).

3. **Chunk-learnings injection** (feature-coordinator + builder edits): after each chunk's G1 passes, feature-coordinator appends a 5-10 line entry to `tasks/builds/{slug}/chunk-learnings.md` (Contract 3). Next chunk's builder reads it at Step 0. Forward-only — no retroactive backfill.

4. **`audit-context-packs` check** (`scripts/audit-context-packs.ts` + test + finalisation-coordinator Step 6 wire + code-graph-freshness-check.js refactor): pure-function validates that every anchor in `docs/context-packs/*.md` resolves to an `<a id>` or heading-derived slug in `architecture.md` (Contract 4). Runs at finalisation Step 6 (blocks on fail) AND at SessionStart (warns on fail).

5. **`cross-repo-scout` agent** (`.claude/agents/cross-repo-scout.md` + `scripts/cross-repo-scoutPure.ts` + test + project-registries.json.template update + migration): searches sibling repos under `.claude/project-registries.json sibling_repos[]` (local Glob/Grep + GitHub `gh search code` fallback). Pure helper `rankAndTrim` (Contract 2) scores recency × framework-alignment × test-presence; agent envelope (Contract 6) carries partial-result signalling. Wired into `spec-coordinator` Step 3a (duplication) and `architect` Step 2 (approach selection).

**Added:**
- `.claude/hooks/phase-lock.js` — ESM PreToolUse hook (decidePhaseLock pure helper inside).
- `.claude/hooks/phase-lock.test.js` — standalone node:test smoke.
- `.claude/agents/experiment-runner.md` — new agent.
- `.claude/agents/cross-repo-scout.md` — new agent.
- `scripts/experiment-runner-loopPure.ts` + test.
- `scripts/cross-repo-scoutPure.ts` + test.
- `scripts/audit-context-packs.ts` + test.
- `migrations/v2.13.0.js` — two halves: tasks/builds/*/.phase added to consumer .gitignore + sibling_repos: [] added to .claude/project-registries.json.
- `.claude/project-registries.json.template.example.md` — documents the sibling_repos[] entry shape.

**Changed:**
- `.claude/settings.json` — appends phase-lock.js entry to all three existing PreToolUse matcher blocks (Write/Edit/MultiEdit), preserves existing config-protection.js + long-doc-guard.js entries.
- `.claude/project-registries.json.template` — adds `sibling_repos: []` + `sibling_repos_$comment` doc-sibling.
- `.claude/agents/feature-coordinator.md` — phase-marker writes at Steps 5/6/7; chunk-learnings append after each G1.
- `.claude/agents/builder.md` — Step 0 reads chunk-learnings.md if present.
- `.claude/agents/spec-coordinator.md` — Step 6 writes .phase=spec; Step 3a dispatches cross-repo-scout.
- `.claude/agents/finalisation-coordinator.md` — Step 0 writes .phase=finalise; Step 6 invokes audit-context-packs with bash path-resolution.
- `.claude/agents/architect.md` — Step 2 dispatches cross-repo-scout per approach.
- `.claude/agents/reality-checker.md` — NEEDS_WORK with numeric criterion surfaces experiment-runner.
- `.claude/agents/triage-agent.md` — capture-phrase classifier tags experiment-eligible.
- `.claude/agents/bug-fixer.md` — fix-mode Step 0 recommends experiment-runner on flake:/perf: labels.
- `.claude/hooks/code-graph-freshness-check.js` — wraps existing 6 branches in runSessionStartChecks(); appends audit-context-packs check; single terminal exit.
- `manifest.json` — version bump 2.12.1 → 2.13.0 + new managedFiles entries for scripts/ paths not covered by existing globs.

**Consumer migration after v2.13.0 lands:**
- Run `/claudeupdate` (or `git submodule update --remote .claude-framework && node .claude-framework/scripts/run-migrations.js . 2.12.1 2.13.0 && node .claude-framework/sync.js`).
- The migration v2.13.0.js idempotently: (a) adds `tasks/builds/*/.phase` to consumer .gitignore; (b) adds `sibling_repos: []` to existing `.claude/project-registries.json` if present.
- Configure cross-repo-scout by adding entries to `sibling_repos[]` — see `.claude/project-registries.json.template.example.md` for the shape.
- New builds get phase-lock enforcement automatically (coordinator writes `.phase`). In-flight builds at v2.13.0 adoption do NOT get retroactive `.phase` — the hook treats missing `.phase` as no-enforcement, so existing builds continue uninterrupted.

**Plan-vs-spec drift recorded:**
- Spec Contract 5 § review row describes a "first invocation per session" stdout message. The plan-and-implementation simplified this to silent no-op (no print) because hooks invoke as fresh child processes and a sentinel-file mechanism was not warranted. Documented in plan § Known plan-vs-spec drift.

**Source provenance:** `tasks/builds/framework-learning-loops/spec.md` (in automation-v1) + 3 review tiers (claude-spec-review 8 findings, Codex spec-reviewer 22 fixes + 2 directional, ChatGPT-spec-review 12 findings across 3 rounds). 9-chunk implementation across one PR on the framework canonical.

---

## 2.12.1 — 2026-06-01 — promote release-control compound learnings (idempotency content-verification, result-type discrimination, post-write recheck, six new pr-review hunt targets)

**Highlights:** four project-agnostic compound learnings, distilled in `release-control` over PRs #16–#23 (the v1.1 follow-ups batch and the multi-repo-readiness-v1 finalisation pass), are promoted upstream so every consumer repo gets the same review power without keeping the rules as local forks. Each addition fits its host file's existing pattern (architect chunk-contract bullet, pr-reviewer hunt-target bullet, spec-authoring Section 10 entry + checklist row, SYSTEM_PROMPT_PR_V2 hunt-target bullet).

Patch-class change — purely additive prompt + reference content across four files. No schema, envelope, or agent-contract change. Consumer migration: run `/claudeupdate`; the four files will sync cleanly with no `.framework-new` writes for consumers whose only customisation was these same patterns (the canonical hashes now match the additions).

**Added:**
- `.claude/agents/architect.md` § 3 Per-Chunk Detail — new "State-based idempotency: 'exists' is not 'correct'" rule appended after the Dependencies bullet. Requires plan-level pinning of three outcomes on any X-exists path (content matches → `exists`; drift → repair + record success only on repair success; repair fails → typed errorCode + `partial` audit). Catches the failure mode where an orchestrator retries against partial state and silently records success while the resource remains wrong.
- `.claude/agents/pr-reviewer.md` § Diff completeness hunts — new "Result-type error/value discrimination" hunt bullet. Flags any consumer of a discriminated `{ errored } | { value }` wrapper (Result, Either, FetchResult, etc.) that collapses `errored` and `value === null` into a single expression. The two states have different recovery semantics (transient upstream failure vs. genuine 404) and conflating them turns a 403 into false "resource missing" guidance. **Class-of-bug discipline** rule extended with explicit "include code newly added in the same diff" callout — the canonical miss is an error-masking fix in one consumer while a second consumer added in the same change repeats the original anti-pattern.
- `docs/spec-authoring-checklist.md` § Section 10.8 (new) — "Post-write recheck for residual race after row-lock release". Any `DB-update-inside-FOR-UPDATE-tx → external HTTP call` flow must declare: (a) the snapshot taken inside the transaction; (b) the re-select + comparison after 2xx; (c) the drift outcome (`status: 'partial'` + typed errorCode + named flag). Without this, a concurrent rotation between lock release and HTTP completion is silently lost while the local audit lies. Pre-launch hardening checklist gains one corresponding `[Section 10]` row.
- `scripts/chatgpt-reviewPure.ts` SYSTEM_PROMPT_PR_V2 — six new Hunt Target bullets appended to the existing list, before "JSON-only output discipline":
  1. **State-based idempotency: "exists" without content verification** — mirrors the architect rule for downstream PR detection.
  2. **External-API parameter-format literals** — verify contract-level string formats (owner-qualified branch filters, ref-name prefixes, full SHAs, owner/repo split) against the documented external-API shape.
  3. **Symmetry-with-new-code on fix application** — extend Class-of-bug discipline to cover code newly introduced in the same diff.
  4. **Reusable-workflow defaults precedence** — flag any caller `with:` value that shadows a more-specific reusable default (canonical bug: a staging caller passing `config: fly.toml`, shadowing the reusable's `fly.staging.toml` default → production config in staging).
  5. **Doc/code drift** — scan referenced docs (onboarding / runbook / README) for code-level symbols the diff renames, removes, or contradicts.
  6. **Prototype / spec drift** — scan `prototypes/*` and spec files for implementation-level claims that no longer match the diff.

**Changed:**
- `.claude/FRAMEWORK_VERSION` — 2.12.0 → 2.12.1.

**Source rollup:** `release-control` compound-learning entries `[2026-05-31] Pattern — Drift-repair for idempotent write-on-existing-state`, `[2026-05-31] Pattern — FetchResult.errored vs value === null`, `[2026-05-31] Pattern — Post-write recheck for residual race after row-lock release`, plus the six hunt targets surfaced in the multi-repo-readiness-v1 finalisation pass. The compound-learning step had been adding these to local copies of the canonical files in `release-control`; this PR moves the learnings to canonical so the local forks can be retired.

**Consumer migration after v2.12.1 lands:** run `/claudeupdate` to pick up the four file updates. Consumers that already added these same rules locally (via compound-learning or manual edit) can drop their local forks by accepting the canonical content; sync.js will write `.framework-new` for review where the locally-added wording differs from the canonical wording adopted here.

---

## 2.12.0 — 2026-06-01 — bug-fixer promoted to framework + session-scoped review-mode + release-branch targeting

**Highlights:** the GitHub-issue-driven `bug-fixer` agent (previously local-only in `automation-v1`) is promoted into the framework so every consumer repo gets the same fix-mode → finalise-mode contract used by the Release Control v2.3 § 12 stage-one loop. Three operator-facing improvements ship together:
1. Operator surface widened with the `launch bugfixer <N>` / `launch bug-fixer <N>` invocation aliases.
2. A trailing `manual` / `automated` / `parallel` keyword on any trigger phrase now propagates the ChatGPT review mode through any coordinator pass the bug-fix escalates into — via a single-line plaintext file at `.claude/session-state/review-mode` that each `chatgpt-*` agent reads as a higher-priority resolution tier than `CHATGPT_REVIEW_DEFAULT_MODE`.
3. **Release-bound fixes now target the correct release branch.** Bug-fixer reads the issue's `release:*` label and derives the PR base from `release_branch_pattern` (e.g. `release:v1.0.0` → `release/v1.0.0`). Falls back to `staging_branch` when no release label is present. Same base is re-resolved and verified at finalise to block silent drift.

Minor-class change — additive agent + resolution tier + branch-resolution algorithm; no breaking change to existing trigger phrases or env-var behaviour.

**Added:**
- `.claude/agents/bug-fixer.md` — promoted from the source repo. Operator triggers cover both `bug-fixer: <N>` and `launch bugfixer <N>` shapes for fix and finalise modes. New § "Mode flag" documents the keyword + state-file mechanism. New § "Base branch resolution" defines the release-label-driven branch derivation. New Step 0 (fix mode) and Step 8c (finalise mode) parse the trigger phrase, validate the optional mode keyword, and write `.claude/session-state/review-mode`. New Step 11a (finalise mode) re-resolves the base branch and refuses to merge if the PR's actual base has drifted. New Step 14 (finalise mode) clears the state file on success.
- Resolution-tier-2 in all three chatgpt-* agents (`chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`): each agent now reads `.claude/session-state/review-mode` between the explicit operator phrase and the `CHATGPT_REVIEW_DEFAULT_MODE` env var. A missing or invalid file value falls through silently; the env-var and hard-default tiers are unchanged.

**Changed:**
- The MODE prose blocks in all three chatgpt-* agents now describe four resolution tiers instead of three (no behavioural change for repos that don't write the state file).
- Escalation Step 5b in `bug-fixer.md` now reads the state file before printing the operator handoff. If a mode is set, the handoff includes a one-liner telling the operator the downstream pipeline will inherit it.
- Fix-mode Step 4 (branch creation) and Step 8 (PR open) now use the base resolved per § Base branch resolution instead of unconditionally targeting `staging_branch`. The PR commit + body record the base explicitly so finalise-mode Step 11a can verify it hasn't drifted.
- Finalise-mode Step 13 comment no longer claims staging redeploys automatically or that downstream verification fires without operator action. Comment now lists the explicit manual next steps (create/refresh RC, deploy, run UI suite) that the operator drives from Release Control.

**Consumer migration after v2.12.0 lands:**
- Run `/claudeupdate` (or `git submodule update --remote .claude-framework && node .claude-framework/scripts/run-migrations.js . 2.11.0 2.12.0 && node .claude-framework/sync.js`) to pick up the new bug-fixer + patched chatgpt-* agents. **Migration runs BEFORE sync** by design — the migration adopts matching local copies into state first, so sync.js doesn't subsequently write `.framework-new` siblings for files that already match the framework version.
- The `migrations/v2.12.0.js` migration auto-adopts `.claude/agents/bug-fixer.md` for repos that already had a local copy (hash match → state entry; mismatch → `.framework-new` for manual merge) AND idempotently appends `.claude/session-state/` to the consumer `.gitignore`. No manual `.gitignore` edit needed if you run the migration.
- Ensure `.release-control.yml` has the three fields the new base-resolution algorithm reads: `repo.staging_branch`, `repo.release_branch_pattern` (defaults to `release/*`), `github.release_label_prefix` (defaults to `release:`).
- Make sure Codex (or whoever files defects against a release candidate) tags the issue with a `release:<version>` label that matches the existing release branch on origin — otherwise the agent will stop with a clear error.
- Existing trigger phrases (`bug-fixer: <N>`, `bug-fixer: done <N>`, `chatgpt-pr-review: parallel`, etc.) are unchanged and continue to work. `CHATGPT_REVIEW_DEFAULT_MODE` still works as before; the state file just takes priority when present.

**Trade-off note:** the state-file mechanism intentionally avoids modifying agent dispatch semantics — every chatgpt-* agent independently reads the file at start, so a coordinator that dispatches multiple chatgpt-* sub-agents propagates the choice for free without needing to pass parameters through. The cost is a per-session disk file that must be cleaned up (handled by bug-fixer Step 14 on successful finalise, by manual `rm` otherwise, or by a future framework-level cleanup hook).

**Release-branch resolution note:** the algorithm is intentionally label-driven (not branch-name-pattern-matching) because the source of truth for "which release is this defect against?" is the rc label that Codex set when filing the issue. The `release_branch_pattern` is a derivation template, not a discovery pattern. This keeps the agent decoupled from any specific RC numbering scheme — the label says it.

---

## 2.11.0 — 2026-05-31 — 9-round chatgpt-pr-review parallel-mode learning from admin-partner-console (`SYSTEM_PROMPT_PR_V2` + pr-reviewer + builder + parallel-mode)

**Highlights:** distilled from a 9-round `chatgpt-pr-review` parallel-mode loop on a multi-tenant admin/partner console build in `altessa` (PR #19, 39 distinct real bugs fixed, 6 HIGH-severity, 3 false positives, server tests 311 → 347). Adds 6 new hunt targets + JSON-only output discipline to `SYSTEM_PROMPT_PR_V2`, a `Diff completeness hunts` block + class-of-bug discipline note to the canonical `pr-reviewer` agent, an extend-type-then-plumb minimal-change check to the canonical `builder` agent, and four reviewer-discipline rules (L2 / L4 / L5 / L6) to the `parallel-mode` operator-paste prompt template. All additions are scope-neutral and apply across multi-tenant SaaS, single-tenant apps, internal tools, and operator-facing repos. Minor-class change — additive prompt + agent-doc content, no schema or envelope contract change.

**Added:**
- `scripts/chatgpt-reviewPure.ts` — six new hunt targets appended to `SYSTEM_PROMPT_PR_V2` ("Completeness sweep on the diff" with 6 sub-shapes; "Class-of-bug discipline"; "Negative-claim audit with quoted search results"; "Round-N+ fresh-angle expectations"), plus a "JSON-only output discipline" section that folds the convergence assessment + acknowledged false-positive recovery content INTO the existing `integrity_check` string field (preserves JSON-only output for `parseReviewResult`; no schema change). No other prompt section changed.
- `scripts/__tests__/chatgpt-reviewPure.test.ts` — regression guard test asserting v2 PR/spec/plan system prompts never instruct the model to emit prose before/after the JSON envelope (would break `JSON.parse(stripJsonFence(rawText))` and quarantine the response). Pattern-matches forbidden phrases; allows them only when adjacent to negation language.
- `.claude/agents/pr-reviewer.md` — new "Diff completeness hunts (project-agnostic)" section before "Specific Things to Check". 6 hunt items (router wiring, dead affordance, endpoint existence trace, cross-tab state freshness, storage-unit hygiene, extend-type-then-plumb) plus a class-of-bug discipline note. Cites the 9-round source for provenance.
- `.claude/agents/builder.md` — new check #4 in "Minimal-change checks": "Extend-type-then-plumb" requiring `git grep` of every `kind: '<variant-name>'` call site before returning SUCCESS when a discriminated union or interface gains an optional field for an architectural reason.
- `docs/review-pipeline/parallel-mode.md` — four reviewer-discipline rules (L2 negative-claim citation; L5 quoted search-result refinement; L4 diff-size discipline ≥5,000 lines or ≥200 KB; L6 acknowledged false-positive recovery) inserted into the operator-paste prompt template that gets handed to ChatGPT-web every round.

**Source provenance:** the consumer-side rollup that fed this PR lives at `docs/review-pipeline/openai-pr-prompt-improvements.md` in `altessa` (committed to main as part of the merged PR #19). It catalogues the per-round findings, false positives, and trajectory that justified each addition.

**Consumer migration after v2.11.0 lands:** run `/claudeupdate` (or `git submodule update --remote .claude-framework && node .claude-framework/sync.js`) to pick up the updates. No file conflicts expected — `scripts/chatgpt-reviewPure.ts`, `.claude/agents/pr-reviewer.md`, `.claude/agents/builder.md`, and `docs/review-pipeline/parallel-mode.md` are all managed files with no LOCAL-OVERRIDE blocks. The PR_CONTEXT contract is unchanged; existing `scripts/__tests__/chatgpt-reviewPure.test.ts` assertions are on `prompt_version` (unchanged — additive prompt content only) and envelope skeleton shape (unchanged), so the new content does not require test updates. Projects that consume the canonical `pr-reviewer.md` overlay-pattern unchanged will gain the completeness-hunt block automatically on next sync; projects that maintain a project-specific overlay should re-merge.

**Trade-off note:** the four reviewer-discipline rules in the operator-paste prompt are intentionally redundant with the SYSTEM_PROMPT_PR_V2 additions — both tiers see the same calibration so the compare-panel mean-|Δ| stays low. The cost is a slightly longer operator paste; the benefit is the false-positive class that emerged in round 8 of the source loop is closed at both tiers simultaneously.

**Quantitative grounding from the source loop** (for any future framework discussion):
- Rounds run: 9
- Findings per round: 5 → 6 → 6 → 5 → 5 → 4 → 4 → 2 → 2 (declining trajectory)
- HIGH-severity findings: 2 oracles (R2), 1 oracle class × 8 sites (R3), 1 TOCTOU (R5), 1 TOCTOU class × 6 sites (R6), 1 RLS-backstop (R7) — 6 total HIGH
- ChatGPT-web verdicts: 6× CHANGES_REQUESTED, 2× APPROVED (R7 and R9; R9 voluntarily applied the L5 quoted-search-result format)
- False positives: 3 total — 2 in R1 (under-scanned negative claims), 1 in R8 (negative-claim citation without running the search). L5 refinement above addresses both classes.
- Two `KNOWLEDGE.md` pattern invariants codified in the consumer repo (tenant-isolation oracle from R3; TOCTOU-after-oracle-fix from R5) — both became load-bearing reviewer hunt tools from R6 onwards.

---

## 2.10.3 — 2026-05-31 — six new SYSTEM_PROMPT_SPEC_V2 hunt targets from v1-freeze-final-hardening parallel-mode learning

**Highlights:** sourced from the 3-round `chatgpt-spec-review` parallel-mode session on the v1-freeze-final-hardening spec in automation-v1 (PR #450, verdict APPROVED, 24 findings). Adds six new Hunt Targets to `scripts/chatgpt-reviewPure.ts` `SYSTEM_PROMPT_SPEC_V2` covering recurring spec defects the prior prompt did not pin: producer/consumer fencing-column pairs, dedupe-key canonicalisation for user-supplied strings, content-boundary AC carrier enumeration (DOM + non-DOM tracks), hostname-allowlist IP-literal handling, denormalised scope-column parent-scope integrity, and deploy-boundary cutover for new idempotency arbiters. SPEC-NEW-8 and SPEC-NEW-9 use scope-neutral / audience-neutral language so the Hunt Targets apply across multi-tenant SaaS, internal automation tools, single-tenant apps, non-Postgres products, and operator-facing repos. Trivial-class change — additive prompt content only, no runtime / schema / envelope contract change. OpenAI envelope `prompt_version` is NOT bumped (additive Hunt-Target additions do not break the output contract).

**Added:**
- `scripts/chatgpt-reviewPure.ts` — six new Hunt Targets appended to `SYSTEM_PROMPT_SPEC_V2` (SPEC-NEW-4 → SPEC-NEW-9). +95 lines, no other prompt section changed.
- `tasks/builds/chatgpt-prompt-tuning-v1-freeze-final-hardening-2026-05-31/brief.md` — full brief covering source attribution, per-Hunt-Target false-positive risk profile, four review rounds (Revision 1 → 4), and Decision log (10 decisions).
- `tasks/review-logs/chatgpt-spec-review-prompt-tuning-v1-freeze-final-hardening-2026-05-31.md` — session log for the OpenAI-tier adversarial review of the brief itself.

**Consumer migration after v2.10.3 lands:** run `/claudeupdate` (or `git submodule update --remote .claude-framework && node .claude-framework/sync.js`) to pick up the new prompt. No file conflicts expected — `scripts/chatgpt-reviewPure.ts` is a managed file with no LOCAL-OVERRIDE blocks in consuming repos. Existing `scripts/__tests__/chatgpt-reviewPure.test.ts` assertions are on `prompt_version` (unchanged) and envelope skeleton shape (unchanged), so the new prompt content does not require test updates.

**Deferred to follow-up brief (slug: `chatgpt-spec-prompt-followup-tracking`):** tracking infrastructure for false-positive / true-positive measurement across SPEC-NEW-4 through SPEC-NEW-8 (SPEC-NEW-9 already has its own tracking commitment in §6.3 of the brief). Will be authored after the next 10–20 spec reviews provide invocation evidence to size the tracking surface appropriately. External-reviewer endorsed this deferral as non-merge-blocking.

**Full brief (Revision 5, APPROVED post external-reviewer wording tweaks and framework semver clarification):** `tasks/builds/chatgpt-prompt-tuning-v1-freeze-final-hardening-2026-05-31/brief.md`

---

## 2.10.2 — 2026-05-30 — lint fix for e2e smoke test

**Fixed:** `scripts/__tests__/local-override-e2e.js:110` had `catch (err)` where `err` was unused, tripping `@typescript-eslint/no-unused-vars` in consuming repos that lint `.js` files under `scripts/`. Changed to optional catch binding (`catch {`). Smoke tests still 4/4 pass.

---

## 2.10.1 — 2026-05-30 — upstream automation-v1 security + schema enum extensions

**Highlights:** Adopts three improvements made in automation-v1 after the v2.8.0 framework PR shipped, that hadn't yet been upstreamed: path-traversal protection + pre-edit snapshot in `applyFindings.ts`, and `observability` + `spec_delta` additions to the `finding_type` enum in `review-finding.schema.json` (with matching schema CHANGELOG entry). Without these in the framework canonical, consumers who had locally improved these files were seeing them regress on `sync.js` deployment.

**Added:**
- `scripts/review-coordinator/applyFindings.ts`:
  - `isPathInsideRoot(absPath, projectRoot)` — rejects paths that escape the project root via absolute paths or `..` segments. Reviewer-supplied file paths are untrusted model output; this is the defence.
  - `snapshotFiles(absPaths)` + `FileSnapshot` type — in-memory byte snapshot of affected files before applying edits, used for rollback on verification failure. Preserves pre-existing uncommitted operator changes that a `git checkout HEAD -- <file>` rollback would discard.
- `schemas/review-finding.schema.json` — `finding_type` enum gains `observability` and `spec_delta`. The v2 spec/plan/PR prompts in `chatgpt-reviewPure.ts` already instruct reviewers to emit these values; previously valid model output was being quarantined as `schema_fail`.
- `schemas/CHANGELOG.md` — corresponding entry for the enum extension (dated 2026-05-28).

**Why now:** the v2.10.0 bootstrap of automation-v1 surfaced these as silent regressions when `sync.js` overwrote consumer's improved files with the framework v2.8.0 versions. Three real safety/correctness improvements were about to be lost. Upstreaming closes the loop: every consumer gets the protection.

**Breaking:** None. Both helper functions are internal additions. The enum extension is strictly additive — existing model output remains valid.

---

## 2.10.0 — 2026-05-30 — LOCAL-OVERRIDE blocks for app-specific customisations

**Highlights:** Solves the long-standing "consuming repos can't customise framework files without forking them" problem. Introduces named override slots that the framework declares inline (HTML comments, invisible in rendered markdown), and a `sync.js` upgrade that extracts the consumer's content from each slot before deploying a framework update, then re-injects it. Consumers can edit inside slots without triggering `.framework-new` siblings; edits outside slots still trigger the manual-merge flow as before. Mechanism is content-driven (presence of `<!-- LOCAL-OVERRIDE:start name="..." -->` markers in the framework file) — no new manifest mode required, no API surface added, every existing managed file is forward-compatible. Ships with `project-notes` slots pre-added to 21 framework files where the automation-v1 consumer had documented additions, plus a `project-ui-patterns` slot in `docs/frontend-design-principles.md` for the consumer's "Recurring UI patterns" extension. Convention documented at `references/local-override-convention.md`.

**Added:**
- `references/local-override-convention.md` — full convention spec: syntax, behaviour during sync.js, how to author a slot, how to use a slot as a consumer, removal semantics, when slots are not the right answer.
- `scripts/__tests__/local-override-smoke.js` — 14 unit smoke tests for parse + extract + inject (well-formed blocks, multiple blocks, nested rejection, duplicate-name rejection, unclosed rejection, end-without-start rejection, invalid-name rejection, extract correctness, inject correctness, missing-consumer fallback, orphan-consumer surfacing, multi-block ordering, idempotency, round-trip preservation). Standalone Node script; runs in ~0.1s.
- `scripts/__tests__/local-override-e2e.js` — 4 end-to-end smoke tests against a synthetic framework + consumer in tmp: (1) `--adopt` deploys file with marker + default content; (2) in-block edits survive framework version bump with no `.framework-new`; (3) out-of-block edits produce `.framework-new` containing in-block content preserved; (4) framework can add new override blocks without disturbing existing consumer overrides.
- `<!-- LOCAL-OVERRIDE:start name="project-notes" -->` block at the end of 21 agent + reference files. Empty by default. Consumers fill the block with project-specific guidance for that agent/doc; sync.js preserves it on update. Files: `.claude/agents/adversarial-reviewer.md`, `.claude/agents/architect.md`, `.claude/agents/audit-runner.md`, `.claude/agents/builder.md`, `.claude/agents/chatgpt-plan-review.md`, `.claude/agents/dual-reviewer.md`, `.claude/agents/finalisation-coordinator.md`, `.claude/agents/hotfix.md`, `.claude/agents/mockup-coordinator.md`, `.claude/agents/mockup-designer.md`, `.claude/agents/mockup-reviewer.md`, `.claude/agents/reality-checker.md`, `.claude/agents/spec-conformance.md`, `.claude/agents/spec-reviewer.md`, `.claude/agents/validate-setup.md`, `docs/context-packs/handover.md`, `docs/context-packs/implement.md`, `docs/context-packs/review.md`, `docs/decisions/README.md`, `docs/spec-authoring-checklist.md`, `references/test-gate-policy.md`.
- `<!-- LOCAL-OVERRIDE:start name="project-ui-patterns" -->` block in `docs/frontend-design-principles.md` for project-specific UI patterns (badge conventions, row-action menu rules, stat-tile limits, banner behaviour). Placed after the framework's "Worked examples" section.
- `sync.js` exports four new helpers: `parseOverrideBlocks(content)`, `extractOverrideContents(content)`, `injectOverrides(framework, consumerOverrides)`, `injectConsumerOverrides(framework, consumerPath)`.

**Changed:**
- `sync.js` `classifyFile` — for files where the consumer's hash diverges from `lastAppliedHash`, the function now checks whether the divergence is absorbable via LOCAL-OVERRIDE slots before classifying as `customised`. It reads the framework canonical content, applies substitutions, extracts the consumer's current slot contents, injects them into the framework version, and compares the resulting synthesised hash to the consumer's actual hash. If equal → all consumer edits live inside slots → `clean + needsUpdate` (sync re-deploys with overrides preserved, updates hash). If not equal → real out-of-slot customisation → `customised` → `.framework-new` written.
- `sync.js` `writeUpdated` — calls `injectConsumerOverrides()` to merge consumer slot content into the framework version before writing. Hash recorded in state is the post-injection hash, so subsequent syncs detect in-slot edits correctly.
- `sync.js` `writeFrameworkNew` — applies the same override injection so the `.framework-new` written for manual merge contains the consumer's in-slot content preserved. Operator's merge diff against their actual file therefore shows only out-of-slot drift, not in-slot content they intentionally customised.
- `sync.js` `writeNewFile` (target-exists-no-state, non-adopt branch) — applies override injection to the `.framework-new` for the same reason.
- `manifest.json` — bumped `frameworkVersion` to `2.10.0`; added entries for the two new smoke-test files and the convention doc.

**Breaking:**
- None. Mechanism is opt-in per-file via marker presence. Framework files without `LOCAL-OVERRIDE` markers behave identically to v2.9.0. State files without `appliedMigrations` continue to work (existing v2.9.0 forward-compat). Files where the consumer has accumulated out-of-slot edits get the same `.framework-new` flow as before.

**Why now:** the v2.9.0 bootstrap of automation-v1 surfaced 23 framework-managed files with consumer customisations diverging from framework canonical. Root cause: when the framework was reverse-engineered out of automation-v1, app-specific guidance stayed in the consumer files while the framework got the generic version. Subsequent framework updates couldn't propagate because the consumer's edits blocked sync.js (`.framework-new` produced for every customised file; operator never reconciled). Without a slot mechanism, every framework update permanently re-accumulates the same divergence. With LOCAL-OVERRIDE, the consumer's app-specific content lives in a defined extension point and the framework updates merge cleanly forever.

**Consumer migration after v2.10.0 lands:**
1. Operator bumps `.claude-framework` submodule to v2.10.0 (or higher) via `/claudeupdate`.
2. Run `node .claude-framework/sync.js`. For files where the consumer has accumulated additions, `.framework-new` siblings are written WITH consumer in-slot content already injected (if any slots match) — operator's merge view shows only what's left.
3. For each `.framework-new`, the operator manually moves the customised content INTO the `project-notes` slot (or another appropriate slot) and accepts the framework version elsewhere.
4. Next sync run: the file is fully clean, marker contents preserved, framework updates land cleanly.

---

## 2.9.0 — 2026-05-30 — one-shot /claudeupdate + framework migrations pattern

**Highlights:** Closes the v2.8.0 adoption gap: bumping the framework submodule no longer leaves consuming repos with manual `sync.js --apply` + per-version conversion steps. Introduces a Rails/Flyway-style migration pattern (`migrations/v<X>.<Y>.<Z>.js`) and a discovery+ordered-execution runner (`scripts/run-migrations.js`). Rewrites the `/claudeupdate` slash command to a one-shot flow: bump submodule pointer → run pending migrations (pre-sync) → run `sync.js` → detect `.framework-new` conflicts across the whole consumer tree (pause if any) → single commit → push. v2.8.0 ships with a backfill migration (`migrations/v2.8.0.js`) that auto-adopts pre-existing local copies of newly-framework-managed files when their content matches framework and seeds `.claude/project-registries.json` from the template.

**Added:**
- `migrations/README.md` — convention document for the new pattern. One file per framework version (`v<MAJOR>.<MINOR>.<PATCH>.js`); each exports `async migrate(ctx)` where `ctx = { consumerRoot, frameworkRoot, fromVersion, toVersion }`. Migrations MUST be idempotent (safe to re-run) and MUST be non-destructive on conflict (leave customised files alone and report). Return shape: `{ status: 'applied' | 'skipped' | 'conflict', notes: string[] }`. State source-of-truth: `appliedMigrations: string[]` in `.claude/.framework-state.json` — the runner appends after each successful migration, so a mid-flight failure cannot re-run already-applied migrations.
- `migrations/v2.8.0.js` — backfill migration for v2.8.0's framework-managed files. Two responsibilities: (1) auto-adopt — for the 7 file globs newly added to `managedFiles` in v2.8.0 (chatgpt-review scripts, review-coordinator helpers, schemas), check if the consumer's local copy hashes equal the framework copy; if yes, pre-populate `.framework-state.json` so `sync.js` treats them as clean instead of writing `.framework-new` siblings; if no, leave alone and report conflict (sync.js will then write `.framework-new` for legitimate manual merge). (2) Template seed — copy `.claude/project-registries.json.template` → `.claude/project-registries.json` if the destination doesn't already exist. Both steps idempotent.
- `scripts/run-migrations.js` — discovery + ordered execution + state tracking. Invoked as `node .claude-framework/scripts/run-migrations.js <consumerRoot> <fromVersion> <toVersion>`. Algorithm: read consumer state.appliedMigrations[] → glob `migrations/v*.js` → sort by semver → filter to `version > fromVersion && version <= toVersion && !appliedMigrations.includes(version)` → run each in order → on `applied` or `skipped`, atomically append the version ID to `appliedMigrations` and write state back; on `conflict`, leave the migration unrecorded so the next `/claudeupdate` retries it after the operator resolves the underlying conflict (e.g. by merging the related `.framework-new` file). On thrown error, stops and propagates; state is updated only for migrations that completed (with `applied` or `skipped`) before the failure. Exit 0 on success or no-pending; exit 1 on any thrown error.
- `manifest.json` entries: `scripts/run-migrations.js` (category `migration-runner`, mode `sync`), `migrations/README.md` (category `migration`, mode `sync`), `migrations/v*.js` (category `migration`, mode `sync`). The glob picks up all current and future migration scripts automatically.

**Changed:**
- `.claude/commands/claudeupdate.md` — rewritten as a one-shot flow. Old flow was: bump submodule pointer, commit, push. The bump alone left the consumer's working tree at the new framework SHA but with stale managed files — operators then had to remember to run `node .claude-framework/sync.js`, resolve any `.framework-new` siblings, and run any per-version manual steps from the CHANGELOG before the consumer was actually on the new version. New flow runs all of that automatically inside one commit per repo: pointer bump → migration runner (pre-sync) → `sync.js` → whole-repo `.framework-new` conflict scan (pause if any) → `git add -A` + commit + push. **Order matters:** migrations run BEFORE `sync.js` so pre-existing local copies that match the framework version can be pre-adopted into state before `sync.js` would otherwise write spurious `.framework-new` siblings. The "No `sync.js` propagation" rule from v2.6.3 onward is reversed (v2.9.0+ does propagate). The conflict-pause behaviour preserves the "never auto-merge customised files" invariant — if any `.framework-new` is written, the one-shot stops for that repo, surfaces the conflict list, and lets the operator merge and re-run. The conflict scan now covers the full consumer tree (excluding `.git/` and the submodule's `.git/`) instead of just `.claude/` + `.claude-framework/` — `sync.js` can write `.framework-new` anywhere it deploys (`scripts/`, `schemas/`, `docs/`, `references/`, etc.).
- `sync.js`: extended `FrameworkState` typedef with `appliedMigrations?: string[]`; first-run `--adopt` mode initialises the field to `[]`. Backward-compatible — older state files without the field continue to work (the runner defensive-initialises it).

**Breaking:**
- None. Consuming repos at v2.7.x or v2.8.0 work with both the old `/claudeupdate` flow (if they haven't pulled the new command yet) and the new one (after the next submodule bump deploys it). Existing `.framework-state.json` files without `appliedMigrations` are forward-compatible — the runner adds the field on first invocation.

**Why now:** v2.8.0 moved chatgpt-review scripts from per-repo local to framework-managed, which surfaced a long-standing adoption gap: every framework bump that adds/relocates a managed file forces every consumer to run `sync.js`, hand-merge any `.framework-new` siblings, and execute per-version migration steps from the CHANGELOG before they're actually on the new version. v2.6.3's `/claudeupdate` shipped only the pointer-bump half; the rest stayed manual. As the framework adds more managed files (the trend is upward — agents, hooks, ADRs, context packs, review prompts, schemas), the manual half scales linearly per consumer per bump. The migrations pattern is the standard answer (Rails / Drizzle / Flyway all use the same shape) and the one-shot `/claudeupdate` rewrite eliminates the operator-toil tax permanently.

**Operator workflow after v2.9.0:**
1. From any consumer with the new framework deployed: `/claudeupdate` (with optional scan-root arg).
2. The command discovers all consuming repos under the scan root, fetches the latest framework tip, and for each clean+on-main repo: bumps submodule, runs `run-migrations.js` (pre-sync), runs `sync.js`, scans the whole consumer tree for `.framework-new` conflicts, commits, pushes.
3. Repos with `.framework-new` conflicts pause and are surfaced in the final report — operator resolves and re-runs `/claudeupdate` for that repo only.
4. Repos with migration failures are surfaced with the error — operator fixes root cause and re-runs (the runner resumes from the failed migration, not from the start).

---

## 2.8.0 — 2026-05-29 — chatgpt-review prompts framework-managed + 13 new Hunt Targets + PROJECT_CONTEXT registries

**Highlights:** Promotes the chatgpt-review prompt harness (`scripts/chatgpt-review.ts`, `scripts/chatgpt-review-api.ts`, `scripts/chatgpt-reviewPure.ts`, `scripts/__tests__/chatgpt-reviewPure.test.ts`) from per-repo local copies to framework-managed files so all consuming repos receive prompt updates via the standard submodule-bump + sync.js adoption path. Adds 13 new Hunt-Target patterns across the three system prompts based on the 2026-05-29 notifications-system build's full end-to-end review run (2 SPEC + 1 in-place SPEC extension + 5 PLAN + 6 PR). Patterns are tied to specific incidents in that build's spec-review false-positives, plan-review missed chunk-discipline, PR-review CI fix-loop iterations, and dual-reviewer test-mock-staleness findings. Adds a parallel coordinator-side change requiring PROJECT_CONTEXT to expose 5 named registry sections (registry/manifest surfaces, CI-only gates, gate IDs + suppression scopes, CI workflow files, local-vs-CI verification policy) so the new Hunt Targets can fire reliably across consuming repos. Posture is soft-default at launch (missing sections degrade gracefully with a console.warn; the corresponding Hunt Targets fall silent on that run) and may flip to fail-closed in a future framework version.

**Added:**
- `scripts/chatgpt-review.ts`, `scripts/chatgpt-review-api.ts`, `scripts/chatgpt-reviewPure.ts`, `scripts/__tests__/chatgpt-reviewPure.test.ts` — now framework-managed (new `review-script` / `review-script-test` categories in `manifest.json`). Consuming repos that previously kept local copies will see the framework's version supersede the local copy via `sync.js --apply`.
- `scripts/review-coordinator/*.ts` — newly added to `manifest.json` `managedFiles` (the directory existed in the framework canonical but was not previously synced to consuming repos).
- `.claude/project-registries.json.template` — template for the new `.claude/project-registries.json` per-repo config that the chatgpt-review coordinator reads at dispatch time to inject registry/manifest/gate/workflow names into PROJECT_CONTEXT. Consuming repos copy the template and fill in the 5 sections to enable the new Hunt Targets.
- 13 new Hunt-Target patterns in `scripts/chatgpt-reviewPure.ts`:
  - **SYSTEM_PROMPT_SPEC_V2** (2 new + 1 in-place extension): stale-view false-positive prevention; chunk-discipline file-count check on the spec's own chunk plan; testing-posture-contradiction escalation rule appended to the existing "Testing-posture drift inside a single spec" bullet so the contradiction now emits as `recommendation="implement"` rather than `"discuss"`.
  - **SYSTEM_PROMPT_PLAN_V2** (5 new): local-vs-CI verification language consistency; Registry / Manifest Completeness (plan-stage); test-mock-staleness implication of implementation contract changes; discovery and precondition-validation sequencing (generalised from probe-specific to any chunk whose output can invalidate later work); forward-reference and migration-order check across the chunk DAG.
  - **SYSTEM_PROMPT_PR_V2** (6 new): Registry / Manifest Completeness (PR-stage); gate convention regex pre-check on new files; test-mock staleness when implementation adds new method calls on a mocked parameter; guard-ignore comment correctness check; module side-effects on import (with standalone-script exception and uncertainty-noting diagnostic); large-diff CI infrastructure adequacy heads-up (advisory only — never blocking).
- `scripts/review-coordinator/validateProjectContextPure.ts` — new exported helpers for the soft-default registry posture:
  - `REGISTRY_SECTIONS` (const tuple) — the 5 §6.2 registry headings the v2.8.0 Hunt Targets reference via "named in PROJECT_CONTEXT".
  - `findMissingRegistrySections(context)` — returns the list of missing section headings.
  - `computeCoverageReport(missingSections)` — maps missing sections → specific Hunt Targets that degrade, returns `{ status: 'complete' | 'partial' | 'all-missing', active_hunt_target_count, degraded_hunt_target_count, degraded_hunt_targets[] }`. 6 of the 13 new patterns are registry-dependent (PLAN-NEW-1, PLAN-NEW-2, PR-NEW-1/2/4/6); the other 7 are self-contained and always active.
  - `formatCoverageWarning(report)` — formats the report as a multi-line operator-facing warning block (or a one-line ok message when status is 'complete'). Coordinators should log this once per dispatch instead of one warning per missing section, so operators see exactly which review coverage they're getting.
- `schemas/*.json` + `schemas/CHANGELOG.md` — added to `manifest.json` `managedFiles` so consuming repos receive the JSON-Schema files that `scripts/chatgpt-review.ts` loads at runtime (`review-result.schema.json` is compiled into the Ajv validator; `review-finding.schema.json` is added to Ajv and referenced transitively from `review-result.schema.json` via `$ref`). Without this entry, a clean consuming-repo adoption would fail with `ENOENT` at the first chatgpt-review dispatch when the script tries to resolve `../schemas/review-finding.schema.json` and `../schemas/review-result.schema.json` from the script's own directory. The other two schemas in the directory (`pr-context.schema.json`, `prior-rounds.schema.json`) ship together for forward-compatibility with future reviewer features that consume them; the bundle is small (~10 KB total).
- `.claude/commands/claudeupdate.md` — promoted from per-repo local to framework-managed. This slash command is itself the framework-adoption helper (it bumps `claude-code-framework` across all consuming repos on the local machine), so it belongs in the framework canonical, not in any single consuming repo. The existing `.claude/commands/*.md` glob in `manifest.json` `managedFiles` picks it up automatically — no new manifest entry needed.

**Changed:**
- `manifest.json`: bumped `frameworkVersion` to `2.8.0`; added 5 new `managedFiles` entries for the relocated chatgpt-review scripts + the project-registries template + the review-coordinator helpers; introduced two new categories (`review-script`, `review-script-test`, `review-coordinator`).

**Why the prompts move to the framework now:** the notifications-system build (PR #447 in automation-v1) was the first complete end-to-end run of all three OpenAI-driven review tiers under the parallel-mode v2.7.2 contract. The build's full audit log (4 CI fix-loop iterations, 6 distinct missed-pattern classes, 14 distinct findings across 2 rounds of chatgpt-pr-review) yielded enough concrete patterns to justify a meaningful tuning pass. Keeping the prompts as per-repo local copies meant Foundry / CryptoTrackr / Freedom Planner would not have benefited from these patterns without a manual mirror per repo. Promoting to framework-managed makes future prompt-tuning iterations a single PR against the framework canonical, propagating to every consuming repo via the existing submodule bump pattern.

**Brief and source incidents:**
- Full brief (revision 3, APPROVED): `tasks/builds/chatgpt-prompt-tuning-notifications-system-2026-05-29/brief.md`
- Source incident logs (in automation-v1): `tasks/review-logs/chatgpt-{spec,plan,pr}-review-*-notifications-system-*.md`, `tasks/review-logs/auto-fix-log-notifications-system-*.md`, `tasks/review-logs/dual-review-log-notifications-system-*.md`.

**Migration for consuming repos (Trivial follow-up PR per repo):**
1. Bump `.claude-framework/` submodule pointer to this version's merge commit.
2. Run `node .claude-framework/sync.js --apply` — deploys the 4 chatgpt-review scripts, the review-coordinator helpers, and the project-registries.json.template.
3. Delete any pre-existing local copies of `scripts/chatgpt-review*.ts` in the consuming repo (now superseded by synced versions).
4. Copy `.claude/project-registries.json.template` to `.claude/project-registries.json` and fill in the 5 sections with paths that exist in your repo. Missing or null sections are tolerated at v2.8.0 launch (the relevant Hunt Targets fall silent on that run) but will be required by a future framework version.
5. Bump `.claude/FRAMEWORK_VERSION` in the consuming repo to `2.8.0` and run lint + typecheck. No behaviour change is expected until the next chatgpt-review dispatch picks up the new prompts.

## 2.7.2 — 2026-05-28 — chatgpt-review parallel mode + learning component

**Highlights:** Fixes three stacked bugs in the OpenAI-driven chatgpt-review CLI that caused real schema quarantines on real artefacts, then adds a `parallel` mode to all three review agents (PR, spec, plan) that runs OpenAI and manual ChatGPT-web side-by-side and renders a compare panel. New learning step (Step 7) inspects every parallel round, proposes targeted edits to the OpenAI prompts when ChatGPT-web catches things OpenAI missed, gates each proposal on operator approval, and persists every edit to a durable `tasks/review-logs/prompt-evolution-log.md` audit trail. Three rounds of self-test on the introducing PR (#441) drove ChatGPT-web's verdict from CHANGES_REQUESTED → APPROVED with three durable prompt-evolution entries logged. The system is the prerequisite for the future Phase 3 flip to fully automated review.

**Added:**
- `docs/review-pipeline/parallel-mode.md` — shared contract for the parallel mode used by `chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`. Covers loop shape, compare-panel rendering, session-log schema (with the new 7a/7b learning sub-sections), failure handling, the three learning channels (chatgpt-only, severity-delta, anti-hunt), Step 7a (pre-triage Channels 1+2) and Step 7b (post-triage Channel 3) split, the `CHATGPT_REVIEW_DEFAULT_MODE` env-var gate, and the Phase 3 flip criterion (zero ChatGPT-only findings for two consecutive rounds).
- `manifest.json` entry for the new shared contract doc as a managed reference file.

**Changed:**
- `.claude/agents/chatgpt-pr-review.md` — mode resolution now lists three modes (`manual` / `automated` / `parallel`); resolution order honours explicit operator phrase, then `CHATGPT_REVIEW_DEFAULT_MODE` env var, then hard-default `manual`. Parallel-mode entry note pins explicit stdin redirection for PR mode to prevent `readStdin` deadlock, splits stdout/stderr to keep JSON capture clean, and points at the shared contract for Step 7 learning analysis.
- `.claude/agents/chatgpt-spec-review.md` — same three-mode resolution + parallel entry note + Step 7 pointer; spec mode uses `--file` for unambiguous input.
- `.claude/agents/chatgpt-plan-review.md` — three-mode resolution + parallel entry note + Step 7 pointer; the legacy "`OPENAI_API_KEY` set → automated by default" behaviour was REMOVED so all three agents now follow the same hard-default-manual contract (no silent token-burn on a fresh machine with the key set). Front-matter description and Mode Detection section both updated.

**Why:**
- The OpenAI-driven CLI was quarantining real responses on real PR diffs because three bugs stacked: (A) the CLI never substituted prompt placeholders (model saw raw `{{DIFF}}` literals), (B) the v2 prompts under-specified the result envelope (verdict enum, integrity_check string contract, source_refs shape, category enum, the conditional `operator_decision_required_reason` requirement), and (C) the repair prompt was generic. Parallel mode is the dev-loop that lets the operator A/B-test the automated OpenAI path against manual ChatGPT-web until OpenAI consistently catches what ChatGPT-web catches plus more — the criterion for flipping the default to automated.
- All three agents reading the shared contract from one doc keeps the loop shape, session-log schema, and Phase 3 transition criteria in one place — three copies of the same content drift apart.

**Project-side companion changes (not framework-managed; documented here for cross-repo awareness):**
- `scripts/chatgpt-reviewPure.ts` and `scripts/chatgpt-review.ts` were rewritten in the introducing PR (#441 on automation-v1) to: substitute `{{KEY}}` placeholders (with fail-fast on missing keys), split each v2 prompt into `_SYSTEM` (instructions + envelope skeleton) and `_USER` (artefact + metadata) templates so untrusted document content stays out of the highest-priority instruction channel, add `buildAdHocPromptVars` for ad-hoc CLI runs, add `buildRepairPrompt` + `OUTPUT_ENVELOPE_SKELETON` + `translateAjvErrorsToChecklist` + `SYSTEM_PROMPT_REPAIR_V2` (dedicated repair-retry system prompt), add `compareFindingSets` + `renderComparePanel` + `mdCell` + `jaccard` for the compare panel, true-alias the `--expected-sha` / `--source-artifact-sha` flags at argument-parse time with conflict detection, and add CLI flags (`--project-context`, `--pr-context`, `--prior-rounds`, `--project-context-version`, `--source-artifact-sha`) for coordinator-driven invocations. These scripts live per-project (the framework does not manage `scripts/`); other repos adopting the framework should pull the same shape from the canonical implementation in `automation-v1`.
- `tasks/review-logs/prompt-evolution-log.md` was introduced as the append-only audit trail for every learning-step edit. Each repo that adopts parallel mode should create the same file using the header template in the canonical implementation.

**Not done (deliberately):**
- `scripts/chatgpt-review.ts` and `scripts/chatgpt-reviewPure.ts` were NOT promoted to framework-managed. Each project's prompts evolve based on its own A/B history; promoting the scripts to framework-canonical would couple prompt evolution across all consumers. The decision was flagged in the introducing PR's session log for future revisit.

## 2.7.1 — 2026-05-28 — feature-coordinator model-switch contradiction fix

**Highlights:** Resolves the Opus/Sonnet model-switching contradiction between Model A (builder dispatched as a Sonnet sub-agent) and Model B (operator manually switches the main session). Commits Model A — the only execution model that actually matches Claude Code runtime constraints (a running interactive session cannot change its own model programmatically). The main session now stays on Opus end-to-end through the three-coordinator pipeline; token-heavy chunk construction runs on Sonnet via the `builder` sub-agent dispatch. No more `/model` prompts during a `feature-coordinator` run.

**Changed:**
- `.claude/agents/feature-coordinator.md` Step 6 (Builder invocation) — added a HARD RULE that the coordinator MUST dispatch `builder` via the `Agent` tool for all chunk construction and MUST NEVER write chunk code inline with `Edit` or `Write` in the main session. The dispatch now passes an explicit `model: "sonnet"` per-invocation override as belt-and-suspenders over the `builder.md` frontmatter (per-invocation override beats frontmatter per Claude Code runtime). Inline construction closes a scope-drift hole and ensures the cost model holds: heavy build tokens are Sonnet, coordinator orchestration tokens are Opus.
- `.claude/agents/feature-coordinator.md` Step 7 (Post-G2 spec-validity checkpoint) — removed the `MANDATORY STOP: switch to Opus before continuing` block and the `Do not start Step 8 until the operator has confirmed they are on Opus` enforcement. The main session is already on Opus throughout Phase 2 under Model A; no switch is needed. The spec-validity question itself is retained — operator still confirms `continue` before Step 8.
- `CLAUDE.md` "Model guidance per phase" table — rewrote to reflect Model A end-to-end. Old table conflated execution model (which session runs) with sub-agent model (per-agent frontmatter). New table has two columns: "Main session" (Opus throughout) and "Sub-agent model" (Sonnet for builder, Opus for everything else). Removed plan-gate "manually switch to Sonnet" and post-G2 "switch back to Opus" rows. Added a closing paragraph explaining why no main-session switch is needed and what the headless `claude -p --model sonnet` escape hatch is if orchestration cost ever becomes an issue.

**Why:**
- A running interactive Claude Code session cannot change its own model programmatically. `/model` is interactive and user-only; no tool, hook, or settings entry lets an agent switch its session model mid-run. Model B (manual main-session switching) was unreachable from inside the coordinator playbook — the operator was being asked to perform a manual dance that the coordinator could not enforce.
- Model A (builder-as-Sonnet-sub-agent) was already implemented (`.claude/agents/builder.md` frontmatter `model: sonnet`; `feature-coordinator.md` Step 6 dispatches `builder` via the `Agent` tool). The fix commits Model A as the sole execution model and deletes Model B's documentation residue.
- The plan-gate and post-G2 stops remain as operator-review seams; they just no longer demand a model switch.

**Not done (deliberately):**
- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` was NOT set. That env var forces ALL sub-agents to Sonnet, which would wrongly demote `architect`, `pr-reviewer`, `reality-checker`, and other reviewers intentionally pinned to `model: opus`. Per-agent frontmatter is the correct mechanism.
- Orchestration cost (coordinator's own Opus tokens during the build loop — running lint/typecheck, reading builder output, writing commits) is accepted as the tradeoff. If it ever becomes material, the right answer is to run the build loop as a separate headless `claude -p --model sonnet` invocation across the plan-gate or post-G2 seam, handing off through `tasks/builds/{slug}/plan.md` and `progress.md`. This is documented in the CLAUDE.md model-guidance table but not implemented in this release.

**Fixed (defence-in-depth):**
- The new HARD RULE in Step 6 also closes a latent drift hole: prior wording allowed the coordinator to be interpreted as optionally dispatching builder, which could lead a future agent (or a confused operator) to inline-write chunk code in the main session, defeating both the cost model and the commit-integrity invariant (which depends on builder's structured `files-changed` verdict).

## 2.7.0 — 2026-05-28 — review-cascade-v3

**Highlights:** Schema-gated multi-tier review pipeline upgrade. Replaces the ad-hoc prose review contract with a JSON-Schema-gated v2 envelope across all three review modes (spec, plan, PR). Adds two new advisory Claude reviewers, upgrades `pr-reviewer` to v2 with mechanical auto-fix authority, wires coordinator-side auto-apply with rollback, disagreement adjudication, and false-positive suppression memory. Golden corpus: 11/11 fixtures passing (8 coordinator + 3 driver smoke).

**Added:**
- `schemas/review-finding.schema.json` — active v2 contract for a single finding. Key additions: `risk_domain` (independent enum from `finding_type`; carve-out gate keys on this), `source_refs[]` (replaces `evidence` string; min 1 item), `scope_signal`, `triage_hint`, `proposed_edits[]` (required when `auto_apply_eligible: true` per §A11 patch contract), `acceptance_check` denylist via `pattern` constraint.
- `schemas/review-result.schema.json` — active v2 envelope. Versioning quartet: `contract_version`, one of `{prompt_version | reviewer_version | stitched_from}`, `project_context_version`, `source_artifact_sha`. `oneOf` enforces mutual-exclusivity between OpenAI-tier, Claude-tier, and coordinator-stitched records.
- `schemas/prior-rounds.schema.json` — PRIOR_ROUNDS input shape: `current_round`, `findings_settled[]` (with resolution enum), `coordinator_notes[]`.
- `schemas/pr-context.schema.json` — PR_CONTEXT input shape: `pr_title`, `build_slug`, `task_class`, `phase_2_review_outcomes`, `accepted_deviations[]`.
- `schemas/CHANGELOG.md` — field-move history for the schema contract surface.
- `.claude/agents/claude-spec-review.md` — new advisory Claude spec reviewer. Read-only, 3-iteration lifetime cap per artifact. Runs before Codex and OpenAI; emits markdown log + canonical JSON validated by the v2 schema. Fail-closed on missing PROJECT_CONTEXT sections (§3b). `auto_apply_eligible: false` at launch; promoted via `CLAUDE_REVIEWER_FIX_MODE_SPEC` config flag.
- `.claude/agents/claude-plan-review.md` — new advisory Claude plan reviewer. Read-only, 3-iteration lifetime cap per artifact. Risk-weighted chunk sampling (schema/migration/RLS/worker/route chunks always in the 2-3 sample). Runs as the only mechanical pre-screen before OpenAI plan review. `auto_apply_eligible: false` at launch; promoted via `CLAUDE_REVIEWER_FIX_MODE_PLAN`.
- `scripts/review-coordinator/applyFindings.ts` — coordinator-side §11a auto-apply orchestrator: one-finding-at-a-time, snapshot + rollback, anchor-based patch, cumulative re-verify, structured commit.
- `scripts/review-coordinator/applyFindingsPure.ts` — pure helper for the apply loop (no FS side effects; testable in isolation).
- `scripts/review-coordinator/auditLog.ts` — structured audit log writer for coordinator decisions (applied / deferred / suppressed / quarantined).
- `scripts/review-coordinator/buildDiffPackage.ts` — coordinator-side §3c diff truncation manifest builder; hashes the focused package (manifest + diff + PR_CONTEXT + PRIOR_ROUNDS) for `source_artifact_sha`.
- `scripts/review-coordinator/buildDiffPackagePure.ts` — pure helper for diff package construction.
- `scripts/review-coordinator/resolveBaseRef.ts` — F9 R1 fix: `resolveBaseRef()` dynamically resolves the merge-base against `origin/HEAD` or the configured default branch; no more hardcoded `origin/main`.
- `scripts/review-coordinator/suppressionStore.ts` — §11c false-positive suppression memory with mandatory provenance, round-level dedup, and F10 R1 absent-directory tolerance.
- `scripts/review-coordinator/validateProjectContextPure.ts` — §3b PROJECT_CONTEXT fail-closed preflight; rejects missing Stage, Framing assumptions, or Architecture + Guidelines sections; pure and testable.
- `context/framing-defaults.md` — default PROJECT_CONTEXT framing block injected into all three review modes when the host repo does not supply its own.
- `context/README.md` — context directory convention: how framing-defaults.md is loaded, override semantics, and the five canonical framing-assumption keys.

**Changed:**
- `.claude/agents/pr-reviewer.md` — upgraded in place to v2 (same file, same caller contract). New authorities: mechanical auto-fix via Edit for `scope_signal: local` AND `risk_domain: none` findings (`auto_apply_eligible: true`, `auto_apply_reason: "local_one_obvious_fix"`). Security carve-out (§13) keys on `risk_domain` — any value other than `none` blocks auto-fix regardless of `finding_type`. Inline-apply sets `applied_inline_by_reviewer: true`; coordinator verifies via `acceptance_check` and does NOT re-apply. JSON output now required alongside the markdown log; both validate against `schemas/review-result.schema.json`. `reviewer_version: "pr-reviewer.v2"`.
- `.claude/agents/chatgpt-pr-review.md` — v2 routing rules: reads `triage_hint` as initial bucket, uses `risk_domain` (NOT `finding_type`) for carve-out gating, reads `auto_apply_eligible` and `proposed_edits[]` directly from the CLI's normalised findings[]. Automated mode flipped to default when `OPENAI_API_KEY` is set.
- `.claude/agents/chatgpt-spec-review.md` — same v2 routing rules; reads normalised findings[] from CLI JSON (no re-parsing raw_response). Automated mode default when `OPENAI_API_KEY` set.
- `.claude/agents/chatgpt-plan-review.md` — new agent (was absent from prior framework versions); automated mode auto-detected from `OPENAI_API_KEY`; manual fallback retained.
- `.claude/agents/spec-coordinator.md` — Steps 6a/6b added: claude-spec-review invocation with D5 cap + validateProjectContext preflight (Step 6a), followed by coordinator apply of surfaced technical findings per §11a (Step 6b).
- `.claude/agents/feature-coordinator.md` — Steps 3a/3b added: claude-plan-review invocation with D5 cap + validateProjectContext preflight (Step 3a), followed by coordinator apply of surfaced technical findings per §11a (Step 3b).

**Coordinator wiring (§11a/11b/11c):**
- §11a coordinator-side auto-apply: one-finding-at-a-time apply loop with snapshot before each apply, anchor-based patch (literal substring uniqueness check), cumulative re-verify (lint + typecheck after each), structured commit per finding, rollback on verification failure.
- §11b reviewer-disagreement adjudication: when two reviewers disagree on the same finding, coordinator surfaces the delta with both rationales; operator decides; decision logged with `coordinator_override_reason`.
- §11c false-positive suppression memory: findings suppressed in prior rounds persist to the suppression store; re-raised findings in subsequent rounds are auto-suppressed with provenance; F10 R1 tolerates absent suppression directory (creates on first write).

**Fixed:**
- F9 R1 — `resolveBaseRef()` replaces hardcoded `origin/main` with dynamic default-branch resolution; consuming repos on `origin/master` or custom default branches no longer fail the diff-package builder.
- F10 R1 — `suppressionStore.ts` creates the store directory on first write instead of throwing on absent path.

**Adoption notes (for repos consuming this framework upgrade):**
- `schemas/` directory is new at the repo root. Sync deploys it automatically (glob `schemas/**`). No manifest entry was needed in prior versions; v2.7.0 adds the glob.
- `scripts/review-coordinator/` is a new directory under `scripts/`. Consuming repos that mount the framework's `scripts/` must ensure their `tsconfig.json` picks up this subdirectory (standard `include: ["scripts/**"]` already covers it).
- `context/` directory is new at the repo root. Contains `framing-defaults.md` and `README.md`. Coordinators load from `context/framing-defaults.md` unless the host repo ships a project-specific override at the same path.
- `pr-reviewer.md` upgraded in place: consuming repos that had local customisations (e.g. project-specific "Specific Things to Check") will see a `.framework-new` sibling on next `sync.js` run. Merge the new §13 carve-out logic and the JSON output requirement; preserve project-specific checklist items.
- `spec-coordinator.md` and `feature-coordinator.md` changed in place: Steps 6a/6b and 3a/3b are additive; consuming repos with `customisedLocally: true` should merge the new steps into their local copies.
- `chatgpt-plan-review.md` is a new agent file. Sync deploys it automatically via the `agents/*.md` glob. Add the fleet table row and common-invocation entry to `CLAUDE.md` (manual step — `CLAUDE.md` is `doNotTouch` per manifest).

---

## 2.6.5 — 2026-05-27

**Highlights:** Operator-facing UX upgrade across all three ChatGPT review agents (`chatgpt-spec-review`, `chatgpt-plan-review`, `chatgpt-pr-review`) for consistency. Every round (kickoff and Round N+1) now ends with two operator-ready outputs in one place: (a) a clickable repo-relative VS Code markdown link to the artefact (spec, plan, or per-round PR diff file), and (b) a ready-to-paste ChatGPT prompt block. For Round N+1, the prompt block enumerates per-finding what was applied, rejected (with reason), and deferred (with reason) drawn from that round's decisions table — so ChatGPT has the context needed to avoid re-flagging items the operator already decided about. Eliminates the previous friction of (1) operators having to manually ask the agent for a file link each round, (2) the spec agent embedding the entire spec content inline in the prompt rather than using ChatGPT-web's native file-attach support, (3) the plan agent providing no Round N+1 prompt at all (just "Run another round?"), and (4) the PR agent lacking the applied/rejected/deferred summary in its upload prompt despite already having clickable diff links.

**Changed:**
- `.claude/agents/chatgpt-spec-review.md` — Step 7 [MANUAL] (Round 1 kickoff) replaces "Read spec content in full + embed in prompt" with a clickable VS Code markdown link to the spec file + paste-ready prompt block (no inline content). Per-Round Loop Round 2+ block trimmed (no re-prompt at start of round N — the round N-1 footer carries the prompt and link). Round summary footer (step 7 manual line) now prints a structured Round N+1 prompt block with per-finding Applied / Rejected (with reason) / Deferred (with reason) sections + a fresh clickable spec link.
- `.claude/agents/chatgpt-plan-review.md` — Step 6 (Round 1 kickoff) replaces backtick-wrapped path + "Upload this file" prose with a clickable markdown link + paste-ready ChatGPT prompt block. Per-Round Loop step 6 replaces the bare "Run another round, or say done?" prompt with the same structured Round N+1 prompt block + clickable plan link used by the spec agent.
- `.claude/agents/chatgpt-pr-review.md` — Per-Round Loop step 9 [MANUAL] now prints a structured Round N+1 prompt block (Implemented / Rejected with reason / Deferred with reason) ABOVE the existing clickable diff-file link, so the operator gets one copy-paste unit (prompt + file attachment) instead of just the diff link. Worked example updated to show the new shape end-to-end. Diff-file generation, exclusions list, repo-relative-link format rules, and VSCode-clickable-link enforcement (no absolute paths, no backslashes, no bare backticks) are unchanged — they were already correct.

---

## 2.6.4 — 2026-05-27

**Highlights:** Docs-only patch documenting a gotcha discovered during the v2.6.3 adoption rollout. The `.framework-new` files sync.js writes when a customised file has a newer canonical version are per-clone working artefacts — if accidentally committed to git, they propagate one developer's mid-sync state to every clone and look like a shared "pending decisions backlog" needing collaborative resolution. They are NOT a team-shared backlog. SYNC.md Phase 5 now opens with a gitignore prerequisite so future adopters add `*.framework-new` to their root `.gitignore` once, up front.

**Changed:**
- `SYNC.md` — Phase 5 opens with a gitignore prerequisite explaining why `*.framework-new` must be gitignored per repo, and showing the exact line to add. The framework itself does NOT auto-write this rule (it would not be safe for sync.js to modify a consuming repo's root `.gitignore`).

---

## 2.6.3 — 2026-05-27

**Highlights:** Two operator-facing additions. First, the framework now ships a `commands/` convention for transportable Claude Code slash commands, with `/claudeupdate` as the inaugural command — a one-touch updater that bumps the `claude-code-framework` submodule pointer across every consuming repo on disk (auto-discovered) and pushes per-repo, only when each repo is on `main` and clean. Second, `finalisation-coordinator` now emits a CEO-level summary at end-of-phase (Step 13.1) — plain-English dot points of what shipped, benefits, further action required, and new backlog items — before the existing technical block (Step 13.2). The summary refreshes the operator when running multiple parallel build sessions.

**Added:**
- `.claude/commands/` directory convention. Sync deploys this category like `agents/`, `hooks/`, `skills/`.
- `.claude/commands/claudeupdate.md` — the `/claudeupdate` slash command. Discovers every directory under `<scan-root>/*` that mounts `claude-code-framework` as a submodule, bumps the pointer, commits, pushes, and reports a per-repo outcome table. `<scan-root>` defaults to the parent of the current working repo; can be overridden via `$ARGUMENTS`.
- `command` category added to `ManifestCategory` in `sync.js`.
- `manifest.json` entry: `{ "path": ".claude/commands/*.md", "category": "command", "mode": "sync", "substituteAt": "never" }`.

**Changed:**
- `.claude/agents/finalisation-coordinator.md` — Step 13 split into 13.1 (CEO summary, prints first) and 13.2 (existing technical end-of-phase block, prints second). 13.1 mandates plain-English composition: no chunk IDs, no agent names, no internal jargon; reads from handoff.md + intent.md + the squash diff of `tasks/todo.md` for ground-truth sources; lists "Further action required" as a binary yes/no, not a hedge.

---

## 2.6.2 — 2026-05-26

**Highlights:** Two clarifications to `finalisation-coordinator` — (a) Step 11 spells out how to invoke `gh pr checks --watch` in Claude Code (background `Bash` + harness notification) and forbids `ScheduleWakeup` polling on top of an active watch; (b) Step 12 forbids any operator-pause `AskUserQuestion` between CI green and auto-merge. The single operator gate remains the `ready-to-merge` label at Step 10.3.

**Changed:**
- `.claude/agents/finalisation-coordinator.md` — Step 11 watch-protocol contract expanded with invocation guidance + `ScheduleWakeup` discipline; Step 12 gains a "No operator pause here" paragraph.

---

## 2.6.1 — 2026-05-24

**Highlights:** Stage 2 framework polish — consolidates findings from Foundry / CryptoTrackr / Freedom Planner sibling adoptions. De-contaminates canonical agent templates of origin-project literals (the framework now describes patterns; project-specific paths and identifiers live in each repo's `.claude/agents/extensions/<agent>.md` overlay). Lifts CryptoTrackr's audit-runner invariants (M1, M2, I1-I3, F1-F5, E1-E5) into canonical. Fixes two `sync.js` bugs that blocked clean adoption elsewhere. Makes `feature-coordinator` profile-aware so STANDARD-profile repos don't choke on missing FULL-only reviewer dispatches.

**Added:**
- `references/project-extensions-convention.md` — documents the `.claude/agents/extensions/<agent>.md` overlay convention end-to-end. Canonical agents now reference it explicitly.
- `## Project Extensions` directive section in `architect.md`, `pr-reviewer.md`, `audit-runner.md`, `feature-coordinator.md` — instructs the agent to load `.claude/agents/extensions/<agent>.md` if present at context-load time.
- `## Branch Naming and Slug Normalization (M1)` section in `audit-runner.md`.
- `## Invariants` section in `audit-runner.md` lifting CryptoTrackr's I1 (read-only-by-default pass-1), I3 (no-parallel-area pass-2), F2/E3/E5 (pass-2 hard allow-list ≤30 LOC / ≤3 files / no schema / no migration / no encryption / no dep changes), E4 (no-speculative-fix), E2 (finding-state invariant), F5 (schema/migration always pass-3), F1/I4/E1 (commit-and-rollback discipline) — all project-agnostic.
- M2 invariant in `audit-runner.md` Pre-flight (behind-main check: `git rev-list --left-right --count origin/main...HEAD`).
- Profile-aware skip block in `feature-coordinator.md` Step 4 — `chatgpt-plan-review` is skipped (no `REVIEW_GAP` required) when the agent file is not present in the repo's fleet (MINIMAL/STANDARD profile per GRADED policy).

**Changed:**
- `architect.md` — "Architecture Constraints" wrong-project section (L145-159 of v2.6.0) removed and replaced with a pointer to the project's `architecture.md` + project extensions file. `DEVELOPMENT_GUIDELINES.md` context-load made conditional ("read if present"). "Three-tier agent hierarchy" / "two-tier permission model" / "WebSocket rooms" / `references/project-map.md` build commands all softened to project-agnostic prose.
- `pr-reviewer.md` — "Specific Things to Check" wrong-project subsections (L60-99 of v2.6.0) removed and replaced with project-agnostic category headers that point to the project extensions file. `DEVELOPMENT_GUIDELINES.md` context-load made conditional. Convention-violation and shallow-modules bullets softened (no more `resolveSubaccount` / `asyncHandler` references).
- `audit-runner.md` — hardcoded subsystem inventory (origin-project hotspots: `rls`, `agent-execution`, `queues`, `skills`, `webhooks`) and per-hotspot path resolution removed. Hotspots are now project-supplied via the extensions file. `docs/codebase-audit-framework.md` is now an OPTIONAL authoritative manual: if the project ships one, audit-runner reads it as the source of truth; if absent, audit-runner uses this file as a self-contained playbook (the pre-v2.6.1 hard-halt on missing doc was a framework defect — fixed).
- `feature-coordinator.md` — `DEVELOPMENT_GUIDELINES.md` context-load made conditional. Step 4 (chatgpt-plan-review) now profile-aware.
- `builder.md`, `dual-reviewer.md`, `chatgpt-pr-review.md`, `chatgpt-spec-review.md`, `adversarial-reviewer.md`, `finalisation-coordinator.md` — `DEVELOPMENT_GUIDELINES.md` context-load made conditional across the agent fleet ("read if present; skip when absent"). Architecture/RLS references softened to project-agnostic wording where the underlying concept (tenant isolation, service-tier, etc.) is universal.
- `manifest.json` — `docs/frontend-design-principles.md` and `references/spec-review-directional-signals.md` `substituteAt` flipped from `"never"` to `"adoption"`. Both files contain `{{PROJECT_NAME}}` / `{{COMPANY_NAME}}` placeholders that were shipping unfilled — surfaced by Foundry's adoption. Consuming repos that already adopted v2.6.0 will see those two files reclassify as needing re-substitution on next `sync.js --apply`.

**Fixed:**
- `sync.js` `frameworkHookIdentity()` no longer crashes with `Cannot read properties of undefined (reading 'trim')` when settings.json contains a hook entry without a `command` string (e.g. agent-type hooks with `prompt` instead of `command`). Such hooks are now correctly classified as project-owned (not framework-owned). Surfaced by Foundry's `--adopt` where a pre-existing PR-quality-gate hook had `type: "agent"`. Workaround in Foundry v2.6.0 adoption: manual settings.json merge — no longer required at v2.6.1.
- `sync.js` `classifyForAdopt()` now honours `state.syncIgnore`, matching the regular `classifyFile()` path. Surfaced by Foundry where `--adopt` re-added FULL-only agents that had been explicitly pruned during STANDARD profile selection. Workaround in v2.6.0: post-adopt delete + re-add to syncIgnore — no longer required.
- `audit-runner.md` pre-flight no longer hard-halts when `docs/codebase-audit-framework.md` is missing. The doc is now treated as an OPTIONAL authoritative manual: if present, audit-runner reads it as the source of truth; if absent, audit-runner uses the canonical agent file as a self-contained playbook. Header description, Step-1 context loading, Pre-flight check, and the executor-vs-rewriter rule all updated to reflect optional-presence semantics. Surfaced by all three sibling-repo adoptions (none ship the manual); was the single hardest blocker for cross-repo audit-runner reuse.

**Adoption notes (for repos consuming this framework upgrade):**

- Consuming repos that adopted v2.6.0 and committed canonical-with-overlay agent files: re-running `node .claude-framework/sync.js` after the v2.6.1 update will reclassify `architect.md`, `pr-reviewer.md`, and `audit-runner.md` as needing update (because canonical now matches what their overlay-using copies already had). `.framework-new` siblings produced during the v2.6.0 adoption can now be deleted; their content is already absorbed into canonical v2.6.1.
- Sibling repos that adopted v2.6.0 with `customisedLocally: true` on the contaminated agents (and stripped the wrong-project content locally) should diff their local against the new canonical v2.6.1 — most local strips are now redundant.
- Two reference docs that previously shipped unfilled placeholders (`docs/frontend-design-principles.md`, `references/spec-review-directional-signals.md`) will re-substitute on next apply. Any local edits to those files survive (they're mode `sync`, not `adopt-only`); operators see a `.framework-new` sibling if local diverges from the canonical.
- Foundry's documented v2.6.0 workarounds (manual settings.json merge, manual delete of FULL-only agents post-adopt) are no longer needed at v2.6.1.

---

## 2.6.0 — 2026-05-24

**Highlights:** Phase A decoupling — Synthetos / Automation OS specifics removed from agent and reference content; portable skills (grill-me, zoom-out) now ship with the framework; new portable hook spec-creation-grill-nudge nudges Standard+ spec authors to invoke grill-me; Post-G2 Opus-switch checkpoint propagated to feature-coordinator; generic project-baseline-gate slot wired into finalisation-coordinator G4.

**Added:**
- `.claude/skills/grill-me/SKILL.md` and `.claude/skills/zoom-out/SKILL.md` — two portable skills ported from mattpocock/skills (MIT). Referenced by spec-coordinator (grill-me) and as a session-start prompt (zoom-out) in CLAUDE.md.
- `.claude/hooks/spec-creation-grill-nudge.js` (+ companion test) — UserPromptSubmit hook that nudges Claude to invoke grill-me when a prompt looks like a spec-creation request. Always exits 0; never blocks.
- `feature-coordinator.md` Post-G2 checkpoint — mandatory Opus-switch instruction before branch-level review pass.

**Changed:**
- `audit-runner.md` — two literal `AutomationOS` placeholders replaced with `{{PROJECT_NAME}}`. v2.2 claimed this fix; it had regressed.
- `docs/spec-context.md` — YAML body genericised; `accepted_primitives` and `convention_rejections` are now template placeholders. Synthetos-loaded content moved to automation-v1-local override.
- `docs/spec-authoring-checklist.md` — Synthetos-specific paths, anchors, function names, migration anecdotes, and named past-specs genericised. Synthetos-flavoured content moved to automation-v1-local override.
- `finalisation-coordinator.md` G4 step — extended with a generic project-baseline-gate slot (not the project-specific `verify-baseline-coverage.sh` path).
- `ADAPT.md` and `README.md` — agent count 22 → 24; FULL profile now lists mockup-coordinator and mockup-reviewer; smoke-check counts corrected to 4 / 11 / 24.
- `manifest.json` — frameworkVersion bumped 2.5.0 → 2.6.0; two literal skill entries added; settings.json now registers the spec-creation-grill-nudge hook.

**Adoption notes (for downstream repos consuming this framework):**
- Consuming repos that re-sync from v2.5.0 → v2.6.0 receive the genericised `docs/spec-context.md` and `docs/spec-authoring-checklist.md`. If a consuming repo had hand-customised either file, sync.js writes a `.framework-new` sibling and the operator merges manually. If a consuming repo had ALSO copied the old Synthetos-flavoured content as their own (rare — that content was not generic), they SHOULD move it to a repo-local override before applying the sync.
- The two new skills (grill-me, zoom-out) sync into `.claude/skills/`. New directory; sync.js will create it.
- The new hook (spec-creation-grill-nudge) appends to the `UserPromptSubmit` array via settings-merge. Existing UserPromptSubmit entries are preserved.

## 2.5.0 — 2026-05-18

**Highlights:** Mockup pipeline gets a self-correcting loop. New `mockup-reviewer` agent independently audits every `mockup-designer` round for ungrounded surfaces (phantom pages, invented nav, fictional component extensions) and operator overload (jargon, exposed internals, complexity-budget breaches). New `mockup-coordinator` inline playbook owns the pre-spec mockup loop — any operator phrase like "create mockups for X" now triggers a self-correcting designer ↔ reviewer loop before the prototype reaches the operator. `spec-coordinator`'s Step 5 reuses the same dispatch pattern.

**Added:**
- `.claude/agents/mockup-reviewer.md` — read-only audit agent for HTML prototypes. CLEAN / NEEDS_REWORK / NEEDS_DISCUSSION verdicts. Persists `mockup-review-log-round-N-*.md` per round for institutional design-governance lineage.
- `.claude/agents/mockup-coordinator.md` — inline playbook for the pre-spec mockup loop. Operator entry phrases (`create mockups for X`, `mock up the Y feature`, `mockup-coordinator: <brief>`) trigger the main session to adopt this playbook.

**Changed:**
- `.claude/agents/mockup-designer.md` — header now notes that the caller will run `mockup-reviewer` after every round, and that grounding (Step 0a) and simplification (Step 3 five-hard-rules) are the highest-leverage steps because that is where reviewer blocking findings concentrate.
- `.claude/agents/spec-coordinator.md` Step 5 — mockup loop now dispatches `mockup-designer` AND `mockup-reviewer` as a pair per round. Reuse-check skips Round 1 if `mockup-coordinator` already ran pre-spec; reuse-check keys off a machine-readable `status: complete` YAML marker in `mockup-log.md` (written by `mockup-coordinator` Step 8), not a prose heading — heading conventions are brittle to formatting drift and future coordinator additions.
- `manifest.json` — `frameworkVersion` bumped 2.4.0 → 2.5.0.

**Adoption notes (for downstream repos consuming this framework):**
- `.claude/agents/mockup-coordinator.md` and `.claude/agents/mockup-reviewer.md` are picked up automatically by the existing `.claude/agents/*.md` glob in `manifest.json`. No manifest change needed in consuming repos beyond running `sync.js` after the version bump.
- Consuming repos should add `mockup-coordinator` and `mockup-reviewer` rows to their own `CLAUDE.md` fleet table, add `create mockups for X` / `mock up the Y feature` / `mockup-coordinator: <brief>` to their common-invocations block, and add a "Mockup-request handling rule" near the inline-coordinator list forbidding the main session from dispatching `mockup-designer` alone. (`CLAUDE.md` itself is `doNotTouch` per manifest, so syncs do not overwrite the consuming repo's version — these edits are a manual one-time adoption step.)

**Design notes (incorporated during PR review on the consuming repo):**
- **No bypass.** `mockup-coordinator` explicitly forbids a "one-shot prototype, skip review" escape hatch. Every mockup request goes through the designer + reviewer pair. The failure mode this release was built to prevent (phantom pages, invented nav, jargon-heavy default surfaces) was demonstrated to enter the system under exactly the "just a quick mockup" framing — a bypass would reintroduce the regression path.
- **Canonical-registry phrasing.** `mockup-reviewer`'s route and sidebar verification refers to "the project's canonical route registry / sidebar registry" with current locations named but allowed to evolve. If a project's architecture splits routes into feature modules or moves sidebar definitions elsewhere, the reviewer follows the current convention. If no canonical registry exists at all, the reviewer returns `NEEDS_DISCUSSION` rather than guess. Consuming repos with different file paths can adopt without editing the reviewer.
- **Complexity-budget escape.** Caps in the reviewer's complexity-budget section are framed as strong defaults, NOT absolute rules. A brief or operator workflow may justify exceeding a cap (safety-critical payload screens, admin-only views per `docs/frontend-design-principles.md § When to break these rules`). Justified exceptions downgrade to 🟡 or 💭; unjustified breaches remain 🔴. The reviewer's job is to surface unjustified bloat, not to block legitimate complex workflows.
- **Single round structure, no duplicated control flow.** The previous draft of `spec-coordinator` Step 5 and `mockup-coordinator` Steps 5+7 carried two near-identical "dispatch designer, then reviewer, loop" descriptions — one for reviewer-driven NEEDS_REWORK, one for operator-driven feedback. Collapsed both to a single round structure: one round = one designer dispatch + one reviewer dispatch + one verdict. Both NEEDS_REWORK and operator-feedback simply start the next round with their respective input as "feedback for the designer." Same loop, same dispatch pair, same verdict gate. Removes divergent-prose risk and makes the playbook easier to follow.

---

## 2.4.0 — 2026-05-15

**Highlights:** propagates v2.3 (incident-commander) and v2.4 (governance overlay) work from the in-repo deployment to the portable bundle. The portable bundle had drifted: v2.2.0 had shipped without `reality-checker` (added to deployment), v2.3 (`incident-commander`) was deployed-only, and v2.4 governance overlay (intent intake, duplication/strategy check, capability registration verdict, compound learning feedback, lifecycle/ABCd in spec authoring) lived only in `.claude/`. This release brings the portable bundle to parity. Bundle is now ready to ship to other dev environments.

**Added:**
- `.claude/agents/reality-checker.md` — post-pr-reviewer evidence-demanding verifier (was deployed at 2.2 but never copied to portable).
- `.claude/agents/incident-commander.md` — production incident coordinator (inline playbook). SEV classification, timeline scribe, hotfix handoff, post-mortem drive. Distinct from hotfix.
- `docs/incident-response.md` — SEV matrix (four levels), on-call expectations, timeline-log format, post-mortem template.

**Changed:**
- `.claude/agents/feature-coordinator.md` — branch-level review pass §8.4 inserts `reality-checker` between `pr-reviewer` and `dual-reviewer`.
- `.claude/agents/spec-coordinator.md` — Step 3 "Intent intake" with classification branching (Trivial → `brief.md`, Standard+ → `intent.md`); Step 3a "Duplication / Strategy Check" hard-gate inserted between Step 3 and Step 4.
- `.claude/agents/finalisation-coordinator.md` — Step 6 emits combined Capability Registration verdict (eight valid strings); Step 7a "Compound Learning Feedback" inserted between Step 7 and Step 8.
- `docs/spec-authoring-checklist.md` — Section 12 (Lifecycle Declaration + ABCd Estimate templates) added.
- `docs/doc-sync.md` — `docs/capabilities.md` row carries the combined eight-string Capability Registration verdict; new row added for `docs/incident-response.md`.
- All other agent files refreshed from the deployed copy (placeholder substitutions applied; Vitest-specific test-runner references rolled back to the portable bundle's generic `npx tsx` idiom).

**Notes:**
- This release closes drift accumulated over v2.2 → v2.3 → v2.4. The portable bundle is now ready to ship to consuming repos. Adoption flow (`ADAPT.md`) and sync flow (`SYNC.md`) are unchanged.
- App-specific work (RLS migration guard, arch-guard, audit-prevention-gates baselines, `docs/capabilities.md` 10-cluster Asset Register content) is intentionally not portable and stays in the deployed tree only.

---

## 2.3.0 — 2026-05-14 — (backfilled heading) incident-commander agent + docs/incident-response.md

Deployed-only release in the origin repo: added the `incident-commander` agent (SEV classification, timeline scribe, hotfix handoff, post-mortem drive) and `docs/incident-response.md`. Never shipped to the portable bundle on its own — ported to portable in 2.4.0 (see the 2.4.0 entry above). Heading backfilled so sync.js changelog-excerpt ranges spanning this version terminate correctly.

---

## 2.2.0 — 2026-05-04

**Highlights:** adds sync infrastructure for one-command framework upgrade across consuming repos. Introduces `manifest.json` (file ownership declaration), `sync.js` (deterministic sync engine, ~300 lines JS with JSDoc types), and `SYNC.md` (guided upgrade prompt for Claude sessions). Migrates placeholder format from `[PROJECT_NAME]` to canonical `{{PROJECT_NAME}}` (double-brace) across all agent files and docs. ADAPT.md Phase 6 now records adoption state in `.claude/.framework-state.json` for future syncs.

**Breaking:** NONE (additive — old `[…]` placeholders are ignored by sync.js, but ADAPT.md authors must use `{{...}}` format from this version forward).

**Added:**
- `setup/portable/manifest.json` — declares which files are framework-managed, their sync mode, and substitution behaviour.
- `setup/portable/sync.js` — the sync engine: reads manifest, classifies per-file state (clean/customised/new), applies substitutions, writes framework updates or `.framework-new` siblings for manual merge. Atomic state write. Flags: `--adopt`, `--dry-run`, `--check`, `--strict`, `--doctor`, `--force`.
- `setup/portable/SYNC.md` — guided upgrade walkthrough prompt. Claude reads it to walk the operator through a framework upgrade (diff versions, dry-run, run sync, resolve merges, verify, commit).
- `setup/portable/tests/` — unit and end-to-end tests for the sync engine (helpers, walk/classify, substitution, settings-merge, flags, e2e-adopt, e2e-sync, e2e-merge).

**Changed:**
- `setup/portable/ADAPT.md` — Phase 2 substitution table updated to `{{...}}` format; Phase 6 added (record adoption state with `sync.js --adopt`).
- `setup/portable/README.md` — updated to describe submodule + sync model; mentions SYNC.md for upgrades; documents `{{...}}` placeholder format.
- Placeholder format migrated across 14 source files in `setup/portable/` (agent files, docs, references).
- `scripts/build-portable-framework.ts` — preflight scan now also detects legacy `[PROJECT_NAME]`-style placeholders as errors. `FORBIDDEN_STRINGS` blacklist expanded with `AutomationOS` (no-space variant) and case variants (`automation-os`, `automation_os`, `automation_v1`, `automationV1`, lowercase / uppercase Synthetos) to catch project-name leakage that the original list missed.
- `scripts/build-portable-framework.ts` — added `assertZipBinaryAvailable()` preflight before invoking `zip` on POSIX, with installation hints for apt / apk / brew so minimal containers fail with a clear error instead of cryptic ENOENT.
- `package.json` — added `test:portable-framework` script (`node --import tsx --test setup/portable/tests/*.test.ts`) and `.github/workflows/ci.yml` `portable_framework_tests` unconditional CI gate that runs the same script on every PR.

**Fixed:**
- Placeholder format consistency: all `[PROJECT_NAME]` occurrences in portable bundle migrated to `{{PROJECT_NAME}}`.
- Two `AutomationOS` (no-space variant) leaks in `setup/portable/.claude/agents/audit-runner.md` replaced with `{{PROJECT_NAME}}`. The forbidden-string scanner only caught `Automation OS` (with space) before this release; both variants are now caught.

**Notes:**
- Version authority is now explicit: `setup/portable/.claude/CHANGELOG.md` (this file) is canonical; `.claude/CHANGELOG.md` in any consuming repo is a deployment marker. See the deployment-marker file's § *Version authority — single source of truth* for the rules.

---

## 2.1.0 — 2026-05-04

**Highlights:** adds in-repo portable bundle infrastructure so the framework can be reproducibly exported to other repos. Adds the SessionStart hook for self-healing code-intelligence cache. Adds the `validate-setup` agent for ongoing framework health checks.

**Added:**
- `setup/portable/` — in-repo source of truth for the export bundle. Mirrors the agent fleet, hooks, and conventions with placeholders substituted at adoption time.
- `setup/portable/ADAPT.md` — master prompt for adapting the framework to a target repo (5-phase walkthrough + profile selector MINIMAL/STANDARD/FULL).
- `setup/portable/README.md` — drop-in instructions for target repos.
- `scripts/build-portable-framework.ts` — preflight-checks the bundle source (forbidden-string scan, conflict-marker scan, agent-count sanity, FRAMEWORK_VERSION ↔ CHANGELOG check) and produces a versioned zip at `dist/portable-claude-framework-v<VERSION>.zip`.
- `.claude/hooks/code-graph-freshness-check.js` — SessionStart hook. Detects a dead code-intelligence watcher at session start and rebuilds the cache plus respawns the watcher in-process. Steady-state cost <200ms; degrades gracefully when the cache build script is absent (so target repos that haven't adopted the cache infra still work).
- `.claude/agents/validate-setup.md` — read-only health-checker. Verifies every agent's referenced files exist, every context-pack anchor resolves in `architecture.md`, ADR index matches files on disk, FRAMEWORK_VERSION matches CHANGELOG, every hook is registered in settings.json. Use periodically to catch drift, or as a pre-merge gate for framework PRs.

**Changed:**
- `.claude/settings.json` — added `SessionStart` hook block for `code-graph-freshness-check`.
- `CLAUDE.md` § Code intelligence artifacts — three-tier refresh model (automatic via SessionStart hook / live during dev / manual). Adds explicit fallback for repos without the cache infra. Reframed as "(optional infra)" so target repos can adopt the cache later.

**Fixed:**
- `.claude/agents/hotfix.md` (internal) — replaced leftover `[PROJECT_NAME]` placeholder with the project name in the internal copy. Portable bundle's copy uses the canonical `{{PROJECT_NAME}}` format.

---

## 2.0.0 — 2026-05-03

**Highlights:** major refactor of the agent fleet for cross-repo portability. Adds ADR convention, mode-scoped context packs, hotfix path, and a stack-neutral templating layer (ADAPT.md). Extracts duplicated boilerplate to references/. Removes hardcoded JS-stack assumptions from the framework core.

**Breaking:**
- Agent file `Context Loading` blocks for `architect`, `pr-reviewer`, `spec-conformance`, `adversarial-reviewer` now reference architecture.md anchor IDs (e.g. `architecture.md#service-layer`) instead of section names. **If you renamed sections in your architecture.md, you must regenerate anchors via the script in tasks/builds/_example/ or run ADAPT.md again.**
- "Test gates are CI-only" boilerplate moved from individual agent files to `references/test-gate-policy.md`. Agents now reference the file. **No-op for operators**, but if you forked an agent file before this version, your fork still has the duplicated boilerplate.

**Added:**
- `.claude/agents/hotfix.md` — fast-path coordinator for time-critical fixes.
- `.claude/agents/context-pack-loader.md` — inline playbook that loads a mode-scoped slice of architecture.md instead of the full file.
- `.claude/agents/codebase-explainer.md` — produces human-facing onboarding tour at `docs/codebase-tour.md`.
- `docs/decisions/` — ADR convention with template + 5 inaugural ADRs.
- `docs/context-packs/` — five mode-scoped packs (review / implement / debug / handover / minimal).
- `references/test-gate-policy.md` — single source of truth for the "test gates are CI-only" rule.
- `references/spec-review-directional-signals.md` — extracted from spec-reviewer.md (was 70 lines of inline bullet lists).
- `references/verification-commands.md` — stack-specific lint/typecheck/test commands template (portable zip only).
- 54 HTML anchors in `architecture.md` so context-packs can splice precisely.
- `Status:` header convention for specs (see `docs/spec-authoring-checklist.md` § 11) — enables future archive sweeps.
- `last_reviewed_at` / `stale_after_days` / `stale_blocks_at_days` staleness gate in `docs/spec-context.md`. `spec-reviewer` enforces it before iteration 1.
- `.claude/FRAMEWORK_VERSION` + this CHANGELOG for cross-repo drift detection.

**Changed:**
- `KNOWLEDGE.md` preamble now distinguishes observations / gotchas / corrections (KNOWLEDGE) from architectural decisions (ADRs in `docs/decisions/`).
- `spec-reviewer.md` slimmed (575 → 509 lines) by extracting the directional-signals classifier.
- `architecture.md` cross-link from `references/project-map.md` softened to "optional infra" — no longer claims the cache always exists.

**Deprecated:**
- "Decision" category in KNOWLEDGE.md — write an ADR in `docs/decisions/` instead. Existing entries stay; new entries should not use this category.

**Removed:**
- `quality-checker-gpt.md` (legacy GPT pipeline doc) — moved to `docs/_archive/`.

**Fixed:**
- 9 fully-resolved sections in `tasks/todo.md` archived to `tasks/todo-archive/2026-Q2.md`.
- `replit.md` is now cross-linked from `CLAUDE.md` (was load-bearing but undocumented).
- `references/` directory presence treated as optional in `CLAUDE.md` and `architect.md` (was previously assumed always-present).

---

## 1.0.0 — predates this changelog

The original {{PROJECT_NAME}} internal setup. Agent fleet of 16, three-coordinator pipeline, ChatGPT review agents, doc-sync sweep, audit framework. No formal version tracking.
