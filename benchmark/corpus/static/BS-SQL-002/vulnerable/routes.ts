// BS-SQL-002 vulnerable fixture: query on tenant table bypassing scoped helper
// The 'invoices' table has an organisationId tenant column, but the query
// does NOT go through the scopedQuery / withTenant helper.

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

// Vulnerable: direct query on tenant table without using scopedQuery helper
export async function getAllInvoices(req: { user: { orgId: string } }) {
  const _orgId = req.user.orgId;
  // Should use scopedQuery(db, orgId).select()... but doesn't
  const result = await db.select().from(invoices).where(eq(invoices.id, 1 as never));
  return result;
}

// Vulnerable: another direct query bypassing the tenant scope helper
export async function getRawInvoiceData() {
  const result = await db.select().from(invoices).where(eq(invoices.id, 2 as never));
  return result;
}
