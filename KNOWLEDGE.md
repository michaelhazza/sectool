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

## Pinned scanner versions (Dockerfile, P6-4)

Chosen at P6-4 Dockerfile authoring (2026-06-13). To bump a version, update
both the `ENV` block in `Dockerfile` and the table below, then rebuild and
push the GHCR image.

| Scanner      | Pinned version | Source |
|---|---|---|
| Semgrep      | 1.78.0         | `pip3 install semgrep==1.78.0` |
| gitleaks     | 8.18.4         | GitHub releases: `gitleaks/gitleaks` |
| osv-scanner  | 1.8.1          | GitHub releases: `google/osv-scanner` |
| OWASP ZAP    | 2.15.0         | GitHub releases: `zaproxy/zaproxy` |
| Nuclei       | 3.2.9          | GitHub releases: `projectdiscovery/nuclei` |

ZAP orchestration mode: Automation Framework YAML (`zap.sh -autorun -cmd -silent`
with YAML piped to stdin) — decided at P4-6. ZAP is installed to `/opt/zap/`
with a symlink at `/usr/local/bin/zap.sh`.

## Gotchas

- **Running `scripts/chatgpt-review.ts` (the review CLI) on this machine** (seen 2026-06-13 in chatgpt-pr-review): three environment blockers, all fixable without touching project source.
  1. `ajv` resolves to **v6** (transitive via eslint) but the CLI's validator uses `ajv-formats@3` + a draft schema that require **ajv v8** — `ajv.compile()` then throws at module-eval time as the opaque `Cannot read properties of undefined (reading 'code')`, which the CLI surfaces as if it were an OpenAI API error. Fix: `npm install ajv@^8 ajv-formats@^3 --no-save`. `ajv-formats` may also be missing entirely.
  2. tsx's bundled esbuild (0.28.1) can mismatch the extracted platform binary (0.21.5) → `Host version "0.28.1" does not match binary version "0.21.5"`. Fix: extract a matching `@esbuild/win32-x64@0.28.1` binary into an isolated dir and set `ESBUILD_BINARY_PATH` to it. Do NOT `npm install --force` the top-level platform pkg — it breaks vitest/vite, which want their nested 0.21.5.
  3. `gpt-5.5` at `effort: high` (and `medium` over a ~96k-token diff) returns **HTTP 520** (Cloudflare gateway timeout — synchronous Responses call exceeds the edge limit). For large PRs, split the diff into subsystem batches and/or drop to `effort: low`; add retry-on-520. A single 520 is transient and usually clears on retry.

## Corrections

- (none yet)
