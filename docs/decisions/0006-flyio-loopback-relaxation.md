# ADR-0006: fly.io deployment relaxes loopback-only binding; compensated by Basic Auth + fly proxy + production fail-closed

**Status:** accepted
**Date:** 2026-06-14
**Domain:** deployment / auth
**Supersedes:** —
**Superseded by:** —

## Context

The v1 `startServer` implementation bound exclusively to `127.0.0.1` (loopback),
enforced by a hardcoded `server.listen(port, '127.0.0.1', …)` call in
`src/ui/server.ts`. This was an intentional "never bind 0.0.0.0" invariant: the
UI server was designed to be reached only through a local reverse proxy or
directly by the developer.

The fly.io deployment model requires the container to bind on `0.0.0.0` so that
fly's TLS-terminating proxy can reach the server on its internal port (4173).
fly does not support loopback-only binding from inside the container because the
proxy lives outside the container network namespace.

The flyio-dashboard build (spec `docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md`,
chunks C1–C9) needed to relax this invariant for the fly.io case while preserving
local-dev loopback behavior. Plan gap 7 additionally surfaced a decision about
which secrets belong to the production fail-closed startup set versus being
runtime-checked.

## Decision

We will relax the loopback-only binding invariant **for the fly.io deployment
only**, compensated by three controls:

1. **Basic Auth gate** (`src/ui/auth.ts`): every request (except `GET /healthz`)
   requires HTTP Basic Auth when `AUDIT_BASIC_AUTH_USER`/`PASS` are set OR when
   `isProduction` is true (`FLY_APP_NAME` set or `REQUIRE_AUTH=true`). Basic Auth
   is enforced via `crypto.timingSafeEqual`.

2. **fly proxy TLS termination**: fly.io terminates TLS at the edge
   (`force_https = true` in `fly.toml`). The container sees only traffic that has
   already been authenticated by the fly proxy. The internal port (4173) is not
   directly internet-reachable.

3. **Production fail-closed startup** (`assertProductionConfig` in
   `src/ui/env.ts`): when `isProduction` is true, a missing `AUDIT_BASIC_AUTH_USER`,
   `AUDIT_BASIC_AUTH_PASS`, `ALLOWED_ORIGIN`, or `BIND_HOST` is a hard startup
   failure — the server refuses to bind and the fly health check (`GET /healthz`)
   never passes. This ensures a misconfigured deploy is immediately visible rather
   than serving unauthenticated traffic.

`BIND_HOST` is controlled by the deployment environment, not the caller. In
`fly.toml [env]` it is set to `0.0.0.0`; local dev defaults to `127.0.0.1`.

### Plan gap 7 — runtime-checked vs startup-required secrets

The production fail-closed startup set is intentionally narrow:
`AUDIT_BASIC_AUTH_USER`, `AUDIT_BASIC_AUTH_PASS`, `ALLOWED_ORIGIN`, `BIND_HOST`.

The remaining secrets (`AUDIT_GH_DISPATCH_TOKEN`, `AUDIT_WORKFLOW_REPO`,
`AUDIT_UPLOAD_TOKEN`) are **runtime-checked, not startup-required.** Rationale:
the read-only dashboard (report history, scan-job list) should remain available
during a secret rotation for scan/upload credentials. Missing a dispatch or upload
token degrades gracefully: `/api/scan` returns `502` when clicked (missing
`AUDIT_GH_DISPATCH_TOKEN`); `/api/upload` returns `401` to CI (missing
`AUDIT_UPLOAD_TOKEN`). Neither causes unauthenticated access to the dashboard.

This creates a **silent-degradation mode**: the dashboard can be fully up,
authenticated, and healthy-check-passing while structurally unable to dispatch
scans or ingest uploads. Operators MUST run the post-deploy smoke check described
in `docs/deployment.md` after any deploy or secret rotation to catch this.

We explicitly do NOT promote scan/upload secrets into the startup fail-closed set
without operator sign-off, because doing so would prevent a valid "rotate upload
token while dashboard stays up" workflow.

## Consequences

- **Positive:**
  - The dashboard is deployable on fly.io with standard fly proxy TLS termination.
  - A misconfigured Basic Auth or `ALLOWED_ORIGIN` is caught at startup (health
    check fails loudly) rather than silently serving unauthenticated traffic.
  - Local-dev behavior is unchanged: `BIND_HOST` defaults to `127.0.0.1`, auth
    gate is disabled when credentials are absent and `isProduction` is false.
  - Secret rotation for scan/upload credentials does not require a coordinated
    deploy + restart (the dashboard stays up during rotation).

- **Negative:**
  - The container binds on `0.0.0.0` in production, which is a wider surface than
    the previous loopback-only stance. Mitigation is the fly proxy boundary, but
    this is a conscious relaxation of a previously hard invariant.
  - The silent-degradation mode for scan/upload secrets requires an operational
    discipline (the post-deploy smoke check) that was not needed in v1. If the
    smoke check is skipped, a missing token may go undetected until an operator
    notices no new reports appearing.

- **Neutral:**
  - `BIND_HOST` is now an explicit env var rather than a hardcoded constant,
    which adds a configuration surface that must be documented and set correctly.

## Alternatives considered

- **Keep loopback-only; use a sidecar proxy inside the fly machine.** Rejected —
  adds operational complexity (two processes, sidecar config) with no security
  benefit over the fly proxy TLS termination already provided.
- **Put all secrets in the startup fail-closed set.** Rejected — prevents the
  "rotate upload token without downtime" workflow and is unnecessary for
  availability: a missing dispatch/upload token degrades functionality without
  exposing unauthenticated access.
- **No Basic Auth; rely on fly proxy network isolation alone.** Rejected — the
  spec (§5.1) requires Basic Auth as an explicit access gate, not only network
  isolation.

## When to revisit

- If fly.io adds support for a non-0.0.0.0 internal binding that still works
  with the fly proxy (e.g. a named unix socket), re-evaluate whether 0.0.0.0 is
  still needed.
- If the silent-degradation mode causes repeated operational incidents (missed
  smoke checks → invisible upload failures), consider promoting `AUDIT_UPLOAD_TOKEN`
  or `AUDIT_GH_DISPATCH_TOKEN` into the startup fail-closed set with operator
  sign-off.
- If the dashboard is ever exposed to untrusted users (currently single shared
  credential, internal operator only), the Basic Auth model should be replaced
  with a proper IdP integration.

## References

- Spec: `docs/superpowers/specs/2026-06-14-flyio-dashboard-deployment-design.md` §5.1, §5.3
- Plan: `tasks/builds/flyio-dashboard/plan.md` (Plan gap 7, system invariant 5)
- Implementation: `src/ui/auth.ts`, `src/ui/env.ts` (`assertProductionConfig`), `fly.toml`
- Deployment guide: `docs/deployment.md`
