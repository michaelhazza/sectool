# CLAUDE.md — audit-tool

Internal security audit tool for Breakout Solutions apps. Two scan surfaces:
static (SAST) over our source repos, and live (DAST) against **allowlisted
staging hosts only**, merged into one prioritized remediation report. This repo
IS the tool; the repos and staging URLs it scans are external targets declared
in a checked-in registry.

## Non-negotiable safety contract

**The surviving invariant (unchanged):** live scanning runs only against hosts
on the staging allowlist. There is no code path that scans a host absent from
the allowlist at scan time — an off-allowlist URL is a hard error before any
network I/O. CI re-validates via the existing preflight exactly as before.
Never weaken this invariant to make a test pass.

**What changed (2026-06-14 — ui-live-config build):** the allowlist is still
the sole authority at scan time, but *authoring* it moved from PR-review to
2FA-gated live edit through the dashboard. Every allowlist (and registry) change
is (a) schema-validated, (b) committed to git as the single source of truth
before it takes effect, with a structured audit trailer in the commit, and
(c) reflected in a hash-chained operational audit cache. Git is the
authoritative record; every change is revertable. The write path requires both
the shared dashboard credential AND a valid TOTP second factor
(`AUDIT_TOTP_SECRET`). The old "requires a PR review" and "no override path"
language is removed — it now contradicts the code.

Accepted residual risk: anyone holding both the dashboard password and the TOTP
device can authorise and scan any host on the internet. Compensating controls:
2FA gate, git history with audit trailers, hash-chained audit cache, and
`AUDIT_GIT_WRITE_TOKEN` as the protected high-value secret.

See `docs/superpowers/specs/2026-06-14-ui-live-config-editing-design.md` §3 for
the full contract and `docs/decisions/0007-live-config-editing.md` for the ADR.

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
