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
