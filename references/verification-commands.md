# Verification Commands (stack-specific template)

> Single source of truth for the lint / typecheck / build / targeted-test commands the agent fleet runs. Substitute the [PLACEHOLDERS] for your stack during framework adoption (see `ADAPT.md` § 3).

This file is referenced from `CLAUDE.md` § Verification Commands and from individual agent files (e.g. `hotfix.md` Step 7). When an agent says "run lint + typecheck + the targeted test," it consults this file for the actual commands.

The `references/test-gate-policy.md` companion file declares the policy ("test gates are CI-only — never run locally"); this file declares the *commands*.

---

## Stack template

Replace each `[PLACEHOLDER]` with the command for your stack. Delete rows that don't apply.

| Trigger | Command | Max auto-fix attempts |
|---------|---------|----------------------|
| Any code change | `[LINT_COMMAND]` | 3 |
| Any type-checked language change (TypeScript / Python / Rust / etc.) | `[TYPECHECK_COMMAND]` | 3 |
| Logic change in a tested area | Targeted run of the test file authored for THIS change | 2 |
| Schema / migration change | `[SCHEMA_VERIFY_COMMAND]` — verify migration file | 1 |
| Frontend / client change | `[BUILD_CLIENT_COMMAND]` | 2 |
| Backend / server change touching the build surface | `[BUILD_SERVER_COMMAND]` | 2 |

### Worked examples by stack

#### Node + TypeScript (Express / Vite / similar)

| Trigger | Command |
|---------|---------|
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Targeted test | `npx tsx <path-to-test>` (or `npx vitest run <path>`) |
| Schema | `npm run db:generate` |
| Client build | `npm run build:client` |
| Server build | `npm run build:server` |

#### Python (FastAPI / Django / similar)

| Trigger | Command |
|---------|---------|
| Lint | `ruff check .` |
| Typecheck | `mypy <package>` (or `pyright`) |
| Targeted test | `pytest <path-to-test>::<test_name>` |
| Schema | `alembic check` (or framework equivalent) |

#### Rust

| Trigger | Command |
|---------|---------|
| Lint | `cargo clippy --all-targets --all-features -- -D warnings` |
| Typecheck | `cargo check --all-targets --all-features` |
| Targeted test | `cargo test <test_name>` |

#### Go

| Trigger | Command |
|---------|---------|
| Lint | `golangci-lint run` |
| Typecheck | `go vet ./...` |
| Targeted test | `go test -run <TestName> ./<package>` |
| Build | `go build ./...` |

---

## Rules (stack-independent)

- Run the relevant checks, not all of them, unless the change spans client + server.
- If a check fails, fix the issue and re-run. Do not mark the task complete.
- After 3 failed fix attempts on the same check, STOP and escalate to the operator with: the exact error output, what was tried, your hypothesis for root cause.
- Never skip a failing check. Never suppress warnings to make a check pass. (Enforced by `config-protection.js` PreToolUse hook.)
- Test gates (whole-repo verification scripts) are CI-only. See `references/test-gate-policy.md`.

## Wiring this file to your project

1. Replace the `[PLACEHOLDERS]` in the *Stack template* table above with your project's commands. Delete rows that don't apply.
2. Optionally retain a worked-examples table for your stack as a quick reference; delete the others.
3. Cross-link from `CLAUDE.md` (or wherever you keep build discipline) — a one-line pointer is enough; don't duplicate the table.
4. When you add a new build / verify command (e.g. a new linter, a new test runner), update this file and bump `.claude/FRAMEWORK_VERSION` if you intend to propagate the change to other repos using this framework.
