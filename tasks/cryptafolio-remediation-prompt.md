# Claude Code prompt — Cryptafolio security remediation (validated subset)

> Context: An internal SAST/DAST audit tool scanned this repo and produced 598
> raw findings. A manual triage against the source confirmed that the large
> majority (missing-auth, tenant-isolation, WS-auth, GCM, secrets) are FALSE
> POSITIVES — the app already does auth via Express mount/router middleware and
> scopes DB queries with Drizzle `.where(eq(table.userId, userId))`. Only the
> items below were validated as genuinely worth addressing. Do NOT act on the
> false-positive categories listed at the end.

You are working in the Cryptafolio (`cryptotrackr`) repo. Implement the
following validated remediations. Work on a branch, keep each item a separate
commit, run the test suite + typecheck after each, and open one PR.

## 1. Vulnerable dependencies (highest priority, lowest risk)
Run `npm audit` and `npx osv-scanner --lockfile=package-lock.json` and resolve:
- **Drizzle ORM — SQL injection via improperly escaped identifiers** (GHSA-gpj5-g38j-94v9). Upgrade `drizzle-orm` to the patched version. After upgrading, grep for any place a **user-controlled value is used as a column/table identifier** (not a value) and confirm none exist; values bound via `eq()/sql\`\`` placeholders are fine.
- **Vite / esbuild dev-server advisories** (GHSA-67mh-4wv8-2f99, GHSA-4w7w-66w2-5vf9, GHSA-p9ff-h696-f583, GHSA-v2wj-q39q-566r, GHSA-gv7w-rqvm-qjhr). These affect the **dev server only**, not production builds — upgrade `vite`/`esbuild` to patched versions; no runtime code change expected.
- **`uuid`** (GHSA-w5hq-g745-h8pq) and **`python-dotenv`** (GHSA-mf9w-mj56-hr94) — upgrade to patched versions.
Acceptance: `npm audit` shows the above resolved; build + tests still green.

## 2. CORS reflection on the Bybit proxy — `server/routes.ts:~3500`
The preflight handler sets `Access-Control-Allow-Origin: req.headers.origin || '*'`,
i.e. it reflects ANY origin while also allowing `Authorization`. Restrict the
allowed origin to an explicit allowlist (the app's own front-end origin(s),
from config/env). Apply the same restriction to the actual proxy response
headers, not just the OPTIONS handler.
Acceptance: requests from a non-allowlisted Origin do not receive a permissive
ACAO header.

## 3. Bybit proxy passthrough — `server/routes.ts:~3488`
The proxy does `res.send(await response.text())` of an upstream response and
copies upstream headers. Set an explicit `Content-Type` (e.g. force
`application/json` for this JSON API, or sanitize the copied content-type) so a
manipulated upstream response cannot cause the browser to render HTML/JS.
Confirm the proxy is auth-gated and that the upstream host is fixed (not
user-controlled). Acceptance: response content-type is controlled by us.

## 4. (Optional hardening — discuss before doing) Crypto auth-tag length
`server/crypto.ts:~69` uses `createDecipheriv('aes-256-gcm', key, iv)` + 
`setAuthTag(tag)`. This is already correct/authenticated. As defense-in-depth
you MAY pass `{ authTagLength: 16 }` and reject tags whose length != 16 before
`setAuthTag`. Low value; skip if it risks the legacy-migration passthrough.

## 5. (Optional, separate project — do NOT auto-apply) Input-validation pass
The audit flagged ~157 routes lacking request-body schema validation
(`BS-VAL-001`, medium). This is a legitimate hardening theme but needs per-route
judgment (many already validate via downstream type coercion). If pursued, do it
as its own scoped effort with a shared `zod` validation middleware — NOT as a
blind sweep. Recommend specifying this separately before implementing.

---

## DO NOT "fix" these — they are confirmed false positives
Touching them will break working code:
- **`BS-AUTH-001` (146)** — auth IS applied via `app.use('/api/...', authMiddleware, adminOnly, router)` at mount and `router.use(authMiddleware, ...)` inside routers. Login/register/forgot-password/validate-token are public by design. Do not add auth to these.
- **`BS-SQL-002` (59)** — the flagged `db.select().from(table)` calls ARE tenant-scoped by a chained `.where(eq(table.userId, userId))`. Do not add redundant filters.
- **`BS-AUTH-002` (3)** — auth endpoints already have `authLimiter` applied at mount.
- **`BS-WS-001` (1)** — the WebSocket handler already authenticates and closes unauthenticated sockets.
- **`gcm-no-tag-length` (1)** — `setAuthTag` is already called; GCM is authenticated.
- **`generic-api-key` (5)** — hits are docs/migrations/seed/UI-disclaimer, not real secrets (verify, then ignore).
- **`BS-RLS-001` (16)** — these are table definitions; the app uses app-level tenant scoping. Postgres-level RLS is an architectural decision, not a per-table bug. Do not add RLS piecemeal.

## Working agreement
- Branch + one PR; separate commit per numbered item.
- After each change: `npm run typecheck`, `npm test` (or the repo's equivalent), and `npm run build`.
- If you find any item is actually a non-issue on closer inspection, STOP and report rather than forcing a change.
