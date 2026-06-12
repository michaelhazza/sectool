# CLAUDE.md — audit-tool

Internal security audit tool for Breakout Solutions apps. Two scan surfaces:
static (SAST) over our source repos, and live (DAST) against **allowlisted
staging hosts only**, merged into one prioritized remediation report. This repo
IS the tool; the repos and staging URLs it scans are external targets declared
in a checked-in registry.

## Non-negotiable safety contract

Live scanning runs ONLY against hosts on the checked-in staging allowlist.
There is no flag, override, or config path that targets a non-allowlisted
host — an off-allowlist URL is a hard error before any request is sent. Never
weaken this to make a test pass. See the spec for the full contract.

## Stack

- Node 20+ / TypeScript, ESM, npm
- AST rule engine: ts-morph / TypeScript compiler API; pattern rules: Semgrep YAML
- Shelled-out scanners (version-pinned in Dockerfile): Semgrep, gitleaks,
  osv-scanner (static); OWASP ZAP, Nuclei (live)
- Schemas: Zod; tests: Vitest; lint: eslint + typescript-eslint

## Verification commands

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run test:unit   # vitest run
npm run build       # tsc -p tsconfig.build.json
npm run benchmark   # (once built) recall/precision benchmark — exits non-zero on failure
```

All four base gates must be green before any commit is considered done.

## Task management

This repo uses the claude-code-framework (submodule at `.claude-framework`,
deployed to `.claude/` via `node .claude-framework/sync.js`). Conventions:

- `tasks/current-focus.md` — single-build concurrency lock (`**Status:**` line is canonical)
- `tasks/builds/<slug>/` — per-build artifacts (intent, spec handoff, progress)
- `tasks/todo.md` — backlog; `tasks/lessons.md` — after-action notes
- `KNOWLEDGE.md` — durable observations/gotchas; ADRs in `docs/decisions/`
- Agent fleet in `.claude/agents/`; coordinators (`spec-coordinator`,
  `feature-coordinator`) run INLINE in the main session, never as sub-agents

## Repo layout notes

- `migrations/` and `scripts/` at the repo root are framework-managed
  (deployed by sync.js) and excluded from this project's eslint config.
- Project source lives under `src/`; fixtures/benchmark corpus under
  `benchmark/` (created during the build).

## Task classification

Trivial: single-file obvious change → implement directly, no pipeline.
Standard: small feature → intent.md + spec, mockups optional.
Significant/Major: full pipeline (spec → plan → build → review).
