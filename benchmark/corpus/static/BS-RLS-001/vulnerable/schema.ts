// BS-RLS-001 vulnerable fixture: tenant table with no RLS policy in migrations
// The 'subscriptions' table has an organisationId column (tenant column)
// but there is no corresponding RLS policy in the migrations directory.

import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';

export const subscriptions = pgTable('subscriptions', {
  id: integer('id'),
  organisationId: text('organisation_id'),
  plan: text('plan'),
  createdAt: timestamp('created_at'),
});

export const users = pgTable('users', {
  id: integer('id'),
  organisationId: text('organisation_id'),
  email: text('email'),
});
