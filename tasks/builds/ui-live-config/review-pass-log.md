# Branch-level review pass — ui-live-config

Agents: spec-conformance, adversarial-reviewer. (dual-reviewer skipped — Codex CLI unavailable.)

## spec-conformance — NON_CONFORMANT (1 directional) → fixed

| Finding | Disposition |
|---|---|
| **configSha threading half-wired** — `dispatchScan`/workflow accept `config_sha` but `handleScanPost` never passed it, so a post-edit scan used the branch tip (re-introducing the MEDIUM-3/ImplInv-6 race). | **Fixed** — added `currentConfigSha(configRepoDir)` (read-only, no token) to config-git; `handleScanPost` now reads the current committed config SHA and passes it as `configSha` (omitted when the dir isn't a git clone). Test: dispatch sends `config_sha`. |
| §3 contract / CLAUDE.md rewrite / ImplInv 1-9 | All conformant (verified against code, not just claimed). |

## adversarial-reviewer — HOLES_FOUND (1 confirmed HIGH, 1 likely HIGH, 4 MED/LOW) → triaged

| ID | Sev | Disposition |
|---|---|---|
| 2-A | HIGH (confirmed) | **Fixed** — `computeConfigRevert` now requires a full 40-hex SHA before any git call (rejects `HEAD`/`HEAD~1`/tags/`refs/...`/`../escape`). Closes the revspec-injection revert. Test added. |
| 5-A | HIGH (likely) | **Fixed** — added an in-memory brute-force throttle on `POST /api/config/step-up`: after 5 consecutive bad codes, lock for a doubling backoff (1→15 min cap); reset on success; `429 + Retry-After`. Test added. |
| 3-A | LOW | **Fixed** — `WorkspaceLockedError` → `503 + Retry-After` (was an opaque 500). |
| 4-A | LOW | **Fixed** — audit-trailer fields (actor/action/target) stripped of CR/LF before assembly (defence in depth over the schema's newline rejection). |
| 4-B | LOW | **Fixed** — env secrets normalised (empty/whitespace-only → undefined), so a whitespace token can't count as "present" or be handed to git. |
| 5-B | LOW | **Fixed** — `runGit` now has a 30s spawn timeout (kills a hung clone/fetch so it can't hold the config lock). |
| 2-B | MED | **Pushed back + routed.** The empty-`principalHash` path only exists when Basic Auth is *disabled* (local dev, single user); in production the upstream Basic Auth gate guarantees the header is present, so the principal is always real. The CSRF-nonce + signature + 5-min TTL are the operative bindings (as recorded in plan M2). Routed to todo as a hardening (require non-empty principal when auth enabled). Not a production hole. |
| 2-C | MED | **Pushed back + routed.** `GET /api/config/history` is Basic-Auth-gated; the server sets **no `Access-Control-Allow-Origin`**, so a cross-origin credentialed fetch reaches the server but the browser **blocks the response read** (same-origin policy). No actual cross-origin data leak; consistent with every other read route. Routed to todo as optional defence-in-depth (add an Origin check to reads). |

## Gates after fixes
typecheck ✓ · UI suite 286 + 2 new security tests ✓. Full G2 re-run next.
