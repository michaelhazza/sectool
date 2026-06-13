# Spec Review Final Report

**Spec:** `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md`
**Spec commit at start:** `15a3adc` (working tree carried the session's earlier 6 fixes, uncommitted)
**Spec commit at finish:** `987b88d`
**Spec-context commit:** `20b224a`
**Iterations run:** 2 of 5
**Exit condition:** two-consecutive-mechanical-only
**Verdict:** READY_FOR_BUILD (2 iterations, 28 mechanical fixes applied, 1 finding rejected-as-already-handled, 0 directional, 0 AUTO-DECIDED)

---

## Iteration summary table

| # | Codex findings | Rubric findings | Accepted | Rejected | Auto-decided (framing) | Auto-decided (convention) | AUTO-DECIDED (best-judgment) |
|---|----|----|----|----|----|----|----|
| 1 | 15 | 0 (Codex covered the rubric classes) | 14 | 1 | 0 | 0 | none |
| 2 | 14 | 0 | 14 | 0 | 0 | 0 | none |

Both rounds mechanical-only (no directional/ambiguous/reclassified findings) → framing converged → stop before the iteration cap. Codex verdict was CHANGES_REQUESTED both rounds; every change requested was a mechanical consistency/contract fix, not a framing or scope objection.

---

## Mechanical changes applied

### Frontmatter
- `Last updated:` 2026-06-12 → 2026-06-13 (matched the 2026-06-13 amendment) [#1.15].

### §4 Safety contract (the non-negotiable chokepoint)
- §4.2 allowlist gate tightened: now requires `https:` + exact-hostname match + default port (443/empty); plaintext/other schemes and non-default ports (different service on same host) are hard `AllowlistViolationError`s [#1.5].
- §4.2 allowlist shape reconciled to the §6.3 `{ hosts: [...] }` object (was prose "array of exact hostnames"); §6.3 named canonical; `LoadedAllowlist` (§4.10) brands that shape [#2.2].

### §5 Architecture / CLI / UI
- §5 execution model: `audit ui` write-posture reconciled to the decided §5.2/§14 contract (read-only on scan state/config; one fix-request write; anchored on no-live-engine-import + issues:write-only, not a blanket no-write rule) [#1.1].
- §5 scanner timeout + pool surfaced as CLI flags `--scanner-timeout` (15) / `--max-parallel-targets` (2), explicitly not config fields [#2.11].
- §5.1 `scan-live --url` resolution pinned: registry-required in v1 (allowlist gate AND enabled `stagingTargets[]` entry; no-entry = `UnregisteredTargetError`; ad-hoc scanning deferred) [#1.4, #2.1, #2.7].
- §5.2 HTML export evidence-content safety: all evidence HTML-escaped + inert, fixed build-time chart script over an escaped JSON island, no eval/innerHTML-of-evidence (a security tool must not become its own XSS vector) [#2.12].
- §5.3 fix-request `in-progress` derivation pinned to read-scope-only signals (issue-assigned OR draft-PR); branch-enumeration dropped to keep the fix token minimal-scope [#1.7, #2.5].
- §5.3 `reopened` pinned non-terminal: re-enters the existing six states via a new referencing PR; tool reopens the issue via existing `issues:write`. No enum value added — the locked 6-state set is untouched [#2.4].

### §6 Contracts
- §6.1 `Finding`: added `note?` (expired-baseline re-alert); added a field-lifecycle paragraph distinguishing raw-scan vs report-stage (severity/correlatedWith/externalRefs/note are report-derived with empty defaults; one Zod type, two stages) [#1.11, #2.6].
- §6.2 `TargetRegistry`: completed the `form` auth contract (method/userField/passField/bodyType/sessionCarrier/successCheck + CSRF capture-replay); added a repo-acquisition contract (shallow depth-1 default-branch clone via read-only `AUDIT_GITHUB_READ_TOKEN`, commit SHA recorded; submodules/monorepo deferred); reconciled active-cred-failure wording to the §14 aggregation rule [#1.6, #1.12, #2.9].
- §6.8 NEW `scannerFamily` closed enum (= the 7 `source` values) + per-(target×family) completion semantics [#1.3].
- §6.9 NEW `RunReport` contract (the canonical report.json: findings/targets/meta.status/failures/scannerStatus/coverageGaps) — homes every run-level field referenced elsewhere; `src/schemas/report.ts` added to inventory [#1.2, #1.11].
- §6.10 NEW SARIF 2.1.0 mapping (fingerprints/level+rank/physical+logical location/suppressions/relatedLocations/workItemUris, deterministic) [#2.10].

### §8 Severity
- §8.1 added reachability + confidence input rules: reachability set at normalization from publicRoutes/middleware context, `unknown` is the neutral default; confidence = active→confirmed / passive→probable / static→probable-unless-correlated (live findings NOT unconditionally confirmed) [#1.13].

### §12 Phasing
- P7/P8 boundary clarified: all 6 screens render read-only in P7 (Fixes empty-state, "Send for fixing" disabled); P8 wires live data + the action endpoint [#1.9].
- Two distinct gates separated: P6 core-quality exit loop (engine, may run with P7/P8 in flight) vs final v1 ship gate (P6 loop green AND P7 AND P8) — remediation is a v1 goal so P8 gates are ship criteria [#1.10, #2.3].

### §13 Deferred items
- Added: non-default-port/non-https allowlist entries; submodule/monorepo static scanning; ad-hoc allowlist-only live scanning (all cascaded from the edits above).

### §14 Execution-safety
- NEW workspace-lock contract (single `reports/.lock`, create-exclusive, `WorkspaceLockedError`, stale-after-2h, all writers take it, read-only consumers don't) [#2.8].
- `reports/fixes.json` write contract: atomic tmp+rename serialised by the lock, fingerprint-keyed RMW convergence, GitHub-status self-heal on read [#1.8].
- Run-status aggregation pinned: a single target's fault (incl. active-cred failure) → that target `failed` + overall run `partial`; run-level `failed` only for run-global faults [#2.9].

### §15 Self-consistency
- Reconciled new counts: 6 contract schemas (+ fix.ts), 7 scanner families = 7 source values.

---

## Rejected findings

- **Iter 1 #14 — "Pinned scanner versions are deferred."** Rejected: already handled. The spec intentionally defers exact binary versions to P6 Dockerfile authoring (§16 open question, §13), sequenced *before* the P6 benchmark that depends on them; Codex itself called it "acceptable as a phase task." Not a defect. (For the human to confirm: this is the only finding dropped, and it was dropped because the spec already makes this decision explicitly — verify you are comfortable resolving binary versions at P6.)

---

## Directional and ambiguous findings (autonomously decided)

None. Across 29 distinct Codex findings over two rounds, zero matched a directional signal and zero required AUTO-DECIDED routing to `tasks/todo.md`. Every finding was a mechanical consistency/contract/clarity fix or (one) a reject-as-already-handled. This is consistent with the spec's stage: it had already passed an operator gate-check and a claude-spec-review first pass, so the remaining surface was mechanical tightening of contracts and cross-section consistency — exactly what this loop is for.

Note on the §4 safety contract: Codex's two safety-adjacent findings (#1.5 scheme/port hole; #2.12 HTML XSS) were both *tightenings* of an existing non-negotiable contract, not posture changes, so they were applied mechanically. Nothing in either round proposed weakening the staging-only allowlist contract; had it, it would have been AUTO-REJECTed against the spec-context `convention_rejections` block.

---

## Mechanically tight, but verify directionally

This spec is now mechanically tight against the rubric and against two rounds of Codex review. Every finding that surfaced was adjudicated. However:

- The review did not re-verify the framing assumptions. The spec's §3 framing (runtime_primary/e2e benchmark as the primary gate, pre-production, staging-only allowlist) was cross-checked against `docs/spec-context.md` and matched — but if the product context has shifted since 2026-06-12 (first agency onboarded, a new test category adopted), re-read §3, §1, and §4 yourself before calling this implementation-ready.
- The review did not catch directional findings Codex and the rubric did not see. Two of this loop's larger fixes (registry-required live scanning §5.1, the RunReport/SARIF contracts) are reasonable conservative resolutions, but they encode product decisions (no ad-hoc scanning in v1; SARIF field semantics) — confirm those match your intent.
- The review did not prescribe what to build next. P1..P8 sequencing and the activeScan-at-launch call (§16) remain operator decisions.

**Recommended next step:** read §1 (goals), §3 (framing), §4 (the non-negotiable safety contract), and §5.1/§6.9/§6.10 (the contracts most reshaped this loop) one more time, confirm they match your current intent, then start P1.
