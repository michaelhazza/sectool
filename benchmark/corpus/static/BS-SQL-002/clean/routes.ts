// BS-SQL-002 clean fixture: queries on tenant table via scoped helper
// All queries go through scopedQuery which automatically scopes by organisationId.

import { eq } from 'drizzle-orm';
import { pgTable, text, integer } from 'drizzle-orm/pg-core';

export const invoices = pgTable('invoices', {
  id: integer('id'),
  organisationId: text('organisation_id'),
  amount: integer('amount'),
});

function buildDb() {
  return {
    select: () => ({
      from: (_t: unknown) => ({ where: (_c: unknown) => Promise.resolve([]) }),
    }),
  };
}

const db = buildDb();

// Helper that scopes all queries to a specific organisation
function scopedQuery(_db: typeof db, _orgId: string) {
  return db;
}

// Safe: uses scopedQuery helper which enforces tenant isolation
export async function getAllInvoices(req: { user: { orgId: string } }) {
  const orgId = req.user.orgId;
  const result = await scopedQuery(db, orgId).select().from(invoices).where(eq(invoices.id, 1 as never));
  return result;
}

// Safe: non-tenant table — no violation
export const settings = pgTable('settings', {
  id: integer('id'),
  key: text('key'),
  value: text('value'),
});

export async function getSettings() {
  const result = await db.select().from(settings).where(eq(settings.id, 1 as never));
  return result;
}
