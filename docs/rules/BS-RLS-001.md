# BS-RLS-001 — Drizzle tenant table without RLS policy in migrations

**Engine:** ts-morph + migration file scan (schema↔migration join)
**Base severity:** critical
**vulnClass:** tenant-isolation

## What it flags

Drizzle `pgTable(...)` definitions with a tenant column (`organisationId`,
`subaccountId`, `tenantId`, `orgId`, or their snake_case equivalents) where no
corresponding RLS policy appears in any `.sql` migration file under
`migrations/`, `drizzle/`, or `db/migrations/`.

Specifically, it looks for:
- `CREATE POLICY ... ON <tableName>`
- `ALTER TABLE <tableName> ENABLE ROW LEVEL SECURITY`

The rule's `symbol` is the normalized pgTable name literal (§6.6), e.g.
`subscriptions`. This is stable for fingerprinting and baseline scoping.

## Why it matters

Without row-level security, a single Postgres connection (or a connection pool
shared across tenants) can access any row in the table. Application-level
scoping (`WHERE organisation_id = $1`) is the only protection, and a missed
WHERE clause or a direct psql query leaks all tenant data.

## Fix pattern

Add RLS to every tenant table in a migration:

```sql
-- Enable RLS on the table
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Create a policy that restricts rows to the current org
CREATE POLICY subscriptions_org_isolation ON subscriptions
  USING (organisation_id = current_setting('app.current_org_id'));
```

In Drizzle, you can add the migration via `drizzle-kit generate` after setting
`enableRLS()` on the table definition (Drizzle v0.36+), or write the SQL
migration manually.

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-RLS-001` with the same
fingerprint must be absent from the next `audit run` output for the flagged
table.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-RLS-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-RLS-001/clean/`
