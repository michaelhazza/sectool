// BS-RLS-001 clean fixture: tenant table with RLS policy present in migrations
// The 'documents' table has an organisationId column AND there is a corresponding
// RLS policy in the migrations directory — no violation.

import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';

export const documents = pgTable('documents', {
  id: integer('id'),
  organisationId: text('organisation_id'),
  title: text('title'),
  createdAt: timestamp('created_at'),
});

// Non-tenant table: no organisationId column — no violation expected
export const globalConfig = pgTable('global_config', {
  id: integer('id'),
  key: text('key'),
  value: text('value'),
});
