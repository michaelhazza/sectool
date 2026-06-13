# LIVE-IDOR-001 — Insecure direct object reference / access-control bypass

**Engine:** ZAP active scan + authenticated two-user crawl
**Scanner family:** probe (finding emitted with `source: "probe"`, `checkId: "LIVE-IDOR-001"`)
**checkId:** LIVE-IDOR-001
**vulnClass:** auth-access-control
**Base severity:** critical

## What it flags

Cross-user or privilege-escalation access-control failures discovered via an
authenticated two-user crawl (requires `activeScan: true` and exactly two
`auth.testUsers` entries per §6.2):

- **Horizontal privilege escalation (IDOR)** — User A can access, modify, or
  delete User B's resources by substituting a numeric/UUID identifier in the URL
  or request body (e.g. `GET /api/orders/42` succeeds for a user who does not
  own order 42)
- **Vertical privilege escalation** — A low-privilege user can access
  admin-only endpoints or data that the authenticated crawl reveals as accessible
- **Missing object-level authorization** — API endpoints that check
  authentication (`401` for unauthenticated callers) but do not verify that the
  authenticated user owns the requested object

The check works by performing the same requests as two distinct authenticated
users and comparing responses — a resource owned by User A that returns 200 for
User B's session is flagged.

## Why it matters

IDOR (OWASP A01:2021 — Broken Access Control) is the most common high-severity
finding in multi-tenant applications. It directly enables data exfiltration
across tenant boundaries. In a multi-tenant Express/Drizzle stack, missing
row-level ownership checks in route handlers are the most frequent root cause.

## Fix pattern

Always verify that the authenticated user owns the requested resource before
returning or mutating it:

```ts
// Vulnerable — checks auth but not ownership
router.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await db.select().from(orders).where(eq(orders.id, Number(req.params.id)));
  res.json(order[0]);
});

// Safe — verify ownership (or admin role) before returning
router.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await db.select().from(orders).where(
    and(
      eq(orders.id, Number(req.params.id)),
      eq(orders.userId, req.user.id),  // ownership check
    ),
  );
  if (!order[0]) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(order[0]);
});
```

For multi-tenant applications, prefer scoped query helpers that automatically
filter by the authenticated user's tenant/org:

```ts
// Use a scoped helper that enforces tenancy at the query layer
const order = await getOrderForUser(db, req.user.id, Number(req.params.id));
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-IDOR-001` with the
same fingerprint must be absent from the next `audit run` output. The
acceptance scan requires `activeScan: true` with two valid test-user
credentials to reproduce the two-user cross-access probe.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-IDOR-001`)
