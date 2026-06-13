# Spec Review — Iteration 2 Log — audit-tool-v1

**Spec:** `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md` (post iteration-1 commit 220f577)
**Codex:** v0.125.0, gpt-5.5, read-only sandbox. Verdict: CHANGES_REQUESTED. 14 findings.

Most of iteration 2's findings are second-order: Codex reacting to iteration-1's own edits (good — that is what a second pass is for). All 14 classified mechanical (consistency/contract/clarity); none matched a directional signal; zero AUTO-DECIDED.

---

## Adjudication (Codex findings 1–14)

### [ACCEPT] #1 §5.1 — scan-live resolution self-contradiction (mechanical; refines iter-1 #4)
My iter-1 wording said "must match an enabled entry" then "no-entry runs passive" — mutually exclusive. Fix: simplified to **registry-required in v1** — host must pass the allowlist gate AND resolve to an enabled `stagingTargets[]` entry; no-entry = named `UnregisteredTargetError`, not an ad-hoc scan. Dissolves #1 and #7. Ad-hoc scanning deferred (§13).

### [ACCEPT] #2 §4.2 — Allowlist shape inconsistency (mechanical; pre-existing)
§4.2 said "array of exact hostnames" but §6.3 is `{ hosts: [{host,owner,addedAt,note}] }`. Fix: §4.2 now references the §6.3 object as canonical; `LoadedAllowlist` (§4.10) brands that shape.

### [ACCEPT] #3 §12 — P6 exit loop vs v1 ship gate conflated (mechanical; refines iter-1 #10)
Fix: split into two named gates — (1) P6 core-quality exit loop (engine benchmark, may run with P7/P8 in flight); (2) final v1 ship gate (P6 loop green AND P7 AND P8 complete). No phase reordering.

### [ACCEPT] #4 §5.3 — `reopened` recovery undefined (mechanical; does NOT modify locked 6-state enum)
Fix: pinned `reopened` as non-terminal — re-enters via a new referencing PR (awaiting-review → merged-awaiting-verification → verified-fixed); tool reopens the issue with a comment via existing `issues:write`. Recovery is re-traversal of the existing six states; no enum value added (the locked set is untouched).

### [ACCEPT] #5 §5.3 — branch-existence signal needs scope the fix token lacks (mechanical; refines iter-1 #7)
My iter-1 `in-progress` signal included "branch `audit-fix/<fp>` exists", which needs `contents`/metadata scope — expanding the fix token's surface. Fix: dropped the branch signal; `in-progress` = issue-assigned OR draft-PR, both from `issues:read`+`pull_requests:read`. Keeps the token minimal-scope (the conservative move; no surface growth).

### [ACCEPT] #6 §6.1 — externalRefs persistence ambiguity (mechanical; pre-existing)
§6.1 lists `externalRefs` on Finding; §5.3 says not-persisted/rehydrated. Fix: added a "Field lifecycle" para — four fields (`severity`, `correlatedWith`, `externalRefs`, `note`) are report-stage-derived with empty defaults at the raw-scan stage; one Zod type, two stages, populated by `src/report/json.ts`. Same precedence as §6.5.

### [ACCEPT] #7 §7.3 — registry semantics vs live-check scope (mechanical; resolved by #1)
Dissolved by the registry-required rule (#1): every live target is registry-backed, so §7.3 "enabled staging targets" and `RunReport.targets[]` always have repo linkage. No unnamed-target semantics needed.

### [ACCEPT] #8 §14 — lock contract "above" dangling + underspecified (mechanical; refines iter-1 #8)
Fix: added a dedicated **Workspace lock** bullet at the top of §14 (single `reports/.lock`, create-exclusive `wx`, `WorkspaceLockedError` on contention, stale-after-2h, taken by all writers, read-only consumers don't take it); fixed the "(above)" reference; reconciled the later Concurrency bullet to point at it.

### [ACCEPT] #9 §6.2/§14 — run-status aggregation for active-cred failure (mechanical; pre-existing)
Fix: §14 Terminal-event now pins multi-target aggregation — a single target's cred failure marks THAT target failed and the overall run `partial` (escalates to run-level `failed` only when sole target / run-global fault). §6.2 wording reconciled to point at this rule.

### [ACCEPT] #10 §6 — SARIF mapping unspecified (mechanical; missing contract per checklist §3)
Fix: added §6.10 SARIF mapping (SARIF 2.1.0) — fingerprints/level+rank/physical+logical location/suppressions/relatedLocations/workItemUris, deterministic ordering. Producer `src/report/sarif.ts` (already in §11 inventory).

### [ACCEPT] #11 §5 — scanner timeout/pool config surface unhomed (mechanical)
Fix: pinned both as CLI flags (`--scanner-timeout` default 15, `--max-parallel-targets` default 2), explicitly NOT config fields in v1.

### [ACCEPT] #12 §5.2 — HTML export inline-JS security boundary (mechanical; output-encoding for in-scope feature)
Fix: added an evidence-content-safety clause — all evidence HTML-entity-escaped + inert, fixed build-time chart script over an escaped JSON island, no eval/innerHTML-of-evidence. A security tool must not turn its own export into an XSS vector.

### [ACCEPT] #13 §11 — rule-docs granularity vs wildcard live checks (mechanical)
Fix: pinned one doc per stable id — 11 custom rules + 3 scanner families + each enumerated `LIVE-*` checkId, with one family-level doc for `ZAP-P-*`/`ZAP-A-*`/`NUCLEI-*` (not one per upstream template).

### [ACCEPT] #14 §16 — KNOWLEDGE.md forward ref not in inventory (mechanical)
Fix: reworded §16 to mark `KNOWLEDGE.md` as an existing standing framework file (per CLAUDE.md), intentionally absent from the §11 deliverable inventory.

---

## Directional / ambiguous findings
None. Zero directional signals matched; zero AUTO-DECIDED items routed to tasks/todo.md.

## Cross-cascade integrity
- New deferred item (ad-hoc live scanning) cascaded into §13.
- New named errors `UnregisteredTargetError` / `WorkspaceLockedError` (errors, not files — no inventory entry needed).
- New §6.10 SARIF + §14 lock bullet; `src/report/sarif.ts` already covered by the §11 `src/report/{...}` row.
- §4.10 cross-reference verified to resolve (LoadedAllowlist = §4 item 10).
- Numeric-count grep re-run: 6 states/screens, 11 rules (7+4), 7 families, 4 report formats — all reconcile. §6 subsections renumber cleanly 6.1–6.10.

---

## Iteration 2 Summary

- Mechanical findings accepted:  14
- Mechanical findings rejected:  0
- Directional findings:          0
- Ambiguous findings:            0
- Reclassified → directional:    0
- Autonomous decisions (directional/ambiguous): 0
  - AUTO-REJECT (framing):    0
  - AUTO-REJECT (convention): 0
  - AUTO-ACCEPT (convention): 0
  - AUTO-DECIDED:             0
- Spec commit after iteration:   987b88d
