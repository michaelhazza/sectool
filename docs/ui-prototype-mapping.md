# UI Prototype Mapping — audit-tool-v1

Maps each locked prototype screen to its React component and primary data source.

| Prototype file | Screen title | React component | Key data source |
|---|---|---|---|
| `prototypes/audit-tool-v1/index.html` | Portfolio Overview | `ui/src/screens/PortfolioOverview.tsx` | `/api/reports` (report list) + `/api/reports/:runId/report.json` (latest run) + `/api/history/trend` (trend data for sparklines and deltas) |
| `prototypes/audit-tool-v1/run-report.html` | What Needs Fixing | `ui/src/screens/RunReport.tsx` | `/api/reports/:runId/report.json` (findings in §8.1 priority order; filters by severity, surface, target, suppressed state) |
| `prototypes/audit-tool-v1/finding-detail.html` | Issue Detail | `ui/src/screens/FindingDetail.tsx` | `/api/reports/:runId/report.json` (single finding by fingerprint; severity trace, correlated evidence, copy-baseline + copy-fix-instructions clipboard affordances; Send-for-fixing DISABLED with P8 affordance) |
| `prototypes/audit-tool-v1/fixes.html` | Fix Progress | `ui/src/screens/Fixes.tsx` | `/api/fixes` (`reports/fixes.json`; 6-state pipeline; empty state "no fix requests yet"; P8 affordance notice) |
| `prototypes/audit-tool-v1/trends.html` | Progress Over Time | `ui/src/screens/Trends.tsx` | `/api/history/trend` (`history/trend.jsonl` as array; Recharts LineChart; per-target tab selector; explicit `unknown` rendering for partial/failed scanner dims) |
| `prototypes/audit-tool-v1/targets.html` | Sites and Safety | `ui/src/screens/TargetsSafety.tsx` | `/api/config/targets` + `/api/config/allowlist` + `/api/config/baseline` (read-only registry view; allowlist empty-state; baseline expiry countdowns; expired re-alert banner) |

`prototypes/audit-tool-v1/mobile-preview.html` is a desktop-only design utility (phone-frame gallery), not a product screen and not built.
