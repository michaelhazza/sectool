# BS-AUTH-001 — Express route without auth/permission middleware

**Engine:** ts-morph (middleware-chain walk)
**Base severity:** high
**vulnClass:** auth-access-control

## What it flags

Express route definitions (`router.get`, `router.post`, `app.put`, etc.) where:

1. The route path is NOT in the per-repo `publicRoutes` allowlist (§6.2), AND
2. No auth or permission middleware identifier appears between the path argument
   and the final handler argument.

Recognized auth middleware names include: `requireAuth`, `authenticate`, `isAuthenticated`,
`verifyToken`, `jwtMiddleware`, `authorize`, `requireRole`, `requirePermission`, `isAdmin`,
`checkAuth`, `protect`, `guardRoute`, and common variants.

## §8.1 Reachability operands set here

This rule sets the `reachability` field used by the severity modifier chain (§8.1):

| Condition | Reachability | Rule fires? |
|---|---|---|
| Route in `publicRoutes` | `unauthenticated` | No — intentionally public |
| Behind auth middleware | `authenticated` | No — protected |
| Behind admin/perm guard | `admin` | No — admin-gated |
| No middleware detected | `unknown` | Yes — unprotected |

## Why it matters

An Express route without auth middleware is reachable by any unauthenticated
caller. In a multi-tenant or privileged-data application this exposes endpoints
that should require a valid session.

## Fix pattern

Add an auth middleware before the handler:

```ts
// Vulnerable
router.get('/api/users', async (req, res) => {
  const users = await db.select().from(usersTable);
  res.json(users);
});

// Safe: auth middleware before handler
router.get('/api/users', requireAuth, async (req, res) => {
  const users = await db.select().from(usersTable);
  res.json(users);
});
```

For intentionally public routes (login, health checks), add them to the repo's
`publicRoutes` config to prevent false positives:

```json
{
  "repos": [{
    "name": "my-app",
    "publicRoutes": ["POST /api/auth/login", "GET /api/health"]
  }]
}
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-AUTH-001` with the same
fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-AUTH-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-AUTH-001/clean/`
