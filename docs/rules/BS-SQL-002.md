# BS-SQL-002 — Queries on tenant tables bypassing scoped helpers

**Engine:** ts-morph (cross-file — table definitions may live in schema.ts)
**Base severity:** high
**vulnClass:** tenant-isolation

## What it flags

`db.select()`, `db.update()`, `db.delete()`, or `db.insert()` calls that reference
a tenant-scoped table (one with `organisationId`, `subaccountId`, `tenantId`,
`orgId`, or their snake_case equivalents) but are NOT chained from a
scoped-helper call (`scopedQuery(...)`, `withTenant(...)`, `forOrg(...)`).

## Why it matters

Queries on multi-tenant tables that bypass the scoped-query helper can leak
or mutate data across organisational boundaries. An authenticated user from
Organisation A could potentially read or write Organisation B's records.

## Fix pattern

Always go through the tenant-scoped helper when querying tenant tables:

```ts
// Vulnerable
const invoices = await db.select().from(invoicesTable);

// Safe: go through the scoped query helper
const invoices = await scopedQuery(db, req.user.orgId).select().from(invoicesTable);
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-SQL-002` with the same
fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-SQL-002/vulnerable/`
- Clean: `benchmark/corpus/static/BS-SQL-002/clean/`
