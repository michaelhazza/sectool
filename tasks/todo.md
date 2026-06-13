# Todo

Active backlog. Items captured here are queued for work; resolved items move to `tasks/todo-archive/<quarter>.md` once a section is fully `[x]`.

## How items land here

- `triage-agent` captures ideas + bugs surfaced during dev sessions.
- Review agents (`pr-reviewer`, `spec-conformance`, `chatgpt-pr-review`, `chatgpt-spec-review`) route deferred / directional findings here.
- Audit runs (`audit-runner`) write deferred items here under a `## Deferred from <scope> audit — <YYYY-MM-DD>` section.

## Item shape

```markdown
- [ ] [origin:<source>:<YYYY-MM-DD>] [status:open|deferred|resolved] Short title
  - Why: one or two sentences.
  - Approach: one or two sentences.
  - Risk: one sentence (optional).
```

`origin` lets you grep the source of every backlog item. Examples: `origin:pr-1234-r2-f3`, `origin:setup-audit:2026-05-03`.

---

## Sections

### Framework adoption gaps

- [ ] [origin:validate-setup:2026-06-12] [status:open] Two origin-repo specs cited by agents are absent everywhere
  - Why: `.claude/agents/spec-coordinator.md` and `finalisation-coordinator.md` cite `tasks/builds/development-lifecycle-governance-upgrade/spec.md` and `docs/superpowers/specs/2026-04-30-dev-pipeline-coordinators-spec.md` as authoritative; neither exists in this repo or the framework submodule.
  - Approach: the governing tables (intent field rules, Lifecycle Declaration, ABCd) are already inlined in the agent files and `docs/spec-authoring-checklist.md`, so the pipeline runs without them; import from the origin repo or localise the citations when convenient.
  - Risk: low — citations are provenance pointers, not runtime dependencies.
- [ ] [origin:validate-setup:2026-06-12] [status:open] doc-sync coverage gaps
  - Why: `references/verification-commands.md`, `references/local-override-convention.md`, `docs/frontend-design-examples.md`, `docs/mobile-capability-principles.md`, `docs/spec-authoring-checklist.md` are neither in the `docs/doc-sync.md` table nor explicitly excluded.
  - Approach: add rows or exclusions to `docs/doc-sync.md` during the first finalisation pass.
- [ ] [origin:validate-setup:2026-06-12] [status:open] Author `architecture.md` so context-pack anchors resolve
  - Why: all 5 context packs reference `architecture.md` anchors; the doc doesn't exist yet (fresh adoption).
  - Approach: author after audit-tool v1 lands its real architecture; anchor IDs per framework convention.

## Spec Review deferred items

### audit-tool-v1 (2026-06-13)

- [ ] [origin:chatgpt-spec-review-OAI-SPEC-003:2026-06-13] [status:deferred] [user] TrendHistory `unknown` partial-run status field — where does `unknown` live? — operator product call needed
  - Why: §6.5 `TrendHistory` (`history/trend.jsonl`) promises a visible `unknown` partial-run status on the Trends UI screen (§5.2) and a guardrail test, but the record shape only defines counts (`new`/`fixed`/`persisting`/`bySeverity`) with no field to store `unknown`. Implementers can't tell whether `unknown` is target-level, scanner-family-level, or both.
  - Approach: operator decides the shape, then the coordinator pins it in §6.5 + the Trends screen contract. Recommended conservative default: a target-level `"status": "unknown"` on the per-run target record, OR a closed `scannerFamilyStatus` map if per-family granularity should surface on the Trends screen. Left UNAPPLIED pending the operator call because it shapes visible Trends-screen rendering of partial runs.
  - Risk: medium — a partial scanner failure could otherwise render as clean remediation on the Trends screen if the field is omitted or placed wrong.

- [ ] [origin:chatgpt-spec-review-OAI-SPEC-004:2026-06-13] [status:collected] [user] UI fix-write endpoint (P8 "Send for fixing") has no HTTP/anti-CSRF contract — operator decision on the protection model
  - Why: §5.2/§5.3/§11 name a token-backed mutating localhost endpoint that spends the GitHub `issues:write` token, but never define its route, body, status codes, `Origin`/CORS posture, or CSRF protection. Binding to 127.0.0.1 does not stop a malicious site in the operator's browser from driving a cross-origin POST that spends the fix token. Left UNAPPLIED because it prescribes a new visible request/response contract the SPA must honour (the reviewer flagged operator_decision_required).
  - Approach (recommended conservative pin): require a per-process `X-Audit-CSRF` nonce minted at `audit ui` start + a same-origin `Origin: http://127.0.0.1:<port>` check on the mutating route; reject foreign/missing origin or missing/invalid nonce with 403 (and do NOT call `src/fix/github.ts`); never emit `Access-Control-Allow-Origin: *`. Acceptance: `src/ui/server.test.ts` cases per the reviewer's `acceptance_check`.
  - Risk: high — without it, any page the operator visits while `audit ui` is running could file GitHub issues on Breakout repos using the operator's fix token. NOT a §4 change (no live-engine path); a P8 implementation-contract decision.

- [ ] [origin:chatgpt-spec-review-OAI-SPEC-005:2026-06-13] [status:collected] [user] No secret/credential redaction boundary for reports, exports, fix packs, and GitHub issues — operator must set the evidence-retention policy
  - Why: findings, raw scanner output, source snippets, live response bodies/headers, SARIF/MD/HTML, fix packs, and CI artifacts are all first-class outputs, and gitleaks (§7.2) detects literal secrets. The spec requires only HTML-escaping (anti-XSS, §5.2) — it does not redact, so literal secrets, `Set-Cookie`/bearer tokens, and staging credentials get persisted and republished (including into externally-filed GitHub issues). Left UNAPPLIED because it introduces a new product capability that changes what evidence the operator sees and what is shared externally (an evidence-retention policy — reviewer flagged operator_decision_required).
  - Approach (recommended conservative default): redact gitleaks secret values, `Set-Cookie`/bearer-token values, and env-derived credentials to a stable hash/placeholder in every emitted artifact (`report.json`, Markdown, SARIF, HTML, stdout logs, remediation packs), retaining enough context for triage. Acceptance: a redaction fixture + `src/report/redaction.test.ts` (or benchmark harness) per the reviewer's `acceptance_check`.
  - Risk: high — a security tool currently re-exports the very secrets it finds into shareable artifacts and external issues.
