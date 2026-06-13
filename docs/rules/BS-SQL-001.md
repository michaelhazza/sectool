# BS-SQL-001 — SQL injection via request-derived interpolation

**Engine:** ts-morph (AST taint walk)
**Base severity:** critical
**vulnClass:** injection

## What it flags

Calls to `` sql`…` `` (Drizzle tagged template) or `db.execute(sql`…`)` where at
least one template expression directly interpolates a request-derived value:

- `req.params.*`
- `req.query.*`
- `req.body.*`
- Local variables assigned from any of the above

## Why it matters

Direct interpolation of HTTP request values into SQL bypasses parameterization.
An attacker can craft input that escapes the query context, reading or modifying
arbitrary data (classic SQL injection).

## Fix pattern

Use Drizzle's type-safe query builder or explicit parameterized queries instead
of raw `sql` tagged templates with user input:

```ts
// Vulnerable
const result = await db.execute(sql`SELECT * FROM users WHERE id = ${req.params.id}`);

// Safe: use Drizzle's query builder
const result = await db.select().from(users).where(eq(users.id, parseInt(req.params.id, 10)));

// Safe: explicit parameterized query (no interpolation of user input)
const result = await db.execute(sql`SELECT * FROM users WHERE id = ${parseInt(req.params.id, 10)}`);
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-SQL-001` with the same
fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-SQL-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-SQL-001/clean/`
