# Adversarial Security Review — audit-tool-v1 (post-build)
Reviewer: adversarial-reviewer (read-only). Verdict: HOLES_FOUND (2 confirmed, 4 likely).

| ID | Sev | Finding | File | Disposition |
|---|---|---|---|---|
| 4-A | high (confirmed) | Path traversal: scanner-emitted `ruleId` resolved into a doc path with no confinement → arbitrary file read leaked into GitHub issue body | `src/fix/pack.ts:42` | FIX — confine resolved path to RULES_DIR + validate ruleId charset |
| 2-A | blocking | Unbounded `readBody` on POST /api/fix → local DoS / event-loop starvation | `src/ui/server.ts:80` | FIX — cap at 64 KiB, 413 on exceed |
| 4-B | high (likely) | `AUDIT_GITHUB_READ_TOKEN` embedded in git clone URL → visible in process argv (/proc/cmdline) | `src/static/orchestrator.ts:84` | FIX — pass token via env/askpass, not URL arg |
| 5-A | high (likely) | Rate limiter acquires ONE token then ZAP/Nuclei subprocess makes thousands of requests ungated → aggregate-per-host invariant (§4.5) violated | `src/live/scanners/zap.ts:274`, `nuclei.ts:222` | FIX — pass per-host rate to the scanner's own rate-limit flag |
| 3-A | high (likely) | Concurrent POST /api/fix for same fingerprint → duplicate GitHub issues (search-before-create not atomic with create) | `src/ui/server.ts:330` | FIX — hold workspace lock across fileFixRequest+upsertFix (serialize) |
| 4-C | medium (confirm) | Cookie redaction regex (no `g`) only redacts the FIRST cookie pair → later values leak | `src/report/redaction.ts:98` | FIX — global/loop redaction |
| — | correctness (blocking on Windows) | gitleaks `--report-path /dev/stdout` is POSIX-only → fails on Windows, all runs partial | `src/static/scanners/gitleaks.ts:133` | FIX — temp file, cross-platform |
| 3-B | worth-confirming | Lock break TOCTOU (two callers breaking same stale lock) | `src/report/lock.ts:144` | defer (narrow window; advisory) |
| ZAP-YAML | worth-confirming | gate-valid URL interpolated into ZAP YAML could inject directives | `zap.ts:365` | harden — quote/escape the URL in YAML |
| pagination | advisory | findExistingIssue caps at per_page=100 | `github.ts` | defer (todo) |

§4 staging-only gate, the `AllowedTarget` brand, redaction boundary, CSRF/origin enforcement order, and `execFile` (no shell) usage were all reviewed and found INTACT. No tenant/RLS surface (N/A by design).
