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

## CI design — two-job split (2026-06-14)

Root cause of broken CI: `ci.yml` ran its single job inside
`container: { image: ghcr.io/breakoutsolutions/audit-tool:latest }`, an image
that was never built or pushed (no image-publish workflow existed). Every run
failed at container startup. Additionally, `USER audit` + a hard `ENTRYPOINT`
in the Dockerfile broke `actions/checkout` and step execution inside a GHA job
container.

**Chosen fix — two-job model:**

1. **`gates` job** (`ubuntu-latest`, no container): `actions/checkout` +
   `actions/setup-node@v4` (Node 20) + `npm ci`, then runs `lint`,
   `typecheck`, `test:unit`, `build`, and `build:client`. No scanner binaries
   needed; these gates pass on the plain node runner.

2. **`benchmark` job** (`ubuntu-latest`, after `gates`): builds the scanner
   image from the repo `Dockerfile` (`docker build -t audit-tool:ci .`), then
   runs benchmark and self-scan via `docker run --rm audit-tool:ci <cmd>`. The
   image is always built from the current commit — no GHCR dependency.

**Dockerfile exec-wrapper:** replaced `ENTRYPOINT ["node", "dist/cli.js"]`
with a shell script (`docker-entrypoint.sh`) that passes `npm`, `node`, `sh`,
`bash`, and absolute-path commands through directly, and prepends
`node dist/cli.js` for bare CLI verbs. Also changed `useradd --shell
/bin/false` to `--shell /bin/sh` so npm/node can execute inside the container.

**weekly-audit.yml:** removed `container:` stanza; now runs `docker build`
then `docker run` with secrets passed via `--env`, and mounts `./reports` to
capture artifacts.

## fly.io dashboard deployment (2026-06-14)

### Two-image split

The repo ships two Docker images with entirely different roles:

- **`Dockerfile`** — the heavy scanner image used by CI only. Contains Semgrep,
  gitleaks, osv-scanner, OWASP ZAP, Nuclei, and their runtimes (Python, JRE).
  Never deployed to fly.io.
- **`Dockerfile.ui`** — a lightweight dashboard image (`node:20-bookworm-slim`).
  Contains only the compiled Node server (`dist/`), the SPA (`ui/dist/`), and
  checked-in config. No scanner binaries. This is what fly.io runs.

When updating scanner versions, update `Dockerfile` only. When updating the
dashboard server or UI, `Dockerfile.ui` rebuilds automatically on `fly deploy`.

### workflow_dispatch has no run id

GitHub's `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`
REST call returns **HTTP 204 with an empty body** — it does NOT return the run id
of the workflow run it creates. This is why a correlation nonce (`jobId`, a
32-hex random string minted by `/api/scan`) is passed as a workflow input and
echoed back by CI in the upload envelope. The server uses this `jobId` to bind
an upload back to the dispatch that triggered it (on-demand provenance, §4.1–§4.2).
Without this nonce, there would be no reliable way to correlate a CI upload with
the specific dashboard request that triggered it.

## Live-config feature: git-write token on the dashboard box (2026-06-14)

The ui-live-config build put `AUDIT_GIT_WRITE_TOKEN` (a fine-grained GitHub PAT,
`contents:write` on this repo only) on the fly.io dashboard machine. Git is the
config source of truth: the dashboard maintains a working clone of the repo at
`CONFIG_REPO_DIR` (`/data/repo` on the volume) and commits every config change
directly to `CONFIG_BRANCH`. The token never touches remote URLs, argv, or
`.git/config` — it is passed only via `GIT_ASKPASS` in a scoped spawn env (see
`src/ui/config-git.ts`). `AUDIT_GIT_WRITE_TOKEN` is the highest-value secret in
the deployment and must be treated accordingly.

## Corrections

- (none yet)
