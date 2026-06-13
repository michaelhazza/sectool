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

- (none yet)

## Corrections

- (none yet)
