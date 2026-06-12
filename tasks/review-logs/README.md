# Review Logs

Persistence directory for the read-only review agents. Every invocation that produces a verdict writes a log file here.

## Filename convention

`<agent-slug>-log-<task-or-spec-slug>[-<chunk>]-<ISO8601-timestamp>.md`

Examples:
- `spec-conformance-log-feature-x-2026-05-04T10-15-23Z.md`
- `pr-reviewer-log-pr-123-2026-05-04T11-00-00Z.md`
- `dual-reviewer-log-feature-x-2026-05-04T11-30-12Z.md`
- `chatgpt-pr-review-log-pr-123-2026-05-04T12-45-00Z.md`

`Z` (Zulu) timestamp suffix is required for sortability.

## Per-agent contracts

Each review agent writes a log with a specific shape. The full contract per agent is in the agent's own definition file at `.claude/agents/<name>.md`. Common fields:

- **Verdict** — one of `APPROVED`, `CHANGES_REQUESTED`, `NEEDS_DISCUSSION`, `CONFORMANT_AFTER_FIXES`, `NON_CONFORMANT`, `SKIPPED`. Specific values depend on the agent.
- **Findings** — bullet list, each with severity / category / file / line / recommendation.
- **Routing** — what was auto-fixed, what was routed to `tasks/todo.md`, what was logged for human-only triage.

## Verdict regex

The orchestrators (`feature-coordinator`, `finalisation-coordinator`) parse log files using the per-agent verdict regex declared in the agent's file. Don't rename verdict tokens without updating the agent definition.

## Final Summary fields

Finalisation agents (`chatgpt-pr-review`, `chatgpt-spec-review`) include a `## Final Summary` block listing doc-sync verdicts. See `docs/doc-sync.md` § Final Summary fields for the exact field list.

## Cleanup

Logs are append-only. Don't delete logs. If a directory grows large, archive to `tasks/review-logs-archive/<quarter>/` rather than deleting.
