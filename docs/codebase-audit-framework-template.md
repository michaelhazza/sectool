# {{PROJECT_NAME}} Codebase Audit Framework

> **TEMPLATE.** Scaffold your repo's `docs/codebase-audit-framework.md` from this file: fill the §2 context block, populate §4 Protected Files, add your repo-specific Layer 2 modules in §8, replace `{{...}}` placeholders, then delete this banner. When this doc ships in a repo, the `audit-runner` agent treats it as the authoritative operating manual.

## How to use this document

This is a runnable framework, not background reading. Treat each section as the source of truth for that step of an audit. The audit runs from the main Claude Code session, delegating reconnaissance to `Explore`, individual cleanup areas to focused subagents, and final review to the existing `pr-reviewer` / `spec-conformance` pipeline. Layer 1 is structural cleanup. Layer 2 is release-gate quality. Every audit run produces a durable log under `tasks/review-logs/` and updates `KNOWLEDGE.md` with patterns learnt.

---

## Scope Guard

**This framework is intentionally constrained. Resist expansion.**

Do not add new rules, modules, areas, or scoring systems unless **both** are true:

1. A real audit run exposed a concrete gap the existing rules and modules failed to catch.
2. That gap cannot be addressed by tightening an existing rule, module, or the §2 context block.

**Default action when in doubt: reuse an existing rule.** Every additional rule increases noise, dilutes attention on the rules that catch real failures, and pushes future agents toward checklist-following instead of judgement.

**Do not add:** more numbered rules, more scoring axes, more modules in either layer, more report-template fields. **Do add:** sharper triggers inside an existing rule, new §4 Protected Files entries as the codebase evolves, refreshed §2 facts when the stack changes, and `KNOWLEDGE.md` entries when an audit catches a recurring pattern. When tempted to expand, write a `KNOWLEDGE.md` entry instead.

---

## 1. How this framework is structured

**Layer 1 — Code Cleanup Audit.** Structural hygiene: dead code, duplicates, type consolidation, type strengthening, error handling, legacy paths, AI residue, circular dependencies, boundary violations, god files. Run on demand. Findings produce surgical, behaviour-preserving changes, gated by the Universal Rules.

**Layer 2 — Production Readiness Audit.** Release-gate concerns. Eight generic modules (security, performance, tests, docs, observability, dependencies, API/spec contracts, accessibility) plus your repo-specific modules (§8). Run before significant releases or after major feature phases.

**Three-pass execution applies to both layers.** Pass 1: findings only, no code changes. Pass 2: high-confidence fixes only, validated after each area. Pass 3: medium/low-confidence and architectural items routed to `tasks/todo.md` and the review pipeline.

**This framework defers to the existing review pipeline.** No fix lands without `pr-reviewer` having seen it.

---

## 2. {{PROJECT_NAME}} context block

Pre-fill from calibration recon. **Re-verify at the start of every audit run** — anything stale here silently mis-classifies safe vs protected files. Update in place when stack facts change and bump the framework version at the bottom of this doc.

| Item | Value |
|---|---|
| Repo | `{{REPO_NAME}}` |
| Package manager / module system | {{e.g. npm, ESM}} |
| Language / runtime | {{STACK_DESCRIPTION}} |
| Test framework + commands | {{e.g. Vitest; note which suites are CI-only}} |
| Lint / typecheck / build commands | {{per `references/verification-commands.md`}} |
| Layer model | {{e.g. routes → services → db, one-way only}} |
| Data-isolation posture | {{tenancy model, if any}} |
| Queue / background-job system | {{if any}} |
| Review-loop logs | `tasks/review-logs/<agent>-log-<slug>-<timestamp>.md` |
| Deferred backlog | `tasks/todo.md` — append-only, dated sections |
| CI gates | {{gate scripts / workflows — treat any gate failure as blocking}} |
| Test coverage posture | {{honest statement; constrains Rule 9 trust}} |

---

## 3. Universal Rules

These apply across both layers, every area, every fix. They override every default elsewhere in this document. Violating one is grounds to revert and escalate.

1. **Reconnaissance before changing.** Complete a recon pass (scope, out-of-scope, subagent plan, in-flight work the audit must not collide with) and record it in the audit report before any change.
2. **Git safety rails.** Clean working tree before starting; dedicated audit branch; commit per area; never force-push; never touch other branches' work.
3. **Three-pass execution.** Pass 1 findings → pass 2 high-confidence fixes → pass 3 routed items. Strict order; pass 2 does not start until pass 1 is complete across all in-scope areas.
4. **Behavioural preservation.** Every pass-2 fix is classified (behaviour-preserving vs behaviour-changing) before commit. Unclassifiable-with-confidence → pass 3.
5. **Diff review before every commit.** Read the full diff; every hunk must trace to a named finding.
6. **Validation after every area.** Run the §2 lint/typecheck/build (and targeted tests where they exist) after each area in pass 2; record exact commands and outcomes. No silent skips — a validation step that cannot run is a finding.
7. **Blast radius control.** Smallest viable units; never batch unrelated fixes into one commit; cap the per-area change size and stop when reached.
8. **Confidence scoring and justification.** Every finding carries severity, confidence, and a written justification. Low confidence never auto-fixes.
9. **Test coverage trust model.** Validation only protects what tests cover. Where coverage is sparse, downgrade fix confidence accordingly — the §2 coverage-posture row is the calibration input.
10. **Do not fight the framework.** Never restructure framework-convention patterns (ORM table definitions, route registration, DI wiring) even if they look redundant. List your named untouchables in §4.
11. **Config-driven and dynamic usage.** Code referenced indirectly (registries, string-keyed lookups, computed imports, reflection, config files) is in use even when static analysis says otherwise. Enumerate your registries in §4.
12. **Observability preservation.** Never remove logs, metrics, traces, or error reporting without verifying nothing external consumes them. When in doubt, pass 3.
13. **State, side-effect, and time-dependent awareness.** Changes touching persisted state, external side effects, clocks, or ordering are high-risk by default — pass 3 unless provably safe.
14. **Idempotency and retry safety.** Changes to anything that may execute more than once (jobs, queue consumers, webhook receivers, retries) must preserve dedup keys, idempotent writes, and terminal-state semantics.
15. **Parallel agent coordination.** Parallel subagents get disjoint file sets; shared files are serialised; each agent declares its files up front.
16. **Prevent the next occurrence.** Every finding proposes how to prevent the issue *class* (gate, lint rule, convention, KNOWLEDGE.md entry) — not just how to fix this instance.

---

## 4. Protected Files & Patterns ({{PROJECT_NAME}}-specific)

Populate at calibration; extend as the codebase evolves. Nothing on this list is deleted, renamed, or restructured by an audit without explicit operator instruction — regardless of what analysis tools report.

- **Registries and config-driven entry points:** {{e.g. action registries, job configs, provider registries — Rule 11 sources}}
- **Schema / migrations:** {{migration directories are append-only}}
- **CI gates and their baselines:** {{gate scripts, baseline files}}
- **Generated / auto-managed files:** {{lockfiles, codegen output}}
- **Framework-managed files:** `.claude/**` managed by the framework sync (see `manifest.json` in `.claude-framework/`)
- **Entry points:** {{server/client/worker entry files}}
- **Protected patterns (not files):** {{e.g. tenancy filters on queries, soft-delete predicates, permission middleware chains — patterns whose *removal anywhere* is a critical finding}}

**Behavioural rule:** when a finding touches a protected file or pattern, it is automatically pass 3 (`manual review required`), whatever its confidence.

---

## 5. Default Execution Order

When Layer 1 areas run sequentially, use this order — it minimises rework between areas.

| Step | Area | Reason |
|---|---|---|
| 1 | Dead code removal | Removes noise before any other analysis |
| 2 | Duplicate logic | Easier to spot after dead code is gone |
| 3 | Type definition consolidation | Consolidate before strengthening |
| 4 | Type strengthening | Types stable before error-handling review |
| 5 | Error handling audit | Stable types make error flow clearer |
| 6 | Legacy and dead path removal | Cleaner codebase reduces false positives |
| 7 | AI residue removal | Low-risk, high-signal cleanup |
| 8 | Circular dependency resolution | Easier after consolidation |
| 9 | Architectural boundary violations | Informed by earlier areas |
| 10 | God files | Reporting-only; runs last so the register reflects post-cleanup LOC |

Layer 2 modules are independent — run in any order or selectively. Run your repo-specific modules (§8) first: they cover the highest-blast-radius concerns.

---

## 6. Layer 1 — Code Cleanup Audit

Each area follows the same shape: **Objective → How to investigate → High-confidence fixes (pass 2) → What NOT to do.** Apply §4 Protected Files before acting on any tool output.

### Area 1 — Dead Code Removal

**Objective.** Remove code defined but never used. Dead-code tools produce false positives — every finding requires manual verification.

- Investigate: static analysis (e.g. `knip`, `depcheck`) as a *starting point*; grep for unreferenced exports cross-referenced against every §4 registry; commented-out blocks; unreachable env-gated branches (confirm intent via `git log -p`).
- High-confidence fixes: delete files confirmed unreferenced after checking registries, scripts, containers, and CI configs; remove unused internal (non-public, non-registry) exports; delete commented-out code; remove packages confirmed unused by tool + manual grep.
- NOT: anything on §4; code used only by tests (tests count); computed-path `import()` targets; entry points; anything named in a registry; declaration files. Manual grep beats tooling wherever the codebase is config-driven.

### Area 2 — Duplicate Logic

**Objective.** Consolidate duplication only where it genuinely reduces complexity. Some duplication is intentional — duplication beats coupling when the implementations may diverge, when abstracting requires a cross-domain import, or when the contexts have different change rates or owners.

- Investigate: structural-clone tooling (e.g. `jscpd`); focus on business logic, not framework boilerplate; near-duplicates differing in one parameter.
- High-confidence fixes: extract identical utilities into your shared layer where no domain boundary is crossed; parameterise obvious near-duplicates; consolidate repeated validation schemas.
- NOT: premature abstractions; consolidation across bounded contexts; breaking exports or signatures (→ `manual review required`); deduplicating framework-shaped boilerplate.

### Area 3 — Type Definition Consolidation

**Objective.** One canonical definition per domain type, in the layer both sides can import.

- Investigate: duplicate/near-duplicate interfaces across layers; drifted copies of the same shape; types redefined instead of imported.
- High-confidence fixes: merge exact duplicates into the shared location; re-point imports.
- NOT: merging types that are coincidentally identical but semantically distinct; widening a type to force a merge.

### Area 4 — Type Strengthening

**Objective.** Replace weak types (`any`, over-broad unions, stringly-typed fields) with precise ones.

- Investigate: `any`/`unknown` escapes, unvalidated casts, string fields that are really enums.
- High-confidence fixes: narrow types where all call sites already conform; add literal-union types for closed value sets.
- NOT: type changes that alter runtime behaviour (validation, serialisation); mass `strict` flag changes in one pass.

### Area 5 — Error Handling Audit

**Objective.** No silent failures. Every catch block either handles meaningfully, rethrows with context, or routes to a documented failure path.

- Investigate: empty catches; catch-and-log-only on write paths; fallback values masking failed lookups; fire-and-forget promises.
- High-confidence fixes: add context to rethrows; replace silent fallbacks with explicit errors on paths where callers can handle them.
- NOT: changing error *semantics* (4xx vs 5xx, retry vs dead-letter) without pass-3 review — that is behaviour change (Rule 4).

### Area 6 — Legacy and Dead Path Removal

**Objective.** Remove superseded implementations and migration shims whose sunset condition has passed.

- Investigate: parallel old/new implementations; feature flags permanently on/off; shims with expired sunset comments.
- High-confidence fixes: remove branches provably unreachable in every environment (config audit + `git log` confirmation).
- NOT: removing a "legacy" path still selected by any config, tenant, or environment; treating "looks old" as evidence.

### Area 7 — AI Residue Removal

**Objective.** Remove artefacts of AI-assisted development: redundant narrating comments, apology/TODO litter, describing-the-refactor comments (the commit message is the right home), copy-paste explanation blocks.

- High-confidence fixes: delete comments that restate the code; delete completed-refactor narration; normalise inconsistent boilerplate headers.
- NOT: deleting comments that carry constraints, invariants, or why-not-the-obvious-way rationale.

### Area 8 — Circular Dependency Resolution

**Objective.** Break import cycles that cause initialisation bugs or block refactors.

- Investigate: cycle-detection tooling (e.g. `madge`); runtime symptoms (undefined imports at module init).
- High-confidence fixes: extract the shared piece into a leaf module both sides import.
- NOT: dependency-inversion redesigns in pass 2 — architectural cycles route to pass 3.

### Area 9 — Architectural Boundary Violations

**Objective.** Enforce the §2 layer model (e.g. routes never touch the DB directly; one-way layer imports).

- Investigate: grep for forbidden import directions; check the CI gates that guard layering (if present) are actually running.
- High-confidence fixes: move a violating call behind the correct layer where an equivalent function already exists.
- NOT: creating new service functions wholesale in pass 2; weakening a gate to make a violation pass.

### Area 10 — God Files

**Objective.** Reporting-only pass. Maintain a register of oversized files (threshold: {{e.g. 800}} LOC) with a split recommendation each. Splits themselves are pass-3 items executed through the normal pipeline with `refactor-safely` discipline — never inline during an audit.

---

## 7. Layer 2 — Production Readiness Audit (generic modules)

Independently selectable; each follows the same three-pass structure as Layer 1.

### Module A — Security Review

Generic application security (repo-specific data-isolation concerns belong in a §8 module):

- Authentication and authorisation enforced at every API boundary, not just top-level routes.
- All user inputs validated through schemas before use; no raw request-body access.
- No hardcoded secrets, credentials, or tokens in source; cross-check the env manifest.
- Sensitive data (passwords, tokens, PII) excluded from all logging and tracing.
- Rate limiting on authentication and high-value endpoints.
- Explicit, restrictive CORS; security headers present; no `eval()`-class execution on untrusted input.
- Parameterised queries only — flag any raw SQL string interpolation.
- Webhook signature verification on every inbound provider; OAuth state validated on every callback.

**Release gate.** Any `critical` security finding blocks release. Fixes changing auth flows or API contracts are pass 3 and require full review before merge.

### Module B — Performance Review

- No N+1 query patterns (flag awaited queries inside loops); indexes on foreign keys and commonly filtered columns.
- No unbounded list queries — everything paginates or limits; long-running work in background jobs, not request handlers.
- No synchronous blocking in async paths; frontend bundle size within budget.

**Do not introduce proactively.** Caching, memoisation, batching, or new indexes only for a real, measured problem. Premature optimisation creates more debt than it removes.

### Module C — Test Coverage

- Critical business logic has *named* coverage — a test, a gate, or a documented `wont-test` rationale per critical path.
- Happy path plus at least one error path per public route; permission-sensitive paths have isolation coverage.
- Tests not so heavily mocked they cannot catch real regressions; no order-dependent tests; no unpinned time/randomness.
- Record a coverage assessment per audit (e.g. `gates only` → `comprehensive`) — it calibrates Rule 9 trust.

### Module D — Documentation Completeness

- Governance docs (CLAUDE.md, architecture doc, KNOWLEDGE.md) reflect current state — spot-check 5 architectural claims against code.
- Env vars documented; capabilities registry current; no docs referencing removed features; specs reflect what actually shipped.
- **Doc-code sync rule:** any code change invalidating a doc updates that doc in the same commit — this module verifies the rule was followed since the last audit.

### Module E — Observability and Operability

- Structured, parseable logging; health checks return meaningful status, not just HTTP 200.
- Key operations emit traces/metrics; errors carry enough context to diagnose without a debugger (tenant/run/job identifiers).
- No secrets or PII in logs; graceful shutdown implemented; queue depth and retry/dead-letter rates observable.
- **Preservation reminder:** Rule 12 applies — never remove existing telemetry without verifying nothing consumes it.

### Module F — Dependency and Supply Chain Risk

- No `critical`/`high` vulnerabilities on production paths; lockfile committed and intentional.
- No abandoned dependencies on critical paths; no duplicate major versions of heavy packages.
- **Auto-fix discipline:** dependency upgrades are never pass-2 fixes — even patch bumps can change runtime behaviour. `manual review required`, always.

### Module G — API and Spec Contract Preservation

- Documented endpoints implemented; nothing removed or path-changed without deprecation; request/response shapes match schemas.
- Job payload shapes, webhook contracts, and any plugin/tool registration names preserved — renames break external consumers silently.
- **Rule:** any fix changing a public contract is `manual review required` in pass 1, never auto-applied in pass 2 regardless of confidence.

### Module H — Accessibility (Frontend)

- Semantic HTML (buttons, labels, headings); keyboard access and logical tab order; visible focus indicators.
- ARIA where semantics fall short; WCAG AA contrast; no information conveyed by colour alone.
- Dynamic updates announced via `aria-live`; modals trap and restore focus; form errors associated with inputs.

---

## 8. Layer 2 — repo-specific modules (ADD YOURS HERE)

<!-- EXTENSION BLOCK: this section is intentionally yours. Add one module per
     high-blast-radius subsystem your repo has that the generic modules don't
     cover. Keep each module in the same shape: why it's its own module, an
     audit checklist, and a release-gate statement. Run these modules FIRST
     in a full audit. -->

| Module | Subsystem | Why it needs its own module |
|---|---|---|
| Module I ([EXAMPLE] — replace) | Row-level security / multi-tenancy | *Illustrative example from the origin project:* a fail-closed multi-layer tenancy architecture where a defect at any layer leaks tenant data. Its module verified every tenant-scoped table appeared in the RLS manifest, tenancy CI gates passed on the audit branch, and every new query carried the tenant filter. Any failure = `critical`, blocks release. |
| Module J… | {{your queue/job discipline, domain invariants, editorial rules, …}} | {{why generic modules don't cover it}} |

If your repo has no subsystem warranting a dedicated module yet, leave this section as the empty extension block — do not pad it (Scope Guard applies).

---

## 9. Audit Modes

| Mode | Scope | When | What runs |
|---|---|---|---|
| **Full Audit** | Whole codebase | Quarterly, pre-major-release, post-incident health check | All Layer 1 areas + selected Layer 2 modules (always the §8 repo-specific ones) |
| **Targeted Audit** | A named set of areas or modules | A specific concern is on the table (e.g. "a type-strengthening pass") | One or more Layer 1 areas, or one or more Layer 2 modules |
| **Hotspot Audit** | A single subsystem | A subsystem feels gnarly or recently shipped a defect | The relevant Layer 2 module(s) plus only the Layer 1 areas needed for that subsystem |

**Default to Hotspot unless you have a reason to go wider.** Most production failures are subsystem-shaped, not codebase-shaped. A weekly Hotspot pass on the riskiest subsystem beats a quarterly Full Audit nobody finishes.

---

## 10. Integration with the review pipeline and audit lifecycle

- Sequence: recon (`Explore`) → pass 1 findings → pass 2 fixes (validated per area) → `spec-conformance` (if spec-driven surfaces were touched) → `pr-reviewer` on the full audit branch (mandatory for any non-trivial audit) → pass 3 items routed to `tasks/todo.md`.
- Every run produces a durable report under `tasks/review-logs/` (findings, fixes, validation outcomes, deferred items) and appends prevention patterns to `KNOWLEDGE.md` (Rule 16).
- The audit framework does NOT replace the review pipeline, ship features, or change behaviour — behaviour changes discovered as necessary become normal backlog items.

---

*{{PROJECT_NAME}} Codebase Audit Framework v1.0 — calibrated {{DATE}} from the framework template. Update §2 and bump this version on stack changes; append a KNOWLEDGE.md entry for every pattern caught.*
