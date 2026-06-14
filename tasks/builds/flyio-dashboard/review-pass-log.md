# Branch-level review pass — flyio-dashboard

Run after build, before finalisation. Agents: spec-conformance, adversarial-reviewer.
(dual-reviewer skipped — local Codex CLI unavailable; noted per feature-coordinator policy.)

## spec-conformance — NON_CONFORMANT → fixed

| Finding | Disposition |
|---|---|
| RunAScan repo dropdown read `config.repoTargets`, but `/api/config/targets` served raw `targets.json` (key `repos`) → dropdown always empty, scan button never enables. Pre-existing TargetsSafety screen had the same latent bug (masked by `?? []`). | **Fixed** — `/api/config/targets` now projects to the declared `TargetsConfig` shape (`repoTargets`/`stagingTargets` of `TargetRegistryEntry`), which also drops the `auth`/`rateLimit` detail from the response (less exposure). RunAScan optional-chaining hardened. Test updated. |

## adversarial-reviewer — HOLES_FOUND (2 confirmed, 3 likely) → triaged

| ID | Sev | Disposition |
|---|---|---|
| 2-A | confirmed | **Fixed** — bearer compare replaced pad + non-constant-time `&& providedToken === uploadToken` with length-check-then-`timingSafeEqual` (reviewer's "just remove the &&" rejected — it handled the length-mismatch case). |
| 4-C | confirmed | **Fixed** — `/api/scan` now requires the submitted `stagingUrl` to exactly match (URL.href-normalised) the registered target URL, closing the allowlisted-host/unregistered-sub-path bypass. preflight matched hostname only. New test: sub-path → 400, no dispatch. |
| 3-A | likely | **Fixed** — added an authoritative `runIdExistsOnVolume` dedup INSIDE the serialized write critical section for ALL triggers, closing the on-demand concurrent-upload TOCTOU (two same-jobId POSTs both passed pre-lock verifyOnDemand → last-rename-wins). New test: runId dir exists → 409 on on-demand. |
| 2-B | likely | **Fixed** — `/api/upload` Basic-Auth exemption scoped to POST; non-POST now goes through Basic Auth (was: any method bypassed to a 404). Tests updated. |
| 5-A | likely | **Fixed** — `server.requestTimeout=60s` + `headersTimeout=15s` to bound slow-loris on the (authenticated) upload route. |
| 6-A | worth-confirming | **Fixed (defense-in-depth)** — GET `/api/reports/:runId` now validates the segment against RUN_ID_RE before `resolve()`, parity with the write path. New test. |
| 2-C | worth-confirming | **Rejected (by design)** — scan/upload secrets are runtime-checked, not startup-required (Plan gap 7 / ADR-0006: the read-only dashboard must serve during a secret rotation). Documented; not a hole (reviewer concurred). |
| 3-B | worth-confirming | **Deferred** — scan-jobs.jsonl unbounded growth. Matches spec §11 (retention deferred). Routed to tasks/todo.md. |

## Gates after fixes
lint ✓ · typecheck ✓ · build:server ✓ · build:client ✓ · test:unit 924/924 ✓
(+4 new safety regression tests: 4-C sub-path, 3-A in-lock dedup, 6-A read-route, 2-B method scoping)
benchmark — Docker-only locally (semgrep/gitleaks/osv binaries live in the scanner image); validated by CI's benchmark job.
