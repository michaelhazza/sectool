# Spec Review — Iteration 1 Log — audit-tool-v1

**Spec:** `docs/superpowers/specs/2026-06-12-audit-tool-v1-spec.md`
**Codex:** v0.125.0, model gpt-5.5, read-only sandbox. Verdict: CHANGES_REQUESTED. 15 findings.
(Codex emitted a trailing `failed to record rollout items` ERROR — a harmless session-rollout warning, not a review failure; full output captured.)

---

## Classification + adjudication (Codex findings 1–15)

### [ACCEPT] #1 §5 / §13 — Dashboard write-contract conflict (mechanical)
Classification: mechanical (consistency — stale absolute language vs decided contract). §5 said `audit ui` "performs no writes" and §13 said "v1 UI is read-only", both predating the 2026-06-13 amendment that made "Send for fixing" the sole outward network action (§5.2, §14). Fix applied: reconciled §5 and §13 to the already-decided §5.2/§14 contract (read-only on scan state/config; one fix-request write; no-live-engine-import + issues:write-only anchor).

### [ACCEPT] #2 §6 — Missing RunReport contract (mechanical / rubric: missing contract)
Classification: mechanical (checklist §3 — the report.json artifact crosses every output boundary but had no Contracts entry; all its fields were already named in prose). Fix applied: added §6.9 `RunReport` schema (runId/date/findings/targets/meta.status/failures/scannerStatus/coverageGaps) + `src/schemas/report.ts` cascaded into §11 inventory and §15 count.

### [ACCEPT] #3 §6.5 — Scanner-family taxonomy undefined (mechanical / rubric: load-bearing claim w/o mechanism)
Classification: mechanical (the family axis is already the §6.1 `source` enum; partial-run accounting referenced it without pinning). Fix applied: added §6.8 `scannerFamily` closed enum (= the 7 `source` values) + completion semantics; reconciled in §15.

### [ACCEPT] #4 §5.1 — scan-live --url resolution ambiguous (mechanical)
Classification: mechanical (contract clarification consistent with §4 + §6.2; not a scope/posture change). Fix applied: pinned the §5.1 row — URL host must pass the allowlist gate AND match an enabled `stagingTargets[]` entry for active/auth/rate-limit; allowlisted-but-unregistered host = passive-unauthenticated + coverage gap; off-allowlist = hard AllowlistViolationError.

### [ACCEPT] #5 §4.2 — Allowlist allows arbitrary scheme/port (mechanical — non-negotiable safety tightening)
Classification: mechanical. The §4 contract is NON-NEGOTIABLE and explicitly "structurally impossible to scan a non-allowlisted host"; gating on hostname only left a hole (`http://host:12345` = different service). Closing a hole in a non-negotiable safety contract is mechanical tightening, not a directional posture change, and is consistent with the spec's stated exact-match direction. Fix applied: §4.2 now requires https + hostname exact-match + default-port (443/empty); non-default ports + non-https deferred (§13).

### [ACCEPT] #6 §6.2 — DAST form-auth contract under-specified (mechanical / rubric: contract worked example)
Classification: mechanical (completes the already-chosen `form` kind; no new kind, no direction change). Fix applied: added method/userField/passField/bodyType/sessionCarrier/successCheck to the `form` auth block + prose pinning login-success definition and the single v1 CSRF handling (capture from pre-login GET, replay on POST).

### [ACCEPT] #7 §5.3 — Fix-request `in-progress` state unobservable (mechanical)
Classification: mechanical (pins the derivation signal for one already-locked state; does NOT touch the 6-state set fixed earlier this session). Fix applied: `in-progress` derivation pinned to read-scope-only signals (issue assigned OR draft PR references issue OR `audit-fix/<fingerprint>` branch exists).

### [ACCEPT] #8 §14 — fixes.json concurrency/atomicity missing (mechanical / checklist §10.3 — extends existing primitive)
Classification: mechanical (extends the existing atomic tmp+rename + `reports/.lock` model to fixes.json; no new primitive). Fix applied: added a §14 bullet — all fixes.json writers serialise under `reports/.lock`, read-modify-write, fingerprint-keyed convergence, GitHub-derived status self-heals on read.

### [ACCEPT] #9 §12 — P7/P8 boundary inconsistent (mechanical)
Classification: mechanical (the file inventory §11 already split P7=screens / P8=fix-action endpoint; §12 prose lagged). NOT moving any item between phases (which would be directional). Fix applied: §12 P7 row now states all 6 screens render read-only in P7 (Fixes empty-state, "Send for fixing" disabled); P8 wires live data + the action endpoint.

### [ACCEPT] #10 §12 — v1 ship criteria silent on P8 (mechanical)
Classification: mechanical (remediation is already a v1 goal §1.7 and P8 already in the roadmap; only the "does not ship without P7" line was stale). Fix applied: §12 note now requires P7 AND P8 for v1 ship, with P8's gates named.

### [ACCEPT] #11 §6.1 — Finding contract missing referenced fields (mechanical, folded into #2)
Classification: mechanical. Fix applied: added `note?` to the Finding example (expired-baseline re-alert); homed `occurrences?` (collision merge) on the finding; routed scanner-family status / failure metadata / coverage gaps to RunReport.meta + targets[] (§6.9).

### [ACCEPT] #12 §6.2 — Repo access contract under-specified (mechanical)
Classification: mechanical (pins the minimal decisions already implied by `localPath:null → shallow clone` + the `commit` field). Fix applied: added a "Repo acquisition contract" para — shallow `--depth 1` single-branch clone of default-branch HEAD via read-only `AUDIT_GITHUB_READ_TOKEN`, commit SHA recorded for reproducibility; submodules/monorepo deferred (§13).

### [ACCEPT] #13 §8.1 — Severity reachability/confidence inputs underdetermined (mechanical)
Classification: mechanical (pins how the modifier operands are set + makes `unknown` neutral; does not build new inference machinery). Fix applied: added a "Reachability inputs" para to §8.1 — reachability set at normalization from publicRoutes/middleware-chain context, `unknown` is the neutral default; confidence inputs pinned (active=confirmed, passive=probable, static=probable unless correlated → live findings NOT unconditionally confirmed).

### [REJECT] #14 §16 — Pinned scanner versions deferred (rejected)
Reason: already handled — the spec intentionally takes this position in §16 (resolved at P6 Dockerfile authoring, before P6 benchmark completion) and §13. Codex acknowledges it "is acceptable as a phase task". Not a defect; deferral is explicit and sequenced ahead of the benchmark that depends on it.

### [ACCEPT] #15 frontmatter — Metadata date inconsistent (mechanical)
Classification: mechanical. Fix applied: `Last updated:` 2026-06-12 → 2026-06-13.

---

## Directional / ambiguous findings
None. Every finding was either a consistency/contract mechanical fix or (one) a reject-as-already-handled. No directional signal matched; no AUTO-DECIDED items routed to tasks/todo.md.

## Cross-cascade integrity
- New file `src/schemas/report.ts` cascaded into §11 inventory + §15 count.
- New env var `AUDIT_GITHUB_READ_TOKEN` named at point of use (§6.2).
- New deferred items (non-default-port allowlist; submodules/monorepo) cascaded into §13.
- Removed review-process leakage ("Codex flagged…") from §6.9 prose.
- Numeric-count grep (checklist §8) re-run post-edit: all counts reconcile (6 states/tokens/pills/screens; 11 rules = 7+4; 7 families = 7 source values; 6 contract schemas + fix.ts).

---

## Iteration 1 Summary

- Mechanical findings accepted:  14
- Mechanical findings rejected:  1
- Directional findings:          0
- Ambiguous findings:            0
- Reclassified → directional:    0
- Autonomous decisions (directional/ambiguous): 0
  - AUTO-REJECT (framing):    0
  - AUTO-REJECT (convention): 0
  - AUTO-ACCEPT (convention): 0
  - AUTO-DECIDED:             0
- Spec commit after iteration:   <set after commit>
