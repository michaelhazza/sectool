---
name: postgres-migrations
description: Use BEFORE authoring or editing a database migration or ORM schema change — CHECK constraints, enums, foreign keys, unique or partial indexes, backfills, column renames, RLS policies, or timestamp/timezone handling. Also use when a migration fails on existing data or a unique index is rejected as non-immutable.
---

# Postgres migration and schema discipline

Rules distilled from recurring migration defects. Postgres-specific unless noted.

## SQL three-valued logic (the silent killer)

- `col = NULL` never matches; `NULL <> 'x'` evaluates UNKNOWN and silently satisfies CHECK constraints or drops rows from filters. Use `IS DISTINCT FROM` for nullable comparisons; validators must route null checks through dedicated `IS NULL` handling.
- Any predicate `event_col >= optional_nullable_col` inside NOT EXISTS / NOT IN inverts silently when the column is NULL. COALESCE optional watermarks to a safe floor and add null-case test fixtures.
- Unique indexes treat NULLs as distinct by default — handle mixed NULL semantics explicitly (COALESCE in the index expression or `NULLS NOT DISTINCT`) or duplicates slip in.

## Constraints

- Adding a CHECK constraint to an existing table requires a backfill/normalising UPDATE in the same transaction, or `NOT VALID` + later `VALIDATE` — otherwise the first pre-existing violating row aborts the migration. Tightened unique constraints likewise need a dedupe of existing rows first.
- CHECK constraints AND together: adding a wider enum CHECK alongside an old closed-enum CHECK still rejects every new value — drop-and-replace, never stack.
- CHECK constraints must mirror the contract's enum exactly. Wider-than-spec admits undefined rows; "we filter upstream" does not survive refactors. When a TEXT column is enum-like, decide explicitly whether to add a CHECK; without one the type layer is the only enforcer.
- For JSONB columns with a fixed shape, write CHECKs as allow-lists (subtract permitted keys, require empty remainder), never deny-lists — deny-lists silently accept every key you didn't enumerate.
- CHECK constraints live outside the type system: a conditionally-NOT-NULL column is still `string | null` to TypeScript. At branches that depend on the constraint, assert and throw loudly — never coerce with `?? 'default'`. Pair multi-column CHECKs with a pure application-level transition classifier every writer consults; the CHECK alone surfaces violations as opaque 500s.
- Match FK actions to the service contract, and give every FK an explicit ON DELETE policy: "rows are never deleted" pairs with ON DELETE RESTRICT, not SET NULL (which silently destroys audit links). Bare ON DELETE SET NULL nulls ALL referencing columns of a composite FK, including NOT NULL tenant columns; composite FKs are MATCH SIMPLE (any NULL column skips enforcement).

## Indexes

- Table-level UNIQUE constraints cannot carry WHERE clauses or expressions — use CREATE UNIQUE INDEX.
- A partial unique index's WHERE clause cannot reference volatile functions (`now()`), runtime UUIDs, or other tables. When it must scope to a foreign entity, denormalise a stable slug column and treat it as immutable identity. "One active row per scope" predicates must exclude EVERY terminal state, not just the one in mind when authored.
- `date_trunc` on `timestamptz` must cast `AT TIME ZONE 'UTC'` — in the projection, the GROUP BY, AND any index expression (without the cast it is only STABLE and the unique index is rejected as non-IMMUTABLE, sometimes only on fresh applies). Bare date_trunc follows session timezone and silently splits UTC days.
- Upserts against a partial unique index must reproduce the index's full predicate in the conflict target (index-expression form — `ON CONSTRAINT` never matches a partial index) or the arbiter won't match. In Drizzle: `onConflictDoNothing({ target, where })` — `targetWhere` belongs to `onConflictDoUpdate` and is silently ignored; pin the generated SQL with a test.

## Structural patterns

- Postgres has no polymorphic FKs. "References table A when type=X, table B when type=Y" splits into one nullable FK per target plus a CHECK enforcing exactly-one-non-null tied to the discriminator.
- Mutually-referencing new tables need a deferred FK: order creation to resolve the cycle, or add the second constraint via later ALTER TABLE. Spec the ordering explicitly.
- Renaming an FK-referenced key value takes three statements in one transaction: INSERT new key, UPDATE referencing rows, DELETE old key.
- Flags governing fallback behaviour when a child config row is missing must live on the parent entity that always exists — a flag on the optional child is unreadable exactly when it matters.

## Cross-layer sync (the drift class)

- ORM schema and SQL migration must agree in both directions: every ORM `.references()` needs the matching SQL FK, and vice versa. Verify by running codegen and confirming zero diff — partial-index-in-migration vs full-index-in-ORM makes the next codegen emit a destructive diff.
- When the deployed column is text+CHECK, align the ORM with a compile-time-only type annotation (Drizzle `.$type<>()`), not a native enum — invisible to the SQL diff, kills a perpetual enum-creating migration. Sweep ALL drifted columns on the affected tables, not just the ones the spec names.
- A NOT NULL column added to a table written by code outside your typecheck surface (separate worker process, external service) needs a grep-enumerated list of every producer, each confirmed updated — cross-process producers get no compile signal.
- Column renames: grep BOTH the ORM camelCase name AND raw snake_case literals in SQL templates, plus provisioning/seed paths. Update side-registries (RLS manifest, job maps, env manifest) in the same change.
- Value-set changes (enum member added/renamed): update the SQL CHECK (drop-and-replace, never stack) and the ORM schema together in one migration; the full cross-layer enumeration sweep (validation schemas, state machines, query filters, config files): see the wire-it-through skill.

## Process

- Before authoring, check the true next-free migration number on main AND all in-flight branches; on collision, renumber forward past all known claims (never backward, never reuse), in original relative order, sweeping headers, down-migrations, and doc references — verified by grepping the old number.
- Runner ordering is lexical — never assert non-numeric suffix order by intuition (`0443c` sorts after `0443b`); a wrong assumption means a dependent constraint doesn't exist at FK-creation time. Verify against the runner's comparator or an empty-database run; no forward references.
- Down migrations are idempotent (`IF EXISTS` everywhere — CI may replay down before up) and must delete rows a restored narrower CHECK forbids.
- Surface ACCESS EXCLUSIVE locks in the PR even when accepted; rename sequences atomically with the consuming code.
- The never-edit-applied-migrations rule applies only to migrations applied to some environment. Net-new migrations on an unmerged branch are edited in place.
- If migration SQL reads a session setting for conditional branching, the runner must bridge the operator's env var into that setting inside the transaction, or the branch is unreachable.
- When a migration set adds a conservative default AND a backfill on a sibling column, check whether the backfill writes values the new default forbids — if so, drop the backfill rather than shipping a permanent row-vs-policy contradiction.
