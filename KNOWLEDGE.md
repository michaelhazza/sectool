# KNOWLEDGE.md — audit-tool

Observations, gotchas, and corrections discovered while working in this repo.
Architectural decisions go to ADRs in `docs/decisions/`, not here.

## Observations

- Repo bootstrapped 2026-06-12 from the claude-code-framework submodule
  (`.claude-framework`, v2.19.0). `migrations/` and `scripts/` at the repo root
  are framework-managed (deployed by `sync.js`) and are excluded from the
  project's own eslint config.
- Framework substitutions recorded in `.claude/.framework-state.json`:
  PROJECT_NAME=audit-tool, COMPANY_NAME=Breakout Solutions.

## Gotchas

- (none yet)

## Corrections

- (none yet)
