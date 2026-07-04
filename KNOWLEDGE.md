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

## Audit patterns (full audit, 2026-07-02)

### [2026-07-02] Pattern — two git-clone token channels diverged
The config-write path (`src/ui/config-git.ts`) deliberately supplies `AUDIT_GIT_WRITE_TOKEN` out-of-band via `GIT_ASKPASS` because spec §7 (HIGH-2) forbids `http.extraHeader` (the header value lands in git's argv). The static-scan clone path (`src/static/orchestrator.ts:90-91`) still uses `-c http.extraHeader=AUTHORIZATION: basic <base64>` for `AUDIT_GITHUB_READ_TOKEN`, placing the token in argv, and its comment wrongly claims the credential "never appears in the process argument list." When hardening one token channel, check every `git clone`/`git fetch` call — there are two, with different token-handling maturity.

### [2026-07-02] Pattern — allowlist invariant only guards the scanner URL, not the login pre-step
`assertAllowlisted`/`preflight` gate the scan target, but `src/live/auth.ts:establishSession` builds `loginUrl = target.url + auth.loginPath` by raw string concatenation and issues credential-bearing GET/POST via `fetch` without re-validating the resulting host against the allowlist. Any config field that becomes a network destination (loginPath, and by extension redirect-following in ZAP/Nuclei) is a second, ungated path out of the "no I/O to non-allowlisted host" invariant. Audit every raw `fetch`/scanner target for allowlist re-validation, not just the CLI entrypoint.

### [2026-07-02] Pattern — `z.string().url()` is not a transport allowlist
`gitUrl` (`src/schemas/targets.ts`) and any URL validated only with Zod `.url()` accept `ext::`, `file://`, `ssh://` etc. For values that reach `git clone` this is an RCE/file-read surface (`ext::` runs commands). URL schema fields that feed a subprocess must additionally pin the scheme (`https` only) and the clone must set `GIT_ALLOW_PROTOCOL`. Adding `--` before positional clone args (done 2026-07-02) blocks option injection but NOT malicious transports.

### [2026-07-02] Fixes applied on `audit/full-2026-07-02`
Three of the deferred audit findings were fixed at the schema/gate layer (unit-tested, all four gates green):
- **H1** — `gitUrl` now pinned to `https` via `HttpsGitUrlSchema` (`src/schemas/targets.ts`); `ext::`/`file://`/`ssh://` rejected at config-parse time (both config-load and the 2FA-gated config-write path parse through this schema).
- **M2** — `loginPath` constrained to a root-relative path (`RootRelativePathSchema`): must start with a single `/`, no `//` prefix, no backslash — so `establishSession`'s `target.url + loginPath` concat can never resolve to an off-allowlist host.
- **L1** — `assertAllowlisted` host match is now case-insensitive (`src/live/gate.ts`), closing a fail-closed correctness bug where a mixed-case allowlist entry never matched the (already-lowercased) URL host.
Still deferred (need Docker/integration verification or touch the clone token channel): M1 (read token in git argv → move to `GIT_ASKPASS`), M3 (ZAP `includePaths` regex over-match), L2 (repo-name charset in `mkdtemp`), L4 (unkeyed audit-cache hash-chain). See `tasks/todo.md` tag `origin:audit:full:2026-07-02`.

### [2026-07-04] Remaining four audit findings fixed on `audit/full-2026-07-02`
The four previously-deferred items are now fixed (unit-tested, all four gates green):
- **M1** — static-clone read token moved off argv into `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env (git 2.31+), so it's in `/proc/<pid>/environ` (uid-only) not `/proc/<pid>/cmdline` (world-readable). Env-building extracted to exported `cloneTokenEnv()` in `src/static/orchestrator.ts` and unit-tested. Chose GIT_CONFIG env over the `GIT_ASKPASS` `.cjs` helper the write path uses, to avoid a helper-file deployment dependency in the static-scan image. **Two git-clone token channels now exist and differ**: config-write uses GIT_ASKPASS, static-scan uses GIT_CONFIG env — both keep the token out of argv, but if you touch either, they are NOT the same mechanism.
  - **[2026-07-05] PR-review follow-up — `http.extraHeader` must be host-scoped, never global.** A bare `http.extraHeader` (via `-c` OR GIT_CONFIG env) is sent by git on EVERY request during the clone — i.e. to whatever host `gitUrl` names. The gitUrl schema allows any https host, so a global header would ship `AUDIT_GITHUB_READ_TOKEN` to a malicious registry `gitUrl` (`https://attacker.example/…`) — credential exfiltration. Fix: `cloneTokenEnv(token, gitUrl)` attaches the header only when `new URL(gitUrl).hostname === 'github.com'` AND URL-scopes it (`http.https://github.com/.extraHeader`). git's `--get-urlmatch` is host-component aware (not string-prefix), so `github.com.attacker.example` does not match. Lesson: any credential injected as an HTTP header for a subprocess that talks to a config-controlled URL must be scoped to the exact expected origin.
- **M3** — `buildZapAutomationYaml` regex-escapes `targetUrl` (new `escapeRegex`) before the trailing `.*`. `includePaths` is a Java regex, not a literal prefix; the escape stops `…com.*` matching `…comX.evil.net`. Unit-tested for shape; ZAP runtime interpretation still wants a Docker integration confirm.
- **L2** — `RepoSchema.name` constrained to `^[A-Za-z0-9._-]+$` (`RepoNameSchema`); `defaultAcquireRepo` also sanitizes the mkdtemp prefix. Only the repo name — staging/finding names use other schemas and legitimately contain spaces.
- **L4** — audit-cache chain link now `chainDigest()`: HMAC-SHA256 keyed by `AUDIT_CACHE_HMAC_SECRET` when set (real tamper-evidence), unkeyed sha256 fallback when absent (backward-compatible). Enabling it is a deployment step (set the fly secret) that invalidates verification of any pre-existing unkeyed chain — expected HMAC behaviour. Git stays the authority per spec §8.

### [2026-07-02] Gotcha — git-integration tests flake under full-suite parallelism on Windows
`src/ui/config-git.test.ts` and `config-write.test.ts` shell out to real `git clone`/`commit`/`push` against local temp bare repos. Under `vitest run` (full parallel suite) on Windows they fail intermittently with `Command failed: git clone … remote.git … working`; the failure count scales with concurrent load (observed 0 alone → 1 for the two suites → 14 in the full 1070-test run) — classic temp-dir/file-lock contention, not a code regression. `npx vitest run --no-file-parallelism` runs the full suite green (1070/1070). When these specific tests fail in a parallel run, re-run sequentially before treating it as a real failure.

**Root cause + fix (2026-07-04):** the failure is `EBUSY: resource busy or locked, rmdir` in the test *teardown* (`afterEach`/`afterAll`) — a just-exited git subprocess (or Windows Defender/indexer) still holds a handle on a `.git` file when `fs.rm` runs, so cleanup throws and vitest attributes it as a test failure even though every assertion passed. Fixed by passing `{ maxRetries: 10, retryDelay: 200 }` to the `rm`/`rmSync` teardown calls in `config-git.test.ts`, `config-write.test.ts`, and `orchestrator.integration.test.ts` (Node's built-in Windows-EBUSY retry). This does not touch any assertion. Linux CI never hit this (no such lock semantics).
