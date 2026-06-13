# PR Review — audit-tool-v1 (correctness pass). Verdict: CHANGES_REQUESTED (3 blocking, 4 should-fix).

Auto-applied by reviewer (green): AUD-004 (live-confirmed modifier scoped to static findings, json.ts), AUD-005 (osv exit-1-on-findings, osv.ts).

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| AUD-001 | blocking | CLI passes an EMPTY ScannerMap + no probe deps → `audit run`/`scan-source`/`scan-live` produce empty reports; no scanner/probe runs in production (cli.test mocked scanRepos, hiding it) | FIX — wire real scanner adapters + probe runner into the CLI |
| AUD-002 | blocking | trend `fixed` cross-family masquerade: a prev fp counted fixed even if its family didn't complete this run (§6.5 violation) | FIX — family-attributed prev fingerprints |
| AUD-003 | blocking | ZAP exit-code-on-findings → successful scan with alerts marked family `failed` | FIX — read report on findings-present code, throw on tool-error |
| AUD-004 | blocking | live-confirmed §8.1 modifier wrongly applied to correlated live findings | DONE (reviewer auto-fix) |
| AUD-005 | blocking | osv exit-1-on-findings marks family failed | DONE (reviewer auto-fix) |
| AUD-006 | should-fix | process.exit inside withWorkspaceLock leaks reports/.lock | FIX — capture code, release, then exit |
| AUD-007 | should-fix | missing cross-family trend guardrail test | FIX — add test |
| AUD-008 | should-fix | missing live-confirmed surface-guard test | FIX — add test |
| AUD-009 | should-fix | findLatestReport lexicographic ordering | FIX — sort by parsed timestamp, ignore non-conforming dirs |
| AUD-010 | consider | doUi .then style | defer |

Severity modifier ORDER (§8.1) verified correct. correlate() idempotent with deriveReportFields.
